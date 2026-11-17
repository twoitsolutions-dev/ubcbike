import { hostname } from 'node:os';
import type { AppContext } from '../services/context.js';
import { runScheduler } from '../services/campaigns.js';
import { claimJob, completeJob, failJob, recoverStaleJobs } from '../services/jobs.js';
import { runPipelineWatchdogAndSchedules } from '../services/pipeline.js';
import { handlers, onDead } from './handlers.js';

const workerId = `${hostname()}:${process.pid}`;

/** Process queued jobs until none are ready. Returns how many ran. */
export async function drain(ctx: AppContext, max = 1000): Promise<number> {
  let n = 0;
  while (n < max) {
    const job = await claimJob(ctx.pool, workerId);
    if (!job) break;
    n++;
    const h = handlers[job.type];
    try {
      if (!h) throw Object.assign(new Error(`No handler for ${job.type}`), { code: 'VALIDATION' });
      await completeJob(ctx.pool, job.id, await h(ctx, job));
    } catch (e) {
      const outcome = await failJob(ctx.pool, job, e);
      if (outcome === 'dead') await onDead[job.type]?.(ctx, job, (e as Error).message).catch(() => {});
    }
  }
  return n;
}

export function startWorkerLoop(ctx: AppContext, opts: { intervalMs?: number; log?: (m: string) => void } = {}) {
  const interval = opts.intervalMs ?? 2000;
  let stopped = false;
  let lastSchedule = 0;
  let lastWatchdog = 0;
  const tick = async () => {
    if (stopped) return;
    try {
      const nowMs = Date.now();
      if (nowMs - lastSchedule > 30_000) {
        lastSchedule = nowMs;
        await recoverStaleJobs(ctx.pool);
        await runScheduler(ctx);
      }
      // Every 5 minutes: check feed silence SLAs (e.g. JBI 48h) and tiered sync cadences (15-30m / 6-12h / 24h).
      if (nowMs - lastWatchdog > 300_000) {
        lastWatchdog = nowMs;
        await runPipelineWatchdogAndSchedules(ctx);
      }
      const n = await drain(ctx, 50);
      if (n) opts.log?.(`processed ${n} job(s)`);
    } catch (e) {
      opts.log?.(`worker error: ${(e as Error).message}`);
    }
    if (!stopped) setTimeout(tick, interval);
  };
  setTimeout(tick, 100);
  return () => { stopped = true; };
}
