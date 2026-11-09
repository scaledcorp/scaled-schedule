// Turning positioned text into schedule rows. PDFs give words with x/y positions; slides give shapes.
// Two readers live here:
// - tableFromWords: finds the header row of a printed schedule (Activity ID, Task Name, Duration…),
//   uses the header cells as column guides, and rebuilds every row below it, page after page.
// - ganttFromShapes: finds a date axis (month or date labels in a row), then reads each bar's left
//   and right edge as start and finish, and the text beside or inside it as the name.
import { columnMap } from './csv.js';
import { parseDay } from '../model.js';
import { weekday } from '../calendar.js';

const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

// words [{text, x0, x1, y, h}] -> lines, top to bottom, each sorted left to right
function lines(words) {
  const sorted = [...words].sort((a, b) => a.y - b.y || a.x0 - b.x0), out = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(w.y - last.y) <= Math.max(w.h, last.h) * 0.5) last.words.push(w);
    else out.push({ y: w.y, h: w.h, words: [w] });
  }
  out.forEach(l => { l.words.sort((a, b) => a.x0 - b.x0); l.h = median(l.words.map(w => w.h)); });
  return out;
}

// Words that sit close together (or stack, for two-line headers) become one cell.
function cells(words) {
  const sorted = [...words].sort((a, b) => a.x0 - b.x0), out = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.x0 <= last.x1 + w.h * 0.85) { last.words.push(w); last.x1 = Math.max(last.x1, w.x1); }
    else out.push({ x0: w.x0, x1: w.x1, words: [w] });
  }
  return out.map(c => ({ x0: c.x0, x1: c.x1,
    text: c.words.sort((a, b) => (Math.abs(a.y - b.y) > a.h * 0.5 ? a.y - b.y : a.x0 - b.x0)).map(w => w.text).join(' ') }));
}

// Fields beyond the name that make a row look like a schedule header.
const known = map => ['id', 'dur', 'start', 'finish', 'pred', 'pct', 'res'].filter(k => map[k] >= 0).length;

function findHeaderLine(ls) {
  for (let i = 0; i < ls.length; i++) {
    const tries = [[ls[i]]];
    if (ls[i + 1] && ls[i + 1].y - ls[i].y < ls[i].h * 1.7) tries.unshift([ls[i], ls[i + 1]]);
    for (const band of tries) {
      const cs = cells(band.flatMap(l => l.words));
      const map = columnMap(cs.map(c => c.text));
      if (map.name >= 0 && known(map) >= 1) return { index: i, span: band.length, cells: cs, map };
    }
  }
  return null;
}

const looksLikeId = s => /^[A-Za-z]{0,8}[-_.]?\d[\w.-]*$/.test(s);
const footer = s => /^(page\s*\d+|\d+\s*(of|\/)\s*\d+|printed|data date|run date)/i.test(s);

// pages [{words}] -> { rows (first row is the header), indents, pages } or null when no table.
export function tableFromWords(pages) {
  let header = null, headerY = 0;
  const rows = [];
  pages.forEach((page, p) => {
    const ls = lines(page.words);
    const found = findHeaderLine(ls);
    let start = 0;
    if (found && (!header || found.cells.length >= header.cells.length - 1)) {
      if (!header) { header = found; headerY = ls[found.index].y; }
      start = found.index + found.span;
    } else if (header) {
      start = ls.findIndex(l => l.y > headerY + l.h * 0.5);
      if (start < 0) return;
    } else return;
    const cols = header.cells, map = header.map;
    // Text in a column starts near its header's left edge (numbers end near its right edge), so a
    // column reaches almost to where the next header starts: long names stay in the name column.
    const h = median(page.words.map(w => w.h)) || 8;
    const bounds = cols.map((c, i) => (i + 1 < cols.length ? Math.max(c.x1, cols[i + 1].x0 - h * 0.6) : c.x1 + Math.max(60, (c.x1 - c.x0) * 2)));
    const colOf = w => {
      const cx = (w.x0 + w.x1) / 2;
      const i = bounds.findIndex(b => cx < b);
      return i < 0 || (i === 0 && cx < cols[0].x0 - 40) ? -1 : i;
    };
    // A long name can wrap onto lines above and below the line holding the row's other values
    // (cells centered vertically): name-only lines tight against a row join its name.
    let prev = null, pending = null;
    const tight = (a, l) => a && a.page === p && l.y - a.y < l.h * 1.3;
    const flush = () => { if (pending) { rows.push(pending); prev = pending; pending = null; } };
    for (const l of ls.slice(start)) {
      if (l.words.length === 1 && footer(l.words[0].text)) continue;
      // P6 marks actual dates with a trailing A (and constrained ones with *): keep it with its date
      const words = [];
      l.words.forEach(w => {
        const last = words[words.length - 1];
        if (last && /^[A*]$/.test(w.text) && /\d/.test(last.text) && w.x0 - last.x1 < w.h * 0.85) words[words.length - 1] = { ...last, text: `${last.text} ${w.text}`, x1: w.x1 };
        else words.push(w);
      });
      const row = cols.map(() => []);
      words.forEach(w => { const c = colOf(w); if (c >= 0) row[c].push(w); });
      const text = row.map(ws => ws.map(w => w.text).join(' ').trim());
      if (footer(text.join(' ').trim()) || text.every(t => !t)) continue;
      // a band row (WBS name printed from the ID column, maybe running into the name column)
      if (map.id >= 0 && text[map.id] && !looksLikeId(text[map.id])) {
        text[map.name] = `${text[map.id]} ${text[map.name]}`.trim(); row[map.name] = [...row[map.id], ...row[map.name]];
        text[map.id] = ''; row[map.id] = [];
      }
      let x = row[map.name][0]?.x0 ?? null;
      const nameOnly = !!text[map.name] && text.every((t, i) => i === map.name || !t);
      if (nameOnly) {
        if (tight(prev, l) && !pending) { prev.text[map.name] = `${prev.text[map.name]} ${text[map.name]}`.trim(); prev.y = l.y; prev.x ??= x; continue; }
        if (tight(pending, l)) { pending.text[map.name] += ` ${text[map.name]}`; pending.y = l.y; continue; }
        flush();
        pending = { text, y: l.y, page: p, x };
        continue;
      }
      if (tight(pending, l)) {
        text[map.name] = `${pending.text[map.name]} ${text[map.name]}`.trim();
        x = pending.x ?? x;
        pending = null;
      } else flush();
      if (!text[map.name] && !(map.id >= 0 && text[map.id])) continue;
      prev = { text, y: l.y, page: p, x };
      rows.push(prev);
    }
    flush();
  });
  if (!header || !rows.length) return null;
  // Outline levels. With an ID column (P6 style), rows without an ID are WBS bands: their indent
  // sets their level and the activities after them sit one level under. Otherwise each distinct
  // name indent is a level (Project style).
  const idCol = header.map.id;
  const banded = idCol >= 0 && rows.some(r => r.text[idCol]) && rows.some(r => !r.text[idCol]);
  const pick = list => {
    const xs = [];
    list.forEach(r => { if (r.x != null && !xs.some(v => Math.abs(v - r.x) < 2.5)) xs.push(r.x); });
    xs.sort((a, b) => a - b);
    return r => (r.x == null ? 0 : Math.max(0, xs.findIndex(v => Math.abs(v - r.x) < 2.5)));
  };
  const levelOf = pick(banded ? rows.filter(r => !r.text[idCol]) : rows);
  let band = -1;
  const indents = [[], ...rows.map(r => {
    const ind = [];
    if (!banded) ind[header.map.name] = levelOf(r);
    else if (!r.text[idCol]) ind[header.map.name] = band = levelOf(r);
    else ind[header.map.name] = band + 1;
    return ind;
  })];
  return { rows: [header.cells.map(c => c.text), ...rows.map(r => r.text)], indents };
}

// ---------------------------------------------------------------- slides

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const dayOf = (y, m, d) => Math.round(Date.UTC(y, m, d) / 86400000);

// An axis label -> { from, to } days (to is exclusive), or null.
function axisLabel(text, year) {
  const s = text.trim().replace(/[’']/g, ' ').replace(/\s+/g, ' ');
  let m = s.match(/^(q[1-4])(?:\s*(?:fy)?\s*(\d{2,4}))?$/i);
  if (m) {
    const y = m[2] ? (m[2].length === 2 ? 2000 + +m[2] : +m[2]) : year, q = +m[1][1] - 1;
    return { from: dayOf(y, q * 3, 1), to: dayOf(y, q * 3 + 3, 1), year: m[2] ? y : null, kind: 'quarter' };
  }
  m = s.match(/^([a-z]{3,9})\.?(?:\s*-?\s*(\d{2,4}))?$/i);
  if (m) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mo < 0 || (m[1].length > 3 && !/^(january|february|march|april|may|june|july|august|september|october|november|december|sept)$/i.test(m[1]))) return null;
    const y = m[2] ? (m[2].length === 2 ? 2000 + +m[2] : +m[2]) : year;
    return { from: dayOf(y, mo, 1), to: dayOf(y, mo + 1, 1), year: m[2] ? y : null, kind: 'month', month: mo };
  }
  const d = /\d/.test(s) && s.length <= 12 ? parseDay(s, year) : null;
  return d != null ? { from: d, to: d + 1, year: /\d{4}/.test(s) ? new Date(d * 864e5).getUTCFullYear() : null, kind: 'day' } : null;
}

const MILESTONE = /^(diamond|flowChartDecision|star\d*|triangle|flowChartMerge|flowChartExtract|ellipse|octagon)$/;
const BAR = /^(rect|roundRect|round1Rect|round2SameRect|snip1Rect|snip2SameRect|homePlate|chevron|rightArrow|flowChartProcess|flowChartAlternateProcess|parallelogram|trapezoid|hexagon|leftRightArrow|notchedRightArrow|pentagon)$/;

// items [{x, y, w, h, text, prst}] in one coordinate space -> { rows, indents, guess } or null.
export function ganttFromShapes(items, slideText = '') {
  const yearHint = +(slideText.match(/\b(20\d{2})\b/)?.[1] || new Date().getFullYear());
  const texts = items.filter(it => it.text);
  // the axis: the horizontal band holding the most date labels
  const labels = texts.map(it => ({ it, a: axisLabel(it.text, yearHint) })).filter(x => x.a);
  if (labels.length < 2) return null;
  const bands = [];
  labels.forEach(l => {
    const cy = l.it.y + l.it.h / 2;
    const b = bands.find(b => Math.abs(b.cy - cy) < Math.max(l.it.h, b.h) * 0.6);
    if (b) b.labels.push(l); else bands.push({ cy, h: l.it.h, labels: [l] });
  });
  const axis = bands.sort((a, b) => b.labels.length - a.labels.length)[0].labels.sort((a, b) => a.it.x - b.it.x);
  if (axis.length < 2) return null;
  // month labels without a year roll over into the next year after December
  let year = axis.find(l => l.a.year)?.a.year ?? yearHint, lastMonth = -1;
  axis.forEach(l => {
    if (l.a.kind !== 'month' || l.a.year) { if (l.a.year) year = l.a.year; lastMonth = l.a.month ?? lastMonth; return; }
    if (lastMonth >= 0 && l.a.month < lastMonth) year++;
    lastMonth = l.a.month;
    l.a = axisLabel(l.it.text, year);
  });
  // labels as boxes (left edge = first day) or as centered captions
  const centers = axis.map(l => l.it.x + l.it.w / 2);
  const gaps = centers.slice(1).map((c, i) => c - centers[i]);
  const boxes = median(axis.map(l => l.it.w)) >= median(gaps) * 0.7;
  const pts = [];
  axis.forEach(l => {
    if (boxes) { pts.push([l.it.x, l.a.from], [l.it.x + l.it.w, l.a.to]); }
    else pts.push([l.it.x + l.it.w / 2, (l.a.from + l.a.to) / 2]);
  });
  // Piecewise: each month box (or gap between label centers) has its own scale, since months differ
  // in length but are often drawn the same width. Beyond the ends, the end segments carry on.
  pts.sort((a, b) => a[0] - b[0]);
  const seg = pts.filter((p, i) => i === 0 || p[0] - pts[i - 1][0] > 0.5);
  if (seg.length < 2 || seg.some((p, i) => i && p[1] <= seg[i - 1][1])) return null;
  const dayAt = x => {
    let i = seg.findIndex(p => p[0] >= x);
    if (i <= 0) i = i === 0 ? 1 : seg.length - 1;
    const [x0, d0] = seg[i - 1], [x1, d1] = seg[i];
    return d0 + (x - x0) * (d1 - d0) / (x1 - x0);
  };
  const axisItems = new Set(axis.map(l => l.it));
  const axisBottom = Math.max(...axis.map(l => l.it.y + l.it.h));
  const left = Math.min(...axis.map(l => l.it.x)), right = Math.max(...axis.map(l => l.it.x + l.it.w));
  const span = right - left;

  // bars and milestones below the axis, inside its width
  const marks = items.filter(it => !axisItems.has(it) && it.y >= axisBottom - 2 && it.prst && it.w > 0 && it.h > 0
    && it.x >= left - span * 0.05 && it.x + it.w <= right + span * 0.05 && it.w < span * 0.98).map(it => {
    const ms = MILESTONE.test(it.prst) && it.w < span * 0.06 && Math.abs(it.w - it.h) < Math.max(it.w, it.h) * 0.6;
    return BAR.test(it.prst) || ms ? { it, ms } : null;
  }).filter(Boolean).filter(m => m.ms || (m.it.h < m.it.w * 1.5 && m.it.w > span * 0.005));
  // drop tall boxes that wrap several bars (swimlane backgrounds); keep their text as a group name
  const lanes = [];
  const bars = marks.filter(m => {
    const inside = marks.filter(o => o !== m && o.it.y >= m.it.y - 1 && o.it.y + o.it.h <= m.it.y + m.it.h + 1 && o.it.x >= m.it.x - 1 && o.it.x + o.it.w <= m.it.x + m.it.w + 1);
    if (inside.length) { if (m.it.text) lanes.push(m.it); return false; }
    return true;
  });
  if (!bars.length) return null;

  const used = new Set();
  const nameFor = m => {
    const own = m.it.text?.trim();
    if (own && !axisLabel(own, year)) return own;
    const cy = m.it.y + m.it.h / 2;
    const near = texts.filter(t => !axisItems.has(t) && !bars.some(b => b.it === t) && !lanes.includes(t)
      && Math.abs(t.y + t.h / 2 - cy) < Math.max(t.h, m.it.h) * 0.6);
    const before = near.filter(t => t.x + t.w <= m.it.x + 2).sort((a, b) => b.x + b.w - (a.x + a.w))[0];
    const after = near.filter(t => t.x >= m.it.x + m.it.w - 2).sort((a, b) => a.x - b.x)[0];
    const pick = before || after;
    if (pick) used.add(pick);
    return pick?.text.trim() || '';
  };
  const tasks = bars.map(m => {
    let from = Math.round(dayAt(m.it.x)), to = Math.round(dayAt(m.it.x + m.it.w)) - 1;
    if (m.ms) from = to = Math.floor(dayAt(m.it.x + m.it.w / 2));
    while (weekday(from) === 0 || weekday(from) === 6) from++;
    while (to > from && (weekday(to) === 0 || weekday(to) === 6)) to--;
    return { name: nameFor(m), y: m.it.y + m.it.h / 2, x: m.it.x, from, to: Math.max(from, to), ms: m.ms };
  });
  // section names: leftover text in the label column, or swimlane captions
  const groups = [
    ...texts.filter(t => !used.has(t) && !axisItems.has(t) && !bars.some(b => b.it === t) && t.y >= axisBottom - 2 && t.x + t.w <= left + 2)
      .map(t => ({ name: t.text.trim(), y: t.y + t.h / 2, top: t.y, bottom: null })),
    ...lanes.map(l => ({ name: l.text.trim(), y: l.y, top: l.y, bottom: l.y + l.h })),
  ].filter(g => g.name);
  groups.sort((a, b) => a.top - b.top);
  groups.forEach((g, i) => { if (g.bottom == null) g.bottom = groups[i + 1]?.top ?? Infinity; });
  const iso = d => new Date(d * 864e5).toISOString().slice(0, 10);
  const out = [], ind = [];
  const inGroup = (t, g) => t.y >= g.top && t.y < g.bottom;
  const loose = tasks.filter(t => !groups.some(g => inGroup(t, g)));
  const order = [...groups.map(g => ({ g, y: g.top })), ...loose.map(t => ({ t, y: t.y }))].sort((a, b) => a.y - b.y);
  order.forEach(o => {
    if (o.t) { out.push([o.t.name, iso(o.t.from), iso(o.t.to), o.t.ms ? '0' : '']); ind.push([0]); return; }
    const kids = tasks.filter(t => inGroup(t, o.g)).sort((a, b) => a.y - b.y || a.x - b.x);
    if (!kids.length) return;
    out.push([o.g.name, '', '', '']); ind.push([0]);
    kids.forEach(t => { out.push([t.name, iso(t.from), iso(t.to), t.ms ? '0' : '']); ind.push([1]); });
  });
  return { rows: [['Name', 'Start', 'Finish', 'Duration'], ...out], indents: [[], ...ind], guess: ['start', 'finish'] };
}

