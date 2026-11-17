// Runs Shopify's official Theme Check on apps/dawn-ubc-fable-theme. Exit code 1 on errors.
import { themeCheckRun } from '@shopify/theme-check-node';
import { resolve } from 'node:path';

const root = resolve('apps/dawn-ubc-fable-theme');
const { theme, offenses } = await themeCheckRun(root, undefined, () => {});
const errors = offenses.filter((o) => o.severity === 0);
for (const o of errors) {
  console.log(`error ${o.check} ${o.uri.replace(/^.*dawn-ubc-fable-theme\//, '')}:${(o.start?.line ?? 0) + 1} ${o.message}`);
}
console.log(`Dawn UBC Fable Theme Check: ${theme.length} files, ${errors.length} errors (${offenses.length} total advisories)`);
if (!theme.length) {
  console.error('No theme files found');
  process.exit(1);
}
process.exitCode = errors.length > 0 ? 1 : 0;
