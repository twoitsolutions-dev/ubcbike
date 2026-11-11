import type { Pool, PoolClient } from '@ubc/database';

type Q = Pool | PoolClient;

export async function audit(
  db: Q,
  e: { companyId: string; userId?: string | null; action: string; entityType?: string; entityId?: string; detail?: unknown; ip?: string },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (company_id, actor_user_id, action, entity_type, entity_id, detail, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [e.companyId, e.userId ?? null, e.action, e.entityType ?? null, e.entityId ?? null, JSON.stringify(e.detail ?? {}), e.ip ?? null],
  );
}

export async function logError(
  db: Q,
  e: { companyId: string | null; source: string; message: string; context?: unknown; jobId?: number | null },
): Promise<void> {
  await db.query(
    `INSERT INTO error_log (company_id, source, message, context, job_id) VALUES ($1,$2,$3,$4,$5)`,
    [e.companyId, e.source, e.message.slice(0, 2000), JSON.stringify(e.context ?? {}), e.jobId ?? null],
  );
}
