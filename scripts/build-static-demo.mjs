// Builds the static DEMO site (admin + in-browser demo driver) for Hostinger.
// Output: build/static-demo/ and build/ubc-demo-static.zip (files at archive root).
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build/static-demo');
const htpasswdPath = process.env.DEMO_HTPASSWD_PATH || '/home/u673103289/domains/ubc-demo.twoitsolutions.com/.htpasswd';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'apps/admin'), out, { recursive: true });
if (!existsSync(join(out, 'js/vendor/business-rules/index.js'))) throw new Error('Run npm run build first (vendor bundle missing)');

const version = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
writeFileSync(join(out, 'js/config.js'), `// Generated for the static DEMO build ${version}. Data is simulated in the browser.\nexport const CONFIG = { driver: 'demo', build: '${version}' };\n`);
writeFileSync(join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
writeFileSync(join(out, 'version.txt'), `ubc-commerce-hub static demo ${version}\n`);
writeFileSync(join(out, '.htaccess'), `# UBC Commerce Hub — private DEMO (static). Managed by scripts/build-static-demo.mjs
Options -Indexes
DirectoryIndex index.html

# Access control: HTTP Basic auth (credentials file kept outside the web root).
AuthType Basic
AuthName "UBC Commerce Hub - private demo"
AuthUserFile ${htpasswdPath}
Require valid-user

<FilesMatch "^\\.">
  Require all denied
</FilesMatch>

<IfModule mod_mime.c>
  AddType text/javascript .js .mjs
  AddType text/css .css
  AddType image/svg+xml .svg
  AddCharset utf-8 .js .css .html .txt
</IfModule>

<IfModule mod_headers.c>
  Header always set X-Robots-Tag "noindex, nofollow, noarchive"
  Header always set X-Content-Type-Options "nosniff"
  Header always set X-Frame-Options "DENY"
  Header always set Referrer-Policy "same-origin"
  Header always set Permissions-Policy "camera=(), microphone=(), geolocation=()"
  Header always set Content-Security-Policy "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  # No content hashing yet: always revalidate so a redeploy is visible immediately.
  Header set Cache-Control "no-cache"
</IfModule>
`);
const zip = join(root, 'build/ubc-demo-static.zip');
rmSync(zip, { force: true });
execFileSync('zip', ['-qr', zip, '.', '-x', 'js/vendor/README.txt'], { cwd: out });
console.log('static demo:', out);
console.log('archive:', zip);
