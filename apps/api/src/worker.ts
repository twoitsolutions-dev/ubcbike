import { createPool } from '@ubc/database';
import { loadConfig } from './config/env.js';
import { createConnectors } from './services/connectors.js';
import { startWorkerLoop } from './workers/runner.js';

const config = loadConfig();
const pool = createPool(config.env.DATABASE_URL);
const stop = startWorkerLoop({ pool, config, connectors: createConnectors(config, pool) }, { log: (m) => console.log(new Date().toISOString(), m) });
console.log(`worker started (${config.mode})`);
process.on('SIGTERM', () => { stop(); void pool.end(); });
