import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, runMigrations } from '@ubc/database';
import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import { resolveLiveStoreConfigFromDb } from './services/connectors.js';
import { startWorkerLoop } from './workers/runner.js';

async function main() {
  const config = loadConfig();
  if (!config.env.ADMIN_DIR) {
    const cwdAdmin = resolve(process.cwd(), 'apps/admin');
    const relAdmin = resolve(dirname(fileURLToPath(import.meta.url)), '../../admin');
    config.env.ADMIN_DIR = existsSync(cwdAdmin) ? cwdAdmin : relAdmin;
  }
  const pool = createPool(config.env.DATABASE_URL);
  await runMigrations(pool, (m) => console.log(m));
  await resolveLiveStoreConfigFromDb(pool, config);
  const { app, ctx } = await buildApp({ pool, config });
  // Single-process deployments run the worker in-process; set RUN_WORKER=false when using `npm run worker`.
  if (process.env.RUN_WORKER !== 'false') startWorkerLoop(ctx, { log: (m) => app.log.info(m) });
  await app.listen({ port: config.env.PORT, host: config.env.HOST });
  app.log.info(`UBC Commerce Hub API listening in ${config.mode.toUpperCase()} mode`);
  const shutdown = async () => { await app.close(); await pool.end(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
