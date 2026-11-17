/**
 * Safely uploads `UBC Dawn v34 — Propuesta 7 Temporadas` strictly as an UNPUBLISHED draft theme
 * into Carlos's Shopify store (`z5wxyn-uc.myshopify.com` / `ubcbike.myshopify.com`).
 *
 * Strict safety guarantees:
 *  - NEVER calls `themePublish`! Verifies before & after that `workstand-theme` stays MAIN.
 *  - NEVER modifies products, prices, inventory, collections, menus, or pages.
 *  - Applies latest `ubc-fable.css`, `ubc-fable.js`, `ubc-brand.css`, `fable-bike-finder.liquid`,
 *    and `fable-new-arrivals.liquid` strictly to the new UNPUBLISHED theme ID.
 */
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const shop = process.env.UBC_LIVE_SHOPIFY_DOMAIN || 'z5wxyn-uc.myshopify.com';
const accessToken = process.env.UBC_LIVE_SHOPIFY_ACCESS_TOKEN;

if (!accessToken) {
  throw new Error('Missing UBC_LIVE_SHOPIFY_ACCESS_TOKEN in .env');
}

const DRAFT_THEME_NAME = 'UBC Dawn v34 — Propuesta 7 Temporadas';

async function gql(query, variables = {}) {
  const res = await fetch(`https://${shop}/admin/api/2026-10/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`GraphQL Error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

async function stageAndUploadZip(zipPath, filename) {
  const buf = await readFile(zipPath);
  const st = await stat(zipPath);

  const staged = await gql(
    `mutation($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }`,
    {
      input: [
        {
          resource: 'FILE',
          filename,
          mimeType: 'application/zip',
          httpMethod: 'POST',
          fileSize: String(st.size),
        },
      ],
    },
  );

  const errs = staged.stagedUploadsCreate.userErrors;
  if (errs?.length) {
    throw new Error(`stagedUploadsCreate failed: ${JSON.stringify(errs)}`);
  }

  const target = staged.stagedUploadsCreate.stagedTargets[0];
  const form = new FormData();
  for (const p of target.parameters) {
    form.append(p.name, p.value);
  }
  form.append('file', new Blob([buf], { type: 'application/zip' }), filename);

  const upRes = await fetch(target.url, { method: 'POST', body: form });
  if (!upRes.ok && upRes.status !== 201 && upRes.status !== 204) {
    const body = await upRes.text();
    throw new Error(`GCS upload failed (${upRes.status}): ${body.slice(0, 400)}`);
  }
  return target.resourceUrl;
}

async function waitForThemeReady(themeGid) {
  for (let i = 0; i < 60; i++) {
    const d = await gql(
      `query($id: ID!) {
        theme(id: $id) { id name role processing }
      }`,
      { id: themeGid },
    );
    if (!d.theme) throw new Error(`Theme ${themeGid} not found during processing`);
    if (!d.theme.processing) return d.theme;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for theme ${themeGid} to finish processing`);
}

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('  Subida Segura de Tema en Borrador (UNPUBLISHED) -> Tienda de Carlos');
  console.log('══════════════════════════════════════════════════════════════════════\n');

  // 1. Check existing themes & record current MAIN theme
  const beforeData = await gql(`query { themes(first: 25) { nodes { id name role } } shop { primaryDomain { url } } }`);
  const themesBefore = beforeData.themes.nodes;
  const mainBefore = themesBefore.find((t) => t.role === 'MAIN');
  console.log(`✓ Tema publicado actual (MAIN intacto): ${mainBefore?.name} (${mainBefore?.id})`);

  let draftTheme =
    themesBefore.find((t) => t.role === 'UNPUBLISHED' && t.id === 'gid://shopify/OnlineStoreTheme/194100855101') ||
    themesBefore.find((t) => t.role === 'UNPUBLISHED' && /ubc dawn v34/i.test(t.name));

  // Clean up any accidental duplicate draft copy if 194100855101 already exists
  const dupTheme = themesBefore.find(
    (t) => t.role === 'UNPUBLISHED' && draftTheme && t.id !== draftTheme.id && t.name === DRAFT_THEME_NAME,
  );
  if (dupTheme) {
    console.log(`Limpiando copia duplicada en borrador: ${dupTheme.name} (${dupTheme.id})...`);
    await gql(`mutation($id: ID!) { themeDelete(id: $id) { deletedThemeId userErrors { message } } }`, { id: dupTheme.id });
  }

  if (!draftTheme) {
    const zipPath = resolve(process.cwd(), 'build', 'ubc-fable-dawn-v34.zip');
    console.log(`\nSubiendo paquete ${zipPath}...`);
    const resourceUrl = await stageAndUploadZip(zipPath, 'ubc-fable-dawn-v34.zip');
    console.log(`Creando tema borrador (role: UNPUBLISHED) "${DRAFT_THEME_NAME}"...`);

    const created = await gql(
      `mutation($name: String!, $source: URL!) {
        themeCreate(name: $name, source: $source, role: UNPUBLISHED) {
          theme { id name role processing }
          userErrors { field message }
        }
      }`,
      { name: DRAFT_THEME_NAME, source: resourceUrl },
    );

    if (created.themeCreate.userErrors?.length) {
      throw new Error(`themeCreate failed: ${JSON.stringify(created.themeCreate.userErrors)}`);
    }
    draftTheme = await waitForThemeReady(created.themeCreate.theme.id);
    console.log(`✓ Tema borrador procesado: ${draftTheme.name} (${draftTheme.id}, role=${draftTheme.role})`);
  } else {
    console.log(`✓ Tema borrador ya existente encontrado: ${draftTheme.id} (role=${draftTheme.role})`);
  }

  // 2. Apply latest polished files strictly to this UNPUBLISHED draft theme
  const themeRoot = resolve(process.cwd(), 'apps', 'dawn-ubc-fable-theme');
  const filesToSync = [
    'assets/ubc-fable.css',
    'assets/ubc-fable.js',
    'assets/ubc-brand.css',
    'sections/fable-bike-finder.liquid',
    'sections/fable-new-arrivals.liquid',
    'sections/fable-header.liquid',
    'sections/main-collection-product-grid.liquid',
    'snippets/card-product.liquid',
    'snippets/ubc-availability.liquid',
  ];

  const filesPayload = [];
  for (const rel of filesToSync) {
    const bodyText = await readFile(resolve(themeRoot, rel), 'utf8');
    filesPayload.push({
      filename: rel,
      body: { type: 'TEXT', value: bodyText },
    });
  }

  console.log(`Sincronizando los 5 archivos pulidos (Spring fix, escala óptica, enlaces reales) en ${draftTheme.id}...`);
  const upsertRes = await gql(
    `mutation($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
      themeFilesUpsert(themeId: $themeId, files: $files) {
        upsertedThemeFiles { filename }
        userErrors { filename message }
      }
    }`,
    { themeId: draftTheme.id, files: filesPayload },
  );

  if (upsertRes.themeFilesUpsert.userErrors?.length) {
    throw new Error(`themeFilesUpsert errors: ${JSON.stringify(upsertRes.themeFilesUpsert.userErrors)}`);
  }

  // 3. Re-verify MAIN theme was NOT changed!
  const afterData = await gql(`query($id: ID!) { themes(first: 25) { nodes { id name role } } theme(id: $id) { id name role } }`, {
    id: draftTheme.id,
  });
  const mainAfter = afterData.themes.nodes.find((t) => t.role === 'MAIN');
  if (mainAfter?.id !== mainBefore?.id || afterData.theme?.role !== 'UNPUBLISHED') {
    throw new Error('Safety assertion failed: MAIN/UNPUBLISHED state unexpected!');
  }

  const numericId = draftTheme.id.split('/').pop();
  const storeSlug = shop.replace(/\.myshopify\.com$/i, '');
  const primaryUrl = beforeData.shop?.primaryDomain?.url || `https://${shop}`;

  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`  ✓ LISTO Y VERIFICADO — TEMA BORRADOR INSTALADO EN TIENDA DE CARLOS`);
  console.log(`══════════════════════════════════════════════════════════════════════`);
  console.log(`  Tema MAIN de Carlos (INTACTO) : ${mainAfter.name} (${mainAfter.id})`);
  console.log(`  Nuevo Tema en Borrador        : ${afterData.theme.name} (role: ${afterData.theme.role})`);
  console.log(`  Preview Link Directo          : ${primaryUrl}/?preview_theme_id=${numericId}`);
  console.log(`  Editor Shopify Admin          : https://admin.shopify.com/store/${storeSlug}/themes/${numericId}/editor`);
  console.log(`══════════════════════════════════════════════════════════════════════\n`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
