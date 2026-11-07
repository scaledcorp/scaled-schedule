import { standardCalendar, usFederalHolidays, WorkCalendar } from '../app/js/calendar.js';
import { schedule } from '../app/js/scheduler.js';
import { createTask, indent, newProject, parseDuration, parsePreds, parseDay, insertTask, deleteTasks,
  outdent, moveBlock, linkTasks } from '../app/js/model.js';
import { hydrate } from '../app/js/store.js';
import { SAMPLE, SAMPLE_EXPECTED } from '../app/js/sample.js';
import { exportMSPDI, importMSPDI } from '../app/js/io/mspdi.js';
import { exportXER } from '../app/js/io/xer.js';
import { exportCSV, exportInversionCSV, exportJiraCSV, importCSV } from '../app/js/io/csv.js';
import { interpret, readDay } from '../app/js/ui/iguana.js';
import { exportInversionModel } from '../app/js/io/inversion.js';

const results = [];
const test = (name, fn) => { try { fn(); results.push([name, true]); } catch (e) { results.push([name, false, e.message]); } };
const eq = (a, b, msg = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const T = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 60000;
const show = t => new Date(t * 60000).toISOString().slice(0, 16);
const cal = new WorkCalendar(standardCalendar());

test('add work across lunch and the weekend', () => {
  eq(show(cal.addWork(T(2027, 1, 4, 8), 480)), '2027-01-04T17:00');
  eq(show(cal.addWork(T(2027, 1, 4, 8), 240)), '2027-01-04T12:00');
  eq(show(cal.addWork(T(2027, 1, 8, 13), 480)), '2027-01-11T12:00');
});
test('subtract work, snap and count', () => {
  eq(show(cal.subtractWork(T(2027, 1, 4, 17), 480)), '2027-01-04T08:00');
  eq(show(cal.subtractWork(T(2027, 1, 11, 8), 60)), '2027-01-08T16:00');
  eq(show(cal.nextWorkStart(T(2027, 1, 8, 17))), '2027-01-11T08:00');
  eq(show(cal.prevWorkEnd(T(2027, 1, 11, 8))), '2027-01-08T17:00');
  eq(cal.workBetween(T(2027, 1, 4, 8), T(2027, 1, 8, 17)), 2400);
});
test('holidays are skipped', () => {
  const c = new WorkCalendar({ ...standardCalendar(), exceptions: [{ date: '2027-01-05', ranges: [] }] });
  eq(show(c.addWork(T(2027, 1, 4, 8), 960)), '2027-01-06T17:00');
});
test('US federal holidays (observed dates)', () => {
  const h = Object.fromEntries(usFederalHolidays(2027).map(x => [x.name, x.date]));
  eq([h["New Year's Day"], h['Martin Luther King Jr. Day'], h['Memorial Day'], h['Independence Day'], h.Thanksgiving, h['Christmas Day']],
    ['2027-01-01', '2027-01-18', '2027-05-31', '2027-07-05', '2027-11-25', '2027-12-24']);
});

function mini(defs) {
  const p = newProject({ start: T(2027, 1, 4, 8) });
  defs.forEach(([name, days, level = 1]) => p.tasks.push(createTask(p, { name, level, duration: days * 480, milestone: days === 0 })));
  return p;
}
const at = (p, r, i) => { const k = r.byId.get(p.tasks[i].id); return [show(k.es), show(k.ef)]; };

test('finish-to-start chain and milestone', () => {
  const p = mini([['A', 2], ['B', 3], ['Done', 0]]);
  p.tasks[1].preds = [{ id: p.tasks[0].id, type: 'FS', lag: 0 }];
  p.tasks[2].preds = [{ id: p.tasks[1].id, type: 'FS', lag: 0 }];
  const r = schedule(p);
  eq(at(p, r, 1), ['2027-01-06T08:00', '2027-01-08T17:00']);
  eq(at(p, r, 2), ['2027-01-08T17:00', '2027-01-08T17:00']);
});
test('SS, FF, SF and lags', () => {
  const p = mini([['A', 5], ['SS+1d', 2], ['FF', 2], ['FS-2d', 3], ['SF', 1]]);
  const a = p.tasks[0].id;
  p.tasks[1].preds = [{ id: a, type: 'SS', lag: 480 }];
  p.tasks[2].preds = [{ id: a, type: 'FF', lag: 0 }];
  p.tasks[3].preds = [{ id: a, type: 'FS', lag: -960 }];
  p.tasks[4].preds = [{ id: p.tasks[1].id, type: 'SF', lag: 0 }];
  const r = schedule(p);
  eq(at(p, r, 1), ['2027-01-05T08:00', '2027-01-06T17:00']);
  eq(at(p, r, 2), ['2027-01-07T08:00', '2027-01-08T17:00']);
  eq(at(p, r, 3), ['2027-01-07T08:00', '2027-01-11T17:00']);
  eq(at(p, r, 4), ['2027-01-04T08:00', '2027-01-04T17:00']);
});
test('float and critical path on parallel paths', () => {
  const p = mini([['Long', 5], ['Short', 2], ['Join', 1]]);
  p.tasks[2].preds = [{ id: p.tasks[0].id, type: 'FS', lag: 0 }, { id: p.tasks[1].id, type: 'FS', lag: 0 }];
  const r = schedule(p);
  eq(r.byId.get(p.tasks[1].id).float, 3 * 480);
  eq([0, 1, 2].map(i => r.byId.get(p.tasks[i].id).critical), [true, false, true]);
});
test('constraints: SNET, MSO, FNLT warning', () => {
  const p = mini([['A', 2], ['B', 1], ['C', 1], ['D', 3]]);
  p.tasks[1].constraint = { type: 'SNET', date: T(2027, 1, 13, 8) };
  p.tasks[2].preds = [{ id: p.tasks[0].id, type: 'FS', lag: 0 }];
  p.tasks[2].constraint = { type: 'MSO', date: T(2027, 1, 4, 8) };
  p.tasks[3].constraint = { type: 'FNLT', date: T(2027, 1, 5, 17) };
  const r = schedule(p);
  eq(at(p, r, 1)[0], '2027-01-13T08:00');
  eq(at(p, r, 2)[0], '2027-01-04T08:00');
  eq(r.warnings.some(w => w.kind === 'constraint'), true);
});
test('summary rollup and links on summaries', () => {
  const p = mini([['Prep', 2], ['Phase', 0], ['Step 1', 1, 2], ['Step 2', 3, 2]]);
  p.tasks[1].milestone = false;
  p.tasks[1].preds = [{ id: p.tasks[0].id, type: 'FS', lag: 0 }];
  p.tasks[3].preds = [{ id: p.tasks[2].id, type: 'FS', lag: 0 }];
  const r = schedule(p);
  eq(at(p, r, 2), ['2027-01-06T08:00', '2027-01-06T17:00']);
  eq(at(p, r, 1), ['2027-01-06T08:00', '2027-01-11T17:00']);
  eq(r.byId.get(p.tasks[1].id).summary, true);
});
test('circular links are reported, not hung', () => {
  const p = mini([['A', 1], ['B', 1]]);
  p.tasks[0].preds = [{ id: p.tasks[1].id, type: 'FS', lag: 0 }];
  p.tasks[1].preds = [{ id: p.tasks[0].id, type: 'FS', lag: 0 }];
  eq(schedule(p).warnings[0].kind, 'cycle');
});
test('as late as possible', () => {
  const p = mini([['Long', 5], ['Late', 1], ['End', 0]]);
  p.tasks[1].constraint = { type: 'ALAP', date: null };
  p.tasks[2].preds = [{ id: p.tasks[0].id, type: 'FS', lag: 0 }, { id: p.tasks[1].id, type: 'FS', lag: 0 }];
  eq(at(p, schedule(p), 1), ['2027-01-08T08:00', '2027-01-08T17:00']);
});
test('Copperline sample matches the ProjectLibre-checked dates', () => {
  const p = hydrate(SAMPLE), r = schedule(p);
  let bad = 0, first = '';
  p.tasks.forEach(t => {
    const k = r.byId.get(t.id), [s, f] = SAMPLE_EXPECTED[t.id];
    if (k.es !== s || k.ef !== f) { bad++; first ||= `${t.name}: ${show(k.es)}-${show(k.ef)} vs ${show(s)}-${show(f)}`; }
  });
  eq(bad, 0, first);
  eq(show(r.finish), '2027-07-06T17:00');
});
test('outline edits: indent, outdent, move, delete', () => {
  const p = mini([['A', 1], ['B', 1], ['C', 1]]);
  indent(p, [p.tasks[1].id, p.tasks[2].id]);
  eq(p.tasks.map(t => t.level), [1, 2, 2]);
  outdent(p, [p.tasks[2].id]);
  eq(p.tasks.map(t => t.level), [1, 2, 1]);
  moveBlock(p, [p.tasks[2].id], -1);
  eq(p.tasks.map(t => t.name), ['C', 'A', 'B']);
  insertTask(p, 1, { name: 'New' });
  linkTasks(p, [p.tasks[0].id, p.tasks[1].id]);
  eq(p.tasks[1].preds.length, 1);
  deleteTasks(p, [p.tasks[0].id]);
  eq(p.tasks.map(t => t.name), ['New', 'A', 'B']);
  eq(p.tasks[0].preds.length, 0);
});
test('typing durations, links and dates', () => {
  const p = mini([['A', 1], ['B', 1]]);
  eq([parseDuration('5', p), parseDuration('2w', p), parseDuration('4h', p), parseDuration('0', p), parseDuration('x', p)], [2400, 4800, 240, 0, null]);
  eq(parsePreds('1SS+1d', p), [{ id: p.tasks[0].id, type: 'SS', lag: 480 }]);
  eq([parseDay('2027-01-04'), parseDay('1/4/27'), parseDay('Jan 4 2027'), parseDay('Mon 1/4/27')].every(d => d === T(2027, 1, 4) / 1440), true);
});
test('MS Project XML round trip', () => {
  const p = hydrate(SAMPLE), r = schedule(p);
  const { project: q, warnings } = importMSPDI(exportMSPDI(p, r));
  eq(warnings, []);
  eq(q.tasks.length, p.tasks.length);
  eq(q.tasks.reduce((s, t) => s + t.preds.length, 0), p.tasks.reduce((s, t) => s + t.preds.length, 0));
  eq(q.resources.length, p.resources.length);
  eq(show(schedule(q).finish), show(r.finish));
});
test('MS Project XML keeps holidays and constraints', () => {
  const p = mini([['A', 3]]);
  p.calendar.exceptions = usFederalHolidays(2027);
  p.tasks[0].constraint = { type: 'SNET', date: T(2027, 1, 15, 8) };
  const q = importMSPDI(exportMSPDI(p, schedule(p))).project;
  eq(q.calendar.exceptions.length, 11);
  eq(at(q, schedule(q), 0), ['2027-01-15T08:00', '2027-01-20T17:00']);
});
test('P6 XER export has every table and activity', () => {
  const p = hydrate(SAMPLE), r = schedule(p);
  const { text } = exportXER(p, r);
  ['PROJECT', 'CALENDAR', 'PROJWBS', 'TASK', 'TASKPRED', 'RSRC', 'TASKRSRC'].forEach(t => {
    if (!text.includes(`%T\t${t}\r\n`)) throw new Error(`missing ${t}`);
  });
  const taskRows = text.split('%T\tTASK\r\n')[1].split('%T\t')[0].split('\r\n').filter(l => l.startsWith('%R'));
  eq(taskRows.length, r.tasks.filter(k => !k.summary).length);
  eq(text.trim().endsWith('%E'), true);
});
test('CSV round trip and Jira import/export', () => {
  const p = hydrate(SAMPLE), r = schedule(p);
  const q = importCSV(exportCSV(p, r)).project;
  eq(q.tasks.length, p.tasks.length);
  eq(show(schedule(q).finish), show(r.finish));
  const jira = 'Summary,Issue key,Issue id,Issue Type,Status,Assignee,Original Estimate,Parent\r\n' +
    'Billing epic,BILL-1,100,Epic,To Do,,,\r\nInvoice page,BILL-2,101,Story,Done,Ana Diaz,28800,100\r\n' +
    'Tax rules,BILL-3,102,Story,To Do,,57600,100\r\n';
  const j = importCSV(jira).project;
  eq(j.tasks.map(t => [t.name, t.level, t.duration, t.percent]), [['Billing epic', 1, 480, 0], ['Invoice page', 2, 480, 100], ['Tax rules', 2, 960, 0]]);
  eq(j.resources[0].name, 'Ana Diaz');
  eq(exportJiraCSV(j, schedule(j)).split('\r\n')[2].startsWith('2,1,Invoice page,Task'), true);
});

test('Inversion CSV uses its column names and ; between links', () => {
  const p = hydrate(SAMPLE), r = schedule(p);
  const lines = exportInversionCSV(p, r).split('\r\n');
  eq(lines[0], 'ID,Title,Type,Start,End,Depends on,Resources,Notes');
  const multi = lines.find(l => /,"?\d+; \d+/.test(l));
  if (!multi) throw new Error('no multi-link row joined with "; "');
  eq(lines[1].startsWith('1,Sales and Scoping,Phase,2027-01-04,2027-01-28,'), true);
});
test('Project XML without durations (Inversion timeline export)', () => {
  const xml = '<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project"><Name>Inv</Name>' +
    '<StartDate>2027-01-04T08:00:00</StartDate><Tasks>' +
    '<Task><UID>1</UID><ID>1</ID><Name>Plan</Name><Start>2027-01-04T08:00:00</Start><Finish>2027-01-08T17:00:00</Finish><Milestone>0</Milestone></Task>' +
    '<Task><UID>2</UID><ID>2</ID><Name>Build</Name><Start>2027-01-11T08:00:00</Start><Finish>2027-01-12T17:00:00</Finish><Milestone>0</Milestone>' +
    '<PredecessorLink><PredecessorUID>1</PredecessorUID><Type>1</Type></PredecessorLink></Task>' +
    '<Task><UID>3</UID><ID>3</ID><Name>Review</Name><Start>2027-01-20T08:00:00</Start><Finish>2027-01-20T17:00:00</Finish><Milestone>0</Milestone></Task>' +
    '</Tasks></Project>';
  const q = importMSPDI(xml).project, r = schedule(q);
  eq(q.tasks.map(t => [t.duration / 480, t.milestone]), [[5, false], [2, false], [1, false]]);
  eq(at(q, r, 2), ['2027-01-20T08:00', '2027-01-20T17:00']);
});

test('Schedule Iguana: add, move, link and answer', () => {
  const p = mini([['Design', 2], ['Build', 3], ['Launch', 1]]);
  p.tasks[1].preds = [{ id: p.tasks[0].id, type: 'FS', lag: 0 }];
  p.tasks[2].preds = [{ id: p.tasks[1].id, type: 'FS', lag: 0 }];
  const ctx = () => ({ project: p, computed: schedule(p) });
  const add = interpret('add a 3-day testing task after Build and give it to Ana Diaz', ctx());
  eq(add.kind, 'plan');
  add.run(p, ctx().computed.calendar, ctx().computed);
  eq(p.tasks.map(t => t.name), ['Design', 'Build', 'Testing', 'Launch']);
  eq([p.tasks[2].duration, p.tasks[2].preds[0].id, p.resources[0].name], [1440, p.tasks[1].id, 'Ana Diaz']);
  interpret('link testing to launch', ctx()).run(p);
  eq(p.tasks[3].preds.length, 2);
  interpret('move Launch to Jan 25 2027', ctx()).run(p, ctx().computed.calendar);
  eq(show(schedule(p).byId.get(p.tasks[3].id).es), '2027-01-25T08:00');
  const crit = interpret("what's on the critical path?", ctx()).text;
  eq([crit.includes('"Launch"'), crit.includes('"Design"')], [true, false]);
  eq(interpret('when does the project finish?', ctx()).text, 'The project finishes Mon 1/25/27.');
  eq(interpret('why did launch move?', ctx()).text.includes('fixed date') || interpret('why did launch move?', ctx()).text.includes('waits for'), true);
  eq(interpret('make build 5 days', ctx()).lines[0], 'Make "Build" 5 days');
});

test('Schedule Iguana understands everyday wording', () => {
  const p = mini([['Design', 2], ['Build', 3], ['Launch', 1]]);
  p.tasks[1].preds = [{ id: p.tasks[0].id, type: 'FS', lag: 0 }];
  p.tasks[2].preds = [{ id: p.tasks[1].id, type: 'FS', lag: 0 }];
  const ctx = { project: p, computed: schedule(p) };
  const says = q => interpret(q, ctx);
  const add = says('hey iguana, can we fit in three days of testing once build is done, Ana will handle it');
  eq([add.kind, add.lines], ['plan', ['Add "Testing", 3 days, after "Build"', 'Assign Ana']]);
  eq(says('launch needs to slide to jan 25 2027').lines, ['Start "Launch" no earlier than Mon 1/25/27']);
  eq(says('push launch out to the 20th of jan 2027').kind === 'plan' || says('push launch out to jan 20 2027').kind === 'plan', true);
  eq(says('what could make us miss the deadline?').text.startsWith('The critical path'), true);
  eq(says("who's swamped right now").text, 'Nobody is over-booked.');
  eq(says('design got wrapped up yesterday').lines, ['Mark "Design" 100% done']);
  eq(says('build is going to take two weeks').lines, ['Make "Build" 10 days']);
  eq(says('design has to happen before launch').lines[0].startsWith('Link "Design" to "Launch"'), true);
  eq(says("launch can't start until build is done").lines[0].startsWith('Link "Build" to "Launch"'), true);
  eq(says('drop the launch').lines, ['Delete "Launch"']);
  eq(says('Ana will handle build').lines, ['Assign Ana to "Build"']);
  eq(says("what's holding up launch?").text.includes('waits for "Build"'), true);
  eq(says('when will we be done?').text.startsWith('The project finishes'), true);
  eq(readDay('next monday', 2027, Math.round(Date.UTC(2027, 0, 6) / 86400000)), Math.round(Date.UTC(2027, 0, 11) / 86400000));
});

test('Inversion model JSON: phases as clusters, goals, tasks and requires links', () => {
  const p = hydrate(SAMPLE), r = schedule(p);
  const f = JSON.parse(exportInversionModel(p, r, '2026-11-07T00:00:00.000Z'));
  eq([f.format, f.formatVersion, f.model.schemaVersion], ['inversion.model', 1, 1]);
  const m = f.model, ids = new Set(m.nodes.map(n => n.id));
  const type = id => m.nodeTypes.find(t => t.id === id)?.name ?? null;
  eq(m.nodes.length, p.tasks.length);
  eq(m.nodes.filter(n => n.cluster).length, r.tasks.filter((k, i) => k.summary && p.tasks[i].level === 1).length);
  eq(m.nodes.filter(n => type(n.typeId) === 'Goal').length, p.tasks.filter(t => t.milestone).length);
  eq(m.connections.length, p.tasks.reduce((s, t) => s + t.preds.length, 0));
  eq(m.connections.every(c => ids.has(c.sourceId) && ids.has(c.targetId)), true);
  eq(m.nodes.filter(n => n.containerId).every(n => m.nodes.find(x => x.id === n.containerId)?.cluster), true);
  const build = m.nodes.find(n => n.title === 'Client review and contract');
  eq([type(build.typeId), build.properties['task.start'], build.properties['task.end']], ['Task', '2027-01-19', '2027-01-28']);
});

const pass = results.filter(r => r[1]).length;
document.getElementById('summary').textContent = `${pass} of ${results.length} passed`;
document.getElementById('summary').className = pass === results.length ? 'ok' : 'bad';
document.getElementById('list').innerHTML = results.map(([n, ok, msg]) =>
  `<li class="${ok ? 'ok' : 'bad'}">${ok ? 'PASS' : 'FAIL'} ${n}${msg ? `<pre>${msg}</pre>` : ''}</li>`).join('');
window.testResults = { pass, total: results.length, failures: results.filter(r => !r[1]) };
