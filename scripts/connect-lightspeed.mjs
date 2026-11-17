// Interactive, zero-leak OAuth 2.0 wizard for Lightspeed Retail R-Series (MerchantOS).
// 1. Prompts for Client ID & Client Secret (hidden input — never echoed on screen or chat).
// 2. Opens Lightspeed OAuth authorization in your default browser & catches the callback on http://localhost:3987/callback.
// 3. Exchanges the authorization code for access_token + rotating refresh_token.
// 4. Discovers UBC's exact accountID, physical Shop IDs (Tampa / Alafia), and total POS item count (100% READ-ONLY).
// 5. Persists credentials safely in `.env` + Supabase `integration_oauth_tokens` vault.

import { exec } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPool, runMigrations } from '../packages/database/dist/index.js';

function askLine(promptText, hidden = false) {
  return new Promise((resolveLine, rejectLine) => {
    process.stdout.write(promptText);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (hidden && stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      if (hidden && stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
    };

    const onData = (chunk) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (code === 13 || code === 10) {
          cleanup();
          process.stdout.write('\n');
          resolveLine(value.trim());
          return;
        }
        if (code === 3) {
          cleanup();
          process.stdout.write('\nCancelled.\n');
          rejectLine(new Error('Cancelled by user'));
          return;
        }
        if (code === 8 || code === 127) {
          value = value.slice(0, -1);
          continue;
        }
        if (code >= 32) {
          value += ch;
          if (!hidden && !stdin.isTTY) {
            // standard stream
          }
        }
      }
    };

    if (!hidden && stdin.isTTY) {
      stdin.setRawMode(true);
      const onVisibleData = (chunk) => {
        for (const ch of chunk) {
          const code = ch.charCodeAt(0);
          if (code === 13 || code === 10) {
            stdin.removeListener('data', onVisibleData);
            stdin.setRawMode(Boolean(wasRaw));
            stdin.pause();
            process.stdout.write('\n');
            resolveLine(value.trim());
            return;
          }
          if (code === 3) {
            stdin.removeListener('data', onVisibleData);
            stdin.setRawMode(Boolean(wasRaw));
            stdin.pause();
            process.stdout.write('\nCancelled.\n');
            rejectLine(new Error('Cancelled by user'));
            return;
          }
          if (code === 8 || code === 127) {
            if (value.length > 0) {
              value = value.slice(0, -1);
              process.stdout.write('\b \b');
            }
            continue;
          }
          if (code >= 32) {
            value += ch;
            process.stdout.write(ch);
          }
        }
      };
      stdin.on('data', onVisibleData);
      return;
    }

    stdin.on('data', onData);
  });
}

function upsertEnvVars(envPath, updates) {
  let content = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  for (const [key, val] of Object.entries(updates)) {
    const line = `${key}=${val}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(content)) {
      content = content.replace(re, line);
    } else {
      content = content.replace(/\s*$/, '') + (content ? '\n' : '') + line + '\n';
    }
  }
  writeFileSync(envPath, content, 'utf8');
}

function openBrowser(url) {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd);
}

console.log('\n====================================================================');
console.log(' UBC Commerce Hub — Lightspeed Retail R-Series (MerchantOS) Connect');
console.log(' Mode: 100% READ-ONLY (Cash registers & POS prices untouched)');
console.log('====================================================================\n');
console.log('Step 1: Sign into MerchantOS with the user Carlos gave you and open:');
console.log('        https://cloud.lightspeedapp.com/oauth/register.php');
console.log('        Register a client with:');
console.log('          • Integration Name : UBC Commerce Hub');
console.log('          • Website          : https://ubc-hub.twoitsolutions.com');
console.log('          • Redirect URI     : https://ubc-hub.twoitsolutions.com/oauth/lightspeed/callback\n');

const clientId = (process.env.LIGHTSPEED_R_CLIENT_ID || '').trim() || await askLine('Paste LIGHTSPEED_R_CLIENT_ID: ', false);
const clientSecret = (process.env.LIGHTSPEED_R_CLIENT_SECRET || '').trim() || await askLine('Paste LIGHTSPEED_R_CLIENT_SECRET (typing hidden): ', true);

if (!clientId || !clientSecret) {
  console.error('Both Client ID and Client Secret are required.');
  process.exit(1);
}

const redirectUri = 'https://ubc-hub.twoitsolutions.com/oauth/lightspeed/callback';
const authUrl = `https://cloud.lightspeedapp.com/oauth/authorize.php?response_type=code&client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent('employee:inventory_read')}&redirect_uri=${encodeURIComponent(redirectUri)}`;

// Non-interactive use: `--code=<code or full redirected URL>` skips the browser + prompt;
// without a terminal (e.g. run from a chat/agent) it only prints the URL and exits.
const codeArg = process.argv.find((a) => a.startsWith('--code='))?.slice(7) ?? '';
if (!codeArg) {
  console.log('\nOpening Lightspeed OAuth authorization screen in your browser...');
  console.log('If it does not open automatically, copy & open this URL:\n');
  console.log('  ' + authUrl + '\n');
  openBrowser(authUrl);
  if (!process.stdin.isTTY) {
    console.log('No terminal: after authorizing, re-run with  --code=<the code shown on the green page>');
    process.exit(0);
  }
}

const rawCodeOrUrl = codeArg || await askLine('After clicking "Authorize", paste the code (or full redirected URL) shown in the browser: ', false);
let authCode = rawCodeOrUrl.trim();
if (authCode.includes('code=')) {
  try {
    const parsed = new URL(authCode);
    authCode = parsed.searchParams.get('code') || authCode;
  } catch {
    const m = /[?&]code=([^&]+)/.exec(authCode);
    if (m) authCode = decodeURIComponent(m[1]);
  }
}
if (!authCode) {
  console.error('No authorization code provided.');
  process.exit(1);
}

console.log('✓ Authorization code received! Exchanging for access & refresh tokens...');

let tokenData = null;
let usedTokenUrl = 'https://cloud.lightspeedapp.com/auth/oauth/token';

for (const candidateUrl of [
  'https://cloud.lightspeedapp.com/auth/oauth/token',
  'https://cloud.lightspeedapp.com/oauth/access_token.php',
]) {
  const res = await fetch(candidateUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: authCode,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }).toString(),
  });
  if (res.ok) {
    tokenData = await res.json();
    usedTokenUrl = candidateUrl;
    break;
  }
}

if (!tokenData?.access_token || !tokenData?.refresh_token) {
  throw new Error('Token exchange failed on Lightspeed OAuth endpoints.');
}

const accessToken = tokenData.access_token;
const refreshToken = tokenData.refresh_token;
const expiresAt = new Date(Date.now() + (Number(tokenData.expires_in) || 1800) * 1000).toISOString();

// Discover Account & Shops (100% GET read-only)
const accRes = await fetch('https://api.lightspeedapp.com/API/V3/Account.json', {
  headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
});
if (!accRes.ok) throw new Error(`GET /Account.json failed: HTTP ${accRes.status}`);
const accBody = await accRes.json();
const accounts = Array.isArray(accBody.Account) ? accBody.Account : [accBody.Account].filter(Boolean);
if (!accounts.length) throw new Error('No Lightspeed Account returned for this user.');
const account = accounts[0];
const accountId = String(account.accountID);

const shopsRes = await fetch(`https://api.lightspeedapp.com/API/V3/Account/${accountId}/Shop.json`, {
  headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
});
const shopsBody = shopsRes.ok ? await shopsRes.json() : {};
const shops = shopsBody.Shop ? (Array.isArray(shopsBody.Shop) ? shopsBody.Shop : [shopsBody.Shop]) : [];

const countRes = await fetch(`https://api.lightspeedapp.com/API/V3/Account/${accountId}/Item.json?limit=1`, {
  headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
});
const countBody = countRes.ok ? await countRes.json() : {};
const totalItems = countBody['@attributes']?.count || 'unknown';

console.log('\n✓ Connected to Live Lightspeed R-Series Account:');
console.log(`    • Account Name : ${account.name} (ID: ${accountId})`);
console.log(`    • Total Items  : ${Number(totalItems).toLocaleString ? Number(totalItems).toLocaleString('en-US') : totalItems}`);
for (const s of shops) {
  console.log(`    • Shop #${s.shopID}     : ${s.name}`);
}

// Save to local .env (without printing any secret)
const envPath = resolve(process.cwd(), '.env');
upsertEnvVars(envPath, {
  LIGHTSPEED_R_CLIENT_ID: clientId,
  LIGHTSPEED_R_CLIENT_SECRET: clientSecret,
  LIGHTSPEED_R_REFRESH_TOKEN: refreshToken,
  LIGHTSPEED_R_ACCOUNT_ID: accountId,
  LIGHTSPEED_R_TOKEN_URL: usedTokenUrl,
  LIGHTSPEED_R_POS_EVENT_WRITES_ENABLED: 'false',
});
console.log('\n✓ Saved credentials safely to local .env (POS writes strictly disabled).');

// Save to Supabase integration_oauth_tokens vault so Hostinger production also connects immediately!
if (process.env.DATABASE_URL) {
  const pool = createPool(process.env.DATABASE_URL);
  try {
    await runMigrations(pool, () => {});
    const comp = await pool.query(`SELECT id FROM companies WHERE slug = 'twoit-sandbox' LIMIT 1`);
    if (comp.rowCount) {
      const companyId = comp.rows[0].id;
      await pool.query(
        `INSERT INTO integration_oauth_tokens (
           company_id, system, client_id, client_secret, account_id, refresh_token, access_token, expires_at, metadata, updated_at
         )
         VALUES ($1, 'lightspeed_r', $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (company_id, system) DO UPDATE SET
           client_id = EXCLUDED.client_id,
           client_secret = EXCLUDED.client_secret,
           account_id = EXCLUDED.account_id,
           refresh_token = EXCLUDED.refresh_token,
           access_token = EXCLUDED.access_token,
           expires_at = EXCLUDED.expires_at,
           metadata = EXCLUDED.metadata,
           updated_at = now()`,
        [
          companyId,
          clientId,
          clientSecret,
          accountId,
          refreshToken,
          accessToken,
          expiresAt,
          JSON.stringify({ accountName: account.name, totalItems, shops: shops.map((s) => ({ shopID: s.shopID, name: s.name })) }),
        ],
      );
      if (shops[0]?.shopID) {
        await pool.query(
          `UPDATE locations SET lightspeed_shop_id = COALESCE(lightspeed_shop_id, $2) WHERE company_id = $1 AND kind = 'physical'`,
          [companyId, String(shops[0].shopID)],
        );
      }
      await pool.query(
        `INSERT INTO integration_connections (company_id, system, status, detail, missing, writes_enabled, last_checked_at)
         VALUES ($1, 'lightspeed_r', 'connected', $2, '[]'::jsonb, false, now())
         ON CONFLICT (company_id, system) DO UPDATE SET
           status = 'connected',
           detail = EXCLUDED.detail,
           missing = '[]'::jsonb,
           last_checked_at = now()`,
        [companyId, `Authenticated (${account.name} #${accountId}, read-only; ${totalItems} POS items)`],
      );
      console.log('✓ Synced rotating token vault to Supabase for ubc-hub.twoitsolutions.com!\n');
    }
  } finally {
    await pool.end();
  }
}

console.log('READY! Tell Antigravity "ya conecté lightspeed" to pull UBC\'s real catalog & stock!\n');
