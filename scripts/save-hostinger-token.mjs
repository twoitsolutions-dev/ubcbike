// Safely prompts for HOSTINGER_API_TOKEN with hidden terminal input (zero echo),
// saves it to .env in the workspace root without printing the token, and verifies
// authentication against Hostinger's official REST API.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_PATH = resolve(process.cwd(), '.env');

function readHiddenLine(promptText) {
  return new Promise((resolveLine, rejectLine) => {
    process.stdout.write(promptText);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
    };

    const onData = (chunk) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolveLine(value.trim());
          return;
        }
        if (code === 3) {
          cleanup();
          process.stdout.write('\nCancelado.\n');
          rejectLine(new Error('Cancelled'));
          return;
        }
        if (code === 8 || code === 127) {
          value = value.slice(0, -1);
          continue;
        }
        if (code >= 32) {
          value += ch;
        }
      }
    };

    stdin.on('data', onData);
  });
}

const token = await readHiddenLine('Pega tu HOSTINGER_API_TOKEN y presiona Enter (la entrada esta oculta): ');
if (!token) {
  console.error('No se ingreso ningun token.');
  process.exit(1);
}

let existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
const lines = existing.split(/\r?\n/).filter((line) => !/^HOSTINGER_API_TOKEN=/.test(line));
while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
lines.push(`HOSTINGER_API_TOKEN=${token}`, '');
writeFileSync(ENV_PATH, lines.join('\n'), 'utf8');
console.log('Guardado en .env correctamente (valor oculto). Verificando conexion con Hostinger API...');

const res = await fetch('https://developers.hostinger.com/api/hosting/v1/orders', {
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  },
});

if (!res.ok) {
  console.error(`Aviso: Hostinger API respondio HTTP ${res.status}. Verifica que el token sea valido en https://hpanel.hostinger.com/profile/api`);
  process.exit(1);
}

const data = await res.json();
const count = Array.isArray(data) ? data.length : Array.isArray(data?.data) ? data.data.length : 1;
console.log(`Conexion con Hostinger API verificada correctamente (${count} plan/orden detectado). Ya puedes volver al chat y escribir "listo".`);
