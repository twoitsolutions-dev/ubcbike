// Safely sets or updates a user's password in UBC Commerce Hub (Supabase)
// using hidden terminal input (zero echo on screen).
// Usage:
//   npm run hub:password                  (defaults to ubcbike)
//   npm run hub:password -- carlos@twoit.sandbox
import { createPool, hashPassword } from '../packages/database/dist/index.js';

const targetEmail = (process.argv[2] || 'ubcbike').trim().toLowerCase();

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

const pw = await readHiddenLine(`Nueva contrasena para ${targetEmail} (entrada oculta): `);
if (pw.length < 8) {
  console.error('La contrasena debe tener al menos 8 caracteres.');
  process.exit(1);
}

const pool = createPool(process.env.DATABASE_URL);
try {
  const hash = await hashPassword(pw);
  const res = await pool.query(
    `UPDATE users SET password_hash = $2 WHERE lower(email) = $1 RETURNING email, name`,
    [targetEmail, hash],
  );
  if (!res.rowCount) {
    console.error(`No se encontro el usuario ${targetEmail}.`);
    process.exitCode = 1;
  } else {
    console.log(`Contrasena actualizada correctamente para ${res.rows[0].email} (${res.rows[0].name}).`);
    console.log('Ya puedes iniciar sesion en https://ubc-hub.twoitsolutions.com');
  }
} finally {
  await pool.end();
}
