// Pictures and scanned PDFs in. Tesseract.js (Apache 2.0) ships with the app in vendor/tesseract,
// with its English model, and loads only when someone opens a picture or a scan. It finds the words
// and where they sit; from there the same readers as for PDFs take over: the table rebuilder, or, for
// a picture of a timeline, the bar reader (bars are found by scanning the pixels for runs of color).
// Nothing leaves the browser.
import { importTable } from './csv.js';
import { ganttFromShapes, phrases, tableFromWords } from './layout.js';

const BASE = new URL('../../vendor/tesseract/', import.meta.url).href;

async function startOCR(progress) {
  const { default: Tesseract } = await import(`${BASE}tesseract.esm.min.js`);
  const worker = await Tesseract.createWorker('eng', 1, {
    workerPath: `${BASE}worker.min.js`, corePath: `${BASE}tesseract-core-simd-lstm.wasm.js`,
    langPath: BASE.replace(/\/$/, ''), gzip: true, cacheMethod: 'none',
    logger: m => progress?.(m),
  });
  return worker;
}

// Page modes: 11 hunts for text wherever it is (clean words, but can skip a lone digit), 3 lays the
// page out automatically (catches those digits), 6 reads one block, 7 reads one line.
// canvas -> words [{ text, x0, x1, y, h, top, bottom, conf }] in canvas pixels
async function wordsOf(worker, canvas, mode = '11') {
  await worker.setParameters({ tessedit_pageseg_mode: mode });
  const { data } = await worker.recognize(canvas, {}, { blocks: true });
  const words = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const lh = l.rowAttributes?.row_height || (l.bbox.y1 - l.bbox.y0);
    for (const w of l.words || []) {
      const text = (w.text || '').trim();
      if (!text || (w.confidence < 20 && text.length < 2)) continue;
      const bl = l.baseline?.has_baseline !== false && l.baseline ? l.baseline : null;
      const cx = (w.bbox.x0 + w.bbox.x1) / 2;
      const y = bl && bl.x1 !== bl.x0 ? bl.y0 + (bl.y1 - bl.y0) * (cx - bl.x0) / (bl.x1 - bl.x0) : w.bbox.y1;
      words.push({ text, x0: w.bbox.x0, x1: w.bbox.x1, y, h: Math.max(lh * 0.8, w.bbox.y1 - w.bbox.y0), top: w.bbox.y0, bottom: w.bbox.y1, conf: w.confidence });
    }
  }
  // drop "words" far taller than the text around them: lines and shapes misread as letters
  const hs = words.map(w => w.bottom - w.top).sort((a, b) => a - b), mid = hs[hs.length >> 1] || 0;
  return words.filter(w => w.bottom - w.top <= mid * 3);
}

// Draw an image so its text is big enough for OCR (small screenshots are scaled up).
export async function imageCanvas(blob) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(3, Math.max(1, 2400 / bmp.width));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}

// Colored, filled shapes in the picture: bars (wide), milestones (diamonds or dots).
export function findBars(canvas) {
  const W = canvas.width, H = canvas.height, step = Math.max(1, Math.round(W / 900));
  const px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const gw = Math.ceil(W / step), gh = Math.ceil(H / step), on = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const i = ((gy * step) * W + gx * step) * 4, r = px[i], g = px[i + 1], b = px[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 55) on[gy * gw + gx] = 1;
  }
  // Thin lines (a "today" line through the bars, rules, text strokes) aren't bars: drop colored
  // cells in short horizontal runs, then in short vertical runs, so they can't join bars together.
  const thin = (len, at, n, min) => {
    for (let a = 0; a < n; a++) {
      let run = 0;
      for (let b = 0; b <= len; b++) {
        if (b < len && on[at(a, b)]) { run++; continue; }
        if (run && run < min) for (let k = b - run; k < b; k++) on[at(a, k)] = 0;
        run = 0;
      }
    }
  };
  thin(gw, (y, x) => y * gw + x, gh, 4);
  thin(gh, (x, y) => y * gw + x, gw, 3);
  const seen = new Uint8Array(gw * gh), out = [], stack = [];
  for (let s = 0; s < on.length; s++) {
    if (!on[s] || seen[s]) continue;
    let x0 = gw, x1 = 0, y0 = gh, y1 = 0, n = 0;
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const k = stack.pop(), x = k % gw, y = (k - x) / gw;
      n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const nb of [k - 1, k + 1, k - gw, k + gw]) {
        if (nb < 0 || nb >= on.length || seen[nb] || !on[nb] || (nb % gw === 0 && k % gw === gw - 1) || (k % gw === 0 && nb % gw === gw - 1)) continue;
        seen[nb] = 1; stack.push(nb);
      }
    }
    const w = (x1 - x0 + 1) * step, h = (y1 - y0 + 1) * step, fill = n / ((x1 - x0 + 1) * (y1 - y0 + 1));
    if (h < 5 || w < 5) continue;
    const square = Math.abs(w - h) < Math.max(w, h) * 0.35;
    let prst = '';
    if (w >= Math.max(12, h * 1.5) && fill > 0.6) prst = 'rect';
    else if (square && fill > 0.3 && fill < 0.68) prst = 'diamond';
    else if (square && fill >= 0.68 && fill < 0.88) prst = 'ellipse';
    if (prst) out.push({ x: x0 * step, y: y0 * step, w, h, prst, text: '' });
  }
  return out;
}

// Text on a colored bar: copy the bar out (minus its rounded ends), bigger, as black text on white
// (anything that differs from the bar's own color is text), and read it as a small block.
async function textInside(worker, canvas, b) {
  const k = 3, pad = 16, ix = Math.round(b.h * 0.25), iy = 2, w = b.w - ix * 2, h = b.h - iy * 2;
  if (w < 8 || h < 8) return '';
  const c = document.createElement('canvas');
  c.width = w * k + pad * 2; c.height = h * k + pad * 2;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(canvas, b.x + ix, b.y + iy, w, h, pad, pad, w * k, h * k);
  const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
  const lum = i => d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
  const inner = [];
  for (let y = pad; y < c.height - pad; y += 3) for (let x = pad; x < c.width - pad; x += 3) inner.push(lum((y * c.width + x) * 4));
  inner.sort((p, q) => p - q);
  const bar = inner[inner.length >> 1];
  for (let i = 0; i < d.length; i += 4) {
    const x = (i / 4) % c.width, y = Math.floor(i / 4 / c.width);
    const text = x >= pad && x < c.width - pad && y >= pad && y < c.height - pad && Math.abs(lum(i) - bar) > 60;
    d[i] = d[i + 1] = d[i + 2] = text ? 0 : 255;
  }
  g.putImageData(img, 0, 0);
  const words = await wordsOf(worker, c, '6');
  return words.filter(w => w.conf >= 50).map(w => w.text).join(' ').replace(/[^\p{L}\p{N})]+$/u, '').trim();
}

// A picture (or rendered page) of a timeline: bars plus the words around them.
async function timelineFrom(worker, canvas, words) {
  const bars = findBars(canvas);
  if (!bars.length) return null;
  const texts = phrases(words);
  // words printed inside a bar are its name
  const free = texts.filter(t => {
    const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
    const bar = bars.find(b => b.prst === 'rect' && cx > b.x && cx < b.x + b.w && cy > b.y && cy < b.y + b.h);
    if (!bar) return true;
    bar.text = `${bar.text} ${t.text}`.trim();
    return false;
  });
  // a bar with nothing written beside it may carry its name inside, in light text
  for (const b of bars) {
    if (b.prst !== 'rect' || b.text || b.w < b.h * 2) continue;
    const beside = free.some(t => Math.abs(t.y + t.h / 2 - (b.y + b.h / 2)) < Math.max(t.h, b.h) * 0.6);
    if (!beside) b.text = await textInside(worker, canvas, b);
  }
  return ganttFromShapes([...free, ...bars], texts.map(t => t.text).join(' '));
}

// pages: canvases. Reads text on each, then rebuilds a table, or else reads a timeline.
async function fromCanvases(canvases, fileName, progress) {
  const worker = await startOCR(progress);
  const name = fileName.replace(/\.[^.]+$/, '') || 'Imported picture';
  try {
    // Two passes a page: sparse mode reads words cleanly wherever they are but can skip a lone digit;
    // automatic layout catches those. Keep the sparse words, and add the others where nothing was read.
    const pages = [], sparse = [];
    const overlap = (a, b) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
    for (let i = 0; i < canvases.length; i++) {
      progress?.({ status: 'page', page: i + 1, pages: canvases.length });
      const a = await wordsOf(worker, canvases[i], '11'), b = await wordsOf(worker, canvases[i], '3');
      sparse.push(a);
      pages.push({ words: [...a, ...b.filter(w => !a.some(x => overlap(w, x)))] });
    }
    if (!pages.some(p => p.words.length)) throw new Error("Couldn't find any text in this picture.");
    const table = tableFromWords(pages);
    if (table) {
      return { table: { ...table, name, ocr: true },
        result: importTable(table.rows, { name, indents: table.indents, low: table.low }) };
    }
    // no table: look for a timeline among the scattered labels
    const g = await timelineFrom(worker, canvases[0], sparse[0]);
    if (!g) throw new Error("Couldn't find a schedule in this picture. It reads a table with a task name column, or a timeline with month labels and bars.");
    return { table: { ...g, name, shapes: true, ocr: true }, result: importTable(g.rows, { name, indents: g.indents, guess: g.guess }) };
  } finally { await worker.terminate(); }
}

export async function importImage(blob, fileName = '', progress) {
  return fromCanvases([await imageCanvas(blob)], fileName, progress);
}

// A scanned PDF: draw each page (PDF.js), then read it like a picture.
export async function importScannedPDF(pageCanvases, fileName = '', progress) {
  return fromCanvases(pageCanvases, fileName, progress);
}
