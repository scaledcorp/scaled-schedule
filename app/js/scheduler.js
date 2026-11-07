// Critical path method. Reads a project and returns computed dates per task without changing it:
// early/late start and finish, total float, critical flag, summary rollups, work, cost, warnings.
import { WorkCalendar } from './calendar.js';
import { outline } from './model.js';

export function schedule(project) {
  const cal = new WorkCalendar(project.calendar);
  const ts = project.tasks;
  const { parent, summary, wbs } = outline(ts);
  const idx = new Map(ts.map((t, i) => [t.id, i]));
  const res = new Map(project.resources.map(r => [r.id, r]));
  const warnings = [];
  const c = ts.map((t, i) => ({
    id: t.id, row: i + 1, wbs: wbs[i], summary: summary[i], parent: parent[i] >= 0 ? ts[parent[i]].id : null,
    es: 0, ef: 0, ls: 0, lf: 0, float: 0, critical: false, work: 0, cost: 0, percent: t.percent || 0,
    leaves: [], violated: false,
  }));

  // leaves under each summary
  ts.forEach((t, i) => {
    if (summary[i]) return;
    for (let p = parent[i]; p >= 0; p = parent[p]) c[p].leaves.push(i);
  });
  const leafIdx = ts.map((_, i) => i).filter(i => !summary[i]);

  // Effective links into each leaf: its own plus those on its summaries.
  const links = new Map(leafIdx.map(i => [i, []]));
  for (const i of leafIdx) {
    for (let a = i; a >= 0; a = parent[a]) {
      for (const p of ts[a].preds) {
        const j = idx.get(p.id);
        if (j === undefined || j === i || (summary[j] && c[j].leaves.includes(i))) continue;
        links.get(i).push({ from: j, type: p.type, lag: p.lag || 0 });
      }
    }
  }

  // Topological order over leaves plus summaries used as predecessors.
  const nodes = new Set(leafIdx);
  links.forEach(ls => ls.forEach(l => { if (summary[l.from]) nodes.add(l.from); }));
  const deps = new Map([...nodes].map(n => [n, new Set()]));
  for (const n of nodes) {
    if (summary[n]) c[n].leaves.forEach(l => deps.get(n).add(l));
    else links.get(n).forEach(l => deps.get(n).add(l.from));
  }
  const order = [], indeg = new Map(), out = new Map([...nodes].map(n => [n, []]));
  deps.forEach((ds, n) => { indeg.set(n, ds.size); ds.forEach(d => out.get(d).push(n)); });
  const queue = [...nodes].filter(n => !indeg.get(n)).sort((a, b) => a - b);
  while (queue.length) {
    const n = queue.shift();
    order.push(n);
    for (const m of out.get(n)) if (indeg.set(m, indeg.get(m) - 1).get(m) === 0) queue.push(m);
  }
  if (order.length < nodes.size) {
    const stuck = [...nodes].filter(n => !order.includes(n)).sort((a, b) => a - b);
    warnings.push({ kind: 'cycle', rows: stuck.map(n => n + 1),
      text: `Circular links between rows ${stuck.map(n => n + 1).join(', ')}. Those links are ignored until fixed.` });
    stuck.forEach(n => { if (!summary[n]) links.set(n, links.get(n).filter(l => order.includes(l.from))); });
    order.push(...stuck);
  }

  const dur = i => (ts[i].milestone ? 0 : Math.max(0, ts[i].duration || 0));
  const startOf = (i, t) => (dur(i) > 0 ? cal.nextWorkStart(t) : t);
  const finishOf = (i, t) => (dur(i) > 0 ? cal.prevWorkEnd(t) : t);
  const projectStart = cal.nextWorkStart(project.start);

  // ---- forward pass
  for (const n of order) {
    if (summary[n]) {
      c[n].es = Math.min(...c[n].leaves.map(l => c[l].es));
      c[n].ef = Math.max(...c[n].leaves.map(l => c[l].ef));
      continue;
    }
    const t = ts[n], d = dur(n), con = t.constraint || { type: 'ASAP' };
    let es = projectStart;
    for (const l of links.get(n)) {
      const p = c[l.from];
      let s;
      if (l.type === 'FS') s = startOf(n, cal.shift(p.ef, l.lag));
      else if (l.type === 'SS') s = startOf(n, cal.shift(p.es, l.lag));
      else if (l.type === 'FF') s = cal.subtractWork(finishOf(n, cal.shift(p.ef, l.lag)), d);
      else s = cal.subtractWork(finishOf(n, cal.shift(p.es, l.lag)), d);
      es = Math.max(es, s);
    }
    if (con.date != null) {
      if (con.type === 'SNET') es = Math.max(es, startOf(n, con.date));
      else if (con.type === 'FNET') es = Math.max(es, cal.subtractWork(finishOf(n, con.date), d));
      else if (con.type === 'MSO') es = startOf(n, con.date);
      else if (con.type === 'MFO') es = cal.subtractWork(finishOf(n, con.date), d);
    }
    if (t.actualStart != null) es = t.actualStart;
    c[n].es = es;
    c[n].ef = t.actualFinish != null ? t.actualFinish : d > 0 ? cal.addWork(es, d) : es;
    if (con.date != null && ((con.type === 'SNLT' && es > startOf(n, con.date)) ||
        (con.type === 'FNLT' && c[n].ef > finishOf(n, con.date)))) {
      c[n].violated = true;
      warnings.push({ kind: 'constraint', rows: [n + 1],
        text: `Row ${n + 1} misses its "${con.type === 'SNLT' ? 'start' : 'finish'} no later than" date.` });
    }
  }

  // ---- backward pass
  const finish = leafIdx.length ? Math.max(...leafIdx.map(i => c[i].ef)) : projectStart;
  const succ = new Map(leafIdx.map(i => [i, []]));
  links.forEach((ls, to) => ls.forEach(l => {
    const froms = summary[l.from] ? c[l.from].leaves : [l.from];
    froms.forEach(f => succ.get(f).push({ to, type: l.type, lag: l.lag }));
  }));
  for (let k = order.length - 1; k >= 0; k--) {
    const n = order[k];
    if (summary[n]) continue;
    const t = ts[n], d = dur(n), con = t.constraint || { type: 'ASAP' };
    let lf = finish;
    for (const s of succ.get(n)) {
      const q = c[s.to];
      const back = x => cal.shift(x, -s.lag);
      if (s.type === 'FS') lf = Math.min(lf, finishOf(n, back(q.ls)));
      else if (s.type === 'SS') lf = Math.min(lf, cal.addWork(startOf(n, back(q.ls)), d));
      else if (s.type === 'FF') lf = Math.min(lf, finishOf(n, back(q.lf)));
      else lf = Math.min(lf, cal.addWork(startOf(n, back(q.lf)), d));
    }
    if (con.date != null) {
      if (con.type === 'SNLT') lf = Math.min(lf, cal.addWork(startOf(n, con.date), d));
      else if (con.type === 'FNLT') lf = Math.min(lf, finishOf(n, con.date));
      else if (con.type === 'MSO') lf = cal.addWork(startOf(n, con.date), d);
      else if (con.type === 'MFO') lf = finishOf(n, con.date);
    }
    c[n].lf = lf;
    c[n].ls = d > 0 ? cal.subtractWork(lf, d) : lf;
    if (con.type === 'ALAP' && t.actualStart == null) { c[n].es = c[n].ls; c[n].ef = c[n].lf; }
    c[n].float = cal.workBetween(c[n].es, c[n].ls);
    c[n].critical = c[n].float <= 0 && (t.percent || 0) < 100;
  }

  // ---- work and cost per leaf
  for (const i of leafIdx) {
    const t = ts[i], d = dur(i);
    let cost = t.fixedCost || 0, work = 0;
    for (const a of t.assignments) {
      const r = res.get(a.resourceId);
      if (!r) continue;
      if (r.type === 'work') { const w = d * a.units; work += w; cost += (w / 60) * (r.rate || 0); }
      else if (r.type === 'material') cost += a.units * (r.rate || 0);
      else cost += a.cost || 0;
      cost += r.costPerUse || 0;
    }
    c[i].work = work;
    c[i].cost = cost;
  }

  // ---- summary rollups (deepest first)
  for (let i = ts.length - 1; i >= 0; i--) {
    if (!summary[i]) continue;
    const ls = c[i].leaves.map(l => c[l]);
    c[i].es = Math.min(...ls.map(x => x.es));
    c[i].ef = Math.max(...ls.map(x => x.ef));
    c[i].ls = Math.min(...ls.map(x => x.ls));
    c[i].lf = Math.max(...ls.map(x => x.lf));
    c[i].float = Math.min(...ls.map(x => x.float));
    c[i].critical = ls.some(x => x.critical);
    c[i].work = ls.reduce((s, x) => s + x.work, 0);
    c[i].cost = ls.reduce((s, x) => s + x.cost, 0) + (ts[i].fixedCost || 0);
    const total = c[i].leaves.reduce((s, l) => s + dur(l), 0);
    c[i].percent = total ? c[i].leaves.reduce((s, l) => s + dur(l) * (ts[l].percent || 0), 0) / total : 0;
    c[i].duration = cal.workBetween(c[i].es, c[i].ef);
  }
  leafIdx.forEach(i => { c[i].duration = dur(i); });

  const byId = new Map(c.map(x => [x.id, x]));
  return {
    tasks: c, byId, start: projectStart, finish, warnings, calendar: cal,
    over: overallocation(project, c, cal, res),
    cost: leafIdx.reduce((s, i) => s + c[i].cost, 0) + ts.reduce((s, t, i) => s + (summary[i] ? t.fixedCost || 0 : 0), 0),
    work: leafIdx.reduce((s, i) => s + c[i].work, 0),
  };
}

// Resources booked above their max units on any working day: Map resourceId -> [dayIndex,...].
function overallocation(project, c, cal, res) {
  const load = new Map();
  project.tasks.forEach((t, i) => {
    if (c[i].summary || t.milestone || !t.duration) return;
    const d0 = Math.floor(c[i].es / 1440), d1 = Math.floor((c[i].ef - 1) / 1440);
    for (const a of t.assignments) {
      const r = res.get(a.resourceId);
      if (!r || r.type !== 'work') continue;
      let m = load.get(r.id);
      if (!m) load.set(r.id, (m = new Map()));
      for (let d = d0; d <= d1; d++) if (cal.isWorkingDay(d)) m.set(d, (m.get(d) || 0) + a.units);
    }
  });
  const over = new Map();
  load.forEach((m, id) => {
    const max = res.get(id).maxUnits ?? 1;
    const days = [...m].filter(([, u]) => u > max + 1e-9).map(([d]) => d);
    if (days.length) over.set(id, days);
  });
  return over;
}
