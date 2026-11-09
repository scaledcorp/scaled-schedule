// PowerPoint (.pptx) and Word (.docx) in. Both are zips of XML, opened with the browser's own unzip.
// - Tables on slides or in a document read cell by cell, then go through the same table import CSV
//   and Excel use.
// - A slide with no table but a drawn timeline (a row of month labels with bars under it) is read
//   from the shapes' positions: see ganttFromShapes in layout.js.
import { columnMap, importTable } from './csv.js';
import { kid, kids, parseXML, unzip } from './files.js';
import { ganttFromShapes } from './layout.js';

const all = (el, name) => (el ? [...el.getElementsByTagNameNS('*', name)] : []);
const paraText = p => all(p, 't').map(t => t.textContent).join('');
const cellText = el => all(el, 'p').map(paraText).map(s => s.trim()).filter(Boolean).join(' ');
const num = s => +(s || 0);

// Tables with a task-name header; tables that repeat the same header (split across slides or pages)
// are joined into one.
function pickTable(tables) {
  let best = null;
  for (const t of tables) {
    if (!t.rows.length) continue;
    const map = columnMap(t.rows[0]);
    if (map.name < 0) continue;
    if (!best) { best = { rows: [...t.rows], indents: [...t.indents] }; continue; }
    if (t.rows[0].join('|').toLowerCase() === best.rows[0].join('|').toLowerCase()) {
      best.rows.push(...t.rows.slice(1));
      best.indents.push(...t.indents.slice(1));
    }
  }
  return best && best.rows.length > 1 ? best : null;
}

// raw indent amounts per cell -> levels 0, 1, 2… by distinct value within each column
function indentLevels(raw) {
  const cols = new Map();
  raw.forEach(r => r.forEach((v, c) => { if (!cols.has(c)) cols.set(c, new Set()); cols.get(c).add(v || 0); }));
  const order = new Map([...cols].map(([c, s]) => [c, [...s].sort((a, b) => a - b)]));
  return raw.map(r => r.map((v, c) => order.get(c).indexOf(v || 0)));
}

// ---------------------------------------------------------------- Word

export async function readDOCX(buf) {
  const zip = unzip(buf);
  const xml = await zip.text('word/document.xml');
  if (!xml) throw new Error("This doesn't look like a Word .docx file.");
  const doc = parseXML(xml, 'Word document').documentElement;
  return all(doc, 'tbl').map(tbl => {
    const rows = [], raw = [];
    kids(tbl, 'tr').forEach(tr => {
      const row = [], ind = [];
      kids(tr, 'tc').forEach(tc => {
        const pr = kid(kid(tc, 'p'), 'pPr'), indEl = kid(pr, 'ind');
        const left = num(indEl?.getAttributeNS(indEl.namespaceURI, 'left') || indEl?.getAttributeNS(indEl.namespaceURI, 'start'));
        const span = num(kid(kid(tc, 'tcPr'), 'gridSpan')?.getAttributeNS(tc.namespaceURI, 'val')) || 1;
        row.push(cellText(tc)); ind.push(left);
        for (let k = 1; k < span; k++) { row.push(''); ind.push(0); }
      });
      if (row.some(Boolean)) { rows.push(row); raw.push(ind); }
    });
    return { rows, indents: indentLevels(raw) };
  });
}

export async function importDOCX(buf, fileName = '') {
  const table = pickTable(await readDOCX(buf));
  if (!table) throw new Error("Couldn't find a schedule table in this document. It reads tables with a task name column.");
  const name = fileName.replace(/\.[^.]+$/, '') || 'Imported from Word';
  return { table: { ...table, name }, result: importTable(table.rows, { name, indents: table.indents }) };
}

// ---------------------------------------------------------------- PowerPoint

const FILL = /^(solidFill|gradFill|pattFill|blipFill)$/;
function filled(sp) {
  const pr = kid(sp, 'spPr');
  const own = pr ? [...pr.children].find(n => FILL.test(n.localName) || n.localName === 'noFill') : null;
  if (own) return own.localName !== 'noFill';
  const ref = kid(kid(sp, 'style'), 'fillRef');
  return !!ref && ref.getAttribute('idx') !== '0';
}

// Walk the shape tree, mapping group coordinates back to slide coordinates.
function shapes(tree, map, out, tables) {
  for (const n of tree.children) {
    const name = n.localName;
    if (name === 'grpSp') {
      const x = kid(kid(n, 'grpSpPr'), 'xfrm');
      const off = kid(x, 'off'), ext = kid(x, 'ext'), chOff = kid(x, 'chOff'), chExt = kid(x, 'chExt');
      let inner = map;
      if (off && ext && chOff && chExt) {
        const sx = num(ext.getAttribute('cx')) / (num(chExt.getAttribute('cx')) || 1);
        const sy = num(ext.getAttribute('cy')) / (num(chExt.getAttribute('cy')) || 1);
        const [ox, oy, cx, cy] = [off.getAttribute('x'), off.getAttribute('y'), chOff.getAttribute('x'), chOff.getAttribute('y')].map(num);
        inner = (px, py, w, h) => map(ox + (px - cx) * sx, oy + (py - cy) * sy, w * sx, h * sy);
      }
      shapes(n, inner, out, tables);
    } else if (name === 'sp') {
      const x = kid(kid(n, 'spPr'), 'xfrm');
      const text = all(kid(n, 'txBody'), 'p').map(paraText).map(s => s.trim()).filter(Boolean).join(' ');
      if (!x) { out.loose.push(text); continue; }
      const off = kid(x, 'off'), ext = kid(x, 'ext');
      const [px, py, w, h] = map(num(off?.getAttribute('x')), num(off?.getAttribute('y')), num(ext?.getAttribute('cx')), num(ext?.getAttribute('cy')));
      const prst = kid(kid(n, 'spPr'), 'prstGeom')?.getAttribute('prst') || '';
      out.items.push({ x: px, y: py, w, h, text, prst: filled(n) ? prst : '' });
    } else if (name === 'graphicFrame') {
      const tbl = all(n, 'tbl')[0];
      if (!tbl) continue;
      const rows = kids(tbl, 'tr').map(tr => kids(tr, 'tc').map(cellText)).filter(r => r.some(Boolean));
      tables.push({ rows, indents: rows.map(() => []) });
    }
  }
}

export async function readPPTX(buf) {
  const zip = unzip(buf);
  const slidesXml = zip.names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => +a.match(/(\d+)\.xml$/)[1] - +b.match(/(\d+)\.xml$/)[1]);
  if (!slidesXml.length) throw new Error("This doesn't look like a PowerPoint .pptx file.");
  const slides = [];
  for (const path of slidesXml) {
    const root = parseXML(await zip.text(path), 'slide').documentElement;
    const tree = all(root, 'spTree')[0];
    const out = { items: [], loose: [] }, tables = [];
    if (tree) shapes(tree, (x, y, w, h) => [x, y, w, h], out, tables);
    slides.push({ items: out.items, tables, text: [...out.loose, ...out.items.map(i => i.text)].join(' ') });
  }
  return slides;
}

export async function importPPTX(buf, fileName = '') {
  const slides = await readPPTX(buf);
  const name = fileName.replace(/\.[^.]+$/, '') || 'Imported from slides';
  const table = pickTable(slides.flatMap(s => s.tables));
  if (table) return { table: { ...table, name }, result: importTable(table.rows, { name, indents: table.indents }) };
  const timelines = slides.map((s, i) => ({ i, g: ganttFromShapes(s.items, s.text) })).filter(x => x.g);
  if (!timelines.length) throw new Error("Couldn't find a schedule in these slides. It reads tables with a task name column, or a timeline with month labels and bars.");
  const best = timelines.sort((a, b) => b.g.rows.length - a.g.rows.length)[0];
  const extra = slides.length > 1 ? [`Read the timeline on slide ${best.i + 1}.`] : [];
  return { table: { ...best.g, name, shapes: true },
    result: importTable(best.g.rows, { name, indents: best.g.indents, guess: best.g.guess, extra }) };
}
