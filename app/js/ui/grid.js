// The task table: Project-style keyboard, inline editing, outline chevrons, and a blank row at the
// bottom for typing new tasks quickly.
import { fmtDate, formatAssignments, formatDuration, formatPreds } from '../model.js';

export const COLUMNS = [
  { key: 'row', label: '', w: 44 },
  { key: 'name', label: 'Task name', w: 260, edit: true },
  { key: 'duration', label: 'Duration', w: 86, edit: true, num: true },
  { key: 'start', label: 'Start', w: 104, edit: true },
  { key: 'finish', label: 'Finish', w: 104, edit: true },
  { key: 'preds', label: 'Predecessors', w: 104, edit: true },
  { key: 'res', label: 'Resources', w: 160, edit: true },
  { key: 'pct', label: '% done', w: 72, edit: true, num: true },
];
const EDITABLE = COLUMNS.filter(c => c.edit).map(c => c.key);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const CHEV = '<svg viewBox="0 0 12 12"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg>';
export const GHOST = -1;

export class Grid {
  constructor(app) {
    this.app = app;
    this.head = document.getElementById('gridHead');
    this.body = document.getElementById('gridBody');
    this.inner = document.getElementById('gridInner');
    this.col = 'name';
    this.anchor = null;
    this.head.innerHTML = COLUMNS.map(c => `<div class="cell ${c.num ? 'num' : ''}" style="width:${c.w}px">${c.label}</div>`).join('');
    this.width = COLUMNS.reduce((s, c) => s + c.w, 0);
    this.inner.style.width = this.head.style.minWidth = `${this.width}px`;
    this.body.addEventListener('mousedown', e => this.onDown(e));
    this.body.addEventListener('dblclick', e => { const c = e.target.closest('.cell'); if (c?.dataset.col && EDITABLE.includes(c.dataset.col)) this.edit(); });
    this.body.addEventListener('keydown', e => this.onKey(e));
    this.body.addEventListener('scroll', () => { this.head.scrollLeft = this.body.scrollLeft; this.app.syncScroll('grid', this.body.scrollTop); });
  }

  render() {
    const { project, store, computed } = this.app;
    const rowOf = new Map(project.tasks.map((t, i) => [t.id, i + 1]));
    const resById = new Map(project.resources.map(r => [r.id, r]));
    const html = [];
    for (const i of this.app.rows) {
      const t = project.tasks[i], k = computed.tasks[i];
      const sel = store.selection.has(t.id) ? ' sel' : '';
      const cells = COLUMNS.map(c => {
        let v = '', cls = c.num ? ' num' : '';
        switch (c.key) {
          case 'row': v = i + 1; cls += ' rownum'; break;
          case 'name': {
            const pad = (t.level - 1) * 18;
            const lead = k.summary ? `<button class="chev${t.collapsed ? ' closed' : ''}" data-act="toggle" tabindex="-1" aria-label="Collapse or expand">${CHEV}</button>` : '<span class="gap"></span>';
            const flag = k.violated ? '<span class="flag" title="A date constraint is missed"></span>' : '';
            return `<div class="cell name" data-col="name" style="width:${c.w}px;padding-left:${6 + pad}px">${lead}<span>${esc(t.name)}</span>${flag}</div>`;
          }
          case 'duration': v = formatDuration(k.duration, project); break;
          case 'start': v = fmtDate(k.es); break;
          case 'finish': v = fmtDate(k.ef); break;
          case 'preds': v = esc(formatPreds(t, project, rowOf)); break;
          case 'res': v = esc(formatAssignments(t, resById)); break;
          case 'pct': v = `${Math.round(k.percent)}%`; break;
        }
        return `<div class="cell${cls}" data-col="${c.key}" style="width:${c.w}px"><span>${v}</span></div>`;
      }).join('');
      html.push(`<div class="row${sel}${k.summary ? ' summary' : ''}" data-id="${t.id}">${cells}</div>`);
    }
    html.push(`<div class="row ghost${store.focusId === GHOST ? ' sel' : ''}" data-id="${GHOST}">${COLUMNS.map(c =>
      `<div class="cell" data-col="${c.key}" style="width:${c.w}px">${c.key === 'name' ? '<span>Type a new task…</span>' : ''}</div>`).join('')}</div>`);
    this.inner.innerHTML = html.join('');
    this.paintFocus();
  }

  paintFocus() {
    this.inner.querySelector('.cell.focus')?.classList.remove('focus');
    const row = this.rowEl(this.app.store.focusId);
    row?.querySelector(`[data-col="${this.col}"]`)?.classList.add('focus');
  }

  rowEl(id) { return id == null ? null : this.inner.querySelector(`.row[data-id="${id}"]`); }

  // Visible order: task ids for the rows on screen, then the blank row.
  order() { return [...this.app.rows.map(i => this.app.project.tasks[i].id), GHOST]; }

  onDown(e) {
    if (e.target.closest('input.edit')) return;
    const rowEl = e.target.closest('.row'), cell = e.target.closest('.cell');
    if (!rowEl) return;
    const id = +rowEl.dataset.id;
    if (e.target.closest('[data-act="toggle"]')) { e.preventDefault(); this.app.toggleCollapse(id); return; }
    if (cell?.dataset.col && cell.dataset.col !== 'row') this.col = cell.dataset.col;
    this.selectTo(id, e.shiftKey, e.ctrlKey || e.metaKey);
    // The table takes focus from the click itself; only the blank row opens an editor straight away.
    if (id === GHOST && this.col === 'name') setTimeout(() => this.edit(), 0);
  }

  selectTo(id, extend, toggle) {
    const { store } = this.app;
    if (id === GHOST) { store.select([], GHOST); return; }
    if (extend && this.anchor != null) {
      const ord = this.order(), a = ord.indexOf(this.anchor), b = ord.indexOf(id);
      store.select(ord.slice(Math.min(a, b), Math.max(a, b) + 1).filter(x => x !== GHOST), id);
    } else if (toggle) {
      const s = new Set(store.selection);
      s.has(id) ? s.delete(id) : s.add(id);
      this.anchor = id;
      store.select([...s], id);
    } else { this.anchor = id; store.select([id], id); }
  }

  move(dRow, dCol, extend) {
    const ord = this.order(), { store } = this.app;
    if (dCol) {
      const keys = COLUMNS.map(c => c.key).filter(k => k !== 'row');
      this.col = keys[Math.max(0, Math.min(keys.length - 1, keys.indexOf(this.col) + dCol))];
      this.paintFocus();
      this.scrollIntoView();
      return;
    }
    const at = Math.max(0, ord.indexOf(store.focusId));
    const id = ord[Math.max(0, Math.min(ord.length - 1, at + dRow))];
    this.selectTo(id, extend, false);
    this.scrollIntoView();
  }

  scrollIntoView() {
    const el = this.rowEl(this.app.store.focusId);
    if (!el) return;
    const top = el.offsetTop, h = el.offsetHeight, b = this.body;
    if (top < b.scrollTop) b.scrollTop = top;
    else if (top + h > b.scrollTop + b.clientHeight) b.scrollTop = top + h - b.clientHeight;
    const cell = el.querySelector(`[data-col="${this.col}"]`);
    if (cell) {
      if (cell.offsetLeft < b.scrollLeft) b.scrollLeft = cell.offsetLeft;
      else if (cell.offsetLeft + cell.offsetWidth > b.scrollLeft + b.clientWidth) b.scrollLeft = cell.offsetLeft + cell.offsetWidth - b.clientWidth;
    }
  }

  onKey(e) {
    if (e.target.closest('input.edit')) return;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      if (e.altKey) return;
      e.preventDefault(); this.move(k === 'ArrowDown' ? 1 : -1, 0, e.shiftKey);
    } else if ((k === 'ArrowLeft' || k === 'ArrowRight') && !e.altKey && !mod) {
      e.preventDefault(); this.move(0, k === 'ArrowRight' ? 1 : -1);
    } else if (k === 'Tab') {
      e.preventDefault(); this.move(0, e.shiftKey ? -1 : 1);
    } else if (k === 'Enter' && !mod && !e.shiftKey && !e.altKey) {
      e.preventDefault(); this.edit();
    } else if (k === 'F2' && !e.shiftKey) {
      e.preventDefault(); this.edit();
    } else if (k === 'Home' && mod) { e.preventDefault(); this.selectTo(this.order()[0], false, false); this.scrollIntoView(); }
    else if (k === 'End' && mod) { e.preventDefault(); this.selectTo(GHOST, false, false); this.scrollIntoView(); }
    else if (k.length === 1 && !mod && !e.altKey && EDITABLE.includes(this.col)) {
      e.preventDefault(); this.edit(k);
    }
  }

  edit(initial) {
    const { store, project, computed } = this.app;
    const id = store.focusId;
    if (id == null || !EDITABLE.includes(this.col)) return;
    const row = this.rowEl(id), cell = row?.querySelector(`[data-col="${this.col}"]`);
    if (!cell || cell.querySelector('input.edit')) return;
    let value = '';
    if (id !== GHOST) {
      const t = project.tasks.find(x => x.id === id), kk = computed.byId.get(id);
      if (kk.summary && ['duration', 'start', 'finish', 'pct'].includes(this.col)) {
        this.app.toast('Summary tasks take their dates from the tasks under them.');
        return;
      }
      const span = cell.querySelector('span');
      value = this.col === 'name' ? t.name : this.col === 'pct' ? String(Math.round(t.percent)) : span?.textContent || '';
    } else if (this.col !== 'name') return;
    const input = document.createElement('input');
    input.className = 'edit';
    input.value = initial ?? value;
    input.spellcheck = false;
    cell.appendChild(input);
    input.focus();
    if (initial == null) input.select();
    let done = false;
    const finish = (commit, dRow = 0, dCol = 0) => {
      if (done) return;
      done = true;
      const text = input.value;
      input.remove();
      if (commit && (text !== value || id === GHOST)) this.app.commitCell(id, this.col, text);
      this.body.focus({ preventScroll: true });
      if (dRow || dCol) this.move(dRow, dCol);
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true, id === GHOST ? 0 : 1);
        // Keep typing: open the next blank row right away so no keystroke is lost.
        if (id === GHOST && input.value.trim()) { this.app.store.select([], GHOST); this.scrollIntoView(); this.edit(); }
      }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'Tab') { e.preventDefault(); finish(true, 0, e.shiftKey ? -1 : 1); }
      else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey) { e.preventDefault(); finish(true, e.key === 'ArrowDown' ? 1 : -1); }
    });
    input.addEventListener('blur', () => finish(true));
  }
}
