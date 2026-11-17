// Packages a clean, lightweight source archive of UBC Commerce Hub for
// Hostinger Node.js Web App deployment (`hosting_deploy`):
//   build/ubc-hub-source.zip (strictly excludes .env, node_modules, dist, themes)
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

const ROOT = resolve(process.cwd());
const OUT_ZIP = join(ROOT, 'build', 'ubc-hub-source.zip');

async function collectDir(dir, zipPrefix) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const out = [];
  for (const e of entries) {
    if (
      e.name.startsWith('.') ||
      e.name === 'node_modules' ||
      e.name === 'dist' ||
      e.name.endsWith('.tsbuildinfo')
    ) {
      continue;
    }
    const full = join(dir, e.name);
    const rel = `${zipPrefix}/${e.name}`;
    if (e.isDirectory()) {
      out.push(...(await collectDir(full, rel)));
    } else if (e.isFile()) {
      out.push({ rel, data: await readFile(full) });
    }
  }
  return out;
}

function buildZip(fileItems) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const dosTime = 0x6000;
  const dosDate = 0x5d6c;

  for (const item of fileItems) {
    if (item.rel === '.env' || item.rel.endsWith('/.env')) {
      throw new Error(`Refusing to include secret file in archive: ${item.rel}`);
    }
    const nameBuf = Buffer.from(item.rel, 'utf8');
    const raw = item.data;
    const deflated = raw.length > 0 ? deflateRawSync(raw) : Buffer.alloc(0);
    const useStore = raw.length === 0 || deflated.length >= raw.length;
    const method = useStore ? 0 : 8;
    const payload = useStore ? raw : deflated;
    const crc = crc32(raw) >>> 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(fileItems.length, 8);
  eocd.writeUInt16LE(fileItems.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

const deployPkg = {
  name: 'ubc-commerce-hub',
  private: true,
  version: '0.1.0',
  description: 'UBC Commerce Hub — TwoIT Solutions LLC',
  type: 'module',
  main: 'apps/api/dist/server.js',
  engines: { node: '>=22' },
  workspaces: ['packages/*', 'apps/api'],
  scripts: {
    build: 'tsc -b packages/shared packages/business-rules packages/demo-data packages/integrations packages/database apps/api',
    start: 'node --env-file-if-exists=.env apps/api/dist/server.js',
    worker: 'node --env-file-if-exists=.env apps/api/dist/worker.js',
    'db:migrate': 'node --env-file-if-exists=.env packages/database/dist/migrate.js',
  },
  dependencies: {
    '@types/node': '^22.20.5',
    '@types/pg': '^8.23.1',
    typescript: '5.9',
  },
};

const items = [
  { rel: 'package.json', data: Buffer.from(JSON.stringify(deployPkg, null, 2) + '\n', 'utf8') },
  { rel: 'tsconfig.base.json', data: await readFile(join(ROOT, 'tsconfig.base.json')) },
  ...(await collectDir(join(ROOT, 'apps/api'), 'apps/api')),
  ...(await collectDir(join(ROOT, 'apps/admin'), 'apps/admin')),
];

for (const pkgName of ['shared', 'business-rules', 'demo-data', 'integrations', 'database']) {
  items.push(...(await collectDir(join(ROOT, `packages/${pkgName}`), `packages/${pkgName}`)));
}

items.sort((a, b) => a.rel.localeCompare(b.rel));
await mkdir(join(ROOT, 'build'), { recursive: true });
const zipBuf = buildZip(items);
await writeFile(OUT_ZIP, zipBuf);
console.log(`Packed ${items.length} files (${(zipBuf.length / 1024).toFixed(1)} KB) -> ${relative(ROOT, OUT_ZIP)}`);
