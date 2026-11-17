import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Apply pending *.sql migrations in filename order, each inside its own
 * transaction serialized with `pg_advisory_xact_lock` (compatible with both
 * Supabase Session Pooler :5432 and Transaction Pooler :6543).
 */
export async function runMigrations(pool: pg.Pool, log: (m: string) => void = console.log): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];

  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, f), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(727001)');
      const already = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [f]);
      if (!already.rowCount) {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        log(`applied ${f}`);
        applied.push(f);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void import('./pool.js').then(({ createPool }) => {
    const pool = createPool();
    return runMigrations(pool)
      .then((a) => console.log(a.length ? `${a.length} migration(s) applied` : 'database is up to date'))
      .catch((e) => { console.error(e); process.exitCode = 1; })
      .finally(() => pool.end());
  });
}
