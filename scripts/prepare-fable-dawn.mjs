// Prepares `apps/dawn-ubc-fable-theme` on top of Shopify Dawn 16.1.1 + UBC Commerce Hub core,
// copying official UBC brand assets from `C:/Users/PMC/Downloads/Flyers/Fable/site/assets`
// and self-hosting Fable's typography (Anton, Barlow Condensed, Barlow) + studio cutouts
// so Shopify Theme Check passes with 0 RemoteAsset / schema errors.
import { cp, mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const srcDawn = resolve(root, 'apps/dawn-ubc-theme');
const destFable = resolve(root, 'apps/dawn-ubc-fable-theme');
const fableSiteAssets = 'C:/Users/PMC/Downloads/Flyers/Fable/site/assets';

console.log('1. Cloning Dawn 16.1.1 + UBC Commerce Hub base into apps/dawn-ubc-fable-theme...');
await rm(destFable, { recursive: true, force: true });
await cp(srcDawn, destFable, { recursive: true });

// Remove v11 boutique-only files so Fable theme stays clean and purpose-built
const boutiqueFiles = [
  'assets/ubc-boutique.css',
  'assets/ubc-boutique.js',
  'sections/ubc-boutique-hero.liquid',
  'sections/ubc-argon-stage.liquid',
  'sections/ubc-parts-tech.liquid',
  'sections/ubc-shop-spotlight.liquid',
  'sections/ubc-promo-cards.liquid',
  'sections/ubc-workshop-pill.liquid',
  'sections/ubc-footer-boutique.liquid',
];
for (const rel of boutiqueFiles) {
  const p = join(destFable, rel);
  if (existsSync(p)) await unlink(p);
}

const destAssets = join(destFable, 'assets');
await mkdir(destAssets, { recursive: true });

console.log('2. Copying official UBC Fable brand assets...');
const localAssetMap = {
  'badge-gold.png': 'fable-badge-gold.png',
  'badge-navy-gold.png': 'fable-badge-navy-gold.png',
  'favicon.png': 'fable-favicon.png',
  'icon-gold.png': 'fable-icon-gold.png',
  'icon-navy.png': 'fable-icon-navy.png',
  'logo-black.png': 'fable-logo-black.png',
  'logo-navy.png': 'fable-logo-navy.png',
  'logo-white.png': 'fable-logo-white.png',
  'pattern.jpg': 'fable-pattern.jpg',
};
for (const [srcName, dstName] of Object.entries(localAssetMap)) {
  const srcPath = join(fableSiteAssets, srcName);
  if (existsSync(srcPath)) {
    await cp(srcPath, join(destAssets, dstName));
  }
}

async function fetchToAsset(url, outName, headers = {}) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0', ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(join(destAssets, outName), buf);
    console.log(`  + Saved ${outName} (${(buf.length / 1024).toFixed(1)} KB)`);
    return true;
  } catch (err) {
    console.warn(`  ! Skipped ${outName}: ${err.message}`);
    return false;
  }
}

console.log('3. Self-hosting Anton, Barlow Condensed, and Barlow woff2 fonts...');
const googleCssUrl = 'https://fonts.googleapis.com/css2?family=Anton&family=Barlow+Condensed:wght@600;700&family=Barlow:wght@400;500;600;700&display=swap';
try {
  const cssRes = await fetch(googleCssUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    },
  });
  const cssText = await cssRes.text();
  // Extract latin blocks
  const blocks = cssText.split('/*');
  const wanted = [
    { family: 'Anton', weight: '400', file: 'fable-anton-400.woff2' },
    { family: 'Barlow Condensed', weight: '600', file: 'fable-barlow-condensed-600.woff2' },
    { family: 'Barlow Condensed', weight: '700', file: 'fable-barlow-condensed-700.woff2' },
    { family: 'Barlow', weight: '400', file: 'fable-barlow-400.woff2' },
    { family: 'Barlow', weight: '500', file: 'fable-barlow-500.woff2' },
    { family: 'Barlow', weight: '600', file: 'fable-barlow-600.woff2' },
    { family: 'Barlow', weight: '700', file: 'fable-barlow-700.woff2' },
  ];
  for (const w of wanted) {
    const matchingBlock = blocks.find(
      (b) =>
        b.startsWith(' latin */') &&
        b.includes(`font-family: '${w.family}'`) &&
        b.includes(`font-weight: ${w.weight}`),
    );
    const urlMatch = matchingBlock && matchingBlock.match(/url\((https:\/\/[^)]+\.woff2)\)/);
    if (urlMatch) {
      await fetchToAsset(urlMatch[1], w.file);
    }
  }
} catch (err) {
  console.warn('Google Fonts fetch warning:', err.message);
}

console.log('4. Caching Fable reference studio images locally into Shopify theme assets...');
const studioImages = [
  ['https://www.sefiles.net/images/library/zoom/specialized-tarmac-sl9-comp-axs-1262103-1.png', 'fable-bike-tarmac.png'],
  ['https://www.sefiles.net/images/library/large/specialized-rockhopper-1243763-1.png', 'fable-bike-rockhopper.png'],
  ['https://www.sefiles.net/images/library/large/specialized-sirrus-x-2.0-1248847-1.png', 'fable-bike-sirrus.png'],
  ['https://www.sefiles.net/images/library/large/specialized-roll-2.0-low-entry-1244447-14.png', 'fable-bike-roll.png'],
  ['https://www.sefiles.net/images/library/large/specialized-allez-comp-1242748-14.png', 'fable-bike-allez.png'],
  ['https://www.sefiles.net/images/library/large/giro-agilis-mips-1251892-1.png', 'fable-gear-agilis.png'],
  ['https://www.sefiles.net/images/library/site/ETSC3859_edit2-slimC.jpg', 'fable-ebike-tile.jpg'],
  ['https://www.sefiles.net/images/library/site/VideoPlaceholder_vala25.jpg', 'fable-vala-poster.jpg'],
];
for (const [url, file] of studioImages) {
  await fetchToAsset(url, file);
}

console.log('5. Verifying config/settings_schema.json (>= 38 KB) & config/settings_data.json (scheme-1..scheme-5)...');
const schemaPath = join(destFable, 'config', 'settings_schema.json');
const dataPath = join(destFable, 'config', 'settings_data.json');
const schemaSt = await stat(schemaPath);
if (schemaSt.size < 38000) {
  throw new Error(`CRITICAL: ${schemaPath} is only ${schemaSt.size} bytes (< 38 KB)!`);
}
const dataJson = JSON.parse(await readFile(dataPath, 'utf8'));
const activeData = typeof dataJson.current === 'object' && dataJson.current ? dataJson.current : dataJson.presets?.[dataJson.current];
for (const sc of ['scheme-1', 'scheme-2', 'scheme-3', 'scheme-4', 'scheme-5']) {
  if (!activeData?.color_schemes?.[sc]?.settings?.background) {
    throw new Error(`CRITICAL: ${dataPath} is missing ${sc}!`);
  }
}

console.log(`Done preparing apps/dawn-ubc-fable-theme base! (settings_schema.json: ${(schemaSt.size / 1024).toFixed(1)} KB)`);
