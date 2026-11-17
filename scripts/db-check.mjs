// Read-only PostgreSQL / Supabase connectivity & migration diagnostic (`npm run db:check`).
// Never prints credentials or full connection strings.
import { createPool } from '../packages/database/dist/index.js';

const rawUrl = process.env.DATABASE_URL?.trim();
if (!rawUrl) {
  console.error('DATABASE_URL is not set in .env');
  process.exit(1);
}

let redactedHost = 'unknown-host';
try {
  const u = new URL(rawUrl);
  redactedHost = `${u.hostname}:${u.port || '5432'}${u.pathname}`;
} catch {
  // ignore parse errors
}

console.log('--- UBC Commerce Hub · PostgreSQL / Supabase Diagnostic ---');
console.log('Target :', redactedHost);

const pool = createPool(rawUrl);
try {
  const res = await pool.query(
    `SELECT current_database() AS db, current_user AS usr, version() AS ver`,
  );
  const row = res.rows[0];
  console.log('Status : connected');
  console.log('DB/User:', `${row.db} (${row.usr})`);
  console.log('Engine :', String(row.ver).split(',')[0]);

  const mig = await pool.query(
    `SELECT to_regclass('public.schema_migrations') AS tbl`,
  );
  if (mig.rows[0]?.tbl) {
    const applied = await pool.query(`SELECT name, applied_at FROM schema_migrations ORDER BY name`);
    console.log(`Migrations (${applied.rowCount}):`, applied.rows.map((r) => r.name).join(', ') || 'none');
  } else {
    console.log('Migrations: none applied yet (run `npm run db:migrate`)');
  }
} catch (err) {
  console.error('Status : error');
  console.error('Detail :', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
