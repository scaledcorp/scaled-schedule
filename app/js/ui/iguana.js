// Schedule Iguana: a small helper that turns plain requests into the app's normal, undoable edits and
// answers questions from the computed schedule. Version 1 reads requests with built-in rules (instant,
// offline, nothing to download). A small local AI model can sit behind the same plan format later.
import { deleteTasks, fmtDate, fmtHours, fmtMoney, formatDuration, insertTask, parseAssignments, parseDay,
  parseDuration, startOfDay, subtreeEnd, todayMinutes, yearOf } from '../model.js';
import { schedule } from '../scheduler.js';
import { setPercent } from './panels.js';
import { Brain } from '../ai/brain.js';

const NUM = '(\\d+(?:\\.\\d+)?)';
const UNIT = '(minutes?|mins?|hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mo)';
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clean = s => String(s || '').trim().replace(/^["'“”]+|["'“”.!?]+$/g, '').trim();
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const q = t => `"${t.name || 'Untitled'}"`;
const HELP = 'I can add tasks ("add a 3-day testing task after Build and give it to Ana"), link them ("link Design to Build"), ' +
  'move them ("move Launch to March 15"), change durations ("make Build 5 days"), rename, delete, assign people and mark progress ' +
  '("Build is 50% done"). Ask me "what\'s on the critical path?", "who\'s over-booked?", "when does Launch finish?" or ' +
  '"why did Launch move?". I always show you the plan first, and every change can be undone.';

export function findTask(project, ref) {
  let r = clean(ref).toLowerCase();
  for (let i = 0; i < 2; i++) r = r.replace(/^(?:the\s+|task\s+|row\s+|#)/, '');
  if (!r) return null;
  if (/^\d+$/.test(r)) return project.tasks[+r - 1] || null;
  const ts = project.tasks, n = t => t.name.toLowerCase();
  return ts.find(t => n(t) === r) || ts.find(t => n(t).startsWith(r)) || ts.find(t => n(t).includes(r)) || null;
}

const durOf = (n, u, project) => parseDuration(`${n}${u.replace(/^wks?$/i, 'w').replace(/^hrs?$/i, 'h').replace(/^mins?$/i, 'min')}`, project);
const notFound = ref => ({ kind: 'answer', text: `I couldn't find a task called "${clean(ref)}".` });
const plan = (label, lines, run, extra = {}) => ({ kind: 'plan', label, lines: lines.filter(Boolean), run, ...extra });
const idx = (p, t) => p.tasks.findIndex(x => x.id === t.id);
const pick = (p, t) => p.tasks.find(x => x.id === t.id);

// ---------------------------------------------------------------- everyday wording
// Rewrites the ways people actually talk into the phrasings below, before anything is matched.
// Returns { text, rewrote } so Iguana can say "I read that as …" when a rule changed the meaning.
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, 'a couple of': 2, 'a couple': 2, 'a few': 3, a: 1, an: 1, half: 0.5 };
const PERSON = "([A-Z][\\w'.-]*(?: [A-Z][\\w'.-]*)?)";
const REWRITES = [
  // questions
  [/^.*\b(?:miss(?:ing)? the (?:deadline|date|finish)|make us late|making us late|bottleneck|holding up the (?:project|finish)|driving the (?:finish|end date))\b.*$/i, "what's on the critical path?"],
  [/^.*\bwho(?:'s| is| are)? (?:overloaded|slammed|swamped|too busy|double.?booked|overworked)\b.*$/i, "who's over-booked?"],
  [/^.*\b(?:when (?:are|will) we (?:be )?(?:done|finished)|when(?:'s| is) (?:the )?(?:end|finish|deadline)|what(?:'s| is) the (?:end|finish) date)\b.*$/i, 'when does the project finish?'],
  [/^(?:what(?:'s| is) )?(?:holding up|blocking|delaying) (.+?)\??$/i, 'why did $1 move?'],
  [/^what(?:'s| is) (.+?) waiting (?:on|for)\??$/i, 'why did $1 move?'],
  [/^why is (.+?) (?:so )?late\??$/i, 'why did $1 move?'],
  // moves
  [/^(?:slide|push|delay|bump|postpone|reschedule|shift|slip|move) (.+?) (?:out |back |up )?(?:to|until|till|til|for|on) (.+)$/i, 'move $1 to $2'],
  [/^(.+?) (?:needs to|has to|should|will|can) (?:slide|move|slip|be pushed|be moved|start|be delayed) (?:out |back )?(?:to|until|till|on) (.+)$/i, 'move $1 to $2'],
  // links
  [/^(.+?) (?:has to|needs to|must|should) (?:happen|be (?:done|finished|complete)|finish|come|go) (?:before|ahead of) (.+?)(?: (?:can )?starts?)?$/i, 'link $1 to $2'],
  [/^(.+?) (?:can't|cannot|can not|shouldn't) start (?:until|till|before) (.+?)(?: is (?:done|finished|complete)| finishes)?$/i, 'link $2 to $1'],
  [/^(.+?) (?:waits for|comes after|follows) (.+)$/i, 'link $2 to $1'],
  [/^(.+?) comes before (.+)$/i, 'link $1 to $2'],
  // durations
  [/^(.+?) (?:is going to take|is gonna take|will need|needs|should be|will be|is) (\d+(?:\.\d+)?) ?(minutes?|hours?|days?|weeks?|months?)(?: long)?$/i, '$1 takes $2 $3'],
  [/^give (.+?) (\d+(?:\.\d+)?) ?(hours?|days?|weeks?)$/i, 'make $1 $2 $3'],
  // progress
  [/^(?:we(?:'re| are) )?halfway (?:through|done with) (.+)$/i, '$1 is 50% done'],
  [/^(.+?) (?:is|got|was) (?:all |completely )?(?:done|finished|complete|wrapped up|wrapped)$/i, '$1 is done'],
  [/^(.+?) (?:got done|got finished|got wrapped up|wrapped up|is wrapped up|is in the bag|finished up)$/i, '$1 is done'],
  [/^(.+?) is halfway(?: done)?$/i, '$1 is 50% done'],
  // delete, rename, assign
  [/^(?:drop|cut|scrap|nix|kill|cancel|get rid of|toss|axe) (?:the )?(.+)$/i, 'delete $1'],
  [/^(?:call|name) (.+?) (.+?) instead$/i, 'rename $1 to $2'],
  [/^change the name of (.+?) to (.+)$/i, 'rename $1 to $2'],
  [new RegExp(`^${PERSON} (?:will|can|should|is going to|is gonna) (?:handle|own|do|take|run|lead|work on) (.+)$`), 'give $2 to $1'],
  [/^(?:have|let) ([A-Z][\w'.-]*) (?:do|handle|own|take|run) (.+)$/, 'give $2 to $1'],
  // adding
  [/^(?:fit|squeeze|slot|throw|put|get|tack|work) (?:in |on )?(.+)$/i, 'add $1'],
];

export function normalize(input) {
  let s = ` ${input.trim().replace(/\s+/g, ' ')} `;
  // greetings and filler: these don't change the meaning
  s = s.replace(/^\s*(?:hey|hi|ok|okay|so)?\s*(?:schedule )?(?:iguana)?[,!:]?\s*/i, ' ')
    .replace(/^\s*(?:please|can you|could you|would you|can we|could we|let'?s|i need you to|i want to|we need to|we should|go ahead and|i'd like to)\s+/i, ' ')
    .replace(/\s*(?:please|for me|thanks|thank you|asap|today|yesterday|this morning|last week)[.!]*\s*$/i, ' ')
    .replace(/[.!]+\s*$/, ' ');
  const plain = s.trim();
  // number words before units: "three days", "a couple of weeks", "half a day"
  s = s.replace(/\bhalf an? (hour|day|week)\b/gi, '0.5 $1')
    .replace(/\b(a couple of|a couple|a few|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|an?)[ -](minutes?|hours?|days?|weeks?|months?)\b/gi,
      (x, w, u) => `${WORDS[w.toLowerCase()]} ${u}`);
  // "once Build is done", "when Build finishes" -> "after Build"
  s = s.replace(/\b(?:once|when|as soon as|after) (.+?) (?:is (?:done|finished|complete|wrapped up)|finishes|wraps(?: up)?|ends|is over)\b/gi, 'after $1');
  // ", Ana will handle it", "and Ana can own it", "have Ana do it" -> "and give it to Ana"
  s = s.replace(new RegExp(`[,;]?\\s*(?:and )?${PERSON} (?:will|can|should|is going to|is gonna|could) (?:handle|own|do|take|run|lead|cover) (?:it|that|this)\\b`), ' and give it to $1')
    .replace(/[,;]?\s*(?:and )?(?:have|let) ([A-Z][\w'.-]*) (?:do|handle|own|take|run) (?:it|that|this)\b/, ' and give it to $1')
    .replace(/\b(\d+(?:\.\d+)?) (minutes?|hours?|days?|weeks?|months?) of (.+?)(?= after | and | for |\s*$)/i, '$3 $1 $2');
  s = s.trim().replace(/\s+([,?])/g, '$1');
  let rewrote = s !== plain;
  for (const [re, to] of REWRITES) {
    if (re.test(s)) { s = s.replace(re, to); rewrote = true; break; }
  }
  return { text: s, rewrote };
}

// "Jan 20", "the 20th", "tomorrow", "next Monday", "in 2 weeks" -> day index (null if unreadable).
export function readDay(text, refYear, today = Math.floor(todayMinutes() / 1440)) {
  const s = clean(text).toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/^(?:on |the )/, '');
  const exact = parseDay(s, refYear);
  if (exact != null) return exact;
  if (s === 'today') return today;
  if (s === 'tomorrow') return today + 1;
  let m = s.match(/^(?:next |this )?(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/);
  if (m) {
    const want = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(m[1]);
    let d = today + 1;
    while (((d + 4) % 7 + 7) % 7 !== want) d++;
    return s.startsWith('next ') && d - today < 7 ? d + 7 * (d - today <= 0 ? 1 : 0) : d;
  }
  if ((m = s.match(/^in (\d+) (day|week)s?$/))) return today + +m[1] * (m[2] === 'week' ? 7 : 1);
  return null;
}

// Reads one request. Returns a plan (shown as a preview, then run through the normal undo history),
// an answer, or "undo". Pure: it never changes the project itself.
export function interpret(text, ctx) {
  const n = normalize(text);
  const res = interpretCore(n.text, ctx);
  if (n.rewrote && n.text.toLowerCase() !== text.trim().toLowerCase() && !res.unknown) res.as = n.text;
  return res;
}

function interpretCore(text, { project, computed }) {
  const s = text.trim().replace(/\s+/g, ' '), low = s.toLowerCase();
  const k = t => computed.byId.get(t.id);
  let m;
  if (!s) return { kind: 'answer', text: HELP };
  if (/^(help|what can you do|how do i|\?)/.test(low)) return { kind: 'answer', text: HELP };
  if (/^undo\b/.test(low)) return { kind: 'undo' };

  // ---- questions
  if (/critical/.test(low)) {
    const crit = project.tasks.filter(t => { const c = k(t); return c.critical && !c.summary; });
    return { kind: 'answer', text: crit.length
      ? `The critical path runs through ${crit.slice(0, 6).map(q).join(', ')}${crit.length > 6 ? ` and ${crit.length - 6} more` : ''}. A slip in any of them moves the finish date.`
      : 'Nothing is critical right now: every task has some slack.' };
  }
  if (/over.?(book|alloc|load)/.test(low)) {
    const list = [...computed.over].map(([id, days]) => `${project.resources.find(r => r.id === id)?.name} (from ${fmtDate(days[0] * 1440)})`);
    return { kind: 'answer', text: list.length ? `Over-booked: ${list.join(', ')}. The Resources view shows the details.` : 'Nobody is over-booked.' };
  }
  if (/(how much|cost|budget)/.test(low)) {
    return { kind: 'answer', text: `The project costs ${fmtMoney(computed.cost, project.currency)}, with ${fmtHours(computed.work)} of work.` };
  }
  if ((m = low.match(/^when (?:does|will|is|do) (.+?) (finish|end|be done|done|due|start|begin)\??$/))) {
    const starts = /start|begin/.test(m[2]);
    if (/^(the project|project|it|we|everything|this|the job)$/.test(m[1])) {
      return { kind: 'answer', text: `The project ${starts ? 'starts' : 'finishes'} ${fmtDate(starts ? computed.start : computed.finish)}.` };
    }
    const t = findTask(project, m[1]);
    if (!t) return notFound(m[1]);
    const c = k(t);
    return { kind: 'answer', text: `${q(t)} ${starts ? `starts ${fmtDate(c.es)}` : `finishes ${fmtDate(c.ef)}`}${c.summary ? '' : `, with ${formatDuration(c.float, project)} of slack`}.` };
  }
  if ((m = low.match(/^why (?:did|does|is|has) (.+?) (?:move|moved|start|starting|late|slip|slipped|pushed)/))) {
    const t = findTask(project, m[1]);
    if (!t) return notFound(m[1]);
    const preds = t.preds.map(p => project.tasks.find(x => x.id === p.id)).filter(Boolean);
    if (preds.length) {
      const drive = preds.reduce((a, b) => (k(b).ef > k(a).ef ? b : a));
      return { kind: 'answer', text: `${q(t)} waits for ${q(drive)}, which finishes ${fmtDate(k(drive).ef)}.` };
    }
    if (t.constraint?.date != null) return { kind: 'answer', text: `${q(t)} has a fixed date: it can't start before ${fmtDate(t.constraint.date)}.` };
    return { kind: 'answer', text: `Nothing is holding ${q(t)} back. It starts with the project.` };
  }

  // ---- edits
  if ((m = s.match(/^(?:add|create|new|insert)\b(.*)$/i))) return planAdd(m[1], project);
  if ((m = s.match(/^(?:link|connect) (.+?) (?:to|->|then|before|with) (.+)$/i)) || (m = s.match(/^make (.+?) depend on (.+)$/i))) {
    const [a, b] = /depend/i.test(s) ? [m[2], m[1]] : [m[1], m[2]];
    const from = findTask(project, a), to = findTask(project, b);
    if (!from) return notFound(a);
    if (!to) return notFound(b);
    return plan('Link tasks', [`Link ${q(from)} to ${q(to)} (${q(to)} starts after ${q(from)} finishes)`], p => {
      const succ = pick(p, to);
      if (!succ.preds.some(x => x.id === from.id)) succ.preds.push({ id: from.id, type: 'FS', lag: 0 });
    });
  }
  if ((m = s.match(/^(?:move|start|schedule|push|shift) (.+?) (?:to|on|for|until|at) (.+)$/i))) {
    const t = findTask(project, m[1]);
    if (!t) return notFound(m[1]);
    const day = readDay(m[2], yearOf(k(t).es));
    if (day == null) return { kind: 'answer', text: `I couldn't read "${clean(m[2])}" as a date. Try "March 15", "next Monday" or 3/15/27.` };
    return plan('Move task', [`Start ${q(t)} no earlier than ${fmtDate(day * 1440)}`], (p, cal) => {
      pick(p, t).constraint = { type: 'SNET', date: cal.nextWorkStart(startOfDay(day, cal)) };
    });
  }
  if ((m = s.match(new RegExp(`^(?:make|set|change) (.+?) (?:to |as )?${NUM} ?${UNIT}(?: long)?$`, 'i'))) ||
      (m = s.match(new RegExp(`^(.+?) (?:takes|will take|lasts|should take) ${NUM} ?${UNIT}$`, 'i')))) {
    const t = findTask(project, m[1]);
    if (!t) return notFound(m[1]);
    const d = durOf(m[2], m[3], project);
    return plan('Change duration', [`Make ${q(t)} ${formatDuration(d, project)}`], p => { const x = pick(p, t); x.duration = d; x.milestone = d === 0; });
  }
  if ((m = s.match(/^rename (.+?) (?:to|as) (.+)$/i))) {
    const t = findTask(project, m[1]);
    if (!t) return notFound(m[1]);
    const name = clean(m[2]);
    return plan('Rename task', [`Rename ${q(t)} to "${name}"`], p => { pick(p, t).name = name; });
  }
  if ((m = s.match(/^(?:delete|remove) (.+)$/i))) {
    const t = findTask(project, m[1]);
    if (!t) return notFound(m[1]);
    const kids = subtreeEnd(project.tasks, idx(project, t)) - idx(project, t) - 1;
    return plan('Delete task', [`Delete ${q(t)}${kids ? ` and the ${kids} task${kids > 1 ? 's' : ''} under it` : ''}`], p => { deleteTasks(p, [t.id]); });
  }
  if ((m = s.match(/^(?:mark |set )?(.+?) (?:as )?(?:is )?(done|complete|completed|finished)$/i)) ||
      (m = s.match(/^(?:mark |set )?(.+?) (?:is |to |at |as )?(\d{1,3}) ?% ?(?:done|complete)?$/i))) {
    const t = findTask(project, m[1]);
    if (!t) return notFound(m[1]);
    const pct = /^\d+$/.test(m[2]) ? Math.min(100, +m[2]) : 100;
    return plan('Update progress', [`Mark ${q(t)} ${pct}% done`], (p, cal, comp) => setPercent(pick(p, t), pct, comp.byId.get(t.id), cal));
  }
  if ((m = s.match(/^(?:assign|give|put) (.+?) (?:to|on) (.+)$/i))) {
    let t = findTask(project, m[1]), who = m[2];
    if (!t) { t = findTask(project, m[2]); who = m[1]; }
    if (!t) return notFound(m[1]);
    who = clean(who);
    return plan('Assign resource', [`Assign ${who} to ${q(t)}`], p => {
      const x = pick(p, t), { assignments } = parseAssignments(who, p);
      assignments.forEach(a => { if (!x.assignments.some(b => b.resourceId === a.resourceId)) x.assignments.push(a); });
    });
  }
  return suggest(s, project, computed);
}

// Didn't match anything: offer the closest commands, built from the task names, durations and dates
// in the request, so one tap gets it done.
function suggest(s, project, computed) {
  const low = s.toLowerCase(), words = low.match(/[a-z0-9]+/g) || [];
  const tasks = project.tasks.filter(t => {
    const n = t.name.toLowerCase();
    return n && (low.includes(n) || n.split(/\s+/).some(w => w.length > 3 && words.includes(w)));
  }).slice(0, 2);
  const dm = s.match(new RegExp(`${NUM} ?(?:more |extra |additional )?${UNIT}\\b`, 'i'));
  const dur = dm ? `${dm[1]} ${/^w/i.test(dm[2]) ? 'weeks' : /^h/i.test(dm[2]) ? 'hours' : /^mo/i.test(dm[2]) ? 'months' : 'days'}` : null;
  const tail = s.match(/\b(?:to|on|until|till|by)\s+(.+?)\??$/i)?.[1];
  const date = tail && readDay(tail, yearOf(computed.start)) != null ? clean(tail) : null;
  const out = [];
  if (tasks.length) {
    const n = tasks[0].name;
    if (date) out.push(`move ${n} to ${date}`);
    if (dur) out.push(`make ${n} ${dur}`, `add New task ${dur} after ${n}`);
    if (tasks[1]) out.push(`link ${n} to ${tasks[1].name}`);
    out.push(`when does ${n} finish?`, `why did ${n} move?`, `${n} is done`);
  } else {
    const name = cap(clean(s.replace(new RegExp(`${NUM} ?${UNIT}`, 'i'), '').split(/\b(?:after|before|for|to|by)\b/i)[0]).slice(0, 40));
    if (name && name.split(' ').length <= 6) out.push(`add ${name} ${dur || '1 day'}`);
    out.push("what's on the critical path?", 'when does the project finish?', 'what can you do?');
  }
  return { kind: 'answer', unknown: true, suggestions: [...new Set(out)].slice(0, 4),
    text: "I'm not sure what you meant. Is it one of these? Tap one, or type it your way." };
}

function planAdd(rest, project) {
  let r = ` ${rest} `, after = null, who = null, d = null;
  const milestone = /\bmilestone\b/i.test(r);
  const quoted = r.match(/["“]([^"”]+)["”]/);
  r = r.replace(new RegExp(`\\s(?:for |lasting |that takes |taking )?${NUM}[ -]?${UNIT}\\b`, 'i'), (x, n, u) => { d = durOf(n, u, project); return ' '; });
  r = r.replace(/\s(?:right\s+)?after\s+(.+?)(?=\s+(?:and|give|assign(?:ed)?|for)\b|\s*$)/i, (x, y) => { after = y; return ' '; });
  r = r.replace(/\s(?:and\s+)?(?:give it to|assign(?:ed)?(?: it)? to|for)\s+(.+?)\s*$/i, (x, y) => { who = clean(y); return ' '; });
  let name = quoted ? quoted[1] : r.replace(/\b(?:a|an|the|new|task|milestone|called|named|and|some|another|extra)\b/gi, ' ').replace(/^\s*(?:of|for)\s+/i, ' ');
  name = cap(clean(name.replace(/\s+/g, ' '))) || (milestone ? 'Milestone' : 'New task');
  const pred = after ? findTask(project, after) : null;
  if (after && !pred) return notFound(after);
  const dur = milestone ? 0 : d ?? project.minutesPerDay;
  return plan(milestone ? 'Add milestone' : 'Add task', [
    `Add "${name}"${milestone ? ' as a milestone' : `, ${formatDuration(dur, project)}`}${pred ? `, after ${q(pred)}` : ''}`,
    who && `Assign ${who}`,
  ], p => {
    const i = pred ? subtreeEnd(p.tasks, idx(p, pred)) : p.tasks.length;
    const t = insertTask(p, i, { name, level: pred ? pred.level : p.tasks[p.tasks.length - 1]?.level ?? 1, duration: dur, milestone });
    if (pred) t.preds.push({ id: pred.id, type: 'FS', lag: 0 });
    if (who) t.assignments = parseAssignments(who, p).assignments;
    return t.id;
  }, { adds: true });
}

// ---------------------------------------------------------------- the chat panel
const SUGGEST = ["What's on the critical path?", "Who's over-booked?", 'When does the project finish?', 'What can you do?'];

export class Iguana {
  constructor(app) {
    this.app = app;
    this.btn = Object.assign(document.createElement('button'), { className: 'iguana-btn', title: 'Ask Schedule Iguana' });
    this.btn.innerHTML = '<img src="iguana.svg" alt="Schedule Iguana">';
    this.panel = Object.assign(document.createElement('section'), { className: 'iguana', ariaLabel: 'Schedule Iguana' });
    this.panel.innerHTML = `
      <header><img src="iguana.svg" alt=""><div><b>Schedule Iguana</b><small>Runs on this computer</small></div>
        <button class="btn icon" data-act="close" title="Close (Esc)"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></header>
      <div class="ig-log" aria-live="polite"></div>
      <div class="ig-chips">${SUGGEST.map(x => `<button data-say="${esc(x)}">${esc(x)}</button>`).join('')}</div>
      <form class="ig-input"><input placeholder="Ask Schedule Iguana" aria-label="Ask Schedule Iguana" autocomplete="off">
        <button class="btn icon primary" title="Send" aria-label="Send"><svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button></form>`;
    document.body.append(this.btn, this.panel);
    this.log = this.panel.querySelector('.ig-log');
    this.input = this.panel.querySelector('input');
    this.btn.onclick = () => this.open();
    this.panel.querySelector('form').onsubmit = e => { e.preventDefault(); const v = this.input.value; this.input.value = ''; this.handle(v); };
    this.input.onkeydown = e => { if (e.key === 'Escape') this.close(); };
    this.panel.onclick = e => {
      const say = e.target.closest('[data-say]')?.dataset.say, act = e.target.closest('[data-act]')?.dataset.act;
      if (say) this.handle(say);
      else if (act === 'close') this.close();
      else if (act === 'do') this.run(+e.target.closest('[data-act]').dataset.i);
      else if (act === 'change') { this.input.value = this.pending[+e.target.closest('[data-act]').dataset.i]?.text || ''; this.input.focus(); }
      else if (act === 'undo') { this.app.store.undo(); this.say('Undone.'); }
    };
    this.pending = [];
    this.brain = new Brain();
    this.say("Hi, I'm Schedule Iguana. Tell me what to change, like \"add a 3-day testing task after Build\", or ask \"what's on the critical path?\" I show you the plan before I touch anything.");
  }

  open() { this.panel.classList.add('open'); this.btn.classList.add('hide'); setTimeout(() => this.input.focus(), 50); }
  close() { this.panel.classList.remove('open'); this.btn.classList.remove('hide'); this.app.focusGrid(); }

  say(html, who = 'bot') {
    const el = document.createElement('div');
    el.className = `ig-msg ${who}`;
    el.innerHTML = html;
    this.log.appendChild(el);
    this.log.scrollTop = this.log.scrollHeight;
    return el;
  }

  // mode: 'user' (typed or a chip), 'retry' (after the brain download; don't repeat the message)
  async handle(text, mode = 'user') {
    if (!text.trim()) return;
    if (mode === 'user') this.say(esc(text), 'user');
    const { project, computed } = this.app;
    let res = interpret(text, { project, computed });
    if (res.unknown) {
      // The rules didn't recognize the wording: let the small model rewrite it into a known phrasing.
      if (!this.brain.ready && !(await this.brain.known())) { this.offerBrain(text); return; }
      const think = this.say('<span class="ig-dots"><i></i><i></i><i></i></span>');
      try {
        if (!this.brain.ready) await this.brain.load(p => { think.innerHTML = `Waking up… ${Math.round(p.progress * 100)}%`; });
        const { command } = await this.brain.rewrite(text, this.app.project);
        think.remove();
        const again = interpret(command, { project: this.app.project, computed: this.app.computed });
        if (command.toLowerCase() === 'help' || again.unknown) { this.say(esc(res.text)); return; }
        res = { ...again, as: command };
      } catch (e) { think.remove(); this.say(esc(`My AI brain hit a snag: ${e.message}`)); return; }
    }
    if (res.as) this.say(`I read that as <b>“${esc(res.as)}”</b>.`);
    if (res.kind === 'undo') { this.say(this.app.store.undo() ? 'Undone.' : 'There is nothing to undo.'); return; }
    if (res.kind === 'answer') {
      const el = this.say(esc(res.text));
      if (res.suggestions?.length) el.insertAdjacentHTML('beforeend', `<div class="ig-sugg">${res.suggestions.map(x => `<button data-say="${esc(x)}">${esc(x)}</button>`).join('')}</div>`);
      return;
    }
    // Try the plan on a copy first, so the preview can say what will move.
    const copy = structuredClone(project);
    let newId;
    try { newId = res.run(copy, computed.calendar, computed); } catch (e) { this.say(esc(`I couldn't do that: ${e.message}`)); return; }
    const after = schedule(copy), lines = [...res.lines];
    if (newId != null) { const n = after.byId.get(newId); lines.push(`Runs ${fmtDate(n.es)} to ${fmtDate(n.ef)}`); }
    if (after.finish !== computed.finish) lines.push(`Project finish moves to ${fmtDate(after.finish)}`);
    const i = this.pending.push({ ...res, text }) - 1;
    this.say(`<p>Here's what I'll do:</p><ul>${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
      <div class="ig-acts"><button class="btn primary" data-act="do" data-i="${i}">Do it</button><button class="btn" data-act="change" data-i="${i}">Change</button></div>`);
  }

  // First time only: ask before downloading the model, then show progress and retry the request.
  offerBrain(text) {
    const el = this.say(`<p>I don't know that wording yet. My AI brain can figure it out: a small Llama model that runs right here on
      this computer, nothing sent anywhere. It's a one-time download of about 1.2 GB. Built with Llama.</p>
      <div class="ig-acts"><button class="btn primary" data-brain="yes">Download my brain</button><button class="btn" data-brain="no">Not now</button></div>`);
    el.querySelector('[data-brain="no"]').onclick = () => { el.querySelectorAll('button').forEach(b => { b.disabled = true; }); this.say('No problem. Try the phrasings in "What can you do?".'); };
    el.querySelector('[data-brain="yes"]').onclick = async () => {
      el.querySelectorAll('button').forEach(b => { b.disabled = true; });
      const bar = this.say('<div class="ig-bar"><i style="width:0%"></i></div><small>Starting download…</small>');
      try {
        await this.brain.load(p => {
          bar.querySelector('i').style.width = `${Math.round(p.progress * 100)}%`;
          bar.querySelector('small').textContent = `${p.loadedMB} of ${p.totalMB} MB`;
        });
        bar.innerHTML = 'Brain ready. Let me try that again.';
        this.handle(text, 'retry');
      } catch (e) { bar.innerHTML = esc(`The download didn't finish: ${e.message}`); }
    };
  }

  run(i) {
    const p = this.pending[i];
    if (!p || p.done) return;
    p.done = true;
    this.log.querySelectorAll(`[data-i="${i}"]`).forEach(b => { b.disabled = true; });
    const { store } = this.app, before = this.app.computed.finish;
    let newId;
    try { store.update(p.label, pr => { newId = p.run(pr, this.app.computed.calendar, this.app.computed); }); }
    catch (e) { this.say(esc(`That didn't work: ${e.message}`)); return; }
    if (newId != null) { store.select([newId], newId); this.app.grid.scrollIntoView(); }
    const fin = this.app.computed.finish;
    this.say(`Done.${fin !== before ? ` The project now finishes ${esc(fmtDate(fin))}.` : ''} <button class="ig-link" data-act="undo">Undo</button>`);
  }
}
