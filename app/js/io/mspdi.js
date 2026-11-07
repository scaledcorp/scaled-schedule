// Microsoft Project XML (MSPDI). Microsoft Project opens it directly, ProjectLibre opens it, and
// Primavera P6 Professional can import it.
import { dateKey, DAY, keyToDay, WorkCalendar } from '../calendar.js';
import { createResource, createTask, newProject, normalizeLevels } from '../model.js';

const LINK_OUT = { FF: 0, FS: 1, SF: 2, SS: 3 };
const LINK_IN = ['FF', 'FS', 'SF', 'SS'];
const CON_OUT = { ASAP: 0, ALAP: 1, MSO: 2, MFO: 3, SNET: 4, SNLT: 5, FNET: 6, FNLT: 7 };
const CON_IN = ['ASAP', 'ALAP', 'MSO', 'MFO', 'SNET', 'SNLT', 'FNET', 'FNLT'];
const RES_OUT = { material: 0, work: 1, cost: 2 };
const RES_IN = ['material', 'work', 'cost'];

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dt = t => new Date(t * 60000).toISOString().slice(0, 19);
const dur = m => `PT${Math.floor(m / 60)}H${Math.round(m % 60)}M0S`;
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;

export function exportMSPDI(project, computed) {
  const x = [], a = s => x.push(s);
  const c = computed.byId;
  a('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  a('<Project xmlns="http://schemas.microsoft.com/project">');
  a('<SaveVersion>14</SaveVersion>');
  a(`<Name>${esc(project.name)}</Name><Title>${esc(project.name)}</Title><Author>scaled Schedule</Author>`);
  a('<ScheduleFromStart>1</ScheduleFromStart>');
  a(`<StartDate>${dt(computed.start)}</StartDate><FinishDate>${dt(computed.finish)}</FinishDate>`);
  a(`<CurrencySymbol>${esc(project.currency)}</CurrencySymbol><CalendarUID>1</CalendarUID>`);
  a(`<MinutesPerDay>${project.minutesPerDay}</MinutesPerDay><MinutesPerWeek>${project.minutesPerWeek}</MinutesPerWeek>`);
  a(`<DaysPerMonth>${project.daysPerMonth}</DaysPerMonth><DurationFormat>7</DurationFormat><WorkFormat>2</WorkFormat>`);
  a('<NewTasksEffortDriven>0</NewTasksEffortDriven><DefaultTaskType>0</DefaultTaskType><WeekStartDay>1</WeekStartDay>');

  a('<Calendars><Calendar><UID>1</UID><Name>Standard</Name><IsBaseCalendar>1</IsBaseCalendar><WeekDays>');
  project.calendar.week.forEach((ranges, i) => {
    a(`<WeekDay><DayType>${i + 1}</DayType><DayWorking>${ranges.length ? 1 : 0}</DayWorking>`);
    if (ranges.length) a(`<WorkingTimes>${ranges.map(([f, t]) => `<WorkingTime><FromTime>${hhmm(f)}</FromTime><ToTime>${hhmm(t)}</ToTime></WorkingTime>`).join('')}</WorkingTimes>`);
    a('</WeekDay>');
  });
  for (const e of project.calendar.exceptions) {
    a(`<WeekDay><DayType>0</DayType><DayWorking>${e.ranges?.length ? 1 : 0}</DayWorking>`);
    a(`<TimePeriod><FromDate>${e.date}T00:00:00</FromDate><ToDate>${e.date}T23:59:00</ToDate></TimePeriod>`);
    if (e.ranges?.length) a(`<WorkingTimes>${e.ranges.map(([f, t]) => `<WorkingTime><FromTime>${hhmm(f)}</FromTime><ToTime>${hhmm(t)}</ToTime></WorkingTime>`).join('')}</WorkingTimes>`);
    a('</WeekDay>');
  }
  a('</WeekDays></Calendar></Calendars>');

  a('<Tasks>');
  project.tasks.forEach((t, i) => {
    const k = c.get(t.id), d = k.summary ? k.duration : (t.milestone ? 0 : t.duration);
    const con = t.constraint || { type: 'ASAP' };
    a('<Task>');
    a(`<UID>${t.id}</UID><ID>${i + 1}</ID><Name>${esc(t.name)}</Name><Type>0</Type><IsNull>0</IsNull>`);
    a(`<WBS>${k.wbs}</WBS><OutlineNumber>${k.wbs}</OutlineNumber><OutlineLevel>${t.level}</OutlineLevel><Priority>500</Priority>`);
    a(`<Start>${dt(k.es)}</Start><Finish>${dt(k.ef)}</Finish><Duration>${dur(d)}</Duration><DurationFormat>7</DurationFormat>`);
    a(`<Work>${dur(k.work)}</Work><Cost>${k.cost.toFixed(2)}</Cost><FixedCost>${(t.fixedCost || 0).toFixed(2)}</FixedCost>`);
    a(`<EffortDriven>0</EffortDriven><Milestone>${t.milestone && !k.summary ? 1 : 0}</Milestone><Summary>${k.summary ? 1 : 0}</Summary>`);
    a(`<Critical>${k.critical ? 1 : 0}</Critical><PercentComplete>${Math.round(k.percent)}</PercentComplete>`);
    a(`<TotalSlack>${Math.round(k.float * 10)}</TotalSlack><RemainingDuration>${dur(Math.round(d * (1 - k.percent / 100)))}</RemainingDuration>`);
    a(`<ConstraintType>${CON_OUT[con.type] ?? 0}</ConstraintType>`);
    if (con.date != null) a(`<ConstraintDate>${dt(con.date)}</ConstraintDate>`);
    if (t.actualStart != null) a(`<ActualStart>${dt(t.actualStart)}</ActualStart>`);
    if (t.actualFinish != null) a(`<ActualFinish>${dt(t.actualFinish)}</ActualFinish>`);
    a('<CalendarUID>-1</CalendarUID><Active>1</Active><Manual>0</Manual>');
    if (t.notes) a(`<Notes>${esc(t.notes)}</Notes>`);
    for (const p of t.preds) {
      a(`<PredecessorLink><PredecessorUID>${p.id}</PredecessorUID><Type>${LINK_OUT[p.type] ?? 1}</Type>`);
      a(`<CrossProject>0</CrossProject><LinkLag>${Math.round((p.lag || 0) * 10)}</LinkLag><LagFormat>7</LagFormat></PredecessorLink>`);
    }
    if (t.baseline) {
      const b = t.baseline;
      a(`<Baseline><Number>0</Number><Start>${dt(b.start)}</Start><Finish>${dt(b.finish)}</Finish>`);
      a(`<Duration>${dur(b.duration)}</Duration><Work>${dur(b.work || 0)}</Work><Cost>${(b.cost || 0).toFixed(2)}</Cost></Baseline>`);
    }
    a('</Task>');
  });
  a('</Tasks>');

  a('<Resources>');
  project.resources.forEach((r, i) => {
    a(`<Resource><UID>${r.id}</UID><ID>${i + 1}</ID><Name>${esc(r.name)}</Name><Type>${RES_OUT[r.type] ?? 1}</Type><IsNull>0</IsNull>`);
    a(`<Initials>${esc(r.initials)}</Initials><Group>${esc(r.group)}</Group><MaxUnits>${r.maxUnits ?? 1}</MaxUnits>`);
    a(`<StandardRate>${r.rate || 0}</StandardRate><StandardRateFormat>2</StandardRateFormat><CostPerUse>${r.costPerUse || 0}</CostPerUse>`);
    a('</Resource>');
  });
  a('</Resources>');

  a('<Assignments>');
  let uid = 1;
  project.tasks.forEach(t => {
    const k = c.get(t.id);
    if (k.summary) return;
    for (const asg of t.assignments) {
      const r = project.resources.find(x => x.id === asg.resourceId);
      if (!r) continue;
      const work = r.type === 'work' ? Math.round((t.milestone ? 0 : t.duration) * asg.units) : 0;
      a(`<Assignment><UID>${uid++}</UID><TaskUID>${t.id}</TaskUID><ResourceUID>${r.id}</ResourceUID>`);
      a(`<Start>${dt(k.es)}</Start><Finish>${dt(k.ef)}</Finish><Units>${asg.units}</Units>`);
      a(`<Work>${dur(work)}</Work><RemainingWork>${dur(work)}</RemainingWork></Assignment>`);
    }
  });
  a('</Assignments>');
  a('</Project>');
  return x.join('\n');
}

// ---------------------------------------------------------------- import

const kids = (el, name) => (el ? [...el.children].filter(n => n.localName === name) : []);
const kid = (el, name) => kids(el, name)[0];
const txt = (el, name, dflt = '') => kid(el, name)?.textContent.trim() ?? dflt;
const num = (el, name, dflt = 0) => { const v = parseFloat(txt(el, name, '')); return Number.isFinite(v) ? v : dflt; };

function parseDT(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000 : null;
}
function parseDur(s) {
  const m = String(s).match(/^-?PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  return m ? Math.round((+(m[1] || 0)) * 60 + +(m[2] || 0) + (+(m[3] || 0)) / 60) : 0;
}
const toMin = s => { const [h, m] = String(s).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
function times(el) {
  return kids(kid(el, 'WorkingTimes'), 'WorkingTime').map(w => {
    const f = toMin(txt(w, 'FromTime')), t = toMin(txt(w, 'ToTime'));
    return [f, t === 0 ? 1440 : t];
  }).filter(([f, t]) => t > f);
}

export function importMSPDI(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  if (!root || root.localName !== 'Project' || doc.querySelector('parsererror')) {
    throw new Error("This doesn't look like a Microsoft Project XML file.");
  }
  const warnings = [];
  const project = newProject({ name: txt(root, 'Title') || txt(root, 'Name') || 'Imported project' });
  project.minutesPerDay = num(root, 'MinutesPerDay', 480) || 480;
  project.minutesPerWeek = num(root, 'MinutesPerWeek', 2400) || 2400;
  project.daysPerMonth = num(root, 'DaysPerMonth', 20) || 20;
  project.currency = txt(root, 'CurrencySymbol') || '$';
  const start = parseDT(txt(root, 'StartDate'));

  // calendar
  const calUid = txt(root, 'CalendarUID', '1');
  const cals = kids(kid(root, 'Calendars'), 'Calendar');
  const calEl = cals.find(cl => txt(cl, 'UID') === calUid) || cals[0];
  if (calEl) {
    const week = [[], [], [], [], [], [], []], exceptions = [];
    for (const wd of kids(kid(calEl, 'WeekDays'), 'WeekDay')) {
      const type = num(wd, 'DayType', -1), working = txt(wd, 'DayWorking') === '1';
      if (type >= 1 && type <= 7) week[type - 1] = working ? times(wd) : [];
      else if (type === 0) {
        const tp = kid(wd, 'TimePeriod');
        addException(exceptions, txt(tp, 'FromDate'), txt(tp, 'ToDate'), working ? times(wd) : []);
      }
    }
    for (const ex of kids(kid(calEl, 'Exceptions'), 'Exception')) {
      const tp = kid(ex, 'TimePeriod');
      addException(exceptions, txt(tp, 'FromDate'), txt(tp, 'ToDate'), txt(ex, 'DayWorking') === '1' ? times(ex) : [], txt(ex, 'Name'));
    }
    if (week.some(r => r.length)) project.calendar = { name: txt(calEl, 'Name') || 'Standard', week, exceptions };
  }
  if (start != null) project.start = start;

  // resources
  const resMap = new Map();
  for (const r of kids(kid(root, 'Resources'), 'Resource')) {
    const uid = txt(r, 'UID'), name = txt(r, 'Name');
    if (uid === '0' || !name || txt(r, 'IsNull') === '1') continue;
    const res = createResource(project, {
      name, type: RES_IN[num(r, 'Type', 1)] || 'work', initials: txt(r, 'Initials'), group: txt(r, 'Group'),
      maxUnits: num(r, 'MaxUnits', 1) || 1, rate: num(r, 'StandardRate', 0), costPerUse: num(r, 'CostPerUse', 0),
    });
    project.resources.push(res);
    resMap.set(uid, res.id);
  }

  // tasks (UID 0 is Project's own summary row)
  const taskEls = kids(kid(root, 'Tasks'), 'Task')
    .filter(t => txt(t, 'UID') !== '0' && txt(t, 'IsNull') !== '1' && txt(t, 'OutlineLevel') !== '0')
    .sort((p, q) => num(p, 'ID') - num(q, 'ID'));
  const uidMap = new Map();
  const pending = [];
  const cal = new WorkCalendar(project.calendar);
  for (const el of taskEls) {
    const ms = txt(el, 'Milestone') === '1';
    // Simpler exporters (Inversion's timeline, for one) give only Start and Finish: work the duration
    // out from those, and keep the dates of unlinked tasks with a start-no-earlier-than constraint.
    const s0 = parseDT(txt(el, 'Start')), f0 = parseDT(txt(el, 'Finish'));
    const noDuration = !kid(el, 'Duration') && s0 != null && f0 != null;
    const keepDate = !kid(el, 'ConstraintType') && !kids(el, 'PredecessorLink').length && s0 != null && s0 > (start ?? s0);
    const con = CON_IN[num(el, 'ConstraintType', 0)] || 'ASAP';
    const conDate = parseDT(txt(el, 'ConstraintDate'));
    const baseline = kids(el, 'Baseline').find(b => txt(b, 'Number') === '0');
    const task = createTask(project, {
      name: txt(el, 'Name'), level: num(el, 'OutlineLevel', 1) || 1,
      duration: ms ? 0 : parseDur(txt(el, 'Duration', 'PT0H0M0S')), milestone: ms,
      constraint: { type: con, date: con === 'ASAP' || con === 'ALAP' ? null : conDate },
      percent: num(el, 'PercentComplete', 0), notes: txt(el, 'Notes'),
      actualStart: parseDT(txt(el, 'ActualStart')), actualFinish: parseDT(txt(el, 'ActualFinish')),
      fixedCost: num(el, 'FixedCost', 0),
      baseline: baseline ? { start: parseDT(txt(baseline, 'Start')), finish: parseDT(txt(baseline, 'Finish')),
        duration: parseDur(txt(baseline, 'Duration', 'PT0H0M0S')), work: parseDur(txt(baseline, 'Work', 'PT0H0M0S')),
        cost: num(baseline, 'Cost', 0) } : null,
    });
    if (noDuration && !ms) task.duration = Math.max(0, cal.workBetween(cal.nextWorkStart(s0), f0));
    if (keepDate) task.constraint = { type: 'SNET', date: s0 };
    if (task.duration === 0 && !ms && txt(el, 'Summary') !== '1') task.milestone = true;
    project.tasks.push(task);
    uidMap.set(txt(el, 'UID'), task.id);
    pending.push([task, el]);
  }
  for (const [task, el] of pending) {
    for (const pl of kids(el, 'PredecessorLink')) {
      const id = uidMap.get(txt(pl, 'PredecessorUID'));
      if (id === undefined) { warnings.push(`A link on "${task.name}" points to a task that isn't in the file.`); continue; }
      const lagFmt = num(pl, 'LagFormat', 7);
      let lag = Math.round(num(pl, 'LinkLag', 0) / 10);
      if ([19, 20].includes(lagFmt)) { lag = 0; warnings.push(`A percent lag on "${task.name}" was dropped.`); }
      task.preds.push({ id, type: LINK_IN[num(pl, 'Type', 1)] || 'FS', lag });
    }
  }
  for (const asg of kids(kid(root, 'Assignments'), 'Assignment')) {
    const tid = uidMap.get(txt(asg, 'TaskUID')), rid = resMap.get(txt(asg, 'ResourceUID'));
    const task = project.tasks.find(t => t.id === tid);
    if (task && rid !== undefined) task.assignments.push({ resourceId: rid, units: num(asg, 'Units', 1) });
  }
  normalizeLevels(project.tasks);
  return { project, warnings };
}

function addException(list, from, to, ranges, name = '') {
  const a = parseDT(from), b = parseDT(to);
  if (a == null || b == null) return;
  for (let d = Math.floor(a / DAY); d <= Math.floor((b - 1) / DAY) && list.length < 5000; d++) {
    list.push({ date: dateKey(d), name, ranges });
  }
}
export { keyToDay };
