/** Read just the header row of a CSV (handles quoted headers). */
export function parseCsvHeader(text) {
  const src = text.replace(/^﻿/, '');
  const out = [];
  let field = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
      continue;
    }
    if (c === '"') q = true;
    else if (c === ',') { out.push(field.trim()); field = ''; }
    else if (c === '\n' || c === '\r') break;
    else field += c;
  }
  out.push(field.trim());
  return out.filter(Boolean);
}
