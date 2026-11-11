// DANGER: drops and recreates the schema. Refuses unless APP_MODE=demo and the URL is explicitly confirmed.
import { createPool, runMigrations, seedDemo } from '../packages/database/dist/index.js';
if (process.env.APP_MODE === 'live') { console.error('Refusing: APP_MODE=live'); process.exit(1); }
if (process.env.CONFIRM_RESET !== process.env.DATABASE_URL) { console.error('Set CONFIRM_RESET to the exact DATABASE_URL to confirm a full reset.'); process.exit(1); }
const pool = createPool();
await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await runMigrations(pool);
const r = await seedDemo(pool);
for (const u of r.users) console.log(`${u.role.padEnd(10)} ${u.email}${u.password ? '  password: ' + u.password : ''}`);
await pool.end();
