// Text out of the files Google Docs / Slides / Sheets download as: .docx, .pptx, .xlsx, .csv,
// .txt / .md are read in the browser; .pdf is sent to the server, which has the AI read it.
// nosemgrep: ssc-b9f8e938-4de9-4305-93e1-fe2997ee8bde
// @e965/xlsx is a security-patched fork of xlsx that resolves CVE-2023-30533.
import * as XLSX from '@e965/xlsx';

export const ACCEPTED_FILES = '.docx,.pptx,.xlsx,.xls,.csv,.txt,.md,.pdf';
const MAX_PDF_BYTES = 700 * 1024; // the platform accepts requests up to 1 MB (base64 adds a third)

// minimal .zip reader: .docx / .pptx are zip files of XML
async function unzip(buf: ArrayBuffer): Promise<Map<string, string>> {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This file is damaged or not a Word / PowerPoint file.');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!/\.xml$/.test(name)) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + compSize);
    if (method === 0) out.set(name, dec.decode(data));
    else if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      out.set(name, await new Response(stream).text());
    }
  }
  return out;
}

const decodeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// paragraphs (<w:p> / <a:p>) become lines; text runs (<w:t> / <a:t>) are joined
function xmlText(xml: string, ns: 'w' | 'a'): string {
  return xml
    .split(new RegExp(`</${ns}:p>`))
    .map((para) => [...para.matchAll(new RegExp(`<${ns}:t(?:\\s[^>]*)?>([^<]*)</${ns}:t>`, 'g'))].map((m) => decodeXml(m[1])).join(''))
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

async function docxText(buf: ArrayBuffer) {
  const files = await unzip(buf);
  const doc = files.get('word/document.xml');
  if (!doc) throw new Error('No text found in this Word file.');
  return xmlText(doc, 'w');
}

async function pptxText(buf: ArrayBuffer) {
  const files = await unzip(buf);
  const slides = [...files.keys()]
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  if (!slides.length) throw new Error('No slides found in this PowerPoint file.');
  return slides.map((k, i) => `--- Slide ${i + 1} ---\n${xmlText(files.get(k)!, 'a')}`).join('\n\n');
}

function sheetText(buf: ArrayBuffer) {
  const wb = XLSX.read(buf, { type: 'array' });
  return wb.SheetNames.map((n) => `--- ${n} ---\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join('\n\n');
}

async function pdfText(file: File): Promise<string> {
  if (file.size > MAX_PDF_BYTES) throw new Error('This PDF is too large to upload. Download the file as Word (.docx) or PowerPoint (.pptx) instead.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const res = await fetch('/api/admin/extract-pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: btoa(bin) }) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out?.error || 'Could not read this PDF.');
  return out.text as string;
}

export async function fileToText(file: File): Promise<string> {
  const ext = file.name.toLowerCase().split('.').pop() || '';
  let text: string;
  if (ext === 'docx') text = await docxText(await file.arrayBuffer());
  else if (ext === 'pptx') text = await pptxText(await file.arrayBuffer());
  else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') text = sheetText(await file.arrayBuffer());
  else if (ext === 'txt' || ext === 'md') text = await file.text();
  else if (ext === 'pdf') text = await pdfText(file);
  else throw new Error('Use a .docx, .pptx, .xlsx, .csv, .txt or .pdf file. Older .doc / .ppt files: open them in Google and download again as .docx / .pptx.');
  text = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 50) throw new Error(`Almost no text was found in ${file.name}. If it is scanned images, download it from Google as .docx instead.`);
  return text;
}
