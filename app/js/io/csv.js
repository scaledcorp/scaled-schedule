// CSV in and out, plus Jira: read a Jira issue CSV export, and write a CSV Jira's importer accepts.
import { createTask, formatAssignments, formatPreds, isoDay, newProject, normalizeLevels,
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

// Header lookup that tolerates Jira's naming ("Custom field (Epic Link)", duplicate columns, etc.).
function columns(header) {
  const norm = header.map(h => h.trim().toLowerCase());
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

export function importCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('The CSV file has no rows.');
  return isJiraCSV(rows) ? importJira(rows) : importPlainCSV(rows);
}

function importPlainCSV(rows) {
  const col = columns(rows[0]);
  const name = col('name', 'task name', 'task'), level = col('outline level', 'level');
  const durC = col('duration (days)', 'duration'), startC = col('start'), predC = col('predecessors');
  const resC = col('resources', 'resource names'), pctC = col('% complete', 'percent complete'), notesC = col('notes');
  if (name < 0) throw new Error('The CSV needs a "Name" column.');
  const project = newProject({ name: 'Imported from CSV' });
  const cal = new WorkCalendar(project.calendar);
  const warnings = [], body = rows.slice(1);
  body.forEach(r => {
    const d = durC >= 0 ? parseDuration(r[durC] || '1', project) : project.minutesPerDay;
    const t = createTask(project, {
      name: r[name] || '', level: level >= 0 ? parseInt(r[level], 10) || 1 : 1,
      duration: d ?? project.minutesPerDay, milestone: d === 0,
      percent: pctC >= 0 ? parseFloat(r[pctC]) || 0 : 0, notes: notesC >= 0 ? r[notesC] || '' : '',
    });
    if (startC >= 0 && r[startC]) {
      const day = parseDay(r[startC].slice(0, 10), new Date().getFullYear());
      if (day != null) t.constraint = { type: 'SNET', date: startOfDay(day, cal) };
    }
    project.tasks.push(t);
  });
  normalizeLevels(project.tasks);
  body.forEach((r, i) => {
    const t = project.tasks[i];
    if (predC >= 0 && r[predC]) {
      try { t.preds = parsePreds(r[predC], project); } catch (e) { warnings.push(`Row ${i + 1}: ${e.message}`); }
    }
    if (resC >= 0 && r[resC]) t.assignments = parseAssignments(r[resC], project).assignments;
    if (t.preds.length && t.constraint.type === 'SNET') t.constraint = { type: 'ASAP', date: null };
  });
  return { project, warnings };
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
