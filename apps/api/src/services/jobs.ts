import type { Pool, PoolClient } from '@ubc/database';
import { logError } from './audit.js';

type Q = Pool | PoolClient;

export interface JobRow {
  id: number;
  company_id: string;
  type: string;
  payload: Record<string, unknown>;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead';
  attempts: number;
  max_attempts: number;
  created_by: string | null;
  idempotency_key: string | null;
}

export async function enqueue(
  db: Q,
  j: { companyId: string; type: string; payload?: unknown; idempotencyKey?: string; createdBy?: string | null; runAt?: Date; maxAttempts?: number },
): Promise<{ id: number; created: boolean }> {
  const r = await db.query<{ id: number }>(
    `INSERT INTO jobs (company_id, type, payload, idempotency_key, created_by, run_at, max_attempts)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6, now()),$7)
     ON CONFLICT (company_id, idempotency_key) DO NOTHING RETURNING id`,
    [j.companyId, j.type, JSON.stringify(j.payload ?? {}), j.idempotencyKey ?? null, j.createdBy ?? null, j.runAt ?? null, j.maxAttempts ?? 5],
  );
  if (r.rows[0]) return { id: r.rows[0].id, created: true };
  const existing = await db.query<{ id: number }>(`SELECT id FROM jobs WHERE company_id = $1 AND idempotency_key = $2`, [j.companyId, j.idempotencyKey]);
  return { id: existing.rows[0]!.id, created: false };
}

export async function claimJob(pool: Pool, workerId: string): Promise<JobRow | null> {
  const r = await pool.query<JobRow>(
    `UPDATE jobs SET status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1
     WHERE id = (
       SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now()
       ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1
     ) RETURNING *`,
    [workerId],
  );
  return r.rows[0] ?? null;
}

export async function setProgress(pool: Pool, jobId: number, progress: Record<string, unknown>) {
  await pool.query(`UPDATE jobs SET progress = $2 WHERE id = $1`, [jobId, JSON.stringify(progress)]);
}

export async function completeJob(pool: Pool, jobId: number, result: unknown) {
  await pool.query(`UPDATE jobs SET status = 'succeeded', result = $2, finished_at = now(), locked_at = NULL, last_error = NULL WHERE id = $1`, [jobId, JSON.stringify(result ?? {})]);
}

const NON_RETRYABLE = new Set(['NOT_CONFIGURED', 'WRITES_DISABLED', 'PENDING_VERIFICATION', 'INVALID_TRANSITION', 'FORBIDDEN', 'VALIDATION']);

export function isRetryable(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return !(code && NON_RETRYABLE.has(code));
}

/** Exponential backoff with cap: 10s, 40s, 160s, ... max 1h. */
export function backoffMs(attempt: number): number {
  return Math.min(3_600_000, 10_000 * 4 ** Math.max(0, attempt - 1));
}

export async function failJob(pool: Pool, job: JobRow, err: unknown): Promise<'requeued' | 'dead'> {
  const message = err instanceof Error ? err.message : String(err);
  const dead = !isRetryable(err) || job.attempts >= job.max_attempts;
  if (dead) {
    await pool.query(`UPDATE jobs SET status = 'dead', last_error = $2, finished_at = now(), locked_at = NULL WHERE id = $1`, [job.id, message]);
    await logError(pool, { companyId: job.company_id, source: `job:${job.type}`, message, context: { jobId: job.id, attempts: job.attempts, payload: job.payload }, jobId: job.id });
    return 'dead';
  }
  await pool.query(
    `UPDATE jobs SET status = 'queued', last_error = $2, run_at = now() + ($3 || ' milliseconds')::interval, locked_at = NULL WHERE id = $1`,
    [job.id, message, String(backoffMs(job.attempts))],
  );
  return 'requeued';
}

/** Requeue jobs whose worker died mid-run. */
export async function recoverStaleJobs(pool: Pool, olderThanMinutes = 15): Promise<number> {
  const r = await pool.query(
    `UPDATE jobs SET status = 'queued', locked_at = NULL, last_error = 'recovered after stale lock'
     WHERE status = 'running' AND locked_at < now() - ($1 || ' minutes')::interval`,
    [String(olderThanMinutes)],
  );
  return r.rowCount ?? 0;
}
