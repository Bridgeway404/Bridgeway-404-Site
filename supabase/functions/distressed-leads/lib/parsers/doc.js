// Text extraction for the document types court sites publish calendars in:
// PDF (delegated to an injected extractor), .docx (zip + document.xml) and
// legacy .doc (printable-run heuristic). Runs in Deno and Node 22.

export function sniffType(bytes, contentType = '', url = '') {
  const b = bytes || new Uint8Array();
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf'; // %PDF
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'docx'; // PK..
  if (b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'doc'; // OLE2
  if (/pdf/i.test(contentType) || /\.pdf$/i.test(url)) return 'pdf';
  if (/wordprocessingml/i.test(contentType) || /\.docx$/i.test(url)) return 'docx';
  if (/msword/i.test(contentType) || /\.doc$/i.test(url)) return 'doc';
  if (/html|xml|text/i.test(contentType)) return 'text';
  return 'unknown';
}

/** Printable text runs from a legacy Word binary (cp1252 and UTF-16LE), one run per line. */
export function docTextRuns(bytes, minLen = 3) {
  const out = [];
  let run = '';
  const flush = () => { if (run.trim().length >= minLen) out.push(run.trim()); run = ''; };
  // 8-bit runs
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if ((c >= 0x20 && c <= 0x7e) || c === 0x09) run += String.fromCharCode(c);
    else if (c === 0x0d || c === 0x0a || c === 0x07 || c === 0x0b) flush();
    else flush();
  }
  flush();
  const split16 = out.length;
  // UTF-16LE runs (Word 97+ stores most text this way)
  let r2 = '';
  const flush2 = () => { if (r2.trim().length >= minLen) out.push(r2.trim()); r2 = ''; };
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const c = bytes[i] | (bytes[i + 1] << 8);
    if ((c >= 0x20 && c <= 0x7e) || c === 0x09) r2 += String.fromCharCode(c);
    else if (c === 0x0d || c === 0x0a || c === 0x07 || c === 0x0b || c === 0x2029) flush2();
    else flush2();
  }
  flush2();
  // UTF-16 runs (Word 97+) are more structured, so they go first; then the 8-bit runs.
  const u16 = out.splice(split16);
  const clean = [...u16, ...out].filter(s => /[A-Za-z]{2}/.test(s) && !/[{}\\|~^`]{2,}/.test(s));
  return clean;
}

/** .docx: unzip document.xml (deflate-raw via DecompressionStream) and strip XML into paragraphs. */
export async function docxText(bytes) {
  const entries = readZipEntries(bytes);
  const doc = entries.find(e => e.name === 'word/document.xml');
  if (!doc) throw new Error('document.xml not found in docx');
  let data = bytes.subarray(doc.dataStart, doc.dataStart + doc.compSize);
  let xml;
  if (doc.method === 8) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    xml = await new Response(stream).text();
  } else xml = new TextDecoder().decode(data);
  return xml.replace(/<w:tab\/>/g, '\t').replace(/<\/w:p>/g, '\n').replace(/<w:br\/>/g, '\n')
    .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .split('\n').map(s => s.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}

function readZipEntries(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // Find end of central directory
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 70000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip EOCD not found');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(b.subarray(off + 46, off + 46 + nameLen));
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    entries.push({ name, method, compSize, dataStart: localOff + 30 + lNameLen + lExtraLen });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Unified: returns { type, text }. `pdfExtract(bytes)` is injected because the
 * PDF library differs between Deno (edge) and Node (tests).
 */
export async function extractDocumentText(bytes, { contentType = '', url = '', pdfExtract } = {}) {
  const type = sniffType(bytes, contentType, url);
  if (type === 'pdf') {
    if (!pdfExtract) throw new Error('no PDF extractor configured');
    return { type, text: await pdfExtract(bytes) };
  }
  if (type === 'docx') return { type, text: await docxText(bytes) };
  if (type === 'doc') return { type, text: docTextRuns(bytes).join('\n') };
  if (type === 'text') return { type, text: new TextDecoder().decode(bytes) };
  return { type, text: '' };
}
