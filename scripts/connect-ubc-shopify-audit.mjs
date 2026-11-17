/**
 * Interactive 100% Read-Only connector for Carlos's Shopify store (`z5wxyn-uc.myshopify.com`).
 * Supports:
 *  1) Direct `shpat_...` Admin token
 *  2) Dev Dashboard `client_credentials` exchange (if app is already installed in the same org)
 *  3) Automatic fallback to standard Shopify OAuth `authorization_code` browser flow
 *     (`https://ubc-hub.twoitsolutions.com/api/shopify/oauth/callback`) when the app is not yet
 *     installed or lives in a Partner/Dev organization!
 */
import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { ShopifyAdminClient } from '../packages/integrations/dist/index.js';

const ENV_PATH = path.resolve(process.cwd(), '.env');
const REDIRECT_URI = 'https://ubc-hub.twoitsolutions.com/api/shopify/oauth/callback';
const SCOPES = 'read_products,write_products,read_inventory,write_inventory,read_locations,read_orders,read_themes,write_themes,write_discounts,write_online_store_pages,write_online_store_navigation';

function upsertEnvKey(raw, key, val) {
  const line = `${key}=${val}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(raw)) return raw.replace(re, line);
  return raw.endsWith('\n') || raw.length === 0 ? `${raw}${line}\n` : `${raw}\n${line}\n`;
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    exec(`rundll32 url.dll,FileProtocolHandler "${url}"`);
  } else if (process.platform === 'darwin') {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}

async function tryClientCredentials(shopDomain, clientId, clientSecret) {
  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\n══════════════════════════════════════════════════════════════════════');
    console.log('  UBC Hub — Conexión Segura a Tienda Shopify (z5wxyn-uc.myshopify.com)');
    console.log('  • Modo inicial: Solo Lectura (writesEnabled: false hasta autorizar)');
    console.log('  • Mantiene intacta nuestra tienda sandbox (ubcbike-hub.myshopify.com)');
    console.log('══════════════════════════════════════════════════════════════════════\n');

    const shopInput = (await rl.question('1) Shop domain [Enter = z5wxyn-uc.myshopify.com]: ')).trim();
    const shopDomain = (shopInput || 'z5wxyn-uc.myshopify.com').replace(/^https?:\/\//i, '').replace(/\/+$/, '');

    const clientId = (await rl.question('2) Pega el ID de cliente de UBC Hub y pulsa Enter: ')).trim();
    const secretOrToken = (await rl.question('3) Pega el Secreto del cliente de UBC Hub y pulsa Enter: ')).trim();
    if (!secretOrToken) throw new Error('No se ingresó ningún secreto o token.');

    let finalAccessToken = '';
    let usedClientCreds = false;

    if (secretOrToken.startsWith('shpat_') || secretOrToken.startsWith('shpua_')) {
      finalAccessToken = secretOrToken;
    } else {
      if (!clientId) throw new Error('Falta el ID de cliente.');
      console.log('\nProbando intercambio directo client_credentials...');
      const cc = await tryClientCredentials(shopDomain, clientId, secretOrToken);
      if (cc.ok) {
        usedClientCreds = true;
      } else {
        console.log(`  → Shopify respondió HTTP ${cc.status}: ${cc.text.slice(0, 180)}`);
        console.log('\nAbriendo autorización OAuth de instalación en tu navegador (1 clic, igual que Lightspeed)...');
        const state = crypto.randomBytes(12).toString('hex');
        const authUrl =
          `https://${shopDomain}/admin/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
          `&scope=${encodeURIComponent(SCOPES)}` +
          `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
          `&state=${state}`;
        console.log(`\nSi no se abre solo, abre este enlace:\n${authUrl}\n`);
        openBrowser(authUrl);

        const pasted = (await rl.question('4) Haz clic en "Instalar" en el navegador y pega aquí el código (o la URL completa): ')).trim();
        let code = pasted;
        if (pasted.includes('code=')) {
          const u = new URL(pasted.startsWith('http') ? pasted : `https://x/${pasted}`);
          code = u.searchParams.get('code') || '';
        }
        if (!code) throw new Error('No se encontró el parámetro code.');

        const tokRes = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: secretOrToken,
            code,
          }).toString(),
        });
        if (!tokRes.ok) {
          const errBody = await tokRes.text();
          throw new Error(`Fallo al canjear code en Shopify (HTTP ${tokRes.status}): ${errBody}`);
        }
        const tokJson = await tokRes.json();
        finalAccessToken = tokJson.access_token;
      }
    }

    const client = usedClientCreds
      ? new ShopifyAdminClient({ shopDomain, clientId, clientSecret: secretOrToken, writesEnabled: false })
      : new ShopifyAdminClient({ shopDomain, accessToken: finalAccessToken, writesEnabled: false });

    const health = await client.health();
    if (health.status !== 'connected') {
      throw new Error(`No se pudo verificar lectura: ${health.detail}`);
    }

    let envContent = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    envContent = upsertEnvKey(envContent, 'UBC_LIVE_SHOPIFY_DOMAIN', client.shopDomain);
    envContent = upsertEnvKey(envContent, 'UBC_LIVE_SHOPIFY_CLIENT_ID', clientId);
    if (usedClientCreds) {
      envContent = upsertEnvKey(envContent, 'UBC_LIVE_SHOPIFY_CLIENT_SECRET', secretOrToken);
    } else {
      envContent = upsertEnvKey(envContent, 'UBC_LIVE_SHOPIFY_CLIENT_SECRET', secretOrToken);
      envContent = upsertEnvKey(envContent, 'UBC_LIVE_SHOPIFY_ACCESS_TOKEN', finalAccessToken);
    }
    fs.writeFileSync(ENV_PATH, envContent, 'utf8');

    console.log(`\n✓ Conectado exitosamente en MODO SOLO LECTURA:`);
    console.log(`  ${health.detail}`);
    console.log(`✓ Guardado seguro en .env (UBC_LIVE_SHOPIFY_*).\n`);
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error('\n✗ Error:', err.message);
  process.exit(1);
});
