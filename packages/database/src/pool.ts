import pg from 'pg';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

/**
 * Normalises PostgreSQL connection options for both local Postgres and managed
 * cloud providers (Supabase Session/Transaction Pooler, Neon, RDS, etc.).
 *
 * Note on node-postgres (`pg` v8) + Supabase:
 *  - Supabase poolers (`*.pooler.supabase.com` / `*.supabase.co`) require TLS
 *    and present the Supabase Root CA, which triggers `SELF_SIGNED_CERT_IN_CHAIN`
 *    on Windows unless `ssl: { rejectUnauthorized: false }` is set.
 *  - `pg-connection-string` overrides `ssl` if `?sslmode=require` remains on
 *    `connectionString`, so we strip `sslmode` when managing `ssl` explicitly.
 */
export function resolvePoolConfig(rawUrl = process.env.DATABASE_URL): pg.PoolConfig {
  if (!rawUrl?.trim()) throw new Error('DATABASE_URL is not set');
  const trimmed = rawUrl.trim();
  let parsed: URL | null = null;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = null;
  }

  const host = parsed?.hostname.toLowerCase() ?? '';
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '';
  const sslModeParam = parsed?.searchParams.get('sslmode')?.toLowerCase();
  const isCloudTlsHost =
    host.endsWith('.supabase.co') ||
    host.endsWith('.supabase.com') ||
    host.endsWith('.neon.tech') ||
    process.env.DATABASE_SSL === 'true' ||
    (sslModeParam !== undefined && sslModeParam !== 'disable');

  const max = Number(process.env.DATABASE_POOL_MAX ?? 10);
  if (isLocal && process.env.DATABASE_SSL !== 'true') {
    return { connectionString: trimmed, max };
  }

  if (isCloudTlsHost && parsed) {
    parsed.searchParams.delete('sslmode');
    const strictVerify = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true';
    return {
      connectionString: parsed.toString(),
      max,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: { rejectUnauthorized: strictVerify },
    };
  }

  return { connectionString: trimmed, max, keepAlive: true };
}

export function createPool(url = process.env.DATABASE_URL): pg.Pool {
  // Return BIGINT/NUMERIC as JS numbers where safe (ids from bigserial stay < 2^53 for our volumes).
  pg.types.setTypeParser(20, (v) => Number(v));
  pg.types.setTypeParser(1700, (v) => Number(v));
  const pool = new pg.Pool(resolvePoolConfig(url));
  pool.on('error', () => {
    // Managed cloud poolers (e.g. Supabase Supavisor) periodically recycle idle TCP sockets;
    // swallowing idle-client socket resets lets pg.Pool open a fresh connection on next checkout.
  });
  return pool;
}

export async function withTransaction<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** scrypt password hash: `scrypt$N$r$p$salt$hash` (base64). No native dependency needed. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error('Password must be at least 12 characters');
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT_PARAMS);
  return ['scrypt', SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT_PARAMS.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
