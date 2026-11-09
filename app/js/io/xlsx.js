// Excel (.xlsx) in. An .xlsx is a zip of XML: read the sheets into rows of text (dates as
// 2027-01-04, percents as 50%), keep each row's outline level or name indent, then hand the rows to
// the same table import CSV uses.
import { importTable } from './csv.js';
import { kid, kids, parseXML, unzip } from './files.js';

const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
const PCT_IDS = new Set([9, 10]);

function colIndex(ref) {
  const letters = String(ref).match(/^[A-Z]+/i)?.[0].toUpperCase() || 'A';
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}
const textOf = el => [...el.getElementsByTagNameNS('*', 't')].filter(t => t.parentNode.localName !== 'rPh').map(t => t.textContent).join('');

function styleInfo(doc) {
  const custom = new Map();
  if (doc) kids(kid(doc.documentElement, 'numFmts'), 'numFmt').forEach(f => custom.set(+f.getAttribute('numFmtId'), f.getAttribute('formatCode') || ''));
  const kind = id => {
    if (DATE_IDS.has(id)) return 'date';
    if (PCT_IDS.has(id)) return 'pct';
    const code = (custom.get(id) || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    if (/%/.test(code)) return 'pct';
    return /[dmyh]/i.test(code) && !/^general$/i.test(code) ? 'date' : '';
  };
  return doc ? kids(kid(doc.documentElement, 'cellXfs'), 'xf').map(xf => ({
    kind: kind(+xf.getAttribute('numFmtId') || 0), indent: +(kid(xf, 'alignment')?.getAttribute('indent') || 0) })) : [];
}

function serialToText(v, date1904) {
  const ms = Math.round((v + (date1904 ? 1462 : 0) - 25569) * 86400000);
  const iso = new Date(ms).toISOString();
  return iso.slice(11, 16) === '00:00' ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
const plain = v => String(Math.round(v * 1e9) / 1e9);

export async function readXLSX(buf) {
  const zip = unzip(buf);
  if (!zip.has('xl/workbook.xml')) throw new Error("This doesn't look like an Excel .xlsx file.");
  const book = parseXML(await zip.text('xl/workbook.xml'), 'Excel workbook').documentElement;
  const date1904 = /^(1|true)$/.test(kid(book, 'workbookPr')?.getAttribute('date1904') || '');
  const rels = new Map();
  const relDoc = await zip.text('xl/_rels/workbook.xml.rels');
  if (relDoc) kids(parseXML(relDoc, 'Excel workbook').documentElement, 'Relationship').forEach(r => rels.set(r.getAttribute('Id'), r.getAttribute('Target')));
  const ssText = await zip.text('xl/sharedStrings.xml');
  const shared = ssText ? kids(parseXML(ssText, 'Excel workbook').documentElement, 'si').map(textOf) : [];
  const stText = await zip.text('xl/styles.xml');
  const styles = styleInfo(stText ? parseXML(stText, 'Excel workbook') : null);

  const sheets = [];
  for (const s of kids(kid(book, 'sheets'), 'sheet')) {
    const rid = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || s.getAttribute('r:id');
    let target = rels.get(rid) || '';
    if (!target) continue;
    target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const xml = await zip.text(target);
    if (!xml) continue;
    const doc = parseXML(xml, 'Excel sheet').documentElement;
    const rows = [], outline = [], indents = [];
    for (const r of kids(kid(doc, 'sheetData'), 'row')) {
      const cells = [], ind = [];
      let next = 0;
      for (const c of kids(r, 'c')) {
        const i = c.getAttribute('r') ? colIndex(c.getAttribute('r')) : next;
        next = i + 1;
        const t = c.getAttribute('t') || 'n', st = styles[+(c.getAttribute('s') || 0)] || {};
        const v = kid(c, 'v')?.textContent ?? '';
        let out = '';
        if (t === 's') out = shared[+v] ?? '';
        else if (t === 'inlineStr') out = kid(c, 'is') ? textOf(kid(c, 'is')) : '';
        else if (t === 'str' || t === 'e') out = v;
        else if (t === 'b') out = v === '1' ? 'TRUE' : 'FALSE';
        else if (v !== '') {
          const n = parseFloat(v);
          out = st.kind === 'date' ? serialToText(n, date1904) : st.kind === 'pct' ? `${plain(n * 100)}%` : plain(n);
        }
        cells[i] = out.trim();
        ind[i] = st.indent || 0;
      }
      for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = '';
      if (!cells.some(v => v !== '')) continue;
      rows.push(cells);
      outline.push(+(r.getAttribute('outlineLevel') || 0));
      indents.push(ind);
    }
    sheets.push({ name: s.getAttribute('name') || `Sheet ${sheets.length + 1}`, rows, outline, indents });
  }
  return sheets;
}

export async function importXLSX(buf, fileName = '') {
  const sheets = await readXLSX(buf);
  let firstError;
  for (const sh of sheets) {
    try {
      return importTable(sh.rows, { name: fileName.replace(/\.[^.]+$/, '') || sh.name, outline: sh.outline, indents: sh.indents,
        extra: sheets.length > 1 ? [`Read the "${sh.name}" sheet.`] : [] });
    } catch (e) { firstError ??= e; }
  }
  throw firstError || new Error('This workbook has no sheets with tasks in it.');
}
