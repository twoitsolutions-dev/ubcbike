import { resolve } from 'node:path';
import { createPool, runMigrations } from '@ubc/database';
import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import { startWorkerLoop } from './workers/runner.js';

const config = loadConfig();
if (!config.env.ADMIN_DIR) config.env.ADMIN_DIR = resolve(process.cwd(), 'apps/admin');
const pool = createPool(config.env.DATABASE_URL);
await runMigrations(pool, (m) => console.log(m));
const { app, ctx } = await buildApp({ pool, config });
// Single-process deployments run the worker in-process; set RUN_WORKER=false when using `npm run worker`.
if (process.env.RUN_WORKER !== 'false') startWorkerLoop(ctx, { log: (m) => app.log.info(m) });
await app.listen({ port: config.env.PORT, host: config.env.HOST });
app.log.info(`UBC Commerce Hub API listening in ${config.mode.toUpperCase()} mode`);
const shutdown = async () => { await app.close(); await pool.end(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
