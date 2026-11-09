// Primavera P6 in: XER (P6's tab-separated export) and P6 XML. Both are read into the same plain
// shape first, then built into a project: WBS nodes become summary tasks, activities sit under
// them, and links, constraints, progress, calendar and resources come across.
import { dateKey, WorkCalendar } from '../calendar.js';
import { createResource, createTask, newProject, normalizeLevels } from '../model.js';
import { kid, kids, parseXML, txt } from './files.js';

const LINK = { PR_FS: 'FS', PR_SS: 'SS', PR_FF: 'FF', PR_SF: 'SF',
  'finish to start': 'FS', 'start to start': 'SS', 'finish to finish': 'FF', 'start to finish': 'SF' };
const CSTR = { CS_MSOA: 'SNET', CS_MSOB: 'SNLT', CS_MEOA: 'FNET', CS_MEOB: 'FNLT', CS_MSO: 'MSO', CS_MEO: 'MFO',
  CS_MANDSTART: 'MSO', CS_MANDFIN: 'MFO', CS_ALAP: 'ALAP',
  'start on or after': 'SNET', 'start on or before': 'SNLT', 'finish on or after': 'FNET', 'finish on or before': 'FNLT',
  'start on': 'MSO', 'finish on': 'MFO', 'mandatory start': 'MSO', 'mandatory finish': 'MFO', 'as late as possible': 'ALAP' };
const TYPE = { TT_Task: 'task', TT_Rsrc: 'task', TT_Mile: 'start', TT_FinMile: 'finish', TT_LOE: 'loe', TT_WBS: 'wbs',
  'task dependent': 'task', 'resource dependent': 'task', 'start milestone': 'start', 'finish milestone': 'finish',
  'level of effort': 'loe', 'wbs summary': 'wbs' };
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// "2027-01-04 08:00" or "2027-01-04T08:00:00" -> floating minutes.
function when(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) / 60000 : null;
}
const hours = s => { const v = parseFloat(s); return Number.isFinite(v) ? Math.round(v * 60) : 0; };
const number = s => { const v = parseFloat(s); return Number.isFinite(v) ? v : 0; };
// P6 writes the end of a shift as 16:59 or 17:00, and midnight as 00:00.
function clock(s, end) {
  const m = String(s || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let v = +m[1] * 60 + +m[2];
  if (end && (v === 0 || v % 60 === 59)) v = v === 0 ? 1440 : v + 1;
  return v;
}
function tidy(ranges) {
  const out = [];
  ranges.filter(([a, b]) => a != null && b != null && b > a).sort((x, y) => x[0] - y[0]).forEach(r => {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else out.push([...r]);
  });
  return out;
}

// ---------------------------------------------------------------- shared build

function build(src) {
  const warnings = [...src.warnings];
  const project = newProject({ name: src.name || 'Imported from P6' });
  if (src.calendar && src.calendar.week.some(r => r.length)) project.calendar = src.calendar;
  else warnings.push("The P6 calendar couldn't be read, so the standard Monday to Friday calendar is used.");
  const cal = new WorkCalendar(project.calendar);
  const weekMinutes = project.calendar.week.reduce((s, r) => s + r.reduce((a, [f, t]) => a + t - f, 0), 0);
  const workDays = project.calendar.week.filter(r => r.length).length || 5;
  project.minutesPerDay = src.hoursPerDay > 0 ? Math.round(src.hoursPerDay * 60) : Math.round(weekMinutes / workDays) || 480;
  project.minutesPerWeek = weekMinutes || project.minutesPerDay * 5;
  const first = src.acts.map(a => a.as ?? a.start).filter(t => t != null).sort((a, b) => a - b)[0];
  project.start = cal.nextWorkStart(src.start ?? first ?? project.start);
  if (src.dataDate != null) project.statusDate = src.dataDate;

  // WBS tree, activities grouped under their node, earliest first
  const wbsIds = new Set(src.wbs.map(w => w.id));
  const childWbs = new Map(), actsOf = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  src.wbs.forEach(w => push(childWbs, wbsIds.has(w.parent) ? w.parent : null, w));
  src.acts.forEach(a => push(actsOf, wbsIds.has(a.wbs) ? a.wbs : null, a));
  childWbs.forEach(list => list.sort((a, b) => a.seq - b.seq || String(a.code).localeCompare(b.code, undefined, { numeric: true })));
  const key = a => a.as ?? a.start ?? Infinity;
  actsOf.forEach(list => list.sort((a, b) => key(a) - key(b) || String(a.code).localeCompare(b.code, undefined, { numeric: true })));
  const hasActs = id => (actsOf.get(id) || []).length > 0 || (childWbs.get(id) || []).some(w => hasActs(w.id));

  const idOf = new Map(), resOf = new Map();
  let odd = 0;
  const addAct = (a, level) => {
    const ms = a.type === 'start' || a.type === 'finish';
    if (a.type === 'loe' || a.type === 'wbs') odd++;
    const t = createTask(project, {
      name: a.name || a.code || 'Activity', level, milestone: ms, duration: ms ? 0 : Math.max(0, a.duration),
      percent: Math.max(0, Math.min(100, Math.round(a.pct))), actualStart: a.as, actualFinish: a.af,
      constraint: { type: a.cType || 'ASAP', date: a.cType && a.cType !== 'ALAP' ? a.cDate : null },
      notes: a.code ? `Activity ID: ${a.code}` : '', activityId: a.code || '',
    });
    if (t.constraint.type !== 'ASAP' && t.constraint.type !== 'ALAP' && t.constraint.date == null) t.constraint = { type: 'ASAP', date: null };
    if (t.duration === 0 && !ms) t.milestone = true;
    project.tasks.push(t);
    idOf.set(a.id, t.id);
  };
  // at each level, WBS nodes keep P6's order and loose activities slot in by date
  const startOf = id => Math.min(...(actsOf.get(id) || []).map(key), ...(childWbs.get(id) || []).map(w => startOf(w.id)));
  const addLevel = (parent, level) => {
    const acts = actsOf.get(parent) || [];
    let i = 0;
    (childWbs.get(parent) || []).filter(w => hasActs(w.id)).forEach(w => {
      const k = startOf(w.id);
      while (i < acts.length && key(acts[i]) < k) addAct(acts[i++], level);
      project.tasks.push(createTask(project, { name: w.name || w.code || 'WBS', level }));
      addLevel(w.id, level + 1);
    });
    while (i < acts.length) addAct(acts[i++], level);
  };
  addLevel(null, 1);
  if (odd) warnings.push(`${odd} level-of-effort or WBS summary ${odd > 1 ? 'activities' : 'activity'} came in as normal tasks.`);

  let lost = 0;
  const seen = new Set();
  src.rels.forEach(r => {
    const from = idOf.get(r.pred), to = idOf.get(r.succ);
    if (from == null || to == null || from === to) { lost++; return; }
    if (seen.has(`${from}-${to}`)) return;
    seen.add(`${from}-${to}`);
    project.tasks.find(t => t.id === to).preds.push({ id: from, type: r.type || 'FS', lag: r.lag || 0 });
  });
  if (lost) warnings.push(`${lost} link${lost > 1 ? 's' : ''} to activities outside this project ${lost > 1 ? 'were' : 'was'} left out.`);

  src.resources.forEach(r => {
    const res = createResource(project, { name: r.name, type: r.type, initials: r.short || '', rate: r.rate || 0 });
    project.resources.push(res);
    resOf.set(r.id, res.id);
  });
  src.asg.forEach(a => {
    const t = project.tasks.find(x => x.id === idOf.get(a.act)), rid = resOf.get(a.res);
    if (t && rid != null && !t.assignments.some(x => x.resourceId === rid)) t.assignments.push({ resourceId: rid, units: a.units || 1 });
  });
  normalizeLevels(project.tasks);
  if (!project.tasks.length) throw new Error('No activities were found in this P6 file.');
  return { project, warnings };
}

// Percent complete the way P6 shows it: physical when that's the type, else by duration.
function progress(status, type, physical, planned, remaining, scale = 1) {
  if (/complete/i.test(status) && !/not/i.test(status)) return 100;
  if (/phys/i.test(type)) return physical * scale;
  if (/not/i.test(status) || !planned) return 0;
  return Math.max(0, (1 - remaining / planned) * 100);
}

const mostUsed = list => {
  const n = new Map();
  list.filter(Boolean).forEach(v => n.set(v, (n.get(v) || 0) + 1));
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0];
};

// ---------------------------------------------------------------- XER

export function readXER(text) {
  const tables = {};
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split('\t');
    if (cells[0] === '%T') tables[cells[1]] = cur = { fields: [], rows: [] };
    else if (cells[0] === '%F' && cur) cur.fields = cells.slice(1).map(f => f.trim());
    else if (cells[0] === '%R' && cur) {
      const row = {};
      cur.fields.forEach((f, i) => { row[f] = (cells[i + 1] ?? '').trim(); });
      cur.rows.push(row);
    }
  }
  return tables;
}

// clndr_data is nested "(0||name(attributes)(children))" nodes.
function clndrTree(data) {
  const s = String(data).replace(/[\x7f\s]/g, '');
  let i = 0;
  const node = () => {
    if (s[i] !== '(') throw new Error('calendar');
    i = s.indexOf('||', i) + 2;
    const open = s.indexOf('(', i), name = s.slice(i, open);
    const close = s.indexOf(')', open), attrs = s.slice(open + 1, close).split('|');
    i = close + 1;
    const children = [];
    if (s[i] === '(') {
      i++;
      while (s[i] === '(') children.push(node());
      if (s[i++] !== ')') throw new Error('calendar');
    }
    if (s[i++] !== ')') throw new Error('calendar');
    const a = {};
    for (let k = 0; k + 1 < attrs.length; k += 2) a[attrs[k]] = attrs[k + 1];
    return { name, a, children };
  };
  return node();
}
const findNode = (n, name) => n.name === name ? n : n.children.map(c => findNode(c, name)).find(Boolean);
const shifts = n => tidy(n.children.map(r => [clock(r.a.s), clock(r.a.f, true)]));

export function xerCalendar(row) {
  if (!row?.clndr_data) return null;
  try {
    const root = clndrTree(row.clndr_data);
    const days = findNode(root, 'DaysOfWeek'), exc = findNode(root, 'Exceptions');
    const week = [[], [], [], [], [], [], []];
    (days?.children || []).forEach(d => { const k = +d.name - 1; if (k >= 0 && k < 7) week[k] = shifts(d); });
    const exceptions = (exc?.children || []).filter(e => e.a.d).map(e => ({
      date: dateKey(Math.round(+e.a.d) - 25569), name: '', ranges: shifts(e) }));
    return { name: row.clndr_name || 'P6 calendar', week, exceptions };
  } catch { return null; }
}

export function importXER(text) {
  if (!/^\s*ERMHDR/.test(text)) throw new Error("This doesn't look like a Primavera P6 XER file.");
  const tb = readXER(text), rows = n => tb[n]?.rows || [];
  const tasks = rows('TASK');
  const projects = rows('PROJECT').filter(p => p.project_flag !== 'N');
  if (!projects.length) throw new Error('This XER file has no project in it.');
  const count = id => tasks.filter(t => t.proj_id === id).length;
  const proj = projects.slice().sort((a, b) => count(b.proj_id) - count(a.proj_id))[0];
  const warnings = [];
  if (projects.length > 1) warnings.push(`This file holds ${projects.length} projects. Opened ${proj.proj_short_name}, the largest.`);
  const pid = proj.proj_id, mine = tasks.filter(t => t.proj_id === pid);

  const cals = rows('CALENDAR');
  const calId = mostUsed(mine.map(t => t.clndr_id)) || proj.clndr_id;
  const calRow = cals.find(c => c.clndr_id === calId) || cals.find(c => c.clndr_id === proj.clndr_id) || cals.find(c => c.default_flag === 'Y') || cals[0];
  const used = new Set(mine.map(t => t.clndr_id).filter(Boolean));
  if (used.size > 1) warnings.push(`Activities use ${used.size} calendars. They all use "${calRow?.clndr_name}" here.`);

  const wbsRows = rows('PROJWBS').filter(w => w.proj_id === pid);
  const root = wbsRows.find(w => w.proj_node_flag === 'Y');
  const rates = new Map();
  rows('RSRCRATE').forEach(r => { if (!rates.has(r.rsrc_id)) rates.set(r.rsrc_id, number(r.cost_per_qty)); });
  const ids = new Set(mine.map(t => t.task_id));
  const asg = rows('TASKRSRC').filter(a => ids.has(a.task_id));
  const usedRes = new Set(asg.map(a => a.rsrc_id));

  return build({
    warnings,
    name: root?.wbs_name || proj.proj_short_name,
    start: when(proj.plan_start_date), dataDate: when(proj.last_recalc_date || proj.next_data_date),
    hoursPerDay: number(calRow?.day_hr_cnt), calendar: xerCalendar(calRow),
    wbs: wbsRows.filter(w => w !== root).map(w => ({ id: w.wbs_id, parent: w.parent_wbs_id, name: w.wbs_name,
      code: w.wbs_short_name, seq: number(w.seq_num) })),
    acts: mine.map(t => {
      const planned = hours(t.target_drtn_hr_cnt), remaining = hours(t.remain_drtn_hr_cnt);
      return {
        id: t.task_id, code: t.task_code, name: t.task_name, wbs: t.wbs_id, type: TYPE[t.task_type] || 'task',
        duration: planned || remaining,
        pct: progress(t.status_code === 'TK_Complete' ? 'complete' : t.status_code === 'TK_NotStart' ? 'not started' : 'active',
          t.complete_pct_type, number(t.phys_complete_pct), planned, remaining),
        as: when(t.act_start_date), af: when(t.act_end_date),
        cType: CSTR[t.cstr_type] || null, cDate: when(t.cstr_date),
        start: when(t.early_start_date || t.target_start_date || t.restart_date),
      };
    }),
    rels: rows('TASKPRED').filter(r => ids.has(r.task_id)).map(r => ({
      pred: r.pred_task_id, succ: r.task_id, type: LINK[r.pred_type] || 'FS', lag: hours(r.lag_hr_cnt) })),
    resources: rows('RSRC').filter(r => usedRes.has(r.rsrc_id)).map(r => ({ id: r.rsrc_id, name: r.rsrc_name,
      short: r.rsrc_short_name, type: r.rsrc_type === 'RT_Mat' ? 'material' : 'work', rate: rates.get(r.rsrc_id) || 0 })),
    asg: asg.map(a => ({ act: a.task_id, res: a.rsrc_id,
      units: number(a.target_qty_per_hr) || number(a.remain_qty_per_hr) || 1 })),
  });
}

// ---------------------------------------------------------------- P6 XML

function xmlCalendar(el) {
  if (!el) return null;
  const week = [[], [], [], [], [], [], []];
  const times = n => tidy(kids(n, 'WorkTime').map(w => [clock(txt(w, 'Start')), clock(txt(w, 'Finish'), true)]));
  kids(kid(el, 'StandardWorkWeek'), 'StandardWorkHours').forEach(h => {
    const k = WEEKDAYS.indexOf(txt(h, 'DayOfWeek').toLowerCase());
    if (k >= 0) week[k] = times(h);
  });
  const exceptions = kids(kid(el, 'HolidayExceptions'), 'HolidayException').map(h => {
    const d = when(txt(h, 'Date'));
    return d == null ? null : { date: dateKey(Math.floor(d / 1440)), name: '', ranges: times(h) };
  }).filter(Boolean);
  return { name: txt(el, 'Name') || 'P6 calendar', week, exceptions, hoursPerDay: number(txt(el, 'HoursPerDay')) };
}

export function isP6XML(text) { return /<APIBusinessObjects[\s>]/.test(text.slice(0, 5000)); }

export function importP6XML(text) {
  const root = parseXML(text, 'P6 XML file').documentElement;
  if (root.localName !== 'APIBusinessObjects') throw new Error("This doesn't look like a Primavera P6 XML file.");
  const projects = kids(root, 'Project');
  if (!projects.length) throw new Error('This P6 XML file has no project in it.');
  const proj = projects.slice().sort((a, b) => kids(b, 'Activity').length - kids(a, 'Activity').length)[0];
  const warnings = [];
  if (projects.length > 1) warnings.push(`This file holds ${projects.length} projects. Opened ${txt(proj, 'Id') || txt(proj, 'Name')}, the largest.`);
  const acts = kids(proj, 'Activity');

  const cals = [...kids(root, 'Calendar'), ...kids(proj, 'Calendar')];
  const calId = mostUsed(acts.map(a => txt(a, 'CalendarObjectId'))) || txt(proj, 'ActivityDefaultCalendarObjectId');
  const calEl = cals.find(c => txt(c, 'ObjectId') === calId) || cals.find(c => txt(c, 'IsDefault') === 'true') || cals[0];
  const calendar = xmlCalendar(calEl);
  const used = new Set(acts.map(a => txt(a, 'CalendarObjectId')).filter(Boolean));
  if (used.size > 1) warnings.push(`Activities use ${used.size} calendars. They all use "${calendar?.name}" here.`);

  const ids = new Set(acts.map(a => txt(a, 'ObjectId')));
  const asg = [...kids(root, 'ResourceAssignment'), ...kids(proj, 'ResourceAssignment')].filter(a => ids.has(txt(a, 'ActivityObjectId')));
  const usedRes = new Set(asg.map(a => txt(a, 'ResourceObjectId')));
  const pctScale = acts.some(a => number(txt(a, 'PhysicalPercentComplete')) > 1) ? 1 : 100;

  return build({
    warnings,
    name: txt(proj, 'Name') || txt(proj, 'Id'),
    start: when(txt(proj, 'PlannedStartDate')), dataDate: when(txt(proj, 'DataDate')),
    hoursPerDay: calendar?.hoursPerDay, calendar,
    wbs: kids(proj, 'WBS').map(w => ({ id: txt(w, 'ObjectId'), parent: txt(w, 'ParentObjectId'), name: txt(w, 'Name'),
      code: txt(w, 'Code'), seq: number(txt(w, 'SequenceNumber')) })),
    acts: acts.map(a => {
      const planned = hours(txt(a, 'PlannedDuration')), remaining = hours(txt(a, 'RemainingDuration'));
      return {
        id: txt(a, 'ObjectId'), code: txt(a, 'Id'), name: txt(a, 'Name'), wbs: txt(a, 'WBSObjectId'),
        type: TYPE[txt(a, 'Type').toLowerCase()] || 'task',
        duration: planned || hours(txt(a, 'AtCompletionDuration')) || remaining,
        pct: progress(txt(a, 'Status'), txt(a, 'PercentCompleteType'), number(txt(a, 'PhysicalPercentComplete')), planned, remaining, pctScale),
        as: when(txt(a, 'ActualStartDate')), af: when(txt(a, 'ActualFinishDate')),
        cType: CSTR[txt(a, 'PrimaryConstraintType').toLowerCase()] || null, cDate: when(txt(a, 'PrimaryConstraintDate')),
        start: when(txt(a, 'StartDate') || txt(a, 'PlannedStartDate')),
      };
    }),
    rels: [...kids(root, 'Relationship'), ...kids(proj, 'Relationship')].map(r => ({
      pred: txt(r, 'PredecessorActivityObjectId'), succ: txt(r, 'SuccessorActivityObjectId'),
      type: LINK[txt(r, 'Type').toLowerCase()] || 'FS', lag: hours(txt(r, 'Lag')) }))
      .filter(r => ids.has(r.succ) || ids.has(r.pred)),
    resources: kids(root, 'Resource').filter(r => usedRes.has(txt(r, 'ObjectId'))).map(r => ({
      id: txt(r, 'ObjectId'), name: txt(r, 'Name'), short: txt(r, 'Id'),
      type: /material/i.test(txt(r, 'ResourceType')) ? 'material' : 'work', rate: number(txt(r, 'PricePerUnit')) })),
    asg: asg.map(a => ({ act: txt(a, 'ActivityObjectId'), res: txt(a, 'ResourceObjectId'),
      units: number(txt(a, 'PlannedUnitsPerTime')) || 1 })),
  });
}
