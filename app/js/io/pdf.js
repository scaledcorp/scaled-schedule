// PDF in. PDF.js (Mozilla, Apache 2.0) ships with the app in vendor/pdfjs and is loaded only when
// someone opens a PDF. It hands back every piece of text with its position; layout.js rebuilds the
// schedule table from those positions. The file never leaves the browser.
import { tableFromWords } from './layout.js';
import { importTable } from './csv.js';

const BASE = new URL('../../vendor/pdfjs/', import.meta.url).href;
let lib = null;
async function pdfjs() {
  if (!lib) {
    lib = await import(`${BASE}pdf.min.mjs`);
    lib.GlobalWorkerOptions.workerSrc = `${BASE}pdf.worker.min.mjs`;
  }
  return lib;
}

// -> [{ width, height, words: [{ text, x0, x1, y, h }] }], y measured from the top of the page.
export async function readPDF(buf, maxPages = 80) {
  const { getDocument, Util } = await pdfjs();
  const task = getDocument({ data: new Uint8Array(buf.slice(0)), isEvalSupported: false, disableFontFace: true,
    useSystemFonts: false, enableXfa: false, stopAtErrors: false, wasmUrl: `${BASE}wasm/` });
  const doc = await task.promise;
  const pages = [];
  try {
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const words = [];
      for (const it of content.items) {
        const str = it.str || '';
        if (!str.trim()) continue;
        const m = Util.transform(vp.transform, it.transform);
        const h = Math.hypot(m[2], m[3]) || it.height || 8;
        const x = m[4], y = m[5], width = it.width * (vp.scale || 1);
        // one text run can hold several words (or several cells): place each by its share of the width
        for (const t of str.matchAll(/\S+/g)) {
          words.push({ text: t[0], x0: x + width * t.index / str.length, x1: x + width * (t.index + t[0].length) / str.length, y, h });
        }
      }
      pages.push({ width: vp.width, height: vp.height, words });
      page.cleanup();
    }
  } finally { await task.destroy(); }
  return pages;
}

// Draw pages onto canvases about 2400 pixels wide, for reading scans with OCR.
export async function renderPDF(buf, maxPages = 20) {
  const { getDocument } = await pdfjs();
  const task = getDocument({ data: new Uint8Array(buf.slice(0)), isEvalSupported: false, enableXfa: false, stopAtErrors: false, wasmUrl: `${BASE}wasm/` });
  const doc = await task.promise, out = [];
  try {
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(4, 2400 / base.width) });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      // print intent: draws in one go, without waiting on animation frames (which pause in hidden tabs)
      await page.render({ canvasContext: g, canvas: c, viewport: vp, intent: 'print' }).promise;
      out.push(c);
      page.cleanup();
    }
  } finally { await task.destroy(); }
  return out;
}

export async function importPDF(buf, fileName = '', progress) {
  const pages = await readPDF(buf);
  const count = pages.reduce((s, p) => s + p.words.length, 0);
  if (!count) {
    // a scan: pictures of pages, so read the text off them
    const { importScannedPDF } = await import('./ocr.js');
    return importScannedPDF(await renderPDF(buf), fileName, progress);
  }
  const table = tableFromWords(pages);
  if (!table) throw new Error("Couldn't find a schedule table in this PDF. It reads tables with a task name column, like a schedule printed from P6, Project or Excel.");
  const name = fileName.replace(/\.[^.]+$/, '') || 'Imported from PDF';
  return { table: { ...table, name }, result: importTable(table.rows, { name, indents: table.indents }) };
}
