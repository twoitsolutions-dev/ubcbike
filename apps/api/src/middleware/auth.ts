import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { hasPermission, type Permission, type Role } from '@ubc/shared';
import { verifyPassword } from '@ubc/database';
import { HttpError, type AppContext } from '../services/context.js';
import { audit } from '../services/audit.js';

export const SESSION_COOKIE = 'ubc_session';

export interface Session {
  sessionId: string;
  userId: string;
  companyId: string;
  role: Role;
  name: string;
  email: string;
  csrfToken: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    session?: Session;
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Naive in-memory login throttle (per process). Good enough for one admin instance; see docs for multi-instance. */
const attempts = new Map<string, { n: number; until: number }>();
function throttle(key: string): void {
  const now = Date.now();
  const a = attempts.get(key);
  if (a && a.until > now && a.n >= 5) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many login attempts. Try again in 15 minutes.');
}
function recordFailure(key: string) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.until < now) attempts.set(key, { n: 1, until: now + 15 * 60_000 });
  else a.n++;
}

/** Failed logins allowed per account (any IP) in the window before the account is locked for the window. */
const MAX_FAILS_PER_ACCOUNT = 8;
const FAIL_WINDOW_MIN = 15;

export async function login(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, email: string, password: string) {
  const key = `${req.ip}:${email.toLowerCase()}`;
  throttle(key);
  // Per-account limit stored in Postgres: shared by every server process and independent of the client IP,
  // so rotating X-Forwarded-For (the IP a client claims) cannot be used to keep guessing passwords.
  const fails = await ctx.pool.query<{ n: number }>(
    `SELECT count(*)::int n FROM audit_log
     WHERE action = 'auth.login_failed' AND lower(detail->>'email') = lower($1) AND created_at > now() - ($2 || ' minutes')::interval`,
    [email, String(FAIL_WINDOW_MIN)],
  );
  if (fails.rows[0]!.n >= MAX_FAILS_PER_ACCOUNT) {
    throw new HttpError(429, 'TOO_MANY_ATTEMPTS', `Too many login attempts for this account. Try again in ${FAIL_WINDOW_MIN} minutes.`);
  }
  const r = await ctx.pool.query<{ id: string; name: string; email: string; password_hash: string; company_id: string; role: Role }>(
    `SELECT u.id, u.name, u.email, u.password_hash, m.company_id, m.role FROM users u JOIN memberships m ON m.user_id = u.id
     WHERE lower(u.email) = lower($1) AND u.is_active ORDER BY m.company_id LIMIT 1`, [email]);
  const u = r.rows[0];
  // Always run a hash comparison to keep timing similar for unknown users.
  const ok = await verifyPassword(password, u?.password_hash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
  if (!u || !ok) {
    recordFailure(key);
    await audit(ctx.pool, { companyId: u?.company_id ?? (null as unknown as string), action: 'auth.login_failed', detail: { email }, ip: req.ip }).catch(() => {});
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect');
  }
  attempts.delete(key);
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  const ttlH = ctx.config.env.SESSION_TTL_HOURS;
  const s = await ctx.pool.query<{ id: string }>(
    `INSERT INTO sessions (token_hash, csrf_token, user_id, company_id, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4, now() + ($5 || ' hours')::interval, $6, $7) RETURNING id`,
    [sha256(token), csrf, u.id, u.company_id, String(ttlH), req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300)]);
  await ctx.pool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [u.id]);
  await audit(ctx.pool, { companyId: u.company_id, userId: u.id, action: 'auth.login', ip: req.ip });
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'strict', path: '/', secure: ctx.config.env.COOKIE_SECURE, maxAge: ttlH * 3600,
  });
  return { sessionId: s.rows[0]!.id, user: { id: u.id, name: u.name, email: u.email, role: u.role }, csrfToken: csrf };
}

export async function loadSession(ctx: AppContext, req: FastifyRequest): Promise<Session | null> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const r = await ctx.pool.query<{ id: string; user_id: string; company_id: string; role: Role; name: string; email: string; csrf_token: string }>(
    `SELECT s.id, s.user_id, s.company_id, m.role, u.name, u.email, s.csrf_token FROM sessions s
     JOIN users u ON u.id = s.user_id AND u.is_active JOIN memberships m ON m.user_id = s.user_id AND m.company_id = s.company_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha256(token)]);
  const row = r.rows[0];
  if (!row) return null;
  return { sessionId: row.id, userId: row.user_id, companyId: row.company_id, role: row.role, name: row.name, email: row.email, csrfToken: row.csrf_token };
}

/** Pre-handler: require an authenticated session, a valid CSRF token on writes, and optionally a permission. */
export function requireAuth(ctx: AppContext, permission?: Permission) {
  return async (req: FastifyRequest) => {
    const s = req.session ?? (await loadSession(ctx, req));
    if (!s) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required');
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-csrf-token'] !== s.csrfToken) {
      throw new HttpError(403, 'CSRF', 'Missing or invalid CSRF token');
    }
    if (permission && !hasPermission(s.role, permission)) {
      throw new HttpError(403, 'FORBIDDEN', `Your role (${s.role}) cannot perform this action (${permission})`);
    }
    req.session = s;
  };
}

export async function logout(ctx: AppContext, req: FastifyRequest, reply: FastifyReply) {
  if (req.session) await ctx.pool.query(`DELETE FROM sessions WHERE id = $1`, [req.session.sessionId]);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}
