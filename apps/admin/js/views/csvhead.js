/** Detect delimiter (comma, tab, semicolon, or pipe) from the header line. */
export function detectHeaderDelimiter(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  let q = false;
  const counts = { ',': 0, '\t': 0, ';': 0, '|': 0 };
  for (let i = 0; i < src.length && i < 8192; i++) {
    const c = src[i];
    if (c === '"') {
      if (q && src[i + 1] === '"') i++;
      else q = !q;
      continue;
    }
    if (!q && (c === '\n' || c === '\r')) break;
    if (!q && counts[c] !== undefined) counts[c]++;
  }
  let best = ',';
  ['\t', ';', '|', ','].forEach((d) => {
    if (counts[d] > counts[best]) best = d;
  });
  return best;
}

/** Read just the header row of a CSV/TSV/pipe/semicolon file (handles quoted headers). */
export function parseCsvHeader(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const sep = detectHeaderDelimiter(src);
  const out = [];
  let field = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
      continue;
    }
    if (c === '"') q = true;
    else if (c === sep) { out.push(field.trim()); field = ''; }
    else if (c === '\n' || c === '\r') break;
    else field += c;
  }
  out.push(field.trim());
  return out.filter(Boolean);
}

/**
 * Split a large CSV/TSV text (e.g. 40,000 rows) into self-contained chunks,
 * each starting with the original header row and respecting quoted multiline cells.
 */
export function splitCsvChunks(text, rowsPerChunk) {
  const maxRows = rowsPerChunk || 2500;
  const src = String(text || '').replace(/^\uFEFF/, '');
  const lines = [];
  let start = 0;
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      if (q && src[i + 1] === '"') i++;
      else q = !q;
    } else if (!q && (c === '\n' || c === '\r')) {
      const line = src.slice(start, i);
      if (line.trim() !== '') lines.push(line);
      if (c === '\r' && src[i + 1] === '\n') i++;
      start = i + 1;
    }
  }
  if (start < src.length) {
    const tail = src.slice(start);
    if (tail.trim() !== '') lines.push(tail);
  }
  if (lines.length <= 1) return { headerLine: lines[0] || '', totalDataRows: 0, chunks: [] };
  const headerLine = lines[0];
  const dataLines = lines.slice(1);
  const chunks = [];
  for (let i = 0; i < dataLines.length; i += maxRows) {
    chunks.push(headerLine + '\n' + dataLines.slice(i, i + maxRows).join('\n'));
  }
  return { headerLine, totalDataRows: dataLines.length, chunks };
}
