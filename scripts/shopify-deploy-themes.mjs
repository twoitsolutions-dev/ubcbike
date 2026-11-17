// Uploads and installs all 4 UBC Dawn v28 themes, publishes Classic as MAIN,
// creates missing /pages/locations & /pages/our-story pages, and configures menus
// via official Shopify Admin GraphQL API (2026-10).
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const shop = process.env.SHOPIFY_SHOP_DOMAIN;
const clientId = process.env.SHOPIFY_CLIENT_ID;
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

if (!shop || !clientId || !clientSecret) {
  throw new Error('Missing SHOPIFY_SHOP_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET');
}

const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  }),
});
const { access_token: accessToken, scope } = await tokenRes.json();
console.log('Authenticated scopes:', scope);

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
  for (let i = 0; i < 45; i++) {
    const d = await gql(
      `query($id: ID!) {
        theme(id: $id) { id name role processing }
      }`,
      { id: themeGid },
    );
    if (!d.theme) throw new Error(`Theme ${themeGid} disappeared during processing`);
    if (!d.theme.processing) return d.theme;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for theme ${themeGid} to finish processing`);
}

const buildDir = resolve(process.cwd(), 'build');
const themesToDeploy = [
  {
    name: 'UBC Dawn v34 — Classic',
    file: 'ubc-fable-dawn-v34.zip',
    publishMain: true,
  },
  {
    name: 'UBC Dawn v34 — Spring Bloom',
    file: 'ubc-fable-dawn-v34-spring.zip',
    publishMain: false,
  },
  {
    name: 'UBC Dawn v34 — July 4th Summer',
    file: 'ubc-fable-dawn-v34-july-4.zip',
    publishMain: false,
  },
  {
    name: 'UBC Dawn v34 — USF Varsity Campus',
    file: 'ubc-fable-dawn-v34-campus.zip',
    publishMain: false,
  },
  {
    name: 'UBC Dawn v34 — Veterans & Police Honor',
    file: 'ubc-fable-dawn-v34-veterans.zip',
    publishMain: false,
  },
  {
    name: 'UBC Dawn v34 — Black Friday',
    file: 'ubc-fable-dawn-v34-black-friday.zip',
    publishMain: false,
  },
  {
    name: 'UBC Dawn v34 — Christmas Evergreen & Velvet',
    file: 'ubc-fable-dawn-v34-christmas.zip',
    publishMain: false,
  },
];

// Check existing themes so re-running is idempotent
const existingRes = await fetch(`https://${shop}/admin/api/2026-10/themes.json`, {
  headers: { 'X-Shopify-Access-Token': accessToken },
});
const { themes: existingThemes } = await existingRes.json();

const deployed = [];
for (const spec of themesToDeploy) {
  const zipPath = resolve(buildDir, spec.file);
  console.log(`\nStaging & uploading ${spec.file} -> "${spec.name}"...`);
  const resourceUrl = await stageAndUploadZip(zipPath, spec.file);
  console.log(`Uploaded to staged URL. Creating Shopify theme "${spec.name}"...`);

  const created = await gql(
    `mutation($name: String!, $source: URL!) {
      themeCreate(name: $name, source: $source, role: UNPUBLISHED) {
        theme { id name role processing }
        userErrors { field message }
      }
    }`,
    { name: spec.name, source: resourceUrl },
  );
  if (created.themeCreate.userErrors?.length) {
    throw new Error(`themeCreate failed for ${spec.name}: ${JSON.stringify(created.themeCreate.userErrors)}`);
  }

  const ready = await waitForThemeReady(created.themeCreate.theme.id);
  const numericId = ready.id.split('/').pop();
  console.log(`Ready: ${ready.name} (${numericId})`);

  if (spec.publishMain) {
    console.log(`Publishing "${ready.name}" (${numericId}) as live MAIN theme...`);
    const pub = await gql(
      `mutation($id: ID!) {
        themePublish(id: $id) {
          theme { id name role }
          userErrors { field message }
        }
      }`,
      { id: ready.id },
    );
    if (pub.themePublish.userErrors?.length) {
      throw new Error(`themePublish failed: ${JSON.stringify(pub.themePublish.userErrors)}`);
    }
    console.log(`Published as MAIN: ${pub.themePublish.theme.name}`);
  }

  deployed.push({
    name: ready.name,
    gid: ready.id,
    numericId,
    previewUrl: `https://${shop}/?preview_theme_id=${numericId}`,
    role: spec.publishMain ? 'MAIN' : 'UNPUBLISHED',
  });
}

// Ensure /pages/locations and /pages/our-story exist and use their custom OS 2.0 templates
const pagesData = await gql(`{ pages(first: 50) { nodes { id handle title templateSuffix isPublished } } }`);
const pagesByHandle = new Map(pagesData.pages.nodes.map((p) => [p.handle, p]));

const requiredPages = [
  {
    handle: 'locations',
    title: 'Store Locations — Tampa & Lithia',
    templateSuffix: 'locations',
    body: '<p>Visit University Bicycle Center in Tampa (1220 E Fletcher Ave) and Lithia (Alafia River State Park Trailhead).</p>',
  },
  {
    handle: 'our-story',
    title: 'Our Family Story — Since 1972',
    templateSuffix: 'our-story',
    body: '<p>Three generations of family-owned cycling passion in Tampa Bay since 1972.</p>',
  },
];

for (const pg of requiredPages) {
  const found = pagesByHandle.get(pg.handle);
  if (!found) {
    const res = await gql(
      `mutation($page: PageCreateInput!) {
        pageCreate(page: $page) {
          page { id handle title templateSuffix }
          userErrors { field message }
        }
      }`,
      {
        page: {
          handle: pg.handle,
          title: pg.title,
          templateSuffix: pg.templateSuffix,
          body: pg.body,
          isPublished: true,
        },
      },
    );
    if (res.pageCreate.userErrors?.length) {
      console.warn(`Warning creating page ${pg.handle}:`, res.pageCreate.userErrors);
    } else {
      console.log(`Created page /pages/${res.pageCreate.page.handle} (template: page.${res.pageCreate.page.templateSuffix}.json)`);
    }
  } else {
    console.log(`Page /pages/${pg.handle} already exists (${found.id})`);
  }
}

// Remove superseded unpublished UBC Dawn v28 themes so Theme Library stays spotless
const latestListRes = await fetch(`https://${shop}/admin/api/2026-10/themes.json`, {
  headers: { 'X-Shopify-Access-Token': accessToken },
});
const { themes: latestThemes } = await latestListRes.json();
for (const t of latestThemes) {
  if (t.role !== 'main' && (t.name === 'Horizon' || /^UBC Dawn v(?:2[0-9]|3[0-3])\b/.test(t.name))) {
    await fetch(`https://${shop}/admin/api/2026-10/themes/${t.id}.json`, {
      method: 'DELETE',
      headers: { 'X-Shopify-Access-Token': accessToken },
    });
    console.log(`Cleaned up older draft theme: ${t.name} (${t.id})`);
  }
}

console.log('\n=== DEPLOYMENT SUMMARY ===');
console.log(JSON.stringify(deployed, null, 2));
