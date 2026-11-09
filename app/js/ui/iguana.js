// Schedule Iguana: a small helper that turns plain requests into the app's normal, undoable edits and
// answers questions from the computed schedule. Version 1 reads requests with built-in rules (instant,
// offline, nothing to download). A small local AI model can sit behind the same plan format later.
import { deleteTasks, fmtDate, fmtHours, fmtMoney, formatDuration, insertTask, parseAssignments, parseDay,
  parseDuration, startOfDay, subtreeEnd, todayMinutes, yearOf } from '../model.js';
import { schedule } from '../scheduler.js';
import { setPercent } from './panels.js';
import { WorkCalendar } from '../calendar.js';

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
  const parts = clauses(text);
  return parts.length > 1 ? compound(parts, ctx) : single(text, ctx);
}

// ---------------------------------------------------------------- bigger requests
// Several requests in one message (lines, semicolons or sentences) become one plan, previewed together
// and undone together. Each part is read after the earlier parts are applied, so "add Review" in one
// sentence and "link Review to Launch" in the next both work.
function clauses(text) {
  return text.split(/\s*(?:\n+|;\s*|\.\s+(?=[A-Za-z]))\s*/).map(c => c.trim().replace(/[.!]+$/, '')).filter(Boolean);
}

function compound(parts, ctx) {
  const trial = structuredClone(ctx.project), lines = [], answers = [];
  for (let i = 0; i < parts.length; i++) {
    const comp = schedule(trial);
    const r = single(parts[i], { project: trial, computed: comp, chain: i > 0 });
    if (r.kind === 'plan') { lines.push(...r.lines); r.run(trial, comp.calendar, comp); }
    else if (r.kind === 'answer' && !r.unknown) answers.push(r.text);
    else return { kind: 'answer', unknown: true, suggestions: r.suggestions || [],
      text: `I followed you up to "${parts[i]}". Could you say that part another way? Is it one of these?` };
  }
  if (!lines.length) return { kind: 'answer', text: answers.join(' ') };
  return plan('Make several changes', lines, p => {
    let last;
    parts.forEach((part, i) => {
      const comp = schedule(p);
      const r = single(part, { project: p, computed: comp, chain: i > 0 });
      if (r.kind === 'plan') last = r.run(p, comp.calendar, comp) ?? last;
    });
    return last;
  });
}

const COUNT = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
const CHAIN_WORDS = /\bthen\b|->|→|\bfollowed by\b|\bin (?:that )?order\b|\bone after (?:the )?other\b/i;

// "design 3 days (Ana), then wait 2 days, then plumbing and electrical at the same time, then a launch
// milestone" -> groups of items (a group runs at the same time), gaps before items, and whether the
// groups run in order.
const PARALLEL = /\b(?:at the same time|in parallel|together|simultaneously)\b/i;
function parseItems(list, project) {
  const chain = CHAIN_WORDS.test(list);
  const durRe = new RegExp(`\\(?\\s*${NUM}[ -]?${UNIT}\\b\\s*\\)?`, 'i');
  const lagRe = new RegExp(`^(?:wait|pause|leave|gap of|allow)\\s+${NUM}[ -]?${UNIT}\\b.*$|^${NUM}[ -]?${UNIT}\\s+(?:gap|break|pause|wait|later)\\b,?\\s*(.*)$`, 'i');
  const item = raw => {
    let x = raw, who = null;
    x = x.replace(/\s*\(\s*([^)]+?)\s*\)\s*$/, (m, w) => (/^\d|^(?:one|two|three|four|five|half)\b/i.test(w) ? m : ((who = w), ' ')));
    x = x.replace(/\s+(?:by|assigned to|owner:?)\s+(.+)$/i, (m, w) => ((who = clean(w)), ' '));
    x = x.replace(/\s+(?:for|with)\s+([A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*)?)\s*$/, (m, w) => ((who = w), ' '));
    const dm = x.match(durRe), milestone = /\bmilestone\b/i.test(x);
    let name = x.replace(durRe, ' ').replace(/\b(?:a|an|the|new|task|tasks|step|milestone|called|named|of)\b/gi, ' ');
    name = cap(clean(name.replace(/\s+/g, ' ')));
    return name ? { name, dur: milestone ? 0 : dm ? durOf(dm[1], dm[2], project) : null, milestone, who } : null;
  };
  const tokens = list.replace(/\b(?:in (?:that )?order|one after (?:the )?other|at the (?:end|start))\b/ig, ' ')
    .split(chain ? /\s*(?:,|->|→|\bthen\b|\bfollowed by\b)\s*/i : /\s*(?:,|->|→)\s*/).map(x => x.trim()).filter(Boolean);
  const groups = [];
  let lag = 0;
  for (let t of tokens) {
    const lm = t.match(lagRe);
    if (lm) { lag += durOf(lm[1] ?? lm[3], lm[2] ?? lm[4], project); t = (lm[5] || '').trim(); if (!t) continue; }
    const together = PARALLEL.test(t) || /^both\b/i.test(t);
    const parts = t.replace(PARALLEL, ' ').replace(/^both\s+/i, '').split(/\s*(?:\band\b|&)\s*/i).map(item).filter(Boolean);
    if (!parts.length) continue;
    if (lag) { parts.forEach(p => { p.lag = lag; }); lag = 0; }
    if (chain && together) groups.push(parts); else parts.forEach(p => groups.push([p]));
  }
  const items = groups.flat();
  return { items, groups: chain ? groups : [items], chain };
}

// "three new tasks", "2 milestones: A and B", or any list of two or more tasks.
function parseMany(r, project) {
  const cm = r.match(/^(?:(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+)(?:new\s+|more\s+|extra\s+|other\s+)?(tasks?|steps?|items?|milestones?)\b\s*(?:called|named|:)?\s*(.*)$/i);
  if (cm) {
    const n = /^\d+$/.test(cm[1]) ? +cm[1] : COUNT[cm[1].toLowerCase()], ms = /^m/i.test(cm[2]);
    const listed = cm[3] ? parseItems(cm[3], project) : { items: [], chain: false };
    if (listed.items.length) return listed;
    if (n > 1 && n <= 50) return { chain: false, items: Array.from({ length: n }, (_, i) => ({ name: `${ms ? 'Milestone' : 'New task'} ${i + 1}`, dur: ms ? 0 : null, milestone: ms })) };
  }
  if (/,|\bthen\b|->|→|\band\b/i.test(r)) { const listed = parseItems(r, project); if (listed.items.length >= 2) return listed; }
  return null;
}

function planMany(spec, { after = null, who = null, phase = null, chainFrom = null, startDay = null }, project) {
  const chain = spec.chain;
  const groups = spec.groups || (chain ? spec.items.map(i => [i]) : [spec.items]);
  const items = groups.flat();
  const fmt = it => `${it.name} (${it.milestone ? 'milestone' : formatDuration(it.dur ?? project.minutesPerDay, project)}${it.who ? `, ${it.who}` : ''}${it.lag ? `, after a ${formatDuration(it.lag, project).replace(/s$/, '')} gap` : ''})`;
  const lines = [
    `${phase ? `Add a "${phase}" phase with` : 'Add'} ${items.length} tasks: ${items.slice(0, 6).map(fmt).join(', ')}${items.length > 6 ? `, and ${items.length - 6} more` : ''}`,
    chain ? (groups.some(g => g.length > 1) ? 'In order, with some steps at the same time' : 'Each one starts after the one before') : after ? 'Side by side' : null,
    after && `First one starts after "${after.name}"`,
    startDay != null && `Starting no earlier than ${fmtDate(startDay * 1440)}`,
    who && `Assign ${who}`,
  ];
  return plan(phase ? 'Add a phase' : 'Add tasks', lines, (p, cal) => {
    cal = cal || new WorkCalendar(p.calendar);
    let i = after ? subtreeEnd(p.tasks, idx(p, after)) : p.tasks.length;
    let level = after ? after.level : 1;
    const startAfter = after ? after.id : chainFrom;
    if (phase) { insertTask(p, i++, { name: phase, level }); level++; }
    let prev = startAfter ? [startAfter] : [], lastId = null;
    for (const g of groups) {
      const ids = [];
      for (const it of g) {
        const t = insertTask(p, i++, { name: it.name, level, duration: it.dur ?? p.minutesPerDay, milestone: !!it.milestone });
        const from = chain ? prev : startAfter ? [startAfter] : [];
        from.forEach(id => t.preds.push({ id, type: 'FS', lag: it.lag || 0 }));
        if (!from.length && startDay != null) t.constraint = { type: 'SNET', date: cal.nextWorkStart(startOfDay(startDay, cal)) };
        const w = it.who || who;
        if (w) t.assignments = parseAssignments(w, p).assignments;
        ids.push(t.id); lastId = t.id;
      }
      if (chain) prev = ids;
    }
    return lastId;
  }, { adds: true });
}

// "Kitchen remodel: demo 3 days, then plumbing 2 days, then paint" or "create a schedule for X: ..."
// becomes a phase (summary task) whose steps follow each other unless it says "at the same time".
function planBlock(text, { project, chain }) {
  const m = text.match(/^(?:(?:create|make|build|start|plan|set up|draft)\s+(?:me\s+)?(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:project|schedule|plan|phase|gantt)\s*(?:for|called|named|of)?\s*|phase\s*\d*\s*[.-]?\s*)?([^:]{0,60}):\s*(.+)$/i);
  if (!m) return null;
  const listed = parseItems(m[2], project);
  if (listed.items.length < 2) return null;
  if (!listed.chain && !/\b(?:side by side|all at once)\b/i.test(m[2])) {
    listed.chain = true;
    listed.groups = listed.items.map(it => [it]);
  }
  let startDay = null;
  const left = m[1].replace(/\s*\b(?:starting|beginning|start(?:ing)? on|kicking off|from)\s+(.+?)\s*$/i, (x, d) => {
    const day = readDay(d, yearOf(project.start));
    if (day == null) return x;
    startDay = day;
    return '';
  });
  const phase = cap(clean(left.replace(/^(?:the|a|an|our|my)\s+/i, ''))) || null;
  const lastLeaf = [...project.tasks].reverse().find(t => {
    const next = project.tasks[project.tasks.indexOf(t) + 1];
    return !next || next.level <= t.level;
  });
  return planMany(listed, { phase, startDay, chainFrom: chain && lastLeaf ? lastLeaf.id : null }, project);
}

function single(text, ctx) {
  const blk = planBlock(text.trim(), ctx);
  if (blk) return blk;
  const n = normalize(text);
  const res = interpretCore(n.text, ctx);
  // No rule matched, but one suggestion clearly fits the wording: read it that way (the preview still
  // asks before anything changes).
  if (res.unknown && res.best) {
    const again = interpretCore(res.best, ctx);
    if (!again.unknown) return { ...again, as: res.best };
  }
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
  if ((m = s.match(/^(?:start|begin|kick off) (?:the |this )?(?:project|plan|schedule|job) (?:on |at )?(.+)$/i)) ||
      (m = s.match(/^(?:the )?(?:project|plan|schedule|job) (?:starts|begins|kicks off) (?:on )?(.+)$/i))) {
    const day = readDay(m[1], yearOf(project.start));
    if (day == null) return { kind: 'answer', text: `I couldn't read "${clean(m[1])}" as a date. Try "March 1" or 3/1/27.` };
    return plan('Set project start', [`Start the project on ${fmtDate(day * 1440)}`], (p, cal) => {
      p.start = (cal || new WorkCalendar(p.calendar)).nextWorkStart(day * 1440);
    });
  }
  if ((m = s.match(new RegExp(`^(.+?) (?:starts?|begins?|can start|should start|kicks off) ${NUM} ?${UNIT} after (.+?)(?: (?:finishes|is done|ends|wraps(?: up)?))?$`, 'i')))) {
    const to = findTask(project, m[1]), from = findTask(project, m[4]);
    if (!to) return notFound(m[1]);
    if (!from) return notFound(m[4]);
    const lag = durOf(m[2], m[3], project);
    return plan('Link with a gap', [`${q(to)} starts ${formatDuration(lag, project)} after ${q(from)} finishes`], p => {
      const succ = pick(p, to), ex = succ.preds.find(x => x.id === from.id);
      if (ex) { ex.lag = lag; ex.type = 'FS'; } else succ.preds.push({ id: from.id, type: 'FS', lag });
    });
  }
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

// Didn't match anything: build the likely commands from the task names, durations and dates in the
// request, score each by the words that point to it, and offer the best ones as buttons. When one
// clearly wins it becomes `best`, and Iguana reads the request that way.
const CUES = {
  move: /\b(?:go|goes|going|move|slide|push|shift|slip|bump|delay|postpone|reschedul\w*|later|earlier|sooner)\b/i,
  duration: /\b(?:take|takes|taking|need|needs|longer|shorter|more|extra|another|lasts?)\b/i,
  add: /\b(?:add|stick|insert|tack|squeeze|slot|include|new|step|review|inspection|meeting)\b/i,
  link: /\b(?:before|depends?|first|then|until)\b/i,
  finish: /\b(?:how long|until|when|finish(?:es|ed)? by|out the door|ready by|complete by|end date)\b|\bwhen\b/i,
  why: /\b(?:why|holding|blocking|stuck|late|behind)\b/i,
  done: /\b(?:wrapped|finished|done|complete|completed|over with|signed off)\b/i,
};

function suggest(s, project, computed) {
  const low = s.toLowerCase(), words = low.match(/[a-z0-9]+/g) || [];
  // The task named after "after/before" comes first, then whole names in the text, then word matches.
  const anchor = s.match(/\b(?:after|before|following)\s+(?:the\s+)?(.+?)\??$/i)?.[1];
  const anchored = anchor ? findTask(project, anchor) : null;
  const overlap = t => t.name.toLowerCase().split(/\s+/).filter(w => w.length > 3 && words.includes(w)).length;
  const tasks = [...new Set([anchored, ...project.tasks.filter(t => t.name && low.includes(t.name.toLowerCase())),
    ...project.tasks.filter(t => overlap(t)).sort((a, b) => overlap(b) - overlap(a))].filter(Boolean))].slice(0, 2);
  const durRe = new RegExp(`${NUM}[ -]?(?:more |extra |additional )?${UNIT}\\b`, 'i');
  const dm = s.match(durRe);
  const dur = dm ? `${dm[1]} ${/^w/i.test(dm[2]) ? 'weeks' : /^h/i.test(dm[2]) ? 'hours' : /^mo/i.test(dm[2]) ? 'months' : 'days'}` : null;
  const tail = s.match(/\b(?:to|on|until|till|by)\s+(.+?)\??$/i)?.[1];
  const date = tail && readDay(tail, yearOf(computed.start)) != null ? clean(tail) : null;
  const cue = k => (CUES[k].test(s) ? 2 : 0);
  const cand = [];
  if (tasks.length) {
    const n = tasks[0].name;
    const m = s.replace(durRe, ' ').replace(/\s+/g, ' ').match(/^(?:\w+ )?(?:(?:a|an|the|another|some) )?(.+?) (?:step |task )?(?:after|before|following)\b/i);
    const named = m && clean(m[1]);
    const addName = named && named.split(' ').length <= 5 && !project.tasks.some(t => t.name.toLowerCase() === named.toLowerCase()) ? cap(named) : 'New task';
    if (date) cand.push([`move ${n} to ${date}`, cue('move') + 1]);
    if (dur) cand.push([`make ${n} ${dur}`, cue('duration') + 1]);
    if (dur || CUES.add.test(s)) cand.push([`add ${addName} ${dur || '1 day'} after ${n}`, cue('add') + (dur ? 1 : 0) + (addName !== 'New task' ? 1 : 0)]);
    if (tasks[1]) cand.push([`link ${n} to ${tasks[1].name}`, cue('link') + 1]);
    cand.push([`when does ${n} finish?`, cue('finish')], [`why did ${n} move?`, cue('why')], [`${n} is done`, cue('done') && !CUES.finish.test(s) ? 3 : 0]);
  } else {
    const name = cap(clean(s.replace(durRe, '').split(/\b(?:after|before|for|to|by)\b/i)[0]).slice(0, 40));
    if (name && name.split(' ').length <= 6) cand.push([`add ${name} ${dur || '1 day'}`, cue('add') + (dur ? 1 : 0)]);
    cand.push(["what's on the critical path?", 0], ['when does the project finish?', cue('finish')], ['what can you do?', 0]);
  }
  cand.sort((a, b) => b[1] - a[1]);
  const best = cand[0] && cand[0][1] >= 2 && (!cand[1] || cand[0][1] > cand[1][1]) ? cand[0][0] : null;
  return { kind: 'answer', unknown: true, best, suggestions: [...new Set(cand.map(c => c[0]))].slice(0, 4),
    text: "I'm not sure what you meant. Is it one of these? Tap one, or type it your way." };
}

// Several tasks at once ("three new tasks", "design, build and test", "A then B then C"), else one.
function planAdd(rest, project) {
  if (/["“]/.test(rest)) return planAddSingle(rest, project);
  let r = ` ${rest} `, after = null, who = null;
  r = r.replace(/\s(?:right\s+)?after\s+(.+?)(?=\s+(?:and\s+(?:give|assign)|give|assign(?:ed)?|for)\b|\s*$)/i, (x, y) => { after = y; return ' '; });
  r = r.replace(/\s(?:and\s+)?(?:give (?:it|them) to|assign(?:ed)?(?: (?:it|them))? to|for)\s+(.+?)\s*$/i, (x, y) => {
    if (new RegExp(`^${NUM} ?${UNIT}\\b`, 'i').test(y.trim())) return x;   // "for 3 days" is a duration, not a person
    who = clean(y); return ' ';
  });
  const many = parseMany(r.trim(), project);
  if (!many) return planAddSingle(rest, project);
  const pred = after ? findTask(project, after) : null;
  if (after && !pred) return notFound(after);
  return planMany(many, { after: pred, who }, project);
}

function planAddSingle(rest, project) {
  let r = ` ${rest} `, after = null, who = null, d = null;
  const milestone = /\bmilestone\b/i.test(r);
  const quoted = r.match(/["“]([^"”]+)["”]/);
  r = r.replace(new RegExp(`\\s(?:for |lasting |that takes |taking )?${NUM}[ -]?${UNIT}\\b`, 'i'), (x, n, u) => { d = durOf(n, u, project); return ' '; });
  r = r.replace(/\s(?:right\s+)?after\s+(.+?)(?=\s+(?:and\s+(?:give|assign)|give|assign(?:ed)?|for)\b|\s*$)/i, (x, y) => { after = y; return ' '; });
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

  handle(text) {
    if (!text.trim()) return;
    this.say(esc(text), 'user');
    const { project, computed } = this.app;
    const res = interpret(text, { project, computed });
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
