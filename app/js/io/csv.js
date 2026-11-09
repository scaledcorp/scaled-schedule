// CSV in and out, plus Jira: read a Jira issue CSV export, and write a CSV Jira's importer accepts.
import { createTask, endOfDay, formatAssignments, formatPreds, isoDay, newProject, normalizeLevels,
  parseAssignments, parseDay, parseDuration, parsePreds, startOfDay } from '../model.js';
import { WorkCalendar } from '../calendar.js';

export function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

const quote = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCSV = rows => rows.map(r => r.map(quote).join(',')).join('\r\n') + '\r\n';
const stamp = t => (t == null ? '' : new Date(t * 60000).toISOString().slice(0, 16).replace('T', ' '));

export function exportCSV(project, computed) {
  const rowOf = new Map(project.tasks.map((t, i) => [t.id, i + 1]));
  const resById = new Map(project.resources.map(r => [r.id, r]));
  const out = [['ID', 'WBS', 'Name', 'Outline Level', 'Duration (days)', 'Start', 'Finish', 'Predecessors',
    'Resources', '% Complete', 'Total Float (days)', 'Critical', 'Cost', 'Notes']];
  project.tasks.forEach((t, i) => {
    const k = computed.byId.get(t.id);
    out.push([i + 1, k.wbs, t.name, t.level, +(k.duration / project.minutesPerDay).toFixed(2), stamp(k.es), stamp(k.ef),
      formatPreds(t, project, rowOf), formatAssignments(t, resById), Math.round(k.percent),
      +(k.float / project.minutesPerDay).toFixed(2), k.critical ? 'Yes' : 'No', k.cost.toFixed(2), t.notes]);
  });
  return toCSV(out);
}

// Header lookup that tolerates Jira's naming ("Custom field (Epic Link)", duplicate columns, etc.)
// and spreadsheet headers split over two lines.
function columns(header) {
  const norm = header.map(h => String(h ?? '').replace(/\s+/g, ' ').trim().toLowerCase());
  return (...names) => {
    for (const n of names) {
      const i = norm.findIndex(h => h === n || h === `custom field (${n})`);
      if (i >= 0) return i;
    }
    return -1;
  };
}

export function isJiraCSV(rows) {
  const col = columns(rows[0] || []);
  return col('issue key') >= 0 && col('summary') >= 0;
}

export function importCSV(text, name) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('The CSV file has no rows.');
  return isJiraCSV(rows) ? importJira(rows) : importTable(rows, { name: name || 'Imported from CSV' });
}

const NAMES = ['name', 'task name', 'task', 'activity name', 'activity', 'task description', 'activity description',
  'description', 'title', 'item'];

// "2027-01-04", "1/4/27", "Mon 1/4/27 8:00 AM", "04-Jan-27 A" (P6 marks actual dates with A) -> day index.
function readDate(text) {
  let s = String(text ?? '').trim().replace(/\s*[A*]$/, '');
  if (!s) return null;
  s = s.replace(/^(\d{1,2})[- ]([a-z]{3,})[- ,]+(\d{2,4})\b/i, (m, d, mo, y) => `${d} ${mo} ${y.length === 2 ? 2000 + +y : y}`);
  return parseDay(s, new Date().getFullYear()) ?? parseDay(s.replace(/[ T]+\d{1,2}:\d{2}(:\d{2})?\s*([ap]m)?$/i, ''), new Date().getFullYear());
}

// Rows of cells with a header row (CSV, or a sheet read from Excel) -> project. Finds the header
// within the first rows, maps columns by name, reads links by row number or by Activity ID, and
// takes outline levels from a level column, unique WBS numbers, Excel row grouping or name indent.
// The fields a table column can hold, in the order the review screen lists them.
export const FIELDS = { name: 'Task name', id: 'Activity ID', dur: 'Duration', start: 'Start', finish: 'Finish',
  pred: 'Predecessors', pct: '% complete', res: 'Resources', notes: 'Notes', level: 'Outline level', wbs: 'WBS' };

// Header cells -> which column holds which field (-1 when there's none).
export function columnMap(header) {
  const col = columns(header);
  return {
    name: col(...NAMES), level: col('outline level', 'level', 'indent level'),
    wbs: col('wbs', 'outline number', 'wbs code'), id: col('activity id', 'task id', 'id', 'task code'),
    dur: col('duration (days)', 'duration', 'original duration', 'orig dur', 'orig duration', 'planned duration', 'days', 'duration (d)', 'rem dur', 'remaining duration'),
    start: col('start', 'start date', 'planned start', 'early start', 'begin'),
    finish: col('finish', 'finish date', 'end', 'end date', 'planned finish', 'early finish', 'due date', 'due'),
    pred: col('predecessors', 'predecessor', 'depends on', 'dependencies', 'preds'),
    res: col('resources', 'resource names', 'assigned to', 'owner', 'resource'),
    pct: col('% complete', 'percent complete', 'activity % complete', '% done', 'progress'),
    notes: col('notes', 'comments', 'remarks'),
  };
}
export const findHeader = rows => rows.slice(0, 20).findIndex(r => columns(r)(...NAMES) >= 0);

// options: name, outline / indents (per source row), extra warnings, map (field -> column, from the
// review screen), guess (fields to mark as guessed on every row, like dates read off a slide).
// Returns the project plus what the review screen needs: the header, the column map and, per task,
// the fields that were guessed.
export function importTable(rows, { name = 'Imported project', outline = [], indents = [], extra = [], map = null, guess = [] } = {}) {
  const head = Math.max(0, findHeader(rows));
  const C = map ? { ...Object.fromEntries(Object.keys(FIELDS).map(k => [k, -1])), ...map } : columnMap(rows[head] || []);
  if (C.name < 0) throw new Error("Couldn't find a task name column. Name one Task Name, Activity Name or Name.");
  const project = newProject({ name });
  const cal = new WorkCalendar(project.calendar);
  const warnings = [...extra], body = rows.slice(head + 1), at = i => head + 1 + i;
  const cell = (r, c) => (c >= 0 ? String(r[c] ?? '').trim() : '');
  const guessed = body.map(() => new Set(guess));
  const remC = columns(rows[head] || [])('remaining duration', 'rem dur', 'remaining');

  // outline levels
  const wbsVals = body.map(r => cell(r, C.wbs)).filter(Boolean);
  const wbsLevels = C.wbs >= 0 && wbsVals.length && new Set(wbsVals).size === wbsVals.length;
  const grouped = body.some((r, i) => outline[at(i)] > 0);
  const indented = C.name >= 0 && body.some((r, i) => indents[at(i)]?.[C.name] > 0);
  const levelOf = (r, i) => {
    if (C.level >= 0) return parseInt(cell(r, C.level), 10) || 1;
    if (wbsLevels && cell(r, C.wbs)) return cell(r, C.wbs).split('.').length;
    if (grouped) return (outline[at(i)] || 0) + 1;
    if (indented) return (indents[at(i)]?.[C.name] || 0) + 1;
    return 1;
  };

  const dates = [];
  body.forEach((r, i) => {
    const s = readDate(cell(r, C.start)), f = readDate(cell(r, C.finish)), g = guessed[i];
    if (s == null && cell(r, C.start)) g.add('start');
    if (f == null && cell(r, C.finish)) g.add('finish');
    if (!cell(r, C.name)) g.add('name');
    let d = cell(r, C.dur) ? parseDuration(cell(r, C.dur), project) : null;
    if (d == null && cell(r, C.dur)) g.add('dur');
    if (d == null && s != null && f != null) d = f < s ? 0 : cal.workBetween(startOfDay(s, cal), Math.max(startOfDay(s, cal), endOfDay(f, cal)));
    if (d == null && !(s != null && f != null)) g.add('dur');
    const pctText = cell(r, C.pct);
    let pct = parseFloat(pctText) || 0;
    if (!pctText.includes('%') && pct > 0 && pct < 1) pct *= 100;
    const t = createTask(project, {
      name: cell(r, C.name), level: levelOf(r, i), duration: d ?? project.minutesPerDay, milestone: d === 0,
      percent: Math.max(0, Math.min(100, pct)), notes: cell(r, C.notes),
    });
    if (cell(r, C.id) && C.id !== C.wbs && !/^\d+$/.test(cell(r, C.id))) t.activityId = cell(r, C.id);
    // only a finish date (a finish milestone, say): start it so that it ends that day
    const at = s != null ? startOfDay(s, cal) : f != null ? cal.subtractWork(endOfDay(f, cal), t.duration) : null;
    if (at != null) t.constraint = { type: 'SNET', date: at };
    dates.push([s ?? (at != null ? Math.floor(at / 1440) : null), f]);
    project.tasks.push(t);
  });
  normalizeLevels(project.tasks);

  // links: by row number, or by the ID column (or unique WBS codes) when there is one
  const rowOfId = new Map(), key = C.id >= 0 ? C.id : wbsLevels ? C.wbs : -1;
  if (key >= 0) body.forEach((r, i) => { const v = cell(r, key); if (v && !rowOfId.has(v)) rowOfId.set(v, i + 1); });
  const byId = text => text.split(/[,;]/).map(x => x.trim()).filter(Boolean).map(part => {
    const m = part.match(/^(.+?)\s*(FS|SS|FF|SF)?\s*([+-]\s*\d.*)?$/i);
    return m && rowOfId.has(m[1].trim()) ? `${rowOfId.get(m[1].trim())}${m[2] || ''}${(m[3] || '').replace(/\s+/g, '')}` : part;
  }).join(', ');
  let badLinks = 0;
  body.forEach((r, i) => {
    const t = project.tasks[i], [s, f] = dates[i];
    if (cell(r, C.pred)) {
      try { t.preds = parsePreds(byId(cell(r, C.pred)), project); } catch (e) { guessed[i].add('pred'); badLinks++; if (badLinks === 1) warnings.push(`Row ${i + 1}: ${e.message}`); }
    }
    if (cell(r, C.res)) t.assignments = parseAssignments(cell(r, C.res), project).assignments;
    // P6 prints an A after actual dates
    // P6 prints an A after actual dates; with a Remaining Duration column, progress follows from it
    const actual = c => /\sA$/.test(cell(r, c));
    if (C.pct < 0 && actual(C.start)) {
      const rem = remC >= 0 && remC !== C.dur ? parseDuration(cell(r, remC), project) : null;
      t.percent = actual(C.finish) || t.milestone ? 100 : rem != null && t.duration > 0 ? Math.max(0, Math.round((1 - rem / t.duration) * 100)) : t.percent;
    }
    if ((t.percent > 0 || actual(C.start)) && s != null) t.actualStart = startOfDay(s, cal);
    if (t.percent >= 100 && (f != null || t.milestone)) t.actualFinish = t.milestone ? t.actualStart : Math.max(t.actualStart ?? 0, endOfDay(f, cal));
    if (t.preds.length && t.constraint.type === 'SNET') t.constraint = { type: 'ASAP', date: null };
  });
  const first = dates.map(([s]) => s).filter(s => s != null).sort((a, b) => a - b)[0];
  if (first != null) project.start = startOfDay(first, cal);
  if (badLinks > 1) warnings.push(`${badLinks} rows had links that couldn't be read.`);
  if (!project.tasks.length) throw new Error('The table has a header but no task rows.');
  return { project, warnings, header: rows[head] || [], map: C, guessed };
}

// Jira CSV export -> epics become summary tasks, their issues sit under them, sub-tasks under their
// parent. Original estimate becomes the duration (one person full-time), assignee becomes a resource.
function importJira(rows) {
  const col = columns(rows[0]);
  const C = {
    key: col('issue key'), id: col('issue id'), summary: col('summary'), type: col('issue type'),
    status: col('status'), assignee: col('assignee'), estimate: col('original estimate', 'σ original estimate'),
    parent: col('parent', 'parent id'), parentKey: col('parent key'), epic: col('epic link', 'epic link summary'),
    desc: col('description'), due: col('due date', 'due'), start: col('start date', 'target start'),
  };
  const project = newProject({ name: 'Imported from Jira' });
  const warnings = [];
  const issues = rows.slice(1).map(r => ({
    key: r[C.key], id: C.id >= 0 ? r[C.id] : '', summary: r[C.summary] || r[C.key],
    type: (C.type >= 0 ? r[C.type] : '').trim(), status: C.status >= 0 ? r[C.status] : '',
    assignee: C.assignee >= 0 ? r[C.assignee] : '', estimate: C.estimate >= 0 ? parseFloat(r[C.estimate]) : NaN,
    parent: [C.parentKey, C.parent, C.epic].map(i => (i >= 0 ? (r[i] || '').trim() : '')).find(Boolean) || '',
    desc: C.desc >= 0 ? r[C.desc] : '',
  }));
  const byRef = new Map();
  issues.forEach(is => { byRef.set(is.key, is); if (is.id) byRef.set(is.id, is); });
  const children = new Map(), roots = [];
  issues.forEach(is => {
    const p = byRef.get(is.parent);
    if (p && p !== is) { if (!children.has(p.key)) children.set(p.key, []); children.get(p.key).push(is); }
    else roots.push(is);
  });
  roots.sort((a, b) => (b.type.toLowerCase() === 'epic') - (a.type.toLowerCase() === 'epic'));
  const done = /^(done|closed|resolved|complete)/i;
  const add = (is, level) => {
    const hours = Number.isFinite(is.estimate) ? is.estimate / 3600 : NaN;
    const minutes = Number.isFinite(hours) && hours > 0 ? Math.round(hours * 60) : project.minutesPerDay;
    const t = createTask(project, {
      name: is.summary, level, duration: minutes, percent: done.test(is.status) ? 100 : 0,
      notes: [is.key, is.desc].filter(Boolean).join('\n\n'), jiraKey: is.key,
    });
    if (is.assignee) t.assignments = parseAssignments(is.assignee, project).assignments;
    project.tasks.push(t);
    (children.get(is.key) || []).forEach(ch => add(ch, level + 1));
  };
  roots.forEach(is => add(is, 1));
  if (!issues.some(is => Number.isFinite(is.estimate))) {
    warnings.push('No original estimates were in the export, so every issue starts at 1 day.');
  }
  warnings.push('Jira has no dates for task order, so link the tasks (select them and press Ctrl+L) to build the schedule.');
  normalizeLevels(project.tasks);
  return { project, warnings };
}

// CSV for Inversion's "Import data" (inversion.jxzlabs.com): its own column names, so Title, ID and
// Depends on map themselves; links are row IDs joined with "; " (Inversion splits on ; or |).
export function exportInversionCSV(project, computed) {
  const rowOf = new Map(project.tasks.map((t, i) => [t.id, i + 1]));
  const resById = new Map(project.resources.map(r => [r.id, r]));
  const out = [['ID', 'Title', 'Type', 'Start', 'End', 'Depends on', 'Resources', 'Notes']];
  project.tasks.forEach((t, i) => {
    const k = computed.byId.get(t.id);
    out.push([i + 1, t.name, k.summary ? 'Phase' : t.milestone ? 'Milestone' : 'Task', isoDay(k.es), isoDay(k.ef),
      t.preds.map(p => rowOf.get(p.id)).filter(Boolean).join('; '), formatAssignments(t, resById), t.notes]);
  });
  return toCSV(out);
}

// CSV for Jira's "Import issues from CSV": summary tasks become Epics, the rest Tasks, with
// Issue Id / Parent Id so Jira rebuilds the hierarchy. Estimates are in seconds.
export function exportJiraCSV(project, computed) {
  const out = [['Issue Id', 'Parent Id', 'Summary', 'Issue Type', 'Description', 'Original Estimate',
    'Start date', 'Due date', 'Assignee']];
  const resById = new Map(project.resources.map(r => [r.id, r]));
  project.tasks.forEach((t, i) => {
    const k = computed.byId.get(t.id);
    const parentRow = k.parent ? project.tasks.findIndex(x => x.id === k.parent) + 1 : '';
    const assignee = t.assignments.map(a => resById.get(a.resourceId)?.name).filter(Boolean)[0] || '';
    out.push([i + 1, parentRow, t.name, k.summary ? 'Epic' : 'Task', t.notes,
      k.summary || t.milestone ? '' : Math.round(t.duration * 60), isoDay(k.es), isoDay(k.ef), assignee]);
  });
  return toCSV(out);
}
