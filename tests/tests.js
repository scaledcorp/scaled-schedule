import { standardCalendar, usFederalHolidays, WorkCalendar } from '../app/js/calendar.js';
import { schedule } from '../app/js/scheduler.js';
import { createTask, indent, newProject, parseDuration, parsePreds, parseDay, insertTask, deleteTasks,
  outdent, moveBlock, linkTasks } from '../app/js/model.js';
import { hydrate } from '../app/js/store.js';
import { SAMPLE, SAMPLE_EXPECTED } from './sample.js';
import { exportMSPDI, importMSPDI } from '../app/js/io/mspdi.js';
import { exportXER } from '../app/js/io/xer.js';
import { importP6XML, importXER } from '../app/js/io/p6.js';
import { importXLSX } from '../app/js/io/xlsx.js';
import { decodeText } from '../app/js/io/files.js';
import { importPDF } from '../app/js/io/pdf.js';
import { importDOCX, importPPTX } from '../app/js/io/office.js';
import { importImage } from '../app/js/io/ocr.js';
import { exportCSV, exportInversionCSV, exportJiraCSV, importCSV, importTable } from '../app/js/io/csv.js';
import { coach, Iguana, interpret, readDay } from '../app/js/ui/iguana.js';
import { exportInversionModel } from '../app/js/io/inversion.js';

const results = [];
const pending = [];
const test = (name, fn) => pending.push((async () => {
  try { await fn(); results.push([name, true]); } catch (e) { results.push([name, false, e.message]); }
})());
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

test('Schedule Iguana picks the closest command for loose wording', () => {
  const p = mini([['Design', 2], ['Build', 3], ['Testing', 2], ['Launch', 1]]);
  for (let i = 1; i < 4; i++) p.tasks[i].preds = [{ id: p.tasks[i - 1].id, type: 'FS', lag: 0 }];
  const ctx = { project: p, computed: schedule(p) };
  const read = q => { const r = interpret(q, ctx); return r.as || (r.lines && r.lines[0]) || r.text; };
  eq(read('Launch should probably go to March 3 2027'), 'move Launch to March 3 2027');
  eq(read('Build feels like it needs 2 more weeks'), 'make Build 2 weeks');
  eq(read('how long until launch is out the door'), 'when does Launch finish?');
  eq(read('stick a 3 day review after testing'), 'add Review 3 days after Testing');
  eq(read('design is wrapped, finally'), 'Design is done');
  eq(interpret('blue sky thinking', ctx).unknown, true);
  p.tasks.push(createTask(p, { name: 'Client review and contract' }));
  const ctx2 = { project: p, computed: schedule(p) };
  const r2 = interpret('stick a 2 day review after build', ctx2);
  eq([r2.as, r2.lines[0]], ['add Review 2 days after Build', 'Add "Review", 2 days, after "Build"']);
  eq(interpret('add Sign-off 1 day after Client review and contract', ctx2).lines[0], 'Add "Sign-off", 1 day, after "Client review and contract"');
});

test('Schedule Iguana adds several tasks, chains and phases in one request', () => {
  const p = mini([['Design', 2], ['Build', 3]]);
  p.tasks[1].preds = [{ id: p.tasks[0].id, type: 'FS', lag: 0 }];
  const ctx = () => ({ project: p, computed: schedule(p) });
  const run = q => { const r = interpret(q, ctx()); if (r.kind !== 'plan') throw new Error(`${q}: ${r.text}`); const c = schedule(p); r.run(p, c.calendar, c); return r; };
  run('add three new tasks');
  eq(p.tasks.slice(2).map(t => t.name), ['New task 1', 'New task 2', 'New task 3']);
  run('add review 2 days, sign-off and a handover milestone after Build for Ana');
  const [rv, so, ho] = ['Review', 'Sign-off', 'Handover'].map(n => p.tasks.find(t => t.name === n));
  eq([rv.duration, so.duration, ho.milestone, rv.preds[0].id === p.tasks[1].id, so.preds[0].id === p.tasks[1].id], [960, 480, true, true, true]);
  eq(p.resources.map(r => r.name), ['Ana']);
  run('add framing 3 days, then drywall 4 days, then paint 2 days');
  const [fr, dw, pt] = ['Framing', 'Drywall', 'Paint'].map(n => p.tasks.find(t => t.name === n));
  eq([dw.preds[0].id === fr.id, pt.preds[0].id === dw.id, dw.duration], [true, true, 1920]);
  const q = mini([]);
  const r = interpret('Create a schedule for the kitchen remodel: demo 3 days, then plumbing 2 days, then paint 2 days, inspection milestone.\nCloseout: punch list 2 days, final walkthrough milestone', { project: q, computed: schedule(q) });
  eq(r.kind, 'plan');
  r.run(q);
  eq(q.tasks.map(t => [t.name, t.level]), [['Kitchen remodel', 1], ['Demo', 2], ['Plumbing', 2], ['Paint', 2], ['Inspection', 2], ['Closeout', 1], ['Punch list', 2], ['Final walkthrough', 2]]);
  const s = schedule(q);
  eq(show(s.byId.get(q.tasks[6].id).es) > show(s.byId.get(q.tasks[4].id).es), true);
  eq(show(s.finish), '2027-01-14T17:00');
});

test('Schedule Iguana: gaps, same-time steps, start dates and people', () => {
  const p = mini([]);
  const ctx = () => ({ project: p, computed: schedule(p) });
  const run = q => { const r = interpret(q, ctx()); if (r.kind !== 'plan') throw new Error(`${q}: ${r.text}`); const c = schedule(p); r.run(p, c.calendar, c); return r; };
  const T = n => p.tasks.find(t => t.name === n);
  run('add framing 3 days, then wait 2 days, then drywall 4 days, then 1 day later paint 2 days');
  eq([T('Drywall').preds[0].id === T('Framing').id, T('Drywall').preds[0].lag, T('Paint').preds[0].lag], [true, 960, 480]);
  run('add rough-in 1 day, then plumbing 2 days and electrical 3 days at the same time, then insulation 2 days');
  eq([T('Plumbing').preds[0].id, T('Electrical').preds[0].id].every(id => id === T('Rough-in').id), true);
  eq(T('Insulation').preds.map(x => x.id).sort(), [T('Plumbing').id, T('Electrical').id].sort());
  run('Create a schedule for the deck starting Feb 1 2027: footings 2 days (Ana), then framing 3 days by Ben');
  const s = schedule(p);
  eq([T('Deck').level, T('Footings').level, show(s.byId.get(T('Footings').id).es)], [1, 2, '2027-02-01T08:00']);
  eq(['Footings', 'Framing'].map(n => p.resources.find(r => r.id === p.tasks.filter(t => t.name === n).pop().assignments[0].resourceId).name), ['Ana', 'Ben']);
  run('paint starts 3 days after drywall');
  eq(T('Paint').preds.find(x => x.id === T('Drywall').id).lag, 1440);
  run('start the project on Jan 11 2027');
  eq(show(p.start), '2027-01-11T08:00');
});

test('Schedule Iguana: hedges, deadlines, shifts, ASAP, tentative and "it"', () => {
  const p = mini([['Design', 2], ['Build', 4], ['Test', 2], ['Launch', 0]]);
  p.tasks[1].preds = [{ id: p.tasks[0].id, type: 'FS', lag: 0 }];
  const ctx = () => ({ project: p, computed: schedule(p) });
  const run = q => { const r = interpret(q, ctx()); if (r.kind !== 'plan') throw new Error(`${q}: ${r.text}`); const c = schedule(p); r.run(p, c.calendar, c); return r; };
  const T = n => p.tasks.find(t => t.name === n);
  run('make Build about 5 days');
  run('Test will take 3ish days');
  eq([T('Build').duration, T('Test').duration], [2400, 1440]);
  run('Build must be done by Jan 20 2027');
  eq([T('Build').constraint.type, show(T('Build').constraint.date)], ['FNLT', '2027-01-20T17:00']);
  run("Launch can't start before Feb 1 2027");
  eq([T('Launch').constraint.type, show(T('Launch').constraint.date)], ['SNET', '2027-02-01T08:00']);
  run('push Test by a week');
  eq(show(T('Test').constraint.date), '2027-01-11T08:00');
  run('pull Test in 2 days');
  eq(show(T('Test').constraint.date), '2027-01-07T08:00');
  run('start Test asap');
  eq(T('Test').constraint.type, 'ASAP');
  run('Design must be done before Test');
  eq(T('Test').preds.some(x => x.id === T('Design').id), true);
  run('add a tentative review 1 day after Build');
  run('maybe add sign-off after Review');
  eq([T('Review').notes, T('Sign-off').notes, T('Review').preds[0].id === T('Build').id], ['Tentative', 'Tentative', true]);
  // "it" and "them" mean what was just touched
  const fake = ids => ({ focusIds: ids, app: { project: p, store: { selection: new Set() } } });
  eq(Iguana.prototype.resolve.call(fake([T('Test').id]), 'push it 2 days'), 'push Test 2 days');
  eq(Iguana.prototype.resolve.call(fake([T('Review').id, T('Sign-off').id]), 'give them to Ana'), 'give Review to Ana\ngive Sign-off to Ana');
  eq(Iguana.prototype.resolve.call(fake([T('Test').id]), 'add QA this week and give it to Ana'), 'add QA this week and give it to Ana');
});

test('Schedule Iguana: planning sense (health, buffer, know-how, tips)', () => {
  const p = mini([['Design', 5], ['Build', 25], ['Paint', 5], ['Test', 3], ['Handover', 2], ['Launch', 0]]);
  for (let i = 1; i < p.tasks.length; i++) p.tasks[i].preds = [{ id: p.tasks[i - 1].id, type: 'FS', lag: 0 }];
  const ctx = () => ({ project: p, computed: schedule(p) });
  const run = q => { const r = interpret(q, ctx()); if (r.kind !== 'plan') throw new Error(`${q}: ${r.text}`); const c = schedule(p); r.run(p, c.calendar, c); return r; };
  const T = n => p.tasks.find(t => t.name === n);
  const h = interpret('are we on track?', ctx());
  eq([h.kind, h.list.length, h.suggestions[0]], ['answer', 3, 'add a schedule buffer']);
  eq(h.list.some(l => l.includes('no buffer')) && h.list.some(l => l.includes('"Test"')) && h.list.some(l => l.includes('"Build"')), true);
  eq(interpret('how should I estimate the build?', ctx()).text.includes('similar work really took'), true);
  eq(interpret('add a risk review after Build', ctx()).kind, 'plan');   // an edit, not a health question
  const before = schedule(p).finish;
  run('add a schedule buffer');
  const s = schedule(p), buf = T('Schedule buffer');
  eq([buf.duration, T('Launch').preds[0].id === buf.id, buf.preds[0].id === T('Handover').id], [480 * 4, true, true]);
  eq(s.calendar.workBetween(before, s.finish), 480 * 4);
  run('add 2 days of contingency before Handover');
  eq(p.tasks.filter(t => t.name === 'Schedule buffer').length, 2);
  // tips: a new phase without a finish line, then quiet once seen
  const c0 = schedule(p), had = new Set(p.tasks.map(t => t.id));
  run('Create a schedule for the punch list: walk-through 1 day, then fixes 3 days');
  const c1 = schedule(p), added = p.tasks.filter(t => !had.has(t.id)).map(t => t.id);
  const tip = coach(p, c1, { label: 'Add a phase', added, finishMoved: c1.finish - c0.finish });
  eq([tip.id, tip.say.startsWith('add a Punch list done milestone after ')], ['goal', true]);
  run(tip.say);
  eq(p.tasks.some(t => t.name === 'Punch list done' && t.milestone), true);
  eq(coach(p, c1, { added, seen: new Set(['goal']) })?.id, 'test');      // Test sits in the last quarter
  eq(coach(p, c1, { added, seen: new Set(['goal', 'test']) })?.id ?? null, null);
  eq(coach(p, schedule(p), { edited: [T('Build').id] }).id, 'long');
});

test('Schedule Iguana: what-if, finish sooner, typos, corrections and project controls', () => {
  const p = mini([['Design', 5], ['Build', 10], ['Paint', 5], ['Launch', 0], ['Permits', 2]]);
  for (let i = 1; i < 4; i++) p.tasks[i].preds = [{ id: p.tasks[i - 1].id, type: 'FS', lag: 0 }];
  const ctx = () => ({ project: p, computed: schedule(p) });
  const run = q => { const r = interpret(q, ctx()); if (r.kind !== 'plan') throw new Error(`${q}: ${r.text}`); const c = schedule(p); r.run(p, c.calendar, c); return r; };
  const T = n => p.tasks.find(t => t.name === n);
  const snap = JSON.stringify(p);
  // what if: answers without changing anything, offers the real command
  const w = interpret('what if Build slips a week?', ctx());
  eq([w.kind, w.text.includes('(+5 days)'), w.suggestions[0], JSON.stringify(p) === snap], ['answer', true, 'push Build out 1 week', true]);
  eq(interpret('what if Permits takes 6 days?', ctx()).text.includes('finish holds'), true);
  eq(interpret('if we cut Paint, when do we finish?', ctx()).text.includes('(−5 days)'), true);
  // finish sooner: ranked options that Iguana can run
  const s = interpret('how can we finish sooner?', ctx());
  eq(s.list, ['Start "Paint" 3 days before "Build" finishes (overlap): finish 3 days sooner',
    'Shorten "Build" from 10 days to 8 days (more people or overtime): finish 2 days sooner',
    'Shorten "Design" from 5 days to 4 days (more people or overtime): finish 1 day sooner']);
  run(s.suggestions.find(x => x.startsWith('start')));
  eq(T('Paint').preds[0].lag < 0 || T('Build').preds[0].lag < 0, true);
  // typos
  eq(interpret('make Biuld 9 days', ctx()).lines[0], 'Make "Build" 9 days');
  eq(interpret('when does Pnait finish?', ctx()).text.startsWith('"Paint" finishes'), true);
  // undo several
  eq(interpret('undo the last two', ctx()).count, 2);
  eq(interpret('undo everything you did', ctx()).count, 'all');
  // corrections rewrite the last request
  const fake = last => Object.assign(Object.create(Iguana.prototype), { last: { text: last, i: 0 }, app: { project: p, computed: schedule(p) } });
  eq(fake('add review 2 days after Build').fixUp('3 days').text, 'add review 3 days after Build');
  eq(fake('add review 2 days after Build').fixUp('after Paint').text, 'add review 2 days after Paint');
  eq(fake('move Launch to March 3').fixUp('March 10').text, 'move Launch to March 10');
  eq(fake('add review after Build and give it to Ana').fixUp('Ben').text, 'add review after Build and give it to Ben');
  eq(fake('move Launch to March 3').fixUp('call it Go-live').keep, true);
  // project controls
  eq(interpret('how far off the baseline are we?', ctx()).suggestions[0], 'save a baseline');
  run('save a baseline');
  eq(p.tasks.every(t => t.baseline), true);
  run('make Build 12 days');
  const v = interpret('how far off the baseline are we?', ctx());
  eq([v.text.startsWith('The finish is 2 days behind the baseline'), v.list[0].startsWith('"Build" finishes 2 days late')], [true, true]);
  T('Design').percent = 100; T('Build').percent = 50;
  const ev = interpret("what's our SPI as of Jan 22 2027?", ctx());
  eq([ev.text, ev.list[0]], ['Earned value as of Fri 1/22/27:', 'SPI 0.50, behind: 50% of the work planned by now is done']);
  const st = interpret('write a status update as of Jan 22 2027', ctx());
  eq([st.report.split('\n')[0], st.report.includes('Progress: 46% complete'), st.report.includes('In progress: Build (50%)')], ['Status as of Fri 1/22/27', true, true]);
});

// ---------------------------------------------------------------- dropping in schedule files
// The test files in tests/files are one small project, Pump House Upgrade, saved as a P6 XER (in
// the Windows encoding P6 uses, with its calendar quirks and a second project), a P6 XML, and an
// Excel sheet laid out like P6's "Export to Excel" with a title row and indented names.
const fixture = async f => (await fetch(`files/${f}`)).arrayBuffer();
const files = Promise.all(['pump-house.xer', 'pump-house-p6.xml', 'pump-house.xlsx'].map(fixture));
const rowsOf = p => {
  const r = schedule(p), row = id => p.tasks.findIndex(t => t.id === id) + 1;
  return p.tasks.map(t => [t.level, t.name, t.duration / 480, t.milestone, Math.round(t.percent), t.constraint.type,
    t.preds.map(x => `${row(x.id)}${x.type}${x.lag ? `+${x.lag / 480}` : ''}`).join(','), show(r.byId.get(t.id).ef)].join(' | '));
};
const PUMP_HOUSE = [
  '1 | Engineering | 1 | false | 0 | ASAP |  | 2027-02-05T17:00',
  '2 | Notice to proceed | 0 | true | 100 | ASAP |  | 2027-01-04T08:00',
  '2 | Design pump skid | 10 | false | 100 | ASAP | 2FS | 2027-01-15T17:00',
  '2 | Procure pumps | 15 | false | 33 | ASAP | 3FS | 2027-02-05T17:00',
  '1 | Project management | 30 | false | 33 | ASAP |  | 2027-02-12T17:00',
  '1 | Construction | 1 | false | 0 | ASAP |  | 2027-02-19T17:00',
  '2 | Mechanical | 1 | false | 0 | ASAP |  | 2027-02-18T17:00',
  '3 | Demolish old skid | 5 | false | 0 | ASAP | 4SS+5 | 2027-01-29T17:00',
  '3 | Set new pumps | 4 | false | 0 | ASAP | 4FS,8FS | 2027-02-11T17:00',
  '3 | Pipe and wire – Unit 2 | 6 | false | 0 | ASAP | 9SS+2 | 2027-02-18T17:00',
  '2 | Test and turnover | 3 | false | 0 | FNLT | 9FS,10FF+1 | 2027-02-19T17:00',
  '1 | Ready for service | 0 | true | 0 | ASAP | 11FS | 2027-02-19T17:00',
];
test('P6 XER import: WBS, links, progress, calendar, resources', async () => {
  const [xer] = await files;
  const { project: p, warnings } = importXER(decodeText(xer));
  eq(p.name, 'Pump House Upgrade');
  eq(rowsOf(p), PUMP_HOUSE);
  eq([p.calendar.week[1], p.calendar.exceptions.map(e => e.date)], [[[480, 720], [780, 1020]], ['2027-02-15']]);
  eq(p.resources.map(r => [r.name, r.type, r.rate]), [['Mechanical crew', 'work', 95], ['Pump set', 'material', 0]]);
  eq(p.tasks[8].assignments.length, 2);
  eq(warnings, ['This file holds 2 projects. Opened PHU-2027, the largest.', 'Activities use 2 calendars. They all use "Standard 5 Day" here.',
    '1 level-of-effort or WBS summary activity came in as normal tasks.', '1 link to activities outside this project was left out.']);
  // exporting back to XER keeps P6's Activity IDs
  const back = importXER(exportXER(p, schedule(p)).text).project;
  eq(back.tasks.filter(t => t.activityId).map(t => t.activityId).slice(0, 3), ['A1000', 'A1010', 'A1020']);
  eq(show(schedule(back).finish), '2027-02-19T17:00');
});
test('P6 XML import matches the XER', async () => {
  const [, xml] = await files;
  const { project: p, warnings } = importP6XML(decodeText(xml));
  eq(rowsOf(p), PUMP_HOUSE);
  eq(p.calendar.exceptions.map(e => e.date), ['2027-02-15']);
  eq(warnings.length, 2);
});
test('Excel import: title row, indented names, dates, percents, links by Activity ID', async () => {
  const [, , xlsx] = await files;
  const { project: p } = await importXLSX(xlsx, 'pump-house.xlsx');
  eq(p.name, 'pump-house');
  const rows = rowsOf(p);
  eq(rows.length, 12);
  eq([rows[0], rows[2], rows[7], rows[9]], [
    '1 | Project management | 30 | false | 33 | SNET |  | 2027-02-12T17:00',
    '2 | Notice to proceed | 0 | true | 100 | SNET |  | 2027-01-04T08:00',
    '3 | Demolish old skid | 5 | false | 0 | ASAP | 5SS+5 | 2027-01-29T17:00',
    '3 | Pipe and wire – Unit 2 | 6 | false | 0 | ASAP | 9SS+2 | 2027-02-17T17:00']);
  // a spreadsheet has no holiday calendar, so the finish lands a day earlier than in P6
  eq(show(schedule(p).finish), '2027-02-18T17:00');
});
test('CSV with only start and finish dates, P6 style', () => {
  const csv = 'Activity ID,Activity Name,Start,Finish,Predecessors\r\nA10,Survey,04-Jan-27 A,08-Jan-27 A,\r\n' +
    'A20,Grade,11-Jan-27,20-Jan-27,A10\r\nA30,Pour,21-Jan-27,21-Jan-27,"A20FS+1d"\r\n';
  const { project: p } = importCSV(csv);
  eq(p.tasks.map(t => [t.activityId, t.duration / 480, t.preds.length]), [['A10', 5, 0], ['A20', 8, 1], ['A30', 1, 1]]);
  eq(p.tasks[2].preds[0].lag, 480);
  eq(show(p.start), '2027-01-04T08:00');
});
// ---------------------------------------------------------------- schedules inside documents
// The same project again, as a P6-style PDF report (WBS bands, two pages, a Gantt area), a
// Project-style PDF (indented names, a name that wraps, links with lags), a slide with a table, a
// slide with a drawn timeline, and a Word table. Made with Edge, PowerPoint and Word.
const docs = Promise.all(['pump-house-p6.pdf', 'pump-house-project.pdf', 'pump-house-table.pptx',
  'pump-house-timeline.pptx', 'pump-house.docx'].map(fixture));
const brief = (p, guessed) => {
  const r = schedule(p), row = id => p.tasks.findIndex(t => t.id === id) + 1;
  return p.tasks.map((t, i) => [t.level, t.name, t.milestone ? 'M' : t.duration / 480, t.activityId || '',
    t.preds.map(x => `${row(x.id)}${x.type}${x.lag ? `+${x.lag / 480}` : ''}`).join(','),
    show(r.byId.get(t.id).es).slice(5, 10), show(r.byId.get(t.id).ef).slice(5, 10), [...(guessed?.[i] || [])].join('/')].join(' | '));
};
test('PDF printed from P6: WBS bands, Activity IDs, actual dates, two pages', async () => {
  const [pdf] = await docs;
  const { result } = await importPDF(pdf, 'pump-house-p6.pdf');
  eq(result.header.slice(0, 7), ['Activity ID', 'Activity Name', 'Original Duration', 'Remaining Duration', 'Start', 'Finish', 'Total Float']);
  eq(brief(result.project), [
    '1 | Pump House Upgrade | 35 |  |  | 01-04 | 02-19 | ', '2 | Engineering | 25 |  |  | 01-04 | 02-12 | ',
    '3 | Notice to proceed | M | A1000 |  | 01-04 | 01-04 | ', '3 | Design pump skid | 10 | A1010 |  | 01-04 | 01-15 | ',
    '3 | Procure pumps | 15 | A1020 |  | 01-18 | 02-05 | ', '3 | Project management | 30 | A1080 |  | 01-04 | 02-12 | ',
    '2 | Construction | 19 |  |  | 01-25 | 02-19 | ', '3 | Mechanical | 18 |  |  | 01-25 | 02-19 | ',
    '4 | Demolish old skid | 5 | A1030 |  | 01-25 | 01-29 | ', '4 | Set new pumps | 4 | A1040 |  | 02-08 | 02-11 | ',
    '4 | Pipe and wire – Unit 2 | 6 | A1050 |  | 02-10 | 02-17 | ', '4 | Test and turnover | 3 | A1060 |  | 02-17 | 02-19 | ',
    '4 | Ready for service | M | A1070 |  | 02-19 | 02-19 | ']);
  const t = result.project.tasks;
  eq([t[2].percent, t[3].percent, t[4].percent, t[4].actualStart != null, t[8].actualStart], [100, 100, 33, true, null]);
});
test('PDF printed from Project: indents, a wrapped name, links with lags', async () => {
  const [, pdf] = await docs;
  const { result } = await importPDF(pdf, 'pump-house-project.pdf');
  eq(brief(result.project), [
    '1 | Pump House Upgrade | 35 |  |  | 01-04 | 02-18 | ', '2 | Engineering | 25 |  |  | 01-04 | 02-05 | ',
    '3 | Design pump skid | 10 |  |  | 01-04 | 01-15 | ', '3 | Procure pumps | 15 |  | 3FS | 01-18 | 02-05 | ',
    '2 | Construction | 19 |  |  | 01-25 | 02-18 | ', '3 | Demolish old skid | 5 |  | 4SS+5 | 01-25 | 01-29 | ',
    '3 | Set new pumps | 4 |  | 4FS,6FS | 02-08 | 02-11 | ',
    '3 | Pipe and wire – Unit 2 (includes the new discharge header and instrument loops) | 6 |  | 7SS+2 | 02-10 | 02-17 | ',
    '3 | Test and turnover | 3 |  | 7FS,8FF+1 | 02-16 | 02-18 | ', '2 | Ready for service | M |  | 9FS | 02-18 | 02-18 | ']);
});
test('tables on a slide and in a Word document', async () => {
  const [, , table, , docx] = await docs;
  const s = (await importPPTX(table, 'pump-house-table.pptx')).result;
  eq(brief(s.project), ['1 | Design pump skid | 10 |  |  | 01-04 | 01-15 | ', '1 | Procure pumps | 15 |  | 1FS | 01-18 | 02-05 | ',
    '1 | Set new pumps | 4 |  | 2FS | 02-08 | 02-11 | ', '1 | Test – turnover | 3 |  | 3FS | 02-12 | 02-16 | ',
    '1 | Ready for service | M |  | 4FS | 02-16 | 02-16 | ']);
  // Word: WBS numbers give the outline, and links name WBS numbers
  const w = (await importDOCX(docx, 'pump-house.docx')).result;
  eq(brief(w.project), ['1 | Engineering | 1 |  |  | 01-04 | 02-05 | ', '2 | Design pump skid | 10 |  |  | 01-04 | 01-15 | ',
    '2 | Procure pumps | 15 |  | 2FS | 01-18 | 02-05 | ', '1 | Construction | 1 |  |  | 02-08 | 02-16 | ',
    '2 | Set new pumps | 4 |  | 3FS | 02-08 | 02-11 | ', '2 | Test and turnover | 3 |  | 5FS | 02-12 | 02-16 | ',
    '1 | Ready for service | M |  | 6FS | 02-16 | 02-16 | ']);
});
test('a timeline drawn on a slide: dates from bar positions, groups, a milestone', async () => {
  const [, , , timeline] = await docs;
  const { table, result } = await importPPTX(timeline, 'pump-house-timeline.pptx');
  eq(table.shapes, true);
  eq(brief(result.project, result.guessed), [
    '1 | Engineering | 1 |  |  | 01-04 | 02-05 | start/finish/dur', '2 | Design pump skid | 10 |  |  | 01-04 | 01-15 | start/finish',
    '2 | Procure pumps | 15 |  |  | 01-18 | 02-05 | start/finish', '1 | Construction | 1 |  |  | 02-08 | 02-19 | start/finish/dur',
    '2 | Set new pumps | 4 |  |  | 02-08 | 02-11 | start/finish', '2 | Wiring | 7 |  |  | 02-10 | 02-18 | start/finish',
    '2 | Ready for service | M |  |  | 02-19 | 02-19 | start/finish']);
});
test('review: a column read as the wrong field can be changed', async () => {
  const [, , table] = await docs;
  const { table: t, result } = await importPPTX(table, 'pump-house-table.pptx');
  eq(result.map.pred, 4);
  // read Predecessors as Notes instead, and Finish as nothing
  const again = importTable(t.rows, { name: t.name, indents: t.indents, map: { name: 0, dur: 1, start: 2, notes: 4 } });
  eq([again.project.tasks[1].preds.length, again.project.tasks[1].notes, again.map.finish], [0, '1', -1]);
});

// ---------------------------------------------------------------- pictures and scans (OCR)
// A screenshot of the P6-style report, the Project-style report as a tilted, noisy, image-only PDF
// (a "scan"), and the timeline slide exported as a picture. Text is read with Tesseract, so a few
// characters can come out wrong: what matters is that the structure comes through and that anything
// unsure is marked for review.
const pics = Promise.all(['pump-house-p6.png', 'pump-house-scan.pdf', 'pump-house-timeline.png'].map(fixture));
const png = buf => new Blob([buf], { type: 'image/png' });
await Promise.all(pending);   // OCR is heavy: start these once the quick tests are done
test('picture of a P6 report: OCR, then the same table reader', async () => {
  const [p6] = await pics;
  const { table, result } = await importImage(png(p6), 'pump-house-p6.png');
  const t = result.project.tasks;
  eq(table.ocr, true);
  eq(t.map(x => [x.level, x.name.replace('—', '–'), x.activityId || '']), [
    [1, 'Pump House Upgrade', ''], [2, 'Engineering', ''], [3, 'Notice to proceed', 'A1000'], [3, 'Design pump skid', 'A1010'],
    [3, 'Procure pumps', 'A1020'], [3, 'Project management', 'A1080'], [2, 'Construction', ''], [3, 'Mechanical', ''],
    [4, 'Demolish old skid', 'A1030'], [4, 'Set new pumps', 'A1040'], [4, 'Pipe and wire – Unit 2', 'A1050'],
    [4, 'Test and turnover', 'A1060'], [4, 'Ready for service', 'A1070']]);
  // every duration is right, or marked for review
  const want = [35, 25, 0, 10, 15, 30, 19, 18, 5, 4, 6, 3, 0];
  const off = t.map((x, i) => (x.milestone ? 0 : x.duration / 480) === want[i] || result.guessed[i].has('dur') ? null : x.name).filter(Boolean);
  eq(off, []);
  eq(t.filter((x, i) => (x.milestone ? 0 : x.duration / 480) === want[i]).length >= 11, true);
  eq([t[3].percent, t[4].percent], [100, 33]);
});
test('a scanned PDF (no text in it) is read with OCR', async () => {
  const [, scan] = await pics;
  const { table, result } = await importPDF(scan, 'pump-house-scan.pdf');
  const t = result.project.tasks;
  eq(table.ocr, true);
  eq(t.map(x => x.level), [1, 2, 3, 3, 2, 3, 3, 3, 3, 2]);
  eq(t[7].name.startsWith('Pipe and wire'), true);
  eq(t[7].name.endsWith('instrument loops)'), true);
  eq(t.map(x => (x.milestone ? 'M' : x.duration / 480)), [35, 25, 10, 15, 19, 5, 4, 6, 3, 'M']);
});
test('picture of a timeline: bars found by color, names beside and inside them', async () => {
  const [, , timeline] = await pics;
  const { table, result } = await importImage(png(timeline), 'pump-house-timeline.png');
  eq([table.shapes, table.ocr], [true, true]);
  eq(brief(result.project), [
    '1 | Engineering | 1 |  |  | 01-04 | 02-05 | ', '2 | Design pump skid | 10 |  |  | 01-04 | 01-15 | ',
    '2 | Procure pumps | 15 |  |  | 01-18 | 02-05 | ', '1 | Construction | 1 |  |  | 02-08 | 02-19 | ',
    '2 | Set new pumps | 4 |  |  | 02-08 | 02-11 | ', '2 | Wiring | 7 |  |  | 02-10 | 02-18 | ',
    '2 | Ready for service | M |  |  | 02-19 | 02-19 | ']);
});

await Promise.all(pending);
test('every reader runs offline: no network while importing', async () => {
  const all = await files, more = await docs;
  const before = performance.getEntriesByType('resource').filter(e => !e.name.startsWith(`${location.origin}/app/`)).length;
  const realFetch = window.fetch;
  let calls = 0;
  window.fetch = () => { calls++; throw new Error('network used'); };
  try {
    importXER(decodeText(all[0]));
    importP6XML(decodeText(all[1]));
    await importXLSX(all[2], 'x.xlsx');
    await importPDF(more[0], 'x.pdf');
    await importPPTX(more[3], 'x.pptx');
    await importDOCX(more[4], 'x.docx');
    await importImage(png((await pics)[2]), 'x.png');
  } finally { window.fetch = realFetch; }
  const after = performance.getEntriesByType('resource').filter(e => !e.name.startsWith(`${location.origin}/app/`)).length;
  eq([calls, after - before], [0, 0]);
});

await Promise.all(pending);
const pass = results.filter(r => r[1]).length;
document.getElementById('summary').textContent = `${pass} of ${results.length} passed`;
document.getElementById('summary').className = pass === results.length ? 'ok' : 'bad';
document.getElementById('list').innerHTML = results.map(([n, ok, msg]) =>
  `<li class="${ok ? 'ok' : 'bad'}">${ok ? 'PASS' : 'FAIL'} ${n}${msg ? `<pre>${msg}</pre>` : ''}</li>`).join('');
window.testResults = { pass, total: results.length, failures: results.filter(r => !r[1]) };
