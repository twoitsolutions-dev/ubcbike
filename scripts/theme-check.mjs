// Runs Shopify's official Theme Check on apps/shopify-theme. Exit code 1 on errors.
import { themeCheckRun } from '@shopify/theme-check-node';
import { resolve } from 'node:path';
const root = resolve('apps/shopify-theme'); // must be absolute
const { theme, offenses } = await themeCheckRun(root, undefined, () => {});
for (const o of offenses) console.log(`${['error', 'warning', 'info'][o.severity]} ${o.check} ${o.uri.replace(/^.*shopify-theme\//, '')}:${(o.start?.line ?? 0) + 1} ${o.message}`);
console.log(`Theme Check: ${theme.length} files, ${offenses.length} offenses`);
if (!theme.length) { console.error('No theme files found'); process.exit(1); }
process.exitCode = offenses.some((o) => o.severity === 0) ? 1 : 0;
