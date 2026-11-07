// Project data: creating tasks, the outline, edits that keep the outline valid, and the text
// formats people type into the grid (durations, dates, predecessors, resource assignments).
import { DAY, dayIndex, standardCalendar, WorkCalendar } from './calendar.js';

export const FORMAT = 'scaled-schedule';
export const VERSION = 1;
export const LINK_TYPES = ['FS', 'SS', 'FF', 'SF'];
export const CONSTRAINTS = {
  ASAP: 'As soon as possible', ALAP: 'As late as possible',
  SNET: 'Start no earlier than', SNLT: 'Start no later than',
  FNET: 'Finish no earlier than', FNLT: 'Finish no later than',
  MSO: 'Must start on', MFO: 'Must finish on',
};

// Today at midnight, in floating minutes.
export function todayMinutes() {
  const n = new Date();
  return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) / 60000;
}

export function newProject({ name = 'Untitled project', start } = {}) {
  const calendar = standardCalendar();
  const cal = new WorkCalendar(calendar);
  return {
    format: FORMAT, version: VERSION, name,
    start: cal.nextWorkStart(start ?? todayMinutes()),
    statusDate: null,
    calendar,
    minutesPerDay: 480, minutesPerWeek: 2400, daysPerMonth: 20,
    currency: '$',
    nextId: 1,
    tasks: [],
    resources: [],
  };
}

export function createTask(project, props = {}) {
  return {
    id: project.nextId++,
    name: '',
    level: 1,
    duration: project.minutesPerDay,
    milestone: false,
    constraint: { type: 'ASAP', date: null },
    percent: 0,
    notes: '',
    preds: [],
    assignments: [],
    fixedCost: 0,
    baseline: null,
    actualStart: null,
    actualFinish: null,
    collapsed: false,
    ...props,
  };
}

export function createResource(project, props = {}) {
  return {
    id: project.nextId++, name: '', type: 'work', initials: '', group: '',
    maxUnits: 1, rate: 0, costPerUse: 0, ...props,
  };
}

// ---------------------------------------------------------------- outline

// Levels must start at 1 and never jump more than one step deeper than the row above.
export function normalizeLevels(tasks) {
  let prev = 0;
  for (const t of tasks) {
    t.level = Math.max(1, Math.min(Math.round(t.level) || 1, prev + 1));
    prev = t.level;
  }
}

// Index just past the last descendant of task i.
export function subtreeEnd(tasks, i) {
  let j = i + 1;
  while (j < tasks.length && tasks[j].level > tasks[i].level) j++;
  return j;
}

export function outline(tasks) {
  const parent = new Array(tasks.length).fill(-1);
  const summary = new Array(tasks.length).fill(false);
  const wbs = new Array(tasks.length);
  const stack = [];
  let counters = [];
  tasks.forEach((t, i) => {
    while (stack.length && tasks[stack[stack.length - 1]].level >= t.level) stack.pop();
    parent[i] = stack.length ? stack[stack.length - 1] : -1;
    stack.push(i);
    summary[i] = i + 1 < tasks.length && tasks[i + 1].level > t.level;
    counters = counters.slice(0, t.level);
    counters[t.level - 1] = (counters[t.level - 1] || 0) + 1;
    wbs[i] = counters.join('.');
  });
  return { parent, summary, wbs };
}

export function indexOfId(project, id) { return project.tasks.findIndex(t => t.id === id); }

// ---------------------------------------------------------------- edits

export function insertTask(project, index, props = {}) {
  const ts = project.tasks;
  index = Math.max(0, Math.min(index, ts.length));
  const level = props.level ?? (ts[index]?.level ?? ts[index - 1]?.level ?? 1);
  const t = createTask(project, { ...props, level });
  ts.splice(index, 0, t);
  normalizeLevels(ts);
  return t;
}

export function deleteTasks(project, ids) {
  const ts = project.tasks, drop = new Set();
  ids.forEach(id => {
    const i = indexOfId(project, id);
    if (i < 0) return;
    for (let j = i; j < subtreeEnd(ts, i); j++) drop.add(ts[j].id);
  });
  project.tasks = ts.filter(t => !drop.has(t.id));
  project.tasks.forEach(t => { t.preds = t.preds.filter(p => !drop.has(p.id)); });
  normalizeLevels(project.tasks);
  return drop.size;
}

function selectedRoots(project, ids) {
  const set = new Set(ids), ts = project.tasks, roots = [];
  for (let i = 0; i < ts.length; i++) {
    if (!set.has(ts[i].id)) continue;
    roots.push(i);
    i = subtreeEnd(ts, i) - 1;           // its children move with it
  }
  return roots;
}

export function indent(project, ids) {
  const ts = project.tasks;
  let changed = 0;
  for (const i of selectedRoots(project, ids)) {
    if (i === 0 || ts[i - 1].level < ts[i].level) continue;
    for (let j = i; j < subtreeEnd(ts, i); j++) ts[j].level++;
    changed++;
  }
  normalizeLevels(ts);
  dropFamilyLinks(project);
  return changed;
}

export function outdent(project, ids) {
  const ts = project.tasks;
  let changed = 0;
  for (const i of selectedRoots(project, ids)) {
    if (ts[i].level <= 1) continue;
    for (let j = i; j < subtreeEnd(ts, i); j++) ts[j].level--;
    changed++;
  }
  normalizeLevels(ts);
  return changed;
}

// Move each selected block (with its children) past its neighbouring sibling block.
export function moveBlock(project, ids, dir) {
  const ts = project.tasks;
  const roots = selectedRoots(project, ids);
  if (!roots.length) return false;
  const first = roots[0], end = subtreeEnd(ts, roots[roots.length - 1]);
  const level = ts[first].level;
  if (roots.some(i => ts[i].level !== level)) return false;
  const block = ts.slice(first, end);
  if (dir < 0) {
    let k = first - 1;
    while (k >= 0 && ts[k].level > level) k--;
    if (k < 0 || ts[k].level < level) return false;
    ts.splice(first, block.length);
    ts.splice(k, 0, ...block);
  } else {
    if (end >= ts.length || ts[end].level < level) return false;
    const nextEnd = subtreeEnd(ts, end);
    const moved = ts.splice(first, block.length);
    ts.splice(nextEnd - block.length, 0, ...moved);
  }
  normalizeLevels(ts);
  return true;
}

// A task can't be linked to its own summary or its own children.
export function isFamily(project, aId, bId) {
  const ts = project.tasks, a = indexOfId(project, aId), b = indexOfId(project, bId);
  if (a < 0 || b < 0) return true;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return hi < subtreeEnd(ts, lo);
}

function dropFamilyLinks(project) {
  project.tasks.forEach(t => { t.preds = t.preds.filter(p => !isFamily(project, p.id, t.id)); });
}

export function linkTasks(project, ids, type = 'FS') {
  const order = ids.map(id => indexOfId(project, id)).filter(i => i >= 0).sort((a, b) => a - b);
  let made = 0;
  for (let k = 1; k < order.length; k++) {
    const pred = project.tasks[order[k - 1]], succ = project.tasks[order[k]];
    if (isFamily(project, pred.id, succ.id) || succ.preds.some(p => p.id === pred.id)) continue;
    succ.preds.push({ id: pred.id, type, lag: 0 });
    made++;
  }
  return made;
}

export function addLink(project, predId, succId, type = 'FS', lag = 0) {
  if (predId === succId || isFamily(project, predId, succId)) return false;
  const succ = project.tasks.find(t => t.id === succId);
  if (!succ || succ.preds.some(p => p.id === predId)) return false;
  succ.preds.push({ id: predId, type, lag });
  return true;
}

export function unlinkTasks(project, ids) {
  const set = new Set(ids);
  let removed = 0;
  project.tasks.forEach(t => {
    const before = t.preds.length;
    t.preds = t.preds.filter(p => !(set.size === 1 ? set.has(p.id) || set.has(t.id) : set.has(p.id) && set.has(t.id)));
    removed += before - t.preds.length;
  });
  return removed;
}

// ---------------------------------------------------------------- text formats

const UNIT = { m: 1, min: 1, h: 60, hr: 60, d: 'day', dy: 'day', w: 'week', wk: 'week', mo: 'month', mon: 'month' };

function unitMinutes(u, project) {
  const key = (u || 'd').toLowerCase().replace(/s$/, '').replace(/^minute$/, 'min').replace(/^hour$/, 'h')
    .replace(/^day$/, 'd').replace(/^week$/, 'w').replace(/^month$/, 'mo');
  const v = UNIT[key];
  if (v === undefined) return null;
  if (v === 'day') return project.minutesPerDay;
  if (v === 'week') return project.minutesPerWeek;
  if (v === 'month') return project.minutesPerDay * project.daysPerMonth;
  return v;
}

// "5", "5d", "2 weeks", "4h", "1.5d" -> working minutes (null if it can't be read).
export function parseDuration(text, project) {
  const m = String(text).trim().match(/^(\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)\s*\??$/i);
  if (!m) return null;
  const per = unitMinutes(m[2], project);
  return per === null ? null : Math.round(parseFloat(m[1]) * per);
}

const trim = n => String(Math.round(n * 100) / 100);

export function formatDuration(minutes, project) {
  const days = minutes / project.minutesPerDay;
  return `${trim(days)} ${Math.abs(days) === 1 ? 'day' : 'days'}`;
}

// "+2d", "-1d", "3", "+4h" -> working minutes.
export function parseLag(text, project) {
  const m = String(text).replace(/\s+/g, '').match(/^([+-]?)(\d+(?:\.\d+)?)([a-z]*)$/i);
  if (!m) return null;
  const per = unitMinutes(m[3], project);
  return per === null ? null : (m[1] === '-' ? -1 : 1) * Math.round(parseFloat(m[2]) * per);
}

export function formatLag(minutes, project) {
  if (!minutes) return '';
  const sign = minutes < 0 ? '-' : '+', a = Math.abs(minutes);
  return a % project.minutesPerDay === 0 || a >= project.minutesPerDay
    ? `${sign}${trim(a / project.minutesPerDay)}d` : `${sign}${trim(a / 60)}h`;
}

// "3", "5SS", "7FF+2d" (row numbers) -> links. Throws with a readable message.
export function parsePreds(text, project) {
  const out = [];
  for (const part of String(text).split(/[,;]/).map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*(FS|SS|FF|SF)?\s*([+-].*)?$/i);
    if (!m) throw new Error(`Can't read "${part}". Use a row number, like 3 or 5SS+2d.`);
    const task = project.tasks[parseInt(m[1], 10) - 1];
    if (!task) throw new Error(`There is no row ${m[1]}.`);
    const lag = m[3] ? parseLag(m[3], project) : 0;
    if (lag === null) throw new Error(`Can't read the lag in "${part}".`);
    out.push({ id: task.id, type: (m[2] || 'FS').toUpperCase(), lag });
  }
  return out;
}

export function formatPreds(task, project, rowOf) {
  return task.preds.map(p => {
    const row = rowOf.get(p.id);
    if (!row) return '';
    const type = p.type === 'FS' && !p.lag ? '' : p.type;
    return `${row}${type}${formatLag(p.lag, project)}`;
  }).filter(Boolean).join(', ');
}

// "Matthew[50%], Office Admin" -> assignments, creating any new resources by name.
export function parseAssignments(text, project) {
  const out = [], created = [];
  for (const part of String(text).split(/[,;]/).map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^(.*?)\s*(?:\[\s*(\d+(?:\.\d+)?)\s*%?\s*\])?$/);
    const name = m[1].trim();
    if (!name) continue;
    let r = project.resources.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!r) {
      r = createResource(project, { name, initials: initialsOf(name) });
      project.resources.push(r);
      created.push(name);
    }
    if (!out.some(a => a.resourceId === r.id)) out.push({ resourceId: r.id, units: m[2] ? parseFloat(m[2]) / 100 : 1 });
  }
  return { assignments: out, created };
}

export function formatAssignments(task, resById) {
  return task.assignments.map(a => {
    const r = resById.get(a.resourceId);
    if (!r) return '';
    return Math.abs(a.units - 1) < 1e-9 || r.type !== 'work' ? r.name : `${r.name}[${trim(a.units * 100)}%]`;
  }).filter(Boolean).join(', ');
}

export function initialsOf(name) {
  return name.split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 3).toUpperCase();
}

// ---------------------------------------------------------------- dates

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];
export { MON, MONTH, WD };

const asDate = t => new Date(t * 60000);

export function fmtDate(t) {
  if (t == null) return '';
  const d = asDate(t);
  return `${WD[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}/${String(d.getUTCFullYear()).slice(2)}`;
}

export function fmtDateTime(t) {
  if (t == null) return '';
  const d = asDate(t);
  const h = d.getUTCHours(), mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${fmtDate(t)} ${h % 12 || 12}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
}

export function fmtDateLong(t) {
  const d = asDate(t);
  return `${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function isoDay(t) { return asDate(t).toISOString().slice(0, 10); }

// "2027-01-04", "1/4/27", "1/4/2027", "Jan 4 2027", "Mon 1/4/27" -> day index (null if unreadable).
export function parseDay(text, refYear) {
  const s = String(text).trim().replace(/^(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?\s+/i, '');
  let y, mo, d, m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/))) {
    [mo, d] = [+m[1], +m[2]];
    y = m[3] ? +m[3] : refYear;
    if (y < 100) y += 2000;
  } else if ((m = s.match(/^([a-z]{3,})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i))) {
    mo = MON.findIndex(x => m[1].toLowerCase().startsWith(x.toLowerCase())) + 1;
    [d, y] = [+m[2], m[3] ? +m[3] : refYear];
  } else if ((m = s.match(/^(\d{1,2})\s+([a-z]{3,})\.?(?:,?\s+(\d{4}))?$/i))) {
    mo = MON.findIndex(x => m[2].toLowerCase().startsWith(x.toLowerCase())) + 1;
    [d, y] = [+m[1], m[3] ? +m[3] : refYear];
  } else return null;
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y > 1900)) return null;
  const ms = Date.UTC(y, mo - 1, d);
  if (new Date(ms).getUTCDate() !== d) return null;
  return Math.round(ms / 86400000);
}

export const yearOf = t => asDate(t).getUTCFullYear();
export const startOfDay = (day, cal) => day * DAY + cal.firstWorkMinute(day);
export const endOfDay = (day, cal) => day * DAY + cal.lastWorkMinute(day);
export { dayIndex };

export function fmtMoney(n, currency = '$') {
  const v = Math.round(n || 0);
  return `${v < 0 ? '-' : ''}${currency}${Math.abs(v).toLocaleString('en-US')}`;
}

export function fmtHours(minutes) {
  const h = Math.round((minutes / 60) * 10) / 10;
  return `${h.toLocaleString('en-US')} h`;
}
