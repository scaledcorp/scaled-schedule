// The Gantt chart. Bars are kept between renders (keyed by task id) so changes glide instead of
// jumping. Drag a bar to move it, its right edge to stretch it, or its dot onto another bar to link.
import { addLink, fmtDate, formatAssignments, formatDuration, MON, MONTH } from '../model.js';
import { DAY, dayIndex, weekday } from '../calendar.js';

const ZOOMS = [3, 6, 12, 24, 44];
const PALETTE = ['#2F80ED', '#7C5CFF', '#12B886', '#FF7A45', '#E64980', '#15AABF', '#F59F00'];
const ROW = 34;

export class Gantt {
  constructor(app) {
    this.app = app;
    this.body = document.getElementById('chartBody');
    this.canvas = document.getElementById('chartCanvas');
    this.ts = document.getElementById('tsInner');
    this.zoom = 2;
    this.els = new Map();
    this.known = new Set();
    this.viewStart = null;
    this.critical = false;
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.classList.add('links');
    this.layer = document.createElement('div');
    this.canvas.append(this.layer, this.svg);
    this.body.addEventListener('scroll', () => {
      this.ts.style.transform = `translateX(${-this.body.scrollLeft}px)`;
      this.app.syncScroll('chart', this.body.scrollTop);
    });
    this.body.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('pointerdown', e => this.onDown(e));
    this.canvas.addEventListener('dblclick', e => { const b = e.target.closest('.bar'); if (b) this.app.openDetails(+b.dataset.id); });
    this.canvas.addEventListener('mousemove', e => this.hover(e));
    this.canvas.addEventListener('mouseleave', () => this.tip());
  }

  get ppd() { return ZOOMS[this.zoom]; }
  dayX(day) { return (day - this.viewStart) * this.ppd; }
  x(t) { return this.dayX(dayIndex(t) + this.app.cal.dayFraction(t)); }

  reset() {
    this.viewStart = null;
    this.known.clear();
    this.els.forEach(e => { e.bar.remove(); e.label.remove(); e.base.remove(); });
    this.els.clear();
  }

  setZoom(z, anchorClientX) {
    z = Math.max(0, Math.min(ZOOMS.length - 1, z));
    if (z === this.zoom) return;
    const rect = this.body.getBoundingClientRect();
    const px = anchorClientX != null ? anchorClientX - rect.left : this.body.clientWidth / 2;
    const day = (this.body.scrollLeft + px) / this.ppd + this.viewStart;
    this.zoom = z;
    this.render();
    this.body.scrollLeft = (day - this.viewStart) * this.ppd - px;
  }

  render() {
    const { project, computed, rows } = this.app;
    const cal = this.app.cal;
    const firstDay = dayIndex(Math.min(project.start, computed.start));
    let want = firstDay - 7;
    want -= (weekday(want) + 6) % 7;                      // back to a Monday
    if (this.viewStart == null || want < this.viewStart) {
      const shift = this.viewStart == null ? 0 : (this.viewStart - want) * this.ppd;
      this.viewStart = want;
      if (shift) requestAnimationFrame(() => { this.body.scrollLeft += shift; });
    }
    const lastDay = dayIndex(computed.finish) + 42;
    const width = Math.max(this.dayX(lastDay), this.body.clientWidth);
    const height = (rows.length + 1) * ROW;
    const ppd = this.ppd;
    Object.assign(this.canvas.style, { width: `${width}px`, height: `${height}px` });
    const weekend = ppd >= 9 ? `linear-gradient(to right, transparent ${5 * ppd}px, var(--weekend) ${5 * ppd}px)` : 'none';
    this.canvas.style.backgroundImage = `${weekend}, linear-gradient(to bottom, transparent ${ROW - 1}px, var(--line-soft) ${ROW - 1}px)`;
    this.canvas.style.backgroundSize = `${7 * ppd}px 100%, 100% ${ROW}px`;
    this.ts.style.width = `${width}px`;
    this.renderScale(lastDay);

    // holidays and today
    const extras = [];
    if (ppd >= 9) for (const e of project.calendar.exceptions) {
      if (e.ranges?.length) continue;
      const d = Math.round(Date.parse(e.date + 'T00:00:00Z') / 86400000);
      if (d >= this.viewStart && d <= lastDay) extras.push(`<div class="holiday" style="left:${this.dayX(d)}px;width:${ppd}px" title="${e.name || 'Holiday'}"></div>`);
    }
    const today = Math.floor(Date.now() / 60000 / DAY - new Date().getTimezoneOffset() / 1440);
    if (today >= this.viewStart && today <= lastDay) extras.push(`<div class="today-line" style="left:${this.dayX(today + 0.5)}px"></div>`);
    this.layer.innerHTML = extras.join('');

    // bars
    const resById = new Map(project.resources.map(r => [r.id, r]));
    const top = new Map();
    const seen = new Set();
    let phase = -1;
    project.tasks.forEach((t, i) => { if (t.level === 1) phase++; top.set(t.id, phase); });
    this.pos = new Map();
    rows.forEach((i, r) => {
      const t = project.tasks[i], k = computed.tasks[i];
      seen.add(t.id);
      let e = this.els.get(t.id);
      const isNew = !e;
      if (isNew) {
        const bar = document.createElement('div');
        bar.innerHTML = '<div class="prog"></div><div class="grip"></div><div class="dot" title="Drag onto another task to link"></div>';
        const label = document.createElement('div');
        label.className = 'bar-label';
        const base = document.createElement('div');
        base.className = 'baseline-bar';
        this.canvas.append(base, bar, label);
        e = { bar, label, base };
        this.els.set(t.id, e);
      }
      const ms = t.milestone && !k.summary;
      const x1 = this.x(k.es), x2 = ms ? x1 : Math.max(this.x(k.ef), x1 + 3);
      const h = k.summary ? 10 : ms ? 16 : 18;
      const y = r * ROW + (ROW - h) / 2 - (k.summary ? 2 : 0);
      this.pos.set(t.id, { x1, x2, y: r * ROW + ROW / 2, r });
      const cls = ['bar'];
      if (k.summary) cls.push('summary');
      if (ms) cls.push('milestone');
      if (this.app.store.selection.has(t.id)) cls.push('sel');
      if (this.critical) cls.push('crit-mode');
      if (k.critical) cls.push('crit');
      if (isNew && this.known.size && !this.known.has(t.id)) cls.push('pop');
      e.bar.className = cls.join(' ');
      e.bar.dataset.id = t.id;
      e.bar.style.setProperty('--c', !this.critical ? PALETTE[top.get(t.id) % PALETTE.length]
        : k.critical ? 'var(--crit)' : 'color-mix(in srgb, var(--faint) 50%, var(--pane))');
      e.bar.style.transform = `translate(${x1}px, ${y}px)`;
      e.bar.style.width = `${ms ? 16 : x2 - x1}px`;
      e.bar.firstChild.style.width = `${k.percent}%`;
      const label = ms ? fmtDate(k.es).slice(4) : k.summary ? '' : formatAssignments(t, resById);
      e.label.textContent = label;
      e.label.style.transform = `translate(${x2 + (ms ? 14 : 10)}px, ${r * ROW + 9}px)`;
      if (t.baseline && this.app.showBaseline) {
        const bx = this.x(t.baseline.start), bw = Math.max(this.x(t.baseline.finish) - bx, 3);
        Object.assign(e.base.style, { display: '', width: `${bw}px`, transform: `translate(${bx}px, ${r * ROW + ROW - 8}px)` });
      } else e.base.style.display = 'none';
    });
    for (const [id, e] of this.els) {
      if (!seen.has(id)) { e.bar.remove(); e.label.remove(); e.base.remove(); this.els.delete(id); }
    }
    project.tasks.forEach(t => this.known.add(t.id));
    this.renderLinks();
  }

  renderLinks(extra = '') {
    const { project, computed } = this.app;
    const parts = [];
    project.tasks.forEach(t => t.preds.forEach(p => {
      const a = this.pos.get(p.id), b = this.pos.get(t.id);
      if (!a || !b) return;
      const crit = this.critical && computed.byId.get(p.id).critical && computed.byId.get(t.id).critical ? ' crit' : '';
      const fromFinish = p.type[0] === 'F', toStart = p.type[1] === 'S';
      const x1 = fromFinish ? a.x2 : a.x1, y1 = a.y, x2 = toStart ? b.x1 : b.x2, y2 = b.y;
      const down = y2 > y1 ? 1 : -1, end = y2 - down * 10;
      let d, head;
      if (fromFinish && toStart && x2 >= x1 + 8) {
        const xe = Math.max(x1 + 8, x2 + 4);
        d = `M${x1} ${y1}H${xe}V${end}`;
        head = `M${xe - 4} ${end - down * 5}L${xe + 4} ${end - down * 5}L${xe} ${end + down * 1}Z`;
      } else {
        const out = fromFinish ? x1 + 8 : x1 - 8, mid = y1 + down * ROW / 2, inX = toStart ? x2 - 9 : x2 + 9;
        d = `M${x1} ${y1}H${out}V${mid}H${inX}V${y2}H${toStart ? x2 - 4 : x2 + 4}`;
        head = toStart ? `M${x2 - 5} ${y2 - 4}L${x2 - 5} ${y2 + 4}L${x2} ${y2}Z` : `M${x2 + 5} ${y2 - 4}L${x2 + 5} ${y2 + 4}L${x2} ${y2}Z`;
      }
      parts.push(`<path class="${crit.trim()}" d="${d}"/><path class="head${crit}" d="${head}"/>`);
    }));
    this.svg.innerHTML = parts.join('') + extra;
  }

  renderScale(lastDay) {
    const ppd = this.ppd, cells = [];
    const dt = d => new Date(d * 86400000);
    const add = (cls, a, b, label) => cells.push(`<div class="ts-cell ${cls}" style="left:${this.dayX(a)}px;width:${(b - a) * ppd}px">${label}</div>`);
    const today = Math.floor(Date.now() / 86400000 - new Date().getTimezoneOffset() / 1440);
    const months = [], weeks = [];
    for (let d = this.viewStart; d <= lastDay; d++) {
      const x = dt(d);
      if (x.getUTCDate() === 1 || d === this.viewStart) months.push(d);
      if (weekday(d) === 1) weeks.push(d);
    }
    const span = (list, i, end) => [list[i], list[i + 1] ?? end];
    if (ppd >= 20) {
      weeks.forEach((d, i) => { const [a, b] = span(weeks, i, lastDay); const x = dt(d); add('ts-top', a, b, `${MON[x.getUTCMonth()]} ${x.getUTCDate()}, ${x.getUTCFullYear()}`); });
      for (let d = this.viewStart; d < lastDay; d++) add(`ts-bot${d === today ? ' today' : ''}`, d, d + 1, `${'SMTWTFS'[weekday(d)]} ${dt(d).getUTCDate()}`);
    } else if (ppd >= 9) {
      months.forEach((d, i) => { const [a, b] = span(months, i, lastDay); const x = dt(d); add('ts-top', a, b, `${MONTH[x.getUTCMonth()]} ${x.getUTCFullYear()}`); });
      weeks.forEach((d, i) => { const [a, b] = span(weeks, i, lastDay); add('ts-bot', a, b, String(dt(d).getUTCDate())); });
    } else {
      const quarters = months.filter(d => dt(d).getUTCMonth() % 3 === 0 || d === this.viewStart);
      const years = months.filter(d => dt(d).getUTCMonth() === 0 || d === this.viewStart);
      if (ppd >= 4.5) {
        quarters.forEach((d, i) => { const [a, b] = span(quarters, i, lastDay); const x = dt(d); add('ts-top', a, b, `Q${Math.floor(x.getUTCMonth() / 3) + 1} ${x.getUTCFullYear()}`); });
        months.forEach((d, i) => { const [a, b] = span(months, i, lastDay); add('ts-bot', a, b, MON[dt(d).getUTCMonth()]); });
      } else {
        years.forEach((d, i) => { const [a, b] = span(years, i, lastDay); add('ts-top', a, b, String(dt(d).getUTCFullYear())); });
        quarters.forEach((d, i) => { const [a, b] = span(quarters, i, lastDay); add('ts-bot', a, b, `Q${Math.floor(dt(d).getUTCMonth() / 3) + 1}`); });
      }
    }
    this.ts.innerHTML = cells.join('');
  }

  scrollTo(id) {
    const p = this.pos?.get(id);
    if (p) this.body.scrollTo({ left: Math.max(0, p.x1 - 120), behavior: 'smooth' });
  }

  onWheel(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    clearTimeout(this.wheelT);
    this.wheelAcc = (this.wheelAcc || 0) + e.deltaY;
    if (Math.abs(this.wheelAcc) > 40) { this.setZoom(this.zoom + (this.wheelAcc < 0 ? 1 : -1), e.clientX); this.wheelAcc = 0; }
    this.wheelT = setTimeout(() => { this.wheelAcc = 0; }, 200);
  }

  tip(html, x, y) {
    if (!this.tipEl) { this.tipEl = document.createElement('div'); this.tipEl.className = 'tip'; }
    if (!html) { this.tipEl.remove(); return; }
    this.tipEl.innerHTML = html;
    document.body.appendChild(this.tipEl);
    this.tipEl.style.left = `${Math.min(x + 14, innerWidth - this.tipEl.offsetWidth - 8)}px`;
    this.tipEl.style.top = `${y + 16}px`;
  }

  hover(e) {
    if (this.drag) return;
    const b = e.target.closest('.bar');
    if (!b) { this.tip(); return; }
    const { project, computed } = this.app;
    const t = project.tasks.find(x => x.id === +b.dataset.id), k = computed.byId.get(t.id);
    const float = k.summary ? '' : ` · float ${formatDuration(k.float, project)}`;
    this.tip(`<b>${t.name || 'Untitled task'}</b><br>${fmtDate(k.es)} to ${fmtDate(k.ef)} · ${formatDuration(k.duration, project)}${float}`, e.clientX, e.clientY);
  }

  onDown(e) {
    const b = e.target.closest('.bar');
    if (!b || e.button !== 0) return;
    const id = +b.dataset.id, { project, computed, store } = this.app;
    const k = computed.byId.get(id), t = project.tasks.find(x => x.id === id);
    const mode = e.target.closest('.dot') ? 'link' : e.target.closest('.grip') && !k.summary ? 'resize' : k.summary ? 'select' : 'move';
    if (!store.selection.has(id) || store.selection.size > 1) store.select([id], id);
    e.preventDefault();
    b.setPointerCapture(e.pointerId);
    const p = this.pos.get(id), x0 = e.clientX, ppd = this.ppd, cal = this.app.cal;
    let days = 0, moved = false;
    this.drag = { id, mode };
    this.tip();
    const move = ev => {
      const dx = ev.clientX - x0;
      if (Math.abs(dx) > 3 || Math.abs(ev.clientY - e.clientY) > 3) moved = true;
      if (!moved) return;
      if (mode === 'move') {
        days = Math.round(dx / ppd);
        b.classList.add('dragging');
        b.style.transform = `translate(${p.x1 + days * ppd}px, ${parseFloat(b.style.transform.split(',')[1])}px)`;
        const day = dayIndex(k.es) + days;
        this.tip(`<b>Start ${fmtDate(cal.nextWorkStart(day * DAY + cal.firstWorkMinute(day)))}</b>`, ev.clientX, ev.clientY);
      } else if (mode === 'resize') {
        days = Math.round(dx / ppd);
        const dur = Math.max(project.minutesPerDay, t.duration + days * project.minutesPerDay);
        b.classList.add('dragging');
        b.style.width = `${Math.max(3, p.x2 - p.x1 + days * ppd)}px`;
        this.tip(`<b>${formatDuration(dur, project)}</b>`, ev.clientX, ev.clientY);
      } else if (mode === 'link') {
        const r = this.canvas.getBoundingClientRect();
        const tx = ev.clientX - r.left, ty = ev.clientY - r.top;
        this.renderLinks(`<path class="temp" d="M${p.x2 + 10} ${p.y}L${tx} ${ty}"/>`);
      }
    };
    const up = ev => {
      b.removeEventListener('pointermove', move);
      b.removeEventListener('pointerup', up);
      b.removeEventListener('pointercancel', up);
      b.classList.remove('dragging');
      this.drag = null;
      this.tip();
      if (!moved) { if (mode === 'link') this.renderLinks(); return; }
      if (mode === 'move' && days) {
        const day = dayIndex(k.es) + days;
        const date = cal.nextWorkStart(day * DAY + cal.firstWorkMinute(day));
        store.update('Move task', () => { t.constraint = { type: 'SNET', date }; });
        const now = this.app.computed.byId.get(id).es;
        if (now > date) this.app.toast(`Links hold this task to ${fmtDate(now)}. Use "Must start on" in task details to override.`);
      } else if (mode === 'resize' && days) {
        store.update('Change duration', () => { t.duration = Math.max(project.minutesPerDay, t.duration + days * project.minutesPerDay); t.milestone = false; });
      } else if (mode === 'link') {
        const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.bar');
        const to = target ? +target.dataset.id : null;
        if (to && to !== id) {
          const ok = store.update('Link tasks', pr => addLink(pr, id, to, 'FS'));
          const rowOf = new Map(project.tasks.map((x, i) => [x.id, i + 1]));
          this.app.toast(ok ? `Linked row ${rowOf.get(id)} to row ${rowOf.get(to)}` : "Those tasks are already linked, or one sits inside the other.");
        }
        this.renderLinks();
      } else this.render();
    };
    b.addEventListener('pointermove', move);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
  }
}
