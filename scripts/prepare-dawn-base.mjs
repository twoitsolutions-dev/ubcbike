// Cleans cloned Shopify Dawn directory so only valid Shopify OS 2.0 theme
// directories remain (`assets`, `config`, `layout`, `locales`, `sections`,
// `snippets`, `templates`) and preserves Dawn's MIT license in `docs/DAWN_LICENSE.md`.
import { copyFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ALLOWED_DIRS = new Set([
  'assets',
  'config',
  'layout',
  'locales',
  'sections',
  'snippets',
  'templates',
]);

const dawnRoot = resolve('apps/dawn-ubc-theme');
const licensePath = join(dawnRoot, 'LICENSE.md');
try {
  await stat(licensePath);
  await copyFile(licensePath, resolve('docs/DAWN_LICENSE.md'));
  console.log('Saved Shopify Dawn MIT license -> docs/DAWN_LICENSE.md');
} catch {
  // already moved
}

const entries = await readdir(dawnRoot, { withFileTypes: true });
for (const entry of entries) {
  if (entry.isDirectory() && ALLOWED_DIRS.has(entry.name)) continue;
  const target = join(dawnRoot, entry.name);
  await rm(target, { recursive: true, force: true });
  console.log('Pruned non-theme entry:', entry.name);
}
console.log('Clean Dawn OS 2.0 base ready in apps/dawn-ubc-theme.');
