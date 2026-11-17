// Packages all Shopify Dawn OS 2.0 themes with POSIX forward-slash `/` entry names,
// standard MS-DOS timestamps, STORE fallback for incompressible/empty files, and
// full post-write EOCD + Central Directory + Inflate + CRC32 verification.
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

async function collectFiles(dir, baseDir = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...(await collectFiles(full, baseDir)));
    } else if (e.isFile()) {
      const rel = relative(baseDir, full).split('\\').join('/');
      files.push({ full, rel });
    }
  }
  return files;
}

function buildZip(fileItems) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const dosTime = 0x6000; // 12:00:00
  const dosDate = 0x5d6c; // valid MS-DOS date

  for (const item of fileItems) {
    const nameBuf = Buffer.from(item.rel, 'utf8');
    const raw = item.data;
    const deflated = raw.length > 0 ? deflateRawSync(raw) : Buffer.alloc(0);
    const useStore = raw.length === 0 || deflated.length >= raw.length;
    const method = useStore ? 0 : 8;
    const payload = useStore ? raw : deflated;
    const crc = crc32(raw) >>> 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4);         // version needed to extract (2.0)
    localHeader.writeUInt16LE(0x0800, 6);     // general purpose bit flag (UTF-8)
    localHeader.writeUInt16LE(method, 8);     // compression method (0=store, 8=deflate)
    localHeader.writeUInt16LE(dosTime, 10);   // last mod file time
    localHeader.writeUInt16LE(dosDate, 12);   // last mod file date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);       // version made by
    centralHeader.writeUInt16LE(20, 6);       // version needed
    centralHeader.writeUInt16LE(0x0800, 8);   // UTF-8 flag
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

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(fileItems.length, 8);
  eocd.writeUInt16LE(fileItems.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

function verifyZipBuffer(buf) {
  const eocdOffset = buf.length - 22;
  if (buf.readUInt32LE(eocdOffset) !== 0x06054b50) {
    throw new Error('ZIP verification failed: missing EOCD signature');
  }
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  let ptr = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error(`ZIP verification failed: bad central header at entry ${i}`);
    }
    const method = buf.readUInt16LE(ptr + 10);
    const expectedCrc = buf.readUInt32LE(ptr + 16);
    const compSize = buf.readUInt32LE(ptr + 20);
    const uncompSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');

    if (name.includes('\\')) {
      throw new Error(`ZIP verification failed: backslash in entry ${name}`);
    }
    if (buf.readUInt32LE(localOff) !== 0x04034b50) {
      throw new Error(`ZIP verification failed: bad local header for ${name}`);
    }
    const dataStart = localOff + 30 + nameLen;
    const compSlice = buf.subarray(dataStart, dataStart + compSize);
    const out = method === 0 ? compSlice : inflateRawSync(compSlice);
    if (out.length !== uncompSize || (crc32(out) >>> 0) !== expectedCrc) {
      throw new Error(`ZIP verification failed: CRC/size mismatch for ${name}`);
    }
    ptr += 46 + nameLen;
  }
  return totalEntries;
}

const EDITION_COLOR_SCHEMES = {
  classic: {
    'scheme-1': { background: '#FEFDF3', text: '#14202D', button: '#213549', button_label: '#FEFDF3', secondary_button_label: '#213549', shadow: '#213549' },
    'scheme-2': { background: '#F3F1E7', text: '#14202D', button: '#E04F33', button_label: '#FFFFFF', secondary_button_label: '#213549', shadow: '#213549' },
    'scheme-3': { background: '#213549', text: '#FEFDF3', button: '#E04F33', button_label: '#FFFFFF', secondary_button_label: '#FEFDF3', shadow: '#0E1824' },
    'scheme-4': { background: '#0E1824', text: '#FEFDF3', button: '#CCBB8D', button_label: '#14202D', secondary_button_label: '#FEFDF3', shadow: '#0E1824' },
    'scheme-5': { background: '#CCBB8D', text: '#14202D', button: '#213549', button_label: '#FEFDF3', secondary_button_label: '#14202D', shadow: '#213549' },
  },
  black_friday: {
    'scheme-1': { background: '#0C0F14', text: '#F5F5F2', button: '#E04F33', button_label: '#FFFFFF', secondary_button_label: '#F5F5F2', shadow: '#05070A' },
    'scheme-2': { background: '#141922', text: '#F5F5F2', button: '#E04F33', button_label: '#FFFFFF', secondary_button_label: '#F5F5F2', shadow: '#05070A' },
    'scheme-3': { background: '#090B0F', text: '#F5F5F2', button: '#E04F33', button_label: '#FFFFFF', secondary_button_label: '#F5F5F2', shadow: '#05070A' },
    'scheme-4': { background: '#07090C', text: '#F5F5F2', button: '#E04F33', button_label: '#FFFFFF', secondary_button_label: '#F5F5F2', shadow: '#05070A' },
    'scheme-5': { background: '#E04F33', text: '#FFFFFF', button: '#090B0F', button_label: '#FFFFFF', secondary_button_label: '#FFFFFF', shadow: '#05070A' },
  },
  christmas: {
    'scheme-1': { background: '#FBF9F6', text: '#0F291C', button: '#144D34', button_label: '#FFFFFF', secondary_button_label: '#144D34', shadow: '#0F291C' },
    'scheme-2': { background: '#EEF5F0', text: '#0F291C', button: '#C81E2B', button_label: '#FFFFFF', secondary_button_label: '#144D34', shadow: '#0F291C' },
    'scheme-3': { background: '#144D34', text: '#FBF9F6', button: '#EAD08A', button_label: '#0F291C', secondary_button_label: '#FBF9F6', shadow: '#092619' },
    'scheme-4': { background: '#092619', text: '#FBF9F6', button: '#EAD08A', button_label: '#0F291C', secondary_button_label: '#FBF9F6', shadow: '#092619' },
    'scheme-5': { background: '#EAD08A', text: '#0F291C', button: '#144D34', button_label: '#FFFFFF', secondary_button_label: '#0F291C', shadow: '#0F291C' },
  },
  july_4: {
    'scheme-1': { background: '#EFF6FF', text: '#08172E', button: '#16386B', button_label: '#FEFDF3', secondary_button_label: '#16386B', shadow: '#08172E' },
    'scheme-2': { background: '#DBE7F8', text: '#08172E', button: '#D62828', button_label: '#FFFFFF', secondary_button_label: '#16386B', shadow: '#08172E' },
    'scheme-3': { background: '#16386B', text: '#FEFDF3', button: '#D62828', button_label: '#FFFFFF', secondary_button_label: '#FEFDF3', shadow: '#071428' },
    'scheme-4': { background: '#08172E', text: '#FEFDF3', button: '#E6C875', button_label: '#08172E', secondary_button_label: '#FEFDF3', shadow: '#071428' },
    'scheme-5': { background: '#E6C875', text: '#08172E', button: '#16386B', button_label: '#FEFDF3', secondary_button_label: '#08172E', shadow: '#08172E' },
  },
  spring: {
    'scheme-1': { background: '#FCFDF9', text: '#182E22', button: '#F05243', button_label: '#FFFFFF', secondary_button_label: '#237A4B', shadow: '#182E22' },
    'scheme-2': { background: '#F2FAF0', text: '#182E22', button: '#237A4B', button_label: '#FFFFFF', secondary_button_label: '#237A4B', shadow: '#182E22' },
    'scheme-3': { background: '#1B5C3B', text: '#FFFFFF', button: '#FDE68A', button_label: '#182E22', secondary_button_label: '#FFFFFF', shadow: '#133524' },
    'scheme-4': { background: '#133524', text: '#FFFFFF', button: '#FDE68A', button_label: '#182E22', secondary_button_label: '#FFFFFF', shadow: '#133524' },
    'scheme-5': { background: '#FDE68A', text: '#182E22', button: '#237A4B', button_label: '#FFFFFF', secondary_button_label: '#182E22', shadow: '#182E22' },
  },
  campus: {
    'scheme-1': { background: '#F4F7F5', text: '#062419', button: '#006747', button_label: '#FFFFFF', secondary_button_label: '#006747', shadow: '#062419' },
    'scheme-2': { background: '#E3ECE7', text: '#062419', button: '#F5C43E', button_label: '#062419', secondary_button_label: '#006747', shadow: '#062419' },
    'scheme-3': { background: '#006747', text: '#FFFFFF', button: '#F5C43E', button_label: '#062419', secondary_button_label: '#FFFFFF', shadow: '#042419' },
    'scheme-4': { background: '#042419', text: '#FFFFFF', button: '#F5C43E', button_label: '#062419', secondary_button_label: '#FFFFFF', shadow: '#042419' },
    'scheme-5': { background: '#F5C43E', text: '#062419', button: '#006747', button_label: '#FFFFFF', secondary_button_label: '#062419', shadow: '#062419' },
  },
  veterans: {
    'scheme-1': { background: '#F6F3EB', text: '#181D17', button: '#2B3527', button_label: '#F6F3EB', secondary_button_label: '#2B3527', shadow: '#181D17' },
    'scheme-2': { background: '#EAE4D5', text: '#181D17', button: '#B22828', button_label: '#FFFFFF', secondary_button_label: '#2B3527', shadow: '#181D17' },
    'scheme-3': { background: '#2B3527', text: '#F6F3EB', button: '#D8AE56', button_label: '#181D17', secondary_button_label: '#F6F3EB', shadow: '#141812' },
    'scheme-4': { background: '#141812', text: '#F6F3EB', button: '#D8AE56', button_label: '#181D17', secondary_button_label: '#F6F3EB', shadow: '#141812' },
    'scheme-5': { background: '#D8AE56', text: '#181D17', button: '#2B3527', button_label: '#F6F3EB', secondary_button_label: '#181D17', shadow: '#181D17' },
  },
};

const EDITION_HERO_EYEBROW = {
  classic: '3-Generation Family Cycling Shop · Tampa Since 1972',
  black_friday: 'Black Friday Event · Storewide Deals + 110% Price Guarantee',
  christmas: 'Holiday Gift Edition · Free Bike Hold & Rider Gifts Since 1972',
  july_4: 'July 4th Summer Event · Storewide Promos + Honoring Veterans & Police',
  spring: 'Tampa Bay Spring Season · Specialized Spring Sale & Alafia Trail Rides',
  campus: 'USF Back to Campus · E-Bikes, Scooters & Student Discounts on E Fletcher Ave',
  veterans: 'Veteran-Founded by Manny Since 1972 · Honoring U.S. Veterans & Law Enforcement',
};

function applySettingsPalette(targetObj, edition) {
  if (!targetObj || typeof targetObj !== 'object') return;
  targetObj.ubc_edition = edition;
  const palette = EDITION_COLOR_SCHEMES[edition];
  if (palette && targetObj.color_schemes) {
    for (const [schemeId, vals] of Object.entries(palette)) {
      if (targetObj.color_schemes[schemeId]?.settings) {
        Object.assign(targetObj.color_schemes[schemeId].settings, vals);
      }
    }
  }
}

function validateSettingsObjectAgainstSchema(defs, obj, label, srcDir) {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'sections' || k === 'content_for_index' || k === 'blocks') continue;
    const d = defs.get(k);
    if (!d) {
      throw new Error(`CRITICAL CONFIG ERROR (${srcDir} ${label}): Unknown setting key "${k}" not in settings_schema.json!`);
    }
    if (d.type === 'range') {
      if (typeof v !== 'number' || v < d.min || v > d.max) {
        throw new Error(`CRITICAL CONFIG ERROR (${srcDir} ${label}): "${k}"=${v} out of range [${d.min}, ${d.max}]!`);
      }
      const rem = Number(((v - d.min) % d.step).toFixed(6));
      if (rem !== 0 && Math.abs(rem - d.step) > 1e-6) {
        throw new Error(
          `CRITICAL CONFIG ERROR (${srcDir} ${label}): "${k}"=${v} violates step=${d.step} (min=${d.min}, max=${d.max})!`,
        );
      }
    }
    if (d.type === 'select' && Array.isArray(d.options)) {
      const valid = d.options.map((o) => o.value);
      if (!valid.includes(v)) {
        throw new Error(
          `CRITICAL CONFIG ERROR (${srcDir} ${label}): "${k}"="${v}" invalid select option (expected ${JSON.stringify(valid)})!`,
        );
      }
    }
  }
}

function assertDawnConfigIntegrity(loaded, srcDir, overrides = null) {
  // Only enforce full Dawn 40KB+ schema & scheme-1..scheme-5 check on complete Dawn themes
  if (!srcDir.includes('dawn-ubc')) return;
  const schemaEntry = loaded.find((x) => x.rel === 'config/settings_schema.json');
  const dataEntry = loaded.find((x) => x.rel === 'config/settings_data.json');
  if (!schemaEntry) {
    throw new Error(`CRITICAL CONFIG ERROR (${srcDir}): Missing config/settings_schema.json!`);
  }
  if (schemaEntry.data.length < 38000) {
    throw new Error(
      `CRITICAL CONFIG ERROR (${srcDir}): config/settings_schema.json is too small (${schemaEntry.data.length} bytes < 38000 bytes). Refusing to package broken/empty schema!`,
    );
  }
  const parsedSchema = JSON.parse(schemaEntry.data.toString('utf8'));
  if (!Array.isArray(parsedSchema) || parsedSchema.length < 5) {
    throw new Error(`CRITICAL CONFIG ERROR (${srcDir}): config/settings_schema.json is empty or malformed!`);
  }
  if (!dataEntry || dataEntry.data.length < 500) {
    throw new Error(`CRITICAL CONFIG ERROR (${srcDir}): Missing or empty config/settings_data.json!`);
  }
  const parsedData = JSON.parse(dataEntry.data.toString('utf8'));
  if (typeof parsedData.current !== 'object' || !parsedData.current) {
    throw new Error(
      `CRITICAL CONFIG ERROR (${srcDir}): config/settings_data.json must have "current" as an OS 2.0 JSON object, got ${typeof parsedData.current}!`,
    );
  }
  const defs = new Map();
  for (const group of parsedSchema) {
    for (const s of group.settings || []) {
      if (s.id) defs.set(s.id, s);
    }
  }
  validateSettingsObjectAgainstSchema(defs, parsedData.current, 'current', srcDir);
  if (parsedData.presets && typeof parsedData.presets === 'object') {
    for (const [presetName, presetObj] of Object.entries(parsedData.presets)) {
      validateSettingsObjectAgainstSchema(defs, presetObj, `presets.${presetName}`, srcDir);
    }
  }
  const activeObj = parsedData.current;
  const schemes = activeObj?.color_schemes || {};
  for (const reqScheme of ['scheme-1', 'scheme-2', 'scheme-3', 'scheme-4', 'scheme-5']) {
    if (!schemes[reqScheme]?.settings?.background) {
      throw new Error(`CRITICAL CONFIG ERROR (${srcDir}): Missing ${reqScheme} in config/settings_data.json!`);
    }
  }
  if (overrides?.edition) {
    if (activeObj.ubc_edition !== overrides.edition) {
      throw new Error(
        `CRITICAL CONFIG ERROR (${srcDir}): Expected current.ubc_edition="${overrides.edition}", got "${activeObj.ubc_edition}"!`,
      );
    }
    const themeLiquid = loaded.find((x) => x.rel === 'layout/theme.liquid');
    if (themeLiquid && !themeLiquid.data.toString('utf8').includes(`default: '${overrides.edition}'`)) {
      throw new Error(
        `CRITICAL CONFIG ERROR (${srcDir}): layout/theme.liquid missing default: '${overrides.edition}'!`,
      );
    }
  }
}

async function packDirectory(srcDir, outZipPath, overrides = null) {
  const entries = await collectFiles(srcDir);
  const loaded = await Promise.all(
    entries.map(async (e) => {
      let data = await readFile(e.full);
      if (overrides) {
        if (e.rel === 'config/settings_data.json' && overrides.edition) {
          const parsed = JSON.parse(data.toString('utf8'));
          // Guarantee OS 2.0 object format for `current` AND keep `presets.Dawn` synced
          if (typeof parsed.current === 'string' && parsed.presets?.[parsed.current]) {
            parsed.current = structuredClone(parsed.presets[parsed.current]);
          }
          if (typeof parsed.current === 'object' && parsed.current) {
            applySettingsPalette(parsed.current, overrides.edition);
          }
          if (parsed.presets?.Dawn) {
            applySettingsPalette(parsed.presets.Dawn, overrides.edition);
          }
          data = Buffer.from(JSON.stringify(parsed, null, 2) + '\n', 'utf8');
        } else if (e.rel === 'config/settings_schema.json') {
          const parsed = JSON.parse(data.toString('utf8'));
          if (Array.isArray(parsed)) {
            if (overrides.themeName && parsed[0] && parsed[0].theme_name) {
              parsed[0].theme_name = overrides.themeName;
            }
            if (overrides.themeVersion && parsed[0] && parsed[0].theme_version) {
              parsed[0].theme_version = overrides.themeVersion;
            }
            if (overrides.edition) {
              for (const group of parsed) {
                if (Array.isArray(group.settings)) {
                  for (const s of group.settings) {
                    if (s.id === 'ubc_edition') {
                      s.default = overrides.edition;
                    }
                  }
                }
              }
            }
          }
          data = Buffer.from(JSON.stringify(parsed, null, 2) + '\n', 'utf8');
        } else if (
          overrides.edition &&
          overrides.edition !== 'classic' &&
          (e.rel === 'layout/theme.liquid' || (e.rel.startsWith('sections/') && e.rel.endsWith('.liquid')))
        ) {
          // Bake seasonal edition as the native Liquid fallback so even missing/blank settings render the exact occasion
          const updated = data
            .toString('utf8')
            .replace(/default:\s*'classic'/g, `default: '${overrides.edition}'`);
          data = Buffer.from(updated, 'utf8');
        } else if (overrides.edition && e.rel === 'templates/index.json') {
          const parsed = JSON.parse(data.toString('utf8'));
          if (parsed?.sections?.hero_showcase?.settings && EDITION_HERO_EYEBROW[overrides.edition]) {
            parsed.sections.hero_showcase.settings.eyebrow = EDITION_HERO_EYEBROW[overrides.edition];
          }
          data = Buffer.from(JSON.stringify(parsed, null, 2) + '\n', 'utf8');
        } else if (overrides.edition && overrides.edition !== 'classic' && e.rel === 'assets/ubc-fable.js') {
          const updated = data
            .toString('utf8')
            .replace(/\|\|\s*'classic'/g, `|| '${overrides.edition}'`);
          data = Buffer.from(updated, 'utf8');
        }
      }
      return { rel: e.rel, data };
    }),
  );
  assertDawnConfigIntegrity(loaded, srcDir, overrides);
  const zipBuf = buildZip(loaded);
  const verifiedCount = verifyZipBuffer(zipBuf);
  await writeFile(outZipPath, zipBuf);
  const st = await stat(outZipPath);
  return { count: verifiedCount, bytes: st.size };
}

const root = process.cwd();
const outDir = resolve(root, 'build');
await mkdir(outDir, { recursive: true });

const themeZip = join(outDir, 'ubc-shopify-theme.zip');
const dawnKitZip = join(outDir, 'ubc-dawn-integration-kit.zip');
const dawnV10Zip = join(outDir, 'ubc-sobre-dawn-v10.zip');
const dawnBoutiqueV11Zip = join(outDir, 'ubc-boutique-dawn-v11.zip');
const dawnFableV12Zip = join(outDir, 'ubc-fable-dawn-v12.zip');
const dawnFableV13Zip = join(outDir, 'ubc-fable-dawn-v13.zip');
const dawnFableV14Zip = join(outDir, 'ubc-fable-dawn-v14.zip');
const dawnFableV15Zip = join(outDir, 'ubc-fable-dawn-v15.zip');
const dawnFableV16Zip = join(outDir, 'ubc-fable-dawn-v16.zip');
const dawnFableV17Zip = join(outDir, 'ubc-fable-dawn-v17.zip');
const dawnFableV18Zip = join(outDir, 'ubc-fable-dawn-v18.zip');
const dawnFableV19Zip = join(outDir, 'ubc-fable-dawn-v19.zip');
const dawnFableV20ClassicZip = join(outDir, 'ubc-fable-dawn-v20.zip');
const dawnFableV20BfZip = join(outDir, 'ubc-fable-dawn-v20-black-friday.zip');
const dawnFableV20XmasZip = join(outDir, 'ubc-fable-dawn-v20-christmas.zip');
const dawnFableV21ClassicZip = join(outDir, 'ubc-fable-dawn-v21.zip');
const dawnFableV21BfZip = join(outDir, 'ubc-fable-dawn-v21-black-friday.zip');
const dawnFableV21XmasZip = join(outDir, 'ubc-fable-dawn-v21-christmas.zip');
const dawnFableV21July4Zip = join(outDir, 'ubc-fable-dawn-v21-july-4.zip');
const dawnFableV22ClassicZip = join(outDir, 'ubc-fable-dawn-v22.zip');
const dawnFableV22BfZip = join(outDir, 'ubc-fable-dawn-v22-black-friday.zip');
const dawnFableV22XmasZip = join(outDir, 'ubc-fable-dawn-v22-christmas.zip');
const dawnFableV22July4Zip = join(outDir, 'ubc-fable-dawn-v22-july-4.zip');
const dawnFableV23ClassicZip = join(outDir, 'ubc-fable-dawn-v23.zip');
const dawnFableV23BfZip = join(outDir, 'ubc-fable-dawn-v23-black-friday.zip');
const dawnFableV23XmasZip = join(outDir, 'ubc-fable-dawn-v23-christmas.zip');
const dawnFableV23July4Zip = join(outDir, 'ubc-fable-dawn-v23-july-4.zip');
const dawnFableV24ClassicZip = join(outDir, 'ubc-fable-dawn-v24.zip');
const dawnFableV24BfZip = join(outDir, 'ubc-fable-dawn-v24-black-friday.zip');
const dawnFableV24XmasZip = join(outDir, 'ubc-fable-dawn-v24-christmas.zip');
const dawnFableV24July4Zip = join(outDir, 'ubc-fable-dawn-v24-july-4.zip');
const dawnFableV25ClassicZip = join(outDir, 'ubc-fable-dawn-v25.zip');
const dawnFableV25BfZip = join(outDir, 'ubc-fable-dawn-v25-black-friday.zip');
const dawnFableV25XmasZip = join(outDir, 'ubc-fable-dawn-v25-christmas.zip');
const dawnFableV25July4Zip = join(outDir, 'ubc-fable-dawn-v25-july-4.zip');
const dawnFableV26ClassicZip = join(outDir, 'ubc-fable-dawn-v26.zip');
const dawnFableV26BfZip = join(outDir, 'ubc-fable-dawn-v26-black-friday.zip');
const dawnFableV26XmasZip = join(outDir, 'ubc-fable-dawn-v26-christmas.zip');
const dawnFableV26July4Zip = join(outDir, 'ubc-fable-dawn-v26-july-4.zip');
const dawnFableV27ClassicZip = join(outDir, 'ubc-fable-dawn-v27.zip');
const dawnFableV27BfZip = join(outDir, 'ubc-fable-dawn-v27-black-friday.zip');
const dawnFableV27XmasZip = join(outDir, 'ubc-fable-dawn-v27-christmas.zip');
const dawnFableV27July4Zip = join(outDir, 'ubc-fable-dawn-v27-july-4.zip');
const dawnFableV28ClassicZip = join(outDir, 'ubc-fable-dawn-v28.zip');
const dawnFableV28BfZip = join(outDir, 'ubc-fable-dawn-v28-black-friday.zip');
const dawnFableV28XmasZip = join(outDir, 'ubc-fable-dawn-v28-christmas.zip');
const dawnFableV28July4Zip = join(outDir, 'ubc-fable-dawn-v28-july-4.zip');
const dawnFableV29ClassicZip = join(outDir, 'ubc-fable-dawn-v29.zip');
const dawnFableV29BfZip = join(outDir, 'ubc-fable-dawn-v29-black-friday.zip');
const dawnFableV29XmasZip = join(outDir, 'ubc-fable-dawn-v29-christmas.zip');
const dawnFableV29July4Zip = join(outDir, 'ubc-fable-dawn-v29-july-4.zip');
const dawnFableV30ClassicZip = join(outDir, 'ubc-fable-dawn-v30.zip');
const dawnFableV30SpringZip = join(outDir, 'ubc-fable-dawn-v30-spring.zip');
const dawnFableV30July4Zip = join(outDir, 'ubc-fable-dawn-v30-july-4.zip');
const dawnFableV30CampusZip = join(outDir, 'ubc-fable-dawn-v30-campus.zip');
const dawnFableV30BfZip = join(outDir, 'ubc-fable-dawn-v30-black-friday.zip');
const dawnFableV30XmasZip = join(outDir, 'ubc-fable-dawn-v30-christmas.zip');
const dawnFableV31ClassicZip = join(outDir, 'ubc-fable-dawn-v31.zip');
const dawnFableV31SpringZip = join(outDir, 'ubc-fable-dawn-v31-spring.zip');
const dawnFableV31July4Zip = join(outDir, 'ubc-fable-dawn-v31-july-4.zip');
const dawnFableV31CampusZip = join(outDir, 'ubc-fable-dawn-v31-campus.zip');
const dawnFableV31BfZip = join(outDir, 'ubc-fable-dawn-v31-black-friday.zip');
const dawnFableV31XmasZip = join(outDir, 'ubc-fable-dawn-v31-christmas.zip');
const dawnFableV32ClassicZip = join(outDir, 'ubc-fable-dawn-v32.zip');
const dawnFableV32SpringZip = join(outDir, 'ubc-fable-dawn-v32-spring.zip');
const dawnFableV32July4Zip = join(outDir, 'ubc-fable-dawn-v32-july-4.zip');
const dawnFableV32CampusZip = join(outDir, 'ubc-fable-dawn-v32-campus.zip');
const dawnFableV32VeteransZip = join(outDir, 'ubc-fable-dawn-v32-veterans.zip');
const dawnFableV32BfZip = join(outDir, 'ubc-fable-dawn-v32-black-friday.zip');
const dawnFableV32XmasZip = join(outDir, 'ubc-fable-dawn-v32-christmas.zip');
const dawnFableV33ClassicZip = join(outDir, 'ubc-fable-dawn-v33.zip');
const dawnFableV33SpringZip = join(outDir, 'ubc-fable-dawn-v33-spring.zip');
const dawnFableV33July4Zip = join(outDir, 'ubc-fable-dawn-v33-july-4.zip');
const dawnFableV33CampusZip = join(outDir, 'ubc-fable-dawn-v33-campus.zip');
const dawnFableV33VeteransZip = join(outDir, 'ubc-fable-dawn-v33-veterans.zip');
const dawnFableV33BfZip = join(outDir, 'ubc-fable-dawn-v33-black-friday.zip');
const dawnFableV33XmasZip = join(outDir, 'ubc-fable-dawn-v33-christmas.zip');
const dawnFableV34ClassicZip = join(outDir, 'ubc-fable-dawn-v34.zip');
const dawnFableV34SpringZip = join(outDir, 'ubc-fable-dawn-v34-spring.zip');
const dawnFableV34July4Zip = join(outDir, 'ubc-fable-dawn-v34-july-4.zip');
const dawnFableV34CampusZip = join(outDir, 'ubc-fable-dawn-v34-campus.zip');
const dawnFableV34VeteransZip = join(outDir, 'ubc-fable-dawn-v34-veterans.zip');
const dawnFableV34BfZip = join(outDir, 'ubc-fable-dawn-v34-black-friday.zip');
const dawnFableV34XmasZip = join(outDir, 'ubc-fable-dawn-v34-christmas.zip');

const r1 = await packDirectory(resolve(root, 'apps/shopify-theme'), themeZip);
const r2 = await packDirectory(resolve(root, 'dawn-integration'), dawnKitZip);
const r3 = await packDirectory(resolve(root, 'apps/dawn-ubc-theme'), dawnV10Zip);
const r4 = await packDirectory(resolve(root, 'apps/dawn-ubc-theme'), dawnBoutiqueV11Zip);
const r5 = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV12Zip);
const r6 = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV13Zip);
const r7 = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV14Zip);
const r8 = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV15Zip);
const r9 = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV16Zip);
const r10 = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV17Zip);
const r11 = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV18Zip);
const r12 = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV19Zip);
const r20Classic = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV20ClassicZip, {
  edition: 'classic',
  themeName: 'UBC Dawn v20 Classic',
});
const r20Bf = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV20BfZip, {
  edition: 'black_friday',
  themeName: 'UBC Dawn v20 BlackFriday',
});
const r20Xmas = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV20XmasZip, {
  edition: 'christmas',
  themeName: 'UBC Dawn v20 Christmas',
});
const r21Classic = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV21ClassicZip, {
  edition: 'classic',
  themeName: 'UBC Dawn v21 Classic',
});
const r21Bf = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV21BfZip, {
  edition: 'black_friday',
  themeName: 'UBC Dawn v21 BlackFriday',
});
const r21Xmas = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV21XmasZip, {
  edition: 'christmas',
  themeName: 'UBC Dawn v21 Christmas',
});
const r21July4 = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV21July4Zip, {
  edition: 'july_4',
  themeName: 'UBC Dawn v21 July4th',
});

const r22Classic = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV22ClassicZip, {
  edition: 'classic',
  themeName: 'UBC Dawn v22 Classic',
});
const r22Bf = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV22BfZip, {
  edition: 'black_friday',
  themeName: 'UBC Dawn v22 BlackFriday',
});
const r22Xmas = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV22XmasZip, {
  edition: 'christmas',
  themeName: 'UBC Dawn v22 Christmas',
});
const r22July4 = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV22July4Zip, {
  edition: 'july_4',
  themeName: 'UBC Dawn v22 July4th',
});

const r23Classic = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV23ClassicZip, {
  edition: 'classic',
  themeName: 'UBC Dawn v23 Classic',
});
const r23Bf = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV23BfZip, {
  edition: 'black_friday',
  themeName: 'UBC Dawn v23 BlackFriday',
});
const r23Xmas = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV23XmasZip, {
  edition: 'christmas',
  themeName: 'UBC Dawn v23 Christmas',
});
const r23July4 = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV23July4Zip, {
  edition: 'july_4',
  themeName: 'UBC Dawn v23 July4th',
});

const r24Classic = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV24ClassicZip, {
  edition: 'classic',
  themeName: 'UBC Dawn v24 Classic',
  themeVersion: '24.0.0',
});
const r24Bf = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV24BfZip, {
  edition: 'black_friday',
  themeName: 'UBC Dawn v24 BlackFriday',
  themeVersion: '24.0.0',
});
const r24Xmas = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV24XmasZip, {
  edition: 'christmas',
  themeName: 'UBC Dawn v24 Christmas',
  themeVersion: '24.0.0',
});
const r24July4 = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV24July4Zip, {
  edition: 'july_4',
  themeName: 'UBC Dawn v24 July4th',
  themeVersion: '24.0.0',
});

const r25Classic = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV25ClassicZip, {
  edition: 'classic',
  themeName: 'UBC Dawn v25 Classic',
  themeVersion: '25.0.0',
});
const r25Bf = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV25BfZip, {
  edition: 'black_friday',
  themeName: 'UBC Dawn v25 BlackFriday',
  themeVersion: '25.0.0',
});
const r25Xmas = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV25XmasZip, {
  edition: 'christmas',
  themeName: 'UBC Dawn v25 Christmas',
  themeVersion: '25.0.0',
});
const r25July4 = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV25July4Zip, {
  edition: 'july_4',
  themeName: 'UBC Dawn v25 July4th',
  themeVersion: '25.0.0',
});

const r26Classic = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV26ClassicZip, {
  edition: 'classic',
  themeName: 'UBC Dawn v26 Classic',
  themeVersion: '26.0.0',
});
const r26Bf = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV26BfZip, {
  edition: 'black_friday',
  themeName: 'UBC Dawn v26 BlackFriday',
  themeVersion: '26.0.0',
});
const r26Xmas = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV26XmasZip, {
  edition: 'christmas',
  themeName: 'UBC Dawn v26 Christmas',
  themeVersion: '26.0.0',
});
const r26July4 = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV26July4Zip, {
  edition: 'july_4',
  themeName: 'UBC Dawn v26 July4th',
  themeVersion: '26.0.0',
});

const r27Classic = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV27ClassicZip, {
  edition: 'classic',
  themeName: 'UBC Dawn v27 Classic',
  themeVersion: '27.0.0',
});
const r27Bf = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV27BfZip, {
  edition: 'black_friday',
  themeName: 'UBC Dawn v27 BlackFriday',
  themeVersion: '27.0.0',
});
const r27Xmas = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV27XmasZip, {
  edition: 'christmas',
  themeName: 'UBC Dawn v27 Christmas',
  themeVersion: '27.0.0',
});
const r27July4 = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV27July4Zip, {
  edition: 'july_4',
  themeName: 'UBC Dawn v27 July4th',
  themeVersion: '27.0.0',
});

const r28Classic = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV28ClassicZip, {
  edition: 'classic',
  themeName: 'UBC Dawn v28 Classic',
  themeVersion: '28.0.0',
});
const r28Bf = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV28BfZip, {
  edition: 'black_friday',
  themeName: 'UBC Dawn v28 BlackFriday',
  themeVersion: '28.0.0',
});
const r28Xmas = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV28XmasZip, {
  edition: 'christmas',
  themeName: 'UBC Dawn v28 Christmas',
  themeVersion: '28.0.0',
});
const r28July4 = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV28July4Zip, {
  edition: 'july_4',
  themeName: 'UBC Dawn v28 July4th',
  themeVersion: '28.0.0',
});

const r29Classic = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV29ClassicZip, {
  edition: 'classic',
  themeName: 'UBC Dawn v29 Classic',
  themeVersion: '29.0.0',
});
const r29Bf = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV29BfZip, {
  edition: 'black_friday',
  themeName: 'UBC Dawn v29 BlackFriday',
  themeVersion: '29.0.0',
});
const r29Xmas = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV29XmasZip, {
  edition: 'christmas',
  themeName: 'UBC Dawn v29 Christmas',
  themeVersion: '29.0.0',
});
const r29July4 = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV29July4Zip, {
  edition: 'july_4',
  themeName: 'UBC Dawn v29 July4th',
  themeVersion: '29.0.0',
});

const r30Classic = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV30ClassicZip, {
  edition: 'classic',
  themeName: 'UBC Dawn v30 Classic',
  themeVersion: '30.0.0',
});
const r30Spring = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV30SpringZip, {
  edition: 'spring',
  themeName: 'UBC Dawn v30 Spring',
  themeVersion: '30.0.0',
});
const r30July4 = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV30July4Zip, {
  edition: 'july_4',
  themeName: 'UBC Dawn v30 July4th',
  themeVersion: '30.0.0',
});
const r30Campus = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV30CampusZip, {
  edition: 'campus',
  themeName: 'UBC Dawn v30 USF Campus',
  themeVersion: '30.0.0',
});
const r30Bf = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV30BfZip, {
  edition: 'black_friday',
  themeName: 'UBC Dawn v30 BlackFriday',
  themeVersion: '30.0.0',
});
const r30Xmas = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV30XmasZip, {
  edition: 'christmas',
  themeName: 'UBC Dawn v30 Christmas',
  themeVersion: '30.0.0',
});

const r31Classic = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV31ClassicZip, {
  edition: 'classic',
  themeName: 'UBC Dawn v31 Classic',
  themeVersion: '31.0.0',
});
const r31Spring = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV31SpringZip, {
  edition: 'spring',
  themeName: 'UBC Dawn v31 Spring',
  themeVersion: '31.0.0',
});
const r31July4 = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV31July4Zip, {
  edition: 'july_4',
  themeName: 'UBC Dawn v31 July4th',
  themeVersion: '31.0.0',
});
const r31Campus = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV31CampusZip, {
  edition: 'campus',
  themeName: 'UBC Dawn v31 USF Campus',
  themeVersion: '31.0.0',
});
const r31Bf = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV31BfZip, {
  edition: 'black_friday',
  themeName: 'UBC Dawn v31 BlackFriday',
  themeVersion: '31.0.0',
});
const r31Xmas = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV31XmasZip, {
  edition: 'christmas',
  themeName: 'UBC Dawn v31 Christmas',
  themeVersion: '31.0.0',
});

const r32Classic = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV32ClassicZip, {
  edition: 'classic',
  themeName: 'UBC Dawn v32 Classic',
  themeVersion: '32.0.0',
});
const r32Spring = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV32SpringZip, {
  edition: 'spring',
  themeName: 'UBC Dawn v32 Spring',
  themeVersion: '32.0.0',
});
const r32July4 = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV32July4Zip, {
  edition: 'july_4',
  themeName: 'UBC Dawn v32 July4th',
  themeVersion: '32.0.0',
});
const r32Campus = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV32CampusZip, {
  edition: 'campus',
  themeName: 'UBC Dawn v32 USF Campus',
  themeVersion: '32.0.0',
});
const r32Veterans = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV32VeteransZip, {
  edition: 'veterans',
  themeName: 'UBC Dawn v32 Veterans',
  themeVersion: '32.0.0',
});
const r32Bf = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV32BfZip, {
  edition: 'black_friday',
  themeName: 'UBC Dawn v32 BlackFriday',
  themeVersion: '32.0.0',
});
const r32Xmas = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV32XmasZip, {
  edition: 'christmas',
  themeName: 'UBC Dawn v32 Christmas',
  themeVersion: '32.0.0',
});

const r33Classic = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV33ClassicZip, {
  edition: 'classic',
  themeName: 'UBC Dawn v33 Classic',
  themeVersion: '33.0.0',
});
const r33Spring = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV33SpringZip, {
  edition: 'spring',
  themeName: 'UBC Dawn v33 Spring',
  themeVersion: '33.0.0',
});
const r33July4 = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV33July4Zip, {
  edition: 'july_4',
  themeName: 'UBC Dawn v33 July4th',
  themeVersion: '33.0.0',
});
const r33Campus = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV33CampusZip, {
  edition: 'campus',
  themeName: 'UBC Dawn v33 USF Campus',
  themeVersion: '33.0.0',
});
const r33Veterans = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV33VeteransZip, {
  edition: 'veterans',
  themeName: 'UBC Dawn v33 Veterans',
  themeVersion: '33.0.0',
});
const r33Bf = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV33BfZip, {
  edition: 'black_friday',
  themeName: 'UBC Dawn v33 BlackFriday',
  themeVersion: '33.0.0',
});
const r33Xmas = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV33XmasZip, {
  edition: 'christmas',
  themeName: 'UBC Dawn v33 Christmas',
  themeVersion: '33.0.0',
});

const r34Classic = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV34ClassicZip, {
  edition: 'classic',
  themeName: 'UBC Dawn v34 Classic',
  themeVersion: '34.0.0',
});
const r34Spring = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV34SpringZip, {
  edition: 'spring',
  themeName: 'UBC Dawn v34 Spring',
  themeVersion: '34.0.0',
});
const r34July4 = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV34July4Zip, {
  edition: 'july_4',
  themeName: 'UBC Dawn v34 July4th',
  themeVersion: '34.0.0',
});
const r34Campus = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV34CampusZip, {
  edition: 'campus',
  themeName: 'UBC Dawn v34 USF Campus',
  themeVersion: '34.0.0',
});
const r34Veterans = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV34VeteransZip, {
  edition: 'veterans',
  themeName: 'UBC Dawn v34 Veterans',
  themeVersion: '34.0.0',
});
const r34Bf = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV34BfZip, {
  edition: 'black_friday',
  themeName: 'UBC Dawn v34 BlackFriday',
  themeVersion: '34.0.0',
});
const r34Xmas = await packDirectory(resolve(root, 'apps/dawn-ubc-fable-theme'), dawnFableV34XmasZip, {
  edition: 'christmas',
  themeName: 'UBC Dawn v34 Christmas',
  themeVersion: '34.0.0',
});

console.log(`Packed & Verified UBC Dawn v34 Classic     : ${dawnFableV34ClassicZip} (${r34Classic.count} files, ${(r34Classic.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v34 Spring      : ${dawnFableV34SpringZip} (${r34Spring.count} files, ${(r34Spring.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v34 July 4th    : ${dawnFableV34July4Zip} (${r34July4.count} files, ${(r34July4.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v34 USF Campus  : ${dawnFableV34CampusZip} (${r34Campus.count} files, ${(r34Campus.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v34 Veterans    : ${dawnFableV34VeteransZip} (${r34Veterans.count} files, ${(r34Veterans.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v34 BlackFriday : ${dawnFableV34BfZip} (${r34Bf.count} files, ${(r34Bf.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v34 Christmas   : ${dawnFableV34XmasZip} (${r34Xmas.count} files, ${(r34Xmas.bytes / 1024).toFixed(1)} KB)`);

console.log(`Packed & Verified UBC Dawn v33 Classic     : ${dawnFableV33ClassicZip} (${r33Classic.count} files, ${(r33Classic.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v33 Spring      : ${dawnFableV33SpringZip} (${r33Spring.count} files, ${(r33Spring.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v33 July 4th    : ${dawnFableV33July4Zip} (${r33July4.count} files, ${(r33July4.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v33 USF Campus  : ${dawnFableV33CampusZip} (${r33Campus.count} files, ${(r33Campus.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v33 Veterans    : ${dawnFableV33VeteransZip} (${r33Veterans.count} files, ${(r33Veterans.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v33 BlackFriday : ${dawnFableV33BfZip} (${r33Bf.count} files, ${(r33Bf.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v33 Christmas   : ${dawnFableV33XmasZip} (${r33Xmas.count} files, ${(r33Xmas.bytes / 1024).toFixed(1)} KB)`);

console.log(`Packed & Verified UBC Dawn v32 Classic     : ${dawnFableV32ClassicZip} (${r32Classic.count} files, ${(r32Classic.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v32 Spring      : ${dawnFableV32SpringZip} (${r32Spring.count} files, ${(r32Spring.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v32 July 4th    : ${dawnFableV32July4Zip} (${r32July4.count} files, ${(r32July4.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v32 USF Campus  : ${dawnFableV32CampusZip} (${r32Campus.count} files, ${(r32Campus.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v32 Veterans    : ${dawnFableV32VeteransZip} (${r32Veterans.count} files, ${(r32Veterans.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v32 BlackFriday : ${dawnFableV32BfZip} (${r32Bf.count} files, ${(r32Bf.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v32 Christmas   : ${dawnFableV32XmasZip} (${r32Xmas.count} files, ${(r32Xmas.bytes / 1024).toFixed(1)} KB)`);

console.log(`Packed & Verified UBC Dawn v31 Classic     : ${dawnFableV31ClassicZip} (${r31Classic.count} files, ${(r31Classic.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v31 Spring      : ${dawnFableV31SpringZip} (${r31Spring.count} files, ${(r31Spring.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v31 July 4th    : ${dawnFableV31July4Zip} (${r31July4.count} files, ${(r31July4.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v31 USF Campus  : ${dawnFableV31CampusZip} (${r31Campus.count} files, ${(r31Campus.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v31 BlackFriday : ${dawnFableV31BfZip} (${r31Bf.count} files, ${(r31Bf.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v31 Christmas   : ${dawnFableV31XmasZip} (${r31Xmas.count} files, ${(r31Xmas.bytes / 1024).toFixed(1)} KB)`);

console.log(`Packed & Verified UBC Dawn v30 Classic     : ${dawnFableV30ClassicZip} (${r30Classic.count} files, ${(r30Classic.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v30 Spring      : ${dawnFableV30SpringZip} (${r30Spring.count} files, ${(r30Spring.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v30 July 4th    : ${dawnFableV30July4Zip} (${r30July4.count} files, ${(r30July4.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v30 USF Campus  : ${dawnFableV30CampusZip} (${r30Campus.count} files, ${(r30Campus.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v30 BlackFriday : ${dawnFableV30BfZip} (${r30Bf.count} files, ${(r30Bf.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v30 Christmas   : ${dawnFableV30XmasZip} (${r30Xmas.count} files, ${(r30Xmas.bytes / 1024).toFixed(1)} KB)`);

console.log(`Packed & Verified UBC Dawn v29 Classic     : ${dawnFableV29ClassicZip} (${r29Classic.count} files, ${(r29Classic.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v29 BlackFriday : ${dawnFableV29BfZip} (${r29Bf.count} files, ${(r29Bf.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v29 Christmas   : ${dawnFableV29XmasZip} (${r29Xmas.count} files, ${(r29Xmas.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v29 July 4th    : ${dawnFableV29July4Zip} (${r29July4.count} files, ${(r29July4.bytes / 1024).toFixed(1)} KB)`);

console.log(`Packed & Verified UBC Dawn v28 Classic     : ${dawnFableV28ClassicZip} (${r28Classic.count} files, ${(r28Classic.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v28 BlackFriday : ${dawnFableV28BfZip} (${r28Bf.count} files, ${(r28Bf.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v28 Christmas   : ${dawnFableV28XmasZip} (${r28Xmas.count} files, ${(r28Xmas.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v28 July 4th    : ${dawnFableV28July4Zip} (${r28July4.count} files, ${(r28July4.bytes / 1024).toFixed(1)} KB)`);

console.log(`Packed & Verified UBC Dawn v27 Classic     : ${dawnFableV27ClassicZip} (${r27Classic.count} files, ${(r27Classic.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v27 BlackFriday : ${dawnFableV27BfZip} (${r27Bf.count} files, ${(r27Bf.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v27 Christmas   : ${dawnFableV27XmasZip} (${r27Xmas.count} files, ${(r27Xmas.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v27 July 4th    : ${dawnFableV27July4Zip} (${r27July4.count} files, ${(r27July4.bytes / 1024).toFixed(1)} KB)`);

console.log(`Packed & Verified UBC Dawn v26 Classic     : ${dawnFableV26ClassicZip} (${r26Classic.count} files, ${(r26Classic.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v26 BlackFriday : ${dawnFableV26BfZip} (${r26Bf.count} files, ${(r26Bf.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v26 Christmas   : ${dawnFableV26XmasZip} (${r26Xmas.count} files, ${(r26Xmas.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v26 July 4th    : ${dawnFableV26July4Zip} (${r26July4.count} files, ${(r26July4.bytes / 1024).toFixed(1)} KB)`);

console.log(`Packed & Verified UBC Dawn v25 Classic     : ${dawnFableV25ClassicZip} (${r25Classic.count} files, ${(r25Classic.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v25 BlackFriday : ${dawnFableV25BfZip} (${r25Bf.count} files, ${(r25Bf.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v25 Christmas   : ${dawnFableV25XmasZip} (${r25Xmas.count} files, ${(r25Xmas.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v25 July 4th    : ${dawnFableV25July4Zip} (${r25July4.count} files, ${(r25July4.bytes / 1024).toFixed(1)} KB)`);

console.log(`Packed & Verified UBC Dawn v24 Classic     : ${dawnFableV24ClassicZip} (${r24Classic.count} files, ${(r24Classic.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v24 BlackFriday : ${dawnFableV24BfZip} (${r24Bf.count} files, ${(r24Bf.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v24 Christmas   : ${dawnFableV24XmasZip} (${r24Xmas.count} files, ${(r24Xmas.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v24 July 4th    : ${dawnFableV24July4Zip} (${r24July4.count} files, ${(r24July4.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v23 Classic     : ${dawnFableV23ClassicZip} (${r23Classic.count} files, ${(r23Classic.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v23 BlackFriday : ${dawnFableV23BfZip} (${r23Bf.count} files, ${(r23Bf.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v23 Christmas   : ${dawnFableV23XmasZip} (${r23Xmas.count} files, ${(r23Xmas.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v23 July 4th    : ${dawnFableV23July4Zip} (${r23July4.count} files, ${(r23July4.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v22 Classic     : ${dawnFableV22ClassicZip} (${r22Classic.count} files, ${(r22Classic.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v22 BlackFriday : ${dawnFableV22BfZip} (${r22Bf.count} files, ${(r22Bf.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v22 Christmas   : ${dawnFableV22XmasZip} (${r22Xmas.count} files, ${(r22Xmas.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v22 July 4th    : ${dawnFableV22July4Zip} (${r22July4.count} files, ${(r22July4.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v21 Classic     : ${dawnFableV21ClassicZip} (${r21Classic.count} files, ${(r21Classic.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v21 BlackFriday : ${dawnFableV21BfZip} (${r21Bf.count} files, ${(r21Bf.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v21 Christmas   : ${dawnFableV21XmasZip} (${r21Xmas.count} files, ${(r21Xmas.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v21 July 4th    : ${dawnFableV21July4Zip} (${r21July4.count} files, ${(r21July4.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v20 Classic     : ${dawnFableV20ClassicZip} (${r20Classic.count} files, ${(r20Classic.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v20 BlackFriday : ${dawnFableV20BfZip} (${r20Bf.count} files, ${(r20Bf.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn v20 Christmas   : ${dawnFableV20XmasZip} (${r20Xmas.count} files, ${(r20Xmas.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn Ecommerce v19   : ${dawnFableV19Zip} (${r12.count} files, ${(r12.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn Ecommerce v18: ${dawnFableV18Zip} (${r11.count} files, ${(r11.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn Ecommerce v17: ${dawnFableV17Zip} (${r10.count} files, ${(r10.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn Ecommerce v16: ${dawnFableV16Zip} (${r9.count} files, ${(r9.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn Ecommerce v15: ${dawnFableV15Zip} (${r8.count} files, ${(r8.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Dawn Ecommerce v14: ${dawnFableV14Zip} (${r7.count} files, ${(r7.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Fable Dawn v13    : ${dawnFableV13Zip} (${r6.count} files, ${(r6.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Fable Dawn v12    : ${dawnFableV12Zip} (${r5.count} files, ${(r5.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC Boutique Dawn v11 : ${dawnBoutiqueV11Zip} (${r4.count} files, ${(r4.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified UBC sobre Dawn v10    : ${dawnV10Zip} (${r3.count} files, ${(r3.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified standalone OS 2.0     : ${themeZip} (${r1.count} files, ${(r1.bytes / 1024).toFixed(1)} KB)`);
console.log(`Packed & Verified Dawn integration kit  : ${dawnKitZip} (${r2.count} files, ${(r2.bytes / 1024).toFixed(1)} KB)`);
