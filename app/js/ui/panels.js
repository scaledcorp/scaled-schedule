// Side panels and overlays: task details card, resource sheet, settings dialog, command palette,
// toasts and pop-up menus.
import { CONSTRAINTS, createResource, endOfDay, fmtDate, fmtHours, fmtMoney, formatDuration, formatLag,
  isoDay, LINK_TYPES, parseDay, parseDuration, parseLag, startOfDay, yearOf } from '../model.js';
import { usFederalHolidays, WorkCalendar } from '../calendar.js';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const X = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';

// ---------------------------------------------------------------- toasts
export function toast(text, action) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(text)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { action.run(); close(); };
    el.appendChild(b);
  }
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 260); };
  setTimeout(close, action ? 6000 : 3200);
}

// ---------------------------------------------------------------- menus
export function menu(anchor, items) {
  document.querySelector('.menu')?.remove();
  const m = document.createElement('div');
  m.className = 'menu';
  m.innerHTML = items.map((it, i) => `<button data-i="${i}">${it.icon || ''}<span>${esc(it.label)}<small>${esc(it.hint || '')}</small></span></button>`).join('');
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = `${Math.min(r.left, innerWidth - m.offsetWidth - 8)}px`;
  m.style.top = `${r.bottom + 6}px`;
  const off = e => { if (!m.contains(e.target)) { m.remove(); removeEventListener('pointerdown', off, true); } };
  setTimeout(() => addEventListener('pointerdown', off, true));
  m.addEventListener('click', e => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    m.remove();
    removeEventListener('pointerdown', off, true);
    items[+b.dataset.i].run();
  });
}

// ---------------------------------------------------------------- dialog helpers
export function dialog(html, onReady) {
  const d = document.getElementById('dialog');
  d.innerHTML = html;
  d.showModal();
  onReady?.(d);
  return d;
}

export function ask(title, text, buttons) {
  return new Promise(resolve => {
    const d = dialog(`<div class="dlg-body"><h2>${esc(title)}</h2><p class="hint" style="font-size:14px">${esc(text)}</p></div>
      <div class="actions">${buttons.map((b, i) => `<button class="btn ${b.primary ? 'primary' : ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>`);
    d.onclick = e => { const b = e.target.closest('button[data-i]'); if (b) { d.close(); resolve(buttons[+b.dataset.i].value); } };
    d.oncancel = () => resolve(null);
  });
}

// ---------------------------------------------------------------- task details
export function renderDetails(app) {
  const el = document.getElementById('details');
  const { project, computed, store } = app;
  const id = store.focusId;
  const t = project.tasks.find(x => x.id === id);
  if (!app.detailsOpen || !t) { el.classList.remove('open'); return; }
  const k = computed.byId.get(id), cal = app.cal;
  const rowOf = new Map(project.tasks.map((x, i) => [x.id, i + 1]));
  const others = project.tasks.filter(x => x.id !== id);
  const con = t.constraint || { type: 'ASAP' };
  const variance = t.baseline ? `<div class="stat"><span>Finish vs baseline</span><span>${formatDuration(cal.workBetween(t.baseline.finish, k.ef), project)}</span></div>` : '';
  el.innerHTML = `
    <header><h2>Row ${rowOf.get(id)}${k.summary ? ' · summary' : ''}</h2>
      <button class="btn icon" data-act="close" title="Close (Esc)">${X}</button></header>
    <div class="body">
      <label class="field"><span>Name</span><input data-f="name" value="${esc(t.name)}"></label>
      <div class="two">
        <label class="field"><span>Duration</span><input data-f="duration" value="${esc(formatDuration(k.duration, project))}" ${k.summary ? 'disabled' : ''}></label>
        <label class="field"><span>% complete</span><input data-f="percent" type="number" min="0" max="100" value="${Math.round(t.percent)}" ${k.summary ? 'disabled' : ''}></label>
      </div>
      <input data-f="percentRange" type="range" min="0" max="100" step="5" value="${Math.round(k.percent)}" ${k.summary ? 'disabled' : ''} aria-label="Percent complete">
      <div class="two">
        <div class="stat"><span>Start</span><span>${fmtDate(k.es)}</span></div>
        <div class="stat"><span>Finish</span><span>${fmtDate(k.ef)}</span></div>
      </div>
      ${k.summary ? '' : `<div class="two">
        <label class="field"><span>Constraint</span><select data-f="ctype">${Object.entries(CONSTRAINTS).map(([v, l]) => `<option value="${v}" ${v === con.type ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field"><span>Date</span><input data-f="cdate" value="${con.date != null ? isoDay(con.date) : ''}" placeholder="YYYY-MM-DD" ${['ASAP', 'ALAP'].includes(con.type) ? 'disabled' : ''}></label>
      </div>`}
      <div class="field"><span>Predecessors</span>
        ${t.preds.map((p, i) => `<div class="list-row">
          <select data-pred="${i}" data-pf="id">${others.map(o => `<option value="${o.id}" ${o.id === p.id ? 'selected' : ''}>${rowOf.get(o.id)}. ${esc(o.name || 'Untitled')}</option>`).join('')}</select>
          <select data-pred="${i}" data-pf="type">${LINK_TYPES.map(v => `<option ${v === p.type ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <input data-pred="${i}" data-pf="lag" value="${esc(formatLag(p.lag, project) || '0d')}" title="Lag, e.g. +2d or -1d">
          <button class="btn icon" data-act="delPred" data-i="${i}" title="Remove link">${X}</button></div>`).join('')}
        <button class="btn" data-act="addPred" style="justify-self:start">Add a predecessor</button>
      </div>
      <div class="field"><span>Resources</span>
        ${t.assignments.map((a, i) => `<div class="list-row asg">
          <select data-asg="${i}" data-af="resourceId">${project.resources.map(r => `<option value="${r.id}" ${r.id === a.resourceId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
          <input data-asg="${i}" data-af="units" value="${Math.round(a.units * 100)}%" title="Units">
          <button class="btn icon" data-act="delAsg" data-i="${i}" title="Remove">${X}</button></div>`).join('')}
        <button class="btn" data-act="addAsg" style="justify-self:start">Assign a resource</button>
      </div>
      <label class="field"><span>Notes</span><textarea data-f="notes">${esc(t.notes)}</textarea></label>
      <div>
        <div class="stat"><span>Total float</span><span>${formatDuration(k.float, project)}${k.critical ? ' · critical' : ''}</span></div>
        <div class="stat"><span>Work</span><span>${fmtHours(k.work)}</span></div>
        <div class="stat"><span>Cost</span><span>${fmtMoney(k.cost, project.currency)}</span></div>
        ${variance}
      </div>
    </div>`;
  el.classList.add('open');
  const upd = (label, fn) => { try { store.update(label, fn); } catch (err) { app.toast(err.message); app.render(); } };
  el.onclick = e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    const i = +e.target.closest('[data-act]').dataset.i;
    if (act === 'close') app.closeDetails();
    else if (act === 'delPred') upd('Remove link', () => { t.preds.splice(i, 1); });
    else if (act === 'addPred') {
      const cand = project.tasks[rowOf.get(id) - 2] || others[0];
      if (cand) upd('Add link', () => { t.preds.push({ id: cand.id, type: 'FS', lag: 0 }); });
    } else if (act === 'delAsg') upd('Remove assignment', () => { t.assignments.splice(i, 1); });
    else if (act === 'addAsg') upd('Assign resource', pr => {
      let r = pr.resources.find(x => !t.assignments.some(a => a.resourceId === x.id));
      if (!r) { r = createResource(pr, { name: `Resource ${pr.resources.length + 1}` }); pr.resources.push(r); }
      t.assignments.push({ resourceId: r.id, units: 1 });
    });
  };
  el.onchange = e => {
    const f = e.target.dataset.f, v = e.target.value;
    if (f === 'name') upd('Rename task', () => { t.name = v; });
    else if (f === 'duration') {
      const m = parseDuration(v, project);
      if (m == null) { app.toast(`Can't read "${v}" as a duration. Try 5d, 2w or 4h.`); app.render(); return; }
      upd('Change duration', () => { t.duration = m; t.milestone = m === 0; });
    } else if (f === 'percent' || f === 'percentRange') upd('Update progress', () => setPercent(t, +v, k, cal));
    else if (f === 'ctype') upd('Change constraint', () => {
      t.constraint = { type: v, date: ['ASAP', 'ALAP'].includes(v) ? null : con.date ?? k.es };
    });
    else if (f === 'cdate') {
      const day = parseDay(v, yearOf(project.start));
      if (day == null) { app.toast(`Can't read "${v}" as a date.`); app.render(); return; }
      upd('Change constraint date', () => { t.constraint = { ...con, date: con.type.startsWith('F') || con.type === 'MFO' ? endOfDay(day, cal) : startOfDay(day, cal) }; });
    } else if (f === 'notes') upd('Edit notes', () => { t.notes = v; });
    else if (e.target.dataset.pred != null) {
      const p = t.preds[+e.target.dataset.pred], pf = e.target.dataset.pf;
      if (pf === 'lag') {
        const lag = parseLag(v.replace(/^0d$/, '0'), project);
        if (lag == null) { app.toast(`Can't read "${v}" as a lag. Try +2d or -1d.`); app.render(); return; }
        upd('Change lag', () => { p.lag = lag; });
      } else upd('Change link', () => { p[pf] = pf === 'id' ? +v : v; });
    } else if (e.target.dataset.asg != null) {
      const a = t.assignments[+e.target.dataset.asg], af = e.target.dataset.af;
      upd('Change assignment', () => { a[af] = af === 'units' ? Math.max(0, parseFloat(v) || 0) / 100 : +v; });
    }
  };
  el.oninput = e => {
    if (e.target.dataset.f === 'percentRange') el.querySelector('[data-f="percent"]').value = e.target.value;
  };
}

// Percent complete also records actual start/finish, like Project does.
export function setPercent(t, pct, k, cal) {
  t.percent = Math.max(0, Math.min(100, Math.round(pct)));
  if (t.percent > 0 && t.actualStart == null) t.actualStart = k.es;
  if (t.percent === 0) { t.actualStart = null; t.actualFinish = null; }
  t.actualFinish = t.percent === 100 ? (t.actualFinish ?? k.ef) : null;
}

// ---------------------------------------------------------------- resources
export function renderResources(app) {
  const el = document.getElementById('resourceView');
  const { project, computed } = app;
  const work = new Map(), cost = new Map();
  project.tasks.forEach((t, i) => {
    const k = computed.tasks[i];
    if (k.summary) return;
    t.assignments.forEach(a => {
      const r = project.resources.find(x => x.id === a.resourceId);
      if (!r) return;
      const w = r.type === 'work' ? (t.milestone ? 0 : t.duration) * a.units : 0;
      work.set(r.id, (work.get(r.id) || 0) + w);
      cost.set(r.id, (cost.get(r.id) || 0) + (r.type === 'work' ? (w / 60) * r.rate : r.type === 'material' ? a.units * r.rate : 0) + (r.costPerUse || 0));
    });
  });
  el.innerHTML = `<table class="sheet"><thead><tr><th>Name</th><th>Type</th><th>Group</th><th>Max units</th><th>Rate per hour</th>
    <th>Cost per use</th><th>Work</th><th>Cost</th><th></th></tr></thead><tbody>
    ${project.resources.map(r => {
      const over = computed.over.get(r.id);
      return `<tr class="${over ? 'over' : ''}" data-id="${r.id}">
        <td><input data-rf="name" value="${esc(r.name)}">${over ? `<div class="warn">Over-booked on ${over.length} day${over.length > 1 ? 's' : ''}, first ${fmtDate(over[0] * 1440)}</div>` : ''}</td>
        <td><select data-rf="type">${['work', 'material', 'cost'].map(v => `<option ${v === r.type ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
        <td><input data-rf="group" value="${esc(r.group)}"></td>
        <td><input data-rf="maxUnits" value="${Math.round((r.maxUnits ?? 1) * 100)}%" style="width:80px"></td>
        <td><input data-rf="rate" value="${r.rate || 0}" style="width:90px"></td>
        <td><input data-rf="costPerUse" value="${r.costPerUse || 0}" style="width:90px"></td>
        <td class="tnum">${fmtHours(work.get(r.id) || 0)}</td>
        <td class="tnum">${fmtMoney(cost.get(r.id) || 0, project.currency)}</td>
        <td><button class="btn icon" data-act="del" title="Delete resource">${X}</button></td></tr>`;
    }).join('')}
    </tbody></table>
    <p><button class="btn primary" data-act="add">Add a resource</button>
    <span class="hint">&nbsp; Tip: type names in the Resources column of the task table, like "Ana[50%], Ben", and they're added here.</span></p>`;
  el.onchange = e => {
    const f = e.target.dataset.rf, id = +e.target.closest('tr')?.dataset.id, v = e.target.value;
    const r = project.resources.find(x => x.id === id);
    if (!r || !f) return;
    app.store.update('Edit resource', () => {
      if (f === 'maxUnits') r.maxUnits = Math.max(0, parseFloat(v) || 0) / 100;
      else if (f === 'rate' || f === 'costPerUse') r[f] = Math.max(0, parseFloat(String(v).replace(/[$,]/g, '')) || 0);
      else r[f] = v;
    });
  };
  el.onclick = e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'add') app.store.update('Add resource', pr => { pr.resources.push(createResource(pr, { name: `Resource ${pr.resources.length + 1}` })); });
    if (act === 'del') {
      const id = +e.target.closest('tr').dataset.id;
      app.store.update('Delete resource', pr => {
        pr.resources = pr.resources.filter(r => r.id !== id);
        pr.tasks.forEach(t => { t.assignments = t.assignments.filter(a => a.resourceId !== id); });
      });
    }
  };
}

// ---------------------------------------------------------------- settings (project + calendar)
export function openSettings(app) {
  const p = app.project, cal = p.calendar;
  const day = cal.week.find(r => r.length) || [[480, 720], [780, 1020]];
  const hm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const year = yearOf(app.computed.start);
  const d = dialog(`<form method="dialog"><div class="dlg-body">
    <h2>Project settings</h2>
    <label class="field"><span>Project name</span><input name="name" value="${esc(p.name)}"></label>
    <div class="two">
      <label class="field"><span>Project start</span><input name="start" value="${isoDay(p.start)}"></label>
      <label class="field"><span>Hours per day</span><input name="hpd" value="${p.minutesPerDay / 60}"></label>
    </div>
    <div class="field"><span>Working days</span><div class="days">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((n, i) =>
      `<label><input type="checkbox" name="wd${i}" ${cal.week[i].length ? 'checked' : ''}>${n}</label>`).join('')}</div></div>
    <div class="two">
      <label class="field"><span>Morning</span><input name="am" value="${hm(day[0][0])}-${hm(day[0][1])}"></label>
      <label class="field"><span>Afternoon</span><input name="pm" value="${day[1] ? `${hm(day[1][0])}-${hm(day[1][1])}` : ''}" placeholder="none"></label>
    </div>
    <div class="field"><span>Holidays</span>
      <div class="hol-list" id="holList"></div>
      <div class="two"><input id="holDate" placeholder="Date, e.g. 2027-03-12"><input id="holName" placeholder="Name"></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button type="button" class="btn" id="holAdd">Add holiday</button>
        <button type="button" class="btn" id="holUS">Add US federal holidays for ${year}</button>
        <button type="button" class="btn" id="holUS2">and ${year + 1}</button>
      </div>
    </div>
  </div><div class="actions"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok">Save settings</button></div></form>`);
  let hols = cal.exceptions.map(e => ({ ...e }));
  const list = () => {
    hols.sort((a, b) => a.date.localeCompare(b.date));
    d.querySelector('#holList').innerHTML = hols.length ? hols.map((h, i) => `<div><span>${fmtDate(Date.parse(h.date + 'T00:00:00Z') / 60000)} · ${esc(h.name || 'Holiday')}</span><button type="button" class="btn icon" data-i="${i}">${X}</button></div>`).join('')
      : '<div class="hint">No holidays yet.</div>';
  };
  list();
  const merge = add => { add.forEach(h => { if (!hols.some(x => x.date === h.date)) hols.push(h); }); list(); };
  d.querySelector('#holList').onclick = e => { const b = e.target.closest('[data-i]'); if (b) { hols.splice(+b.dataset.i, 1); list(); } };
  d.querySelector('#holUS').onclick = () => merge(usFederalHolidays(year));
  d.querySelector('#holUS2').onclick = () => merge(usFederalHolidays(year + 1));
  d.querySelector('#holAdd').onclick = () => {
    const dd = parseDay(d.querySelector('#holDate').value, year);
    if (dd == null) { toast('Type the holiday date like 2027-03-12.'); return; }
    merge([{ date: isoDay(dd * 1440), name: d.querySelector('#holName').value || 'Holiday', ranges: [] }]);
  };
  d.onclose = () => {
    if (d.returnValue !== 'ok') return;
    const f = d.querySelector('form').elements;
    const span = s => { const m = String(s).match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/); return m ? [[+m[1] * 60 + +m[2], +m[3] * 60 + +m[4]]] : []; };
    const ranges = [...span(f.am.value), ...span(f.pm.value)].filter(([a, b]) => b > a);
    if (!ranges.length) { toast('Working hours look like 08:00-12:00.'); return; }
    const week = [0, 1, 2, 3, 4, 5, 6].map(i => (f[`wd${i}`].checked ? ranges : []));
    if (!week.some(r => r.length)) { toast('Pick at least one working day.'); return; }
    const startDay = parseDay(f.start.value, year);
    const hpd = parseFloat(f.hpd.value);
    app.store.update('Change settings', pr => {
      pr.name = f.name.value.trim() || pr.name;
      pr.calendar = { ...pr.calendar, week, exceptions: hols };
      if (hpd > 0 && hpd <= 24) { pr.minutesPerDay = Math.round(hpd * 60); pr.minutesPerWeek = pr.minutesPerDay * week.filter(r => r.length).length; }
      if (startDay != null) pr.start = new WorkCalendar(pr.calendar).nextWorkStart(startDay * 1440);
    });
    app.toast('Settings saved');
  };
}

// ---------------------------------------------------------------- command palette
export function openPalette(app) {
  const pal = document.getElementById('palette'), input = document.getElementById('paletteInput'), list = document.getElementById('paletteList');
  const cmds = app.commandList();
  let shown = cmds, on = 0;
  const draw = () => {
    list.innerHTML = shown.map((c, i) => `<li class="${i === on ? 'on' : ''}" data-i="${i}"><span>${esc(c.label)}</span><kbd>${esc(c.keys || '')}</kbd></li>`).join('');
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => { pal.hidden = true; app.focusGrid(); };
  const run = i => { const c = shown[i]; close(); if (c) app.run(c.id); };
  input.value = '';
  pal.hidden = false;
  draw();
  input.focus();
  input.oninput = () => {
    const q = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = cmds.filter(c => q.every(w => c.label.toLowerCase().includes(w)));
    on = 0;
    draw();
  };
  input.onkeydown = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); on = Math.min(shown.length - 1, on + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); on = Math.max(0, on - 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(on); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
  list.onclick = e => { const li = e.target.closest('li'); if (li) run(+li.dataset.i); };
  pal.onclick = e => { if (e.target === pal) close(); };
}
