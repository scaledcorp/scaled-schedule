// scaled Schedule: wires the store, table, Gantt, panels, commands, keyboard and files together.
import { Store } from './store.js';
import { Grid, GHOST } from './ui/grid.js';
import { Gantt } from './ui/gantt.js';
import { ask, menu, openPalette, openSettings, renderDetails, renderResources, setPercent, toast } from './ui/panels.js';
import { deleteTasks, endOfDay, fmtDate, fmtHours, fmtMoney, formatDuration, indent, indexOfId, insertTask, isFamily,
  linkTasks, moveBlock, newProject, outdent, parseAssignments, parseDay, parseDuration, parsePreds, startOfDay,
  subtreeEnd, unlinkTasks, yearOf } from './model.js';
import { SAMPLE } from './sample.js';
import { Iguana } from './ui/iguana.js';
import { exportMSPDI, importMSPDI } from './io/mspdi.js';
import { exportXER } from './io/xer.js';
import { exportCSV, exportInversionCSV, exportJiraCSV, importCSV } from './io/csv.js';
import { exportInversionModel } from './io/inversion.js';
import { importP6XML, importXER, isP6XML } from './io/p6.js';
import { importXLSX } from './io/xlsx.js';
import { decodeText } from './io/files.js';
import { importDOCX, importPPTX } from './io/office.js';
import { reviewImport } from './ui/review.js';

// PDF.js is about 1.7 MB, so it loads only when someone opens a PDF.
const importPDF = async (buf, name) => (await import('./io/pdf.js')).importPDF(buf, name);

const P = {
  open: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  save: 'M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 3v5h7V3M7 21v-7h10v7',
  exportMenu: 'M12 15V3M7 8l5-5 5 5M5 21h14',
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3', redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3',
  addTask: 'M12 5v14M5 12h14', addMilestone: 'M12 4l8 8-8 8-8-8z',
  outdent: 'M21 6H11M21 12H11M21 18H11M7 9l-3 3 3 3', indent: 'M21 6H11M21 12H11M21 18H11M4 9l3 3-3 3',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
  unlink: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1M4 4l16 16',
  details: 'M4 5h16v14H4zM8 9h8M8 13h5',
  zoomOut: 'M4 11h12M20 20l-4-4M4 4h12v14H4z', zoomIn: 'M4 11h12M10 5v12M20 20l-4-4M4 4h12v14H4z',
  scrollToTask: 'M4 12h10M10 8l4 4-4 4M19 5v14', critical: 'M13 3 5 14h6l-1 7 8-11h-6z',
  settings: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  theme: 'M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z', palette: 'M5 8l4 4-4 4M11 16h8',
  install: 'M12 4v11M7 10l5 5 5-5M5 20h14',
};
const LABELS = { open: 'Open', save: 'Save', exportMenu: 'Export', addTask: 'Task', install: 'Install' };
const icon = k => `<svg viewBox="0 0 24 24"><path d="${P[k]}"/></svg>`;
const safeName = s => (s || 'schedule').replace(/[\\/:*?"<>|]+/g, '').trim() || 'schedule';

class App {
  constructor() {
    this.store = new Store();
    this.grid = new Grid(this);
    this.gantt = new Gantt(this);
    this.detailsOpen = false;
    this.showBaseline = true;
    this.view = 'gantt';
    this.rows = [];
    document.querySelectorAll('[data-cmd]').forEach(b => {
      const k = b.dataset.cmd;
      if (P[k]) b.innerHTML = icon(k) + (LABELS[k] ? `<span>${LABELS[k]}</span>` : '');
      b.addEventListener('click', () => this.run(k, b));
    });
    document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => this.setView(b.dataset.view)));
    const name = document.getElementById('projName');
    name.addEventListener('change', () => this.store.update('Rename project', p => { p.name = name.value.trim() || p.name; }));
    name.addEventListener('keydown', e => { if (e.key === 'Enter') { name.blur(); this.focusGrid(); } });
    document.getElementById('status').addEventListener('click', e => { if (e.target.closest('.warn')) this.showWarnings(); });
    document.getElementById('fileInput').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) this.openFile(f); });
    this.store.on((kind, detail) => {
      if (kind === 'select') this.paintSelection();
      else { if (kind === 'load') this.gantt.reset(); this.render(); }
      if (kind === 'change' && detail?.startsWith('Und')) this.toast(detail);
    });
    addEventListener('keydown', e => this.onKey(e));
    this.dropTarget();
    this.splitter();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
      if (!localStorage.getItem('scaled-schedule:theme')) document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
    });
    const saved = Store.restore();
    if (saved) { this.store.load(saved.project, { fileName: saved.fileName }); if (saved.project.tasks.length) this.toast('Picked up where you left off'); }
    else this.render();
    this.focusGrid();
    this.installable();
    this.iguana = new Iguana(this);
  }

  // Installed like a desktop app (Edge, Chrome): works offline, and Windows can open .sched files
  // with a double-click. Windows hands those files to us through the launch queue.
  installable() {
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
    }
    const btn = document.querySelector('[data-cmd="install"]');
    addEventListener('beforeinstallprompt', e => { e.preventDefault(); this.installPrompt = e; btn.hidden = false; });
    addEventListener('appinstalled', () => {
      this.installPrompt = null;
      btn.hidden = true;
      this.toast('Installed. Double-click a .sched file to open it here.');
    });
    if ('launchQueue' in window) {
      launchQueue.setConsumer(async params => {
        const handle = params.files?.[0];
        if (handle) this.openFile(await handle.getFile(), handle);
      });
    }
  }

  get project() { return this.store.project; }
  get computed() { return this.store.computed; }
  toast(text, action) { toast(text, action); }
  focusGrid() { this.grid.body.focus({ preventScroll: true }); }

  // ---------------------------------------------------------------- rendering
  render() {
    const { project, computed } = this;
    this.cal = computed.calendar;
    this.rows = [];
    let hideBelow = Infinity;
    project.tasks.forEach((t, i) => {
      if (t.level > hideBelow) return;
      hideBelow = Infinity;
      this.rows.push(i);
      if (t.collapsed && computed.tasks[i].summary) hideBelow = t.level;
    });
    const name = document.getElementById('projName');
    if (document.activeElement !== name) name.value = project.name;
    document.title = `${project.name} · scaled Schedule`;
    document.getElementById('empty').hidden = project.tasks.length > 0;
    this.grid.render();
    this.gantt.render();
    renderDetails(this);
    if (this.view === 'resources') renderResources(this);
    this.renderStatus();
    this.toolbarState();
    if (this.pendingEdit != null) {
      const id = this.pendingEdit;
      this.pendingEdit = null;
      this.store.select([id], id);
      this.grid.col = 'name';
      this.grid.paintFocus();
      this.grid.scrollIntoView();
      requestAnimationFrame(() => this.grid.edit());
    }
  }

  paintSelection() {
    const sel = this.store.selection;
    this.grid.inner.querySelectorAll('.row').forEach(r => r.classList.toggle('sel', sel.has(+r.dataset.id) || (+r.dataset.id === GHOST && this.store.focusId === GHOST)));
    this.grid.paintFocus();
    this.gantt.els.forEach((e, id) => e.bar.classList.toggle('sel', sel.has(id)));
    renderDetails(this);
    this.toolbarState();
  }

  renderStatus() {
    const { project, computed, store } = this;
    const el = document.getElementById('status');
    if (!project.tasks.length) { el.innerHTML = '<span>No tasks yet</span>'; return; }
    const span = formatDuration(this.cal.workBetween(computed.start, computed.finish), project);
    const warn = computed.warnings.length ? `<button class="warn">${computed.warnings.length} to check</button>` : '';
    el.innerHTML = `<span>Starts <b>${fmtDate(computed.start)}</b></span><span>Finishes <b>${fmtDate(computed.finish)}</b></span>
      <span><b>${span}</b></span><span>Work <b>${fmtHours(computed.work)}</b></span><span>Cost <b>${fmtMoney(computed.cost, project.currency)}</b></span>
      ${warn}<span class="right">${store.dirty ? (store.fileName ? 'Unsaved changes' : 'Not saved to a file yet') : store.fileName ? `Saved · ${store.fileName}` : ''}</span>`;
  }

  toolbarState() {
    const has = this.store.selection.size > 0;
    const set = (cmd, on) => document.querySelectorAll(`[data-cmd="${cmd}"]`).forEach(b => { b.disabled = !on; });
    set('undo', this.store.undoStack.length > 0);
    set('redo', this.store.redoStack.length > 0);
    ['indent', 'outdent', 'unlink', 'details', 'scrollToTask'].forEach(c => set(c, has));
    set('link', this.store.selection.size > 1);
    document.querySelector('[data-cmd="critical"]').classList.toggle('on', this.gantt.critical);
  }

  syncScroll(src, top) {
    const other = src === 'grid' ? this.gantt.body : this.grid.body;
    if (Math.abs(other.scrollTop - top) > 1) other.scrollTop = top;
  }

  setView(v) {
    this.view = v;
    document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === v));
    document.getElementById('ganttView').hidden = v !== 'gantt';
    document.getElementById('resourceView').hidden = v !== 'resources';
    this.render();
  }

  // ---------------------------------------------------------------- editing
  selectedIds() {
    const sel = this.store.selection;
    return this.project.tasks.filter(t => sel.has(t.id)).map(t => t.id);
  }

  commitCell(id, col, text) {
    const s = this.store, p = this.project;
    try {
      if (id === GHOST) {
        if (!text.trim()) return;
        s.update('Add task', pr => {
          const last = pr.tasks[pr.tasks.length - 1];
          const level = last ? last.level : 1;
          insertTask(pr, pr.tasks.length, { name: text.trim(), level });
        });
        return;
      }
      const t = p.tasks.find(x => x.id === id), k = this.computed.byId.get(id), cal = this.cal;
      const bad = what => { throw new Error(`Can't read "${text}" as ${what}.`); };
      if (col === 'name') s.update('Rename task', () => { t.name = text; });
      else if (col === 'duration') {
        const m = parseDuration(text, p);
        if (m == null) bad('a duration. Try 5d, 2w or 4h');
        s.update('Change duration', () => { t.duration = m; t.milestone = m === 0; });
      } else if (col === 'start') {
        const d = parseDay(text, yearOf(k.es));
        if (d == null) bad('a date');
        s.update('Set start', () => { t.constraint = { type: 'SNET', date: cal.nextWorkStart(startOfDay(d, cal)) }; });
      } else if (col === 'finish') {
        const d = parseDay(text, yearOf(k.ef));
        if (d == null) bad('a date');
        const m = Math.max(0, cal.workBetween(k.es, endOfDay(d, cal)));
        s.update('Set finish', () => { t.duration = m; t.milestone = m === 0; });
      } else if (col === 'preds') {
        const preds = parsePreds(text, p).filter(x => x.id !== id && !isFamily(p, x.id, id));
        s.update('Change links', () => { t.preds = preds; });
      } else if (col === 'res') {
        let created = [];
        s.update('Assign resources', pr => { const r = parseAssignments(text, pr); t.assignments = r.assignments; created = r.created; });
        if (created.length) this.toast(`Added ${created.join(', ')} to Resources`);
      } else if (col === 'pct') {
        const v = parseFloat(text);
        if (!Number.isFinite(v)) bad('a percent');
        s.update('Update progress', () => setPercent(t, v, k, cal));
      }
    } catch (e) { this.toast(e.message); this.render(); }
  }

  toggleCollapse(id, value) {
    const t = this.project.tasks.find(x => x.id === id);
    if (!t) return;
    t.collapsed = value ?? !t.collapsed;
    this.store.autosave();
    this.render();
  }

  addTask({ above = false, milestone = false } = {}) {
    const { project, store } = this;
    const i = indexOfId(project, store.focusId);
    let index = project.tasks.length, level;
    if (i >= 0) {
      const k = this.computed.tasks[i], t = project.tasks[i];
      if (above) { index = i; level = t.level; }
      else if (k.summary && !t.collapsed) { index = i + 1; level = t.level + 1; }
      else { index = subtreeEnd(project.tasks, i); level = t.level; }
    }
    store.update(milestone ? 'Add milestone' : 'Add task', pr => {
      const t = insertTask(pr, index, { level, name: milestone ? 'Milestone' : '', duration: milestone ? 0 : pr.minutesPerDay, milestone });
      this.pendingEdit = t.id;
    });
  }

  openDetails(id) {
    if (id != null) this.store.select([id], id);
    this.detailsOpen = true;
    renderDetails(this);
    setTimeout(() => document.querySelector('#details [data-f="name"]')?.focus(), 60);
  }
  closeDetails() { this.detailsOpen = false; renderDetails(this); this.focusGrid(); }

  showWarnings() {
    const w = this.computed.warnings;
    w.slice(0, 3).forEach(x => this.toast(x.text));
    const first = w[0]?.rows?.[0];
    if (first) { const id = this.project.tasks[first - 1].id; this.store.select([id], id); this.grid.scrollIntoView(); }
  }

  // ---------------------------------------------------------------- commands
  commandList() {
    const c = (id, label, keys = '') => ({ id, label, keys });
    return [
      c('addTask', 'Add a task', 'Ctrl+Enter'), c('insertTask', 'Insert a task above', 'Insert'), c('addMilestone', 'Add a milestone'),
      c('deleteTasks', 'Delete selected tasks', 'Delete'), c('indent', 'Indent', 'Alt+Shift+Right'), c('outdent', 'Outdent', 'Alt+Shift+Left'),
      c('moveUp', 'Move up', 'Alt+Shift+Up'), c('moveDown', 'Move down', 'Alt+Shift+Down'), c('link', 'Link selected tasks', 'Ctrl+L'),
      c('unlink', 'Unlink selected tasks', 'Ctrl+Shift+L'), c('details', 'Task details', 'Shift+F2'),
      c('undo', 'Undo', 'Ctrl+Z'), c('redo', 'Redo', 'Ctrl+Y'),
      c('new', 'New project'), c('open', 'Open a file', 'Ctrl+O'), c('save', 'Save', 'Ctrl+S'), c('saveAs', 'Save as'),
      c('exportMSPDI', 'Export to Microsoft Project (XML)'), c('exportXER', 'Export to Primavera P6 (XER)'),
      c('exportCSV', 'Export to CSV'), c('exportJira', 'Export for Jira (CSV)'), c('exportInversionModel', 'Export an Inversion model (JSON)'), c('exportInversion', 'Export for Inversion import (CSV)'),
      c('sample', 'Open the sample project'),
      c('critical', 'Show or hide the critical path'), c('saveBaseline', 'Save a baseline'), c('toggleBaseline', 'Show or hide the baseline'),
      c('zoomIn', 'Zoom in'), c('zoomOut', 'Zoom out'), c('scrollToTask', 'Scroll to the selected task'),
      c('collapseAll', 'Collapse all summaries'), c('expandAll', 'Expand all summaries'),
      c('viewGantt', 'Show the Gantt view'), c('viewResources', 'Show the resource sheet'),
      c('settings', 'Project and calendar settings'), c('theme', 'Switch light or dark'), c('print', 'Print'),
      c('install', 'Install as an app (open .sched files with a double-click)'),
      c('iguana', 'Ask Schedule Iguana'),
    ];
  }

  async run(cmd, anchor) {
    const { store, project } = this;
    const ids = this.selectedIds();
    switch (cmd) {
      case 'addTask': return this.addTask();
      case 'insertTask': return this.addTask({ above: true });
      case 'addMilestone': return this.addTask({ milestone: true });
      case 'deleteTasks': {
        if (!ids.length) return;
        const n = store.update('Delete tasks', pr => deleteTasks(pr, ids));
        store.select([], null);
        return this.toast(`Deleted ${n} task${n > 1 ? 's' : ''}`, { label: 'Undo', run: () => store.undo() });
      }
      case 'indent': return ids.length && store.update('Indent', pr => indent(pr, ids) || false);
      case 'outdent': return ids.length && store.update('Outdent', pr => outdent(pr, ids) || false);
      case 'moveUp': return ids.length && store.update('Move up', pr => moveBlock(pr, ids, -1));
      case 'moveDown': return ids.length && store.update('Move down', pr => moveBlock(pr, ids, 1));
      case 'link': {
        const n = ids.length > 1 ? store.update('Link tasks', pr => linkTasks(pr, ids) || false) : 0;
        return this.toast(n ? `Linked ${ids.length} tasks in order` : 'Select two or more tasks to link them.');
      }
      case 'unlink': return ids.length && store.update('Unlink tasks', pr => unlinkTasks(pr, ids) || false);
      case 'details': return this.detailsOpen ? this.closeDetails() : this.openDetails();
      case 'undo': return store.undo() || this.toast('Nothing to undo');
      case 'redo': return store.redo() || this.toast('Nothing to redo');
      case 'new': {
        if (store.dirty && project.tasks.length && !(await ask('Start a new project?', 'Your current project is autosaved in this browser, but not saved to a file.', [{ label: 'Cancel', value: false }, { label: 'Start new', value: true, primary: true }]))) return;
        store.load(newProject());
        return this.focusGrid();
      }
      case 'open': return this.pickFile();
      case 'save': return this.save(false);
      case 'saveAs': return this.save(true);
      case 'exportMenu': return menu(anchor, [
        { label: 'Microsoft Project (.xml)', hint: 'Opens in Project; P6 and ProjectLibre can import it', run: () => this.run('exportMSPDI') },
        { label: 'Primavera P6 (.xer)', hint: 'Import in P6 Professional', run: () => this.run('exportXER') },
        { label: 'Jira (.csv)', hint: "For Jira's Import issues from CSV", run: () => this.run('exportJira') },
        { label: 'Inversion model (.json)', hint: 'Open it in Inversion: phases, goals, tasks and links', run: () => this.run('exportInversionModel') },
        { label: 'Inversion import (.csv)', hint: "For Inversion's Import data", run: () => this.run('exportInversion') },
        { label: 'Spreadsheet (.csv)', hint: 'Excel, Google Sheets', run: () => this.run('exportCSV') },
        { label: 'Print or save as PDF', hint: '', run: () => this.run('print') },
      ]);
      case 'exportMSPDI': return this.download(`${safeName(project.name)}.xml`, exportMSPDI(project, this.computed), 'application/xml', 'Microsoft Project XML');
      case 'exportXER': {
        const r = exportXER(project, this.computed);
        this.download(`${safeName(project.name)}.xer`, r.text, 'text/plain', 'Primavera P6 XER');
        return r.warnings.forEach(w => this.toast(w));
      }
      case 'exportCSV': return this.download(`${safeName(project.name)}.csv`, exportCSV(project, this.computed), 'text/csv', 'CSV');
      case 'exportJira': return this.download(`${safeName(project.name)} for Jira.csv`, exportJiraCSV(project, this.computed), 'text/csv', 'Jira CSV');
      case 'exportInversionModel': return this.download(`${safeName(project.name)}.inversion.json`, exportInversionModel(project, this.computed), 'application/json', 'Inversion model');
      case 'exportInversion': return this.download(`${safeName(project.name)} for Inversion.csv`, exportInversionCSV(project, this.computed), 'text/csv', 'Inversion CSV');
      case 'sample': {
        if (store.dirty && project.tasks.length && !(await ask('Open the sample project?', 'Your current project is autosaved in this browser, but not saved to a file.', [{ label: 'Cancel', value: false }, { label: 'Open sample', value: true, primary: true }]))) return;
        store.load(structuredClone(SAMPLE));
        return this.toast('Sample: a fictional contractor building tools, private AI and two agents');
      }
      case 'critical': this.gantt.critical = !this.gantt.critical; return this.render();
      case 'saveBaseline':
        store.update('Save baseline', pr => pr.tasks.forEach(t => {
          const k = this.computed.byId.get(t.id);
          t.baseline = { start: k.es, finish: k.ef, duration: k.duration, work: k.work, cost: k.cost };
        }));
        this.showBaseline = true;
        this.render();
        return this.toast('Baseline saved. Gray bars show it as dates move.');
      case 'toggleBaseline': this.showBaseline = !this.showBaseline; return this.render();
      case 'zoomIn': return this.gantt.setZoom(this.gantt.zoom + 1);
      case 'zoomOut': return this.gantt.setZoom(this.gantt.zoom - 1);
      case 'scrollToTask': return this.gantt.scrollTo(store.focusId);
      case 'collapseAll': case 'expandAll':
        project.tasks.forEach((t, i) => { if (this.computed.tasks[i].summary) t.collapsed = cmd === 'collapseAll'; });
        store.autosave();
        return this.render();
      case 'viewGantt': return this.setView('gantt');
      case 'viewResources': return this.setView('resources');
      case 'settings': return openSettings(this);
      case 'theme': {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem('scaled-schedule:theme', next); } catch { /* per-viewer convenience only */ }
        return;
      }
      case 'palette': return openPalette(this);
      case 'iguana': return this.iguana.open();
      case 'install': {
        if (matchMedia('(display-mode: standalone)').matches) return this.toast("You're already in the installed app.");
        if (!this.installPrompt) return this.toast('To install, open this page in Edge or Chrome and use the install icon in the address bar.');
        this.installPrompt.prompt();
        const { outcome } = await this.installPrompt.userChoice;
        if (outcome === 'accepted') this.installPrompt = null;
        return;
      }
      case 'print': return window.print();
    }
  }

  onKey(e) {
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
    if (mod && k.toLowerCase() === 'k') { e.preventDefault(); return this.run('palette'); }
    if (mod && k.toLowerCase() === 's') { e.preventDefault(); return this.run(e.shiftKey ? 'saveAs' : 'save'); }
    if (mod && k.toLowerCase() === 'o') { e.preventDefault(); return this.run('open'); }
    if (typing || document.querySelector('dialog[open]') || !document.getElementById('palette').hidden) {
      if (k === 'Escape' && this.detailsOpen && e.target.closest('#details')) this.closeDetails();
      return;
    }
    const map = [
      [mod && !e.shiftKey && k.toLowerCase() === 'z', 'undo'], [mod && (k.toLowerCase() === 'y' || (e.shiftKey && k.toLowerCase() === 'z')), 'redo'],
      [mod && !e.shiftKey && k.toLowerCase() === 'l', 'link'], [mod && e.shiftKey && k.toLowerCase() === 'l', 'unlink'],
      [e.altKey && e.shiftKey && k === 'ArrowRight', 'indent'], [e.altKey && e.shiftKey && k === 'ArrowLeft', 'outdent'],
      [e.altKey && e.shiftKey && k === 'ArrowUp', 'moveUp'], [e.altKey && e.shiftKey && k === 'ArrowDown', 'moveDown'],
      [mod && k === ']', 'indent'], [mod && k === '[', 'outdent'],
      [k === 'Insert', 'insertTask'], [mod && k === 'Enter', 'addTask'], [k === 'Delete', 'deleteTasks'],
      [e.shiftKey && k === 'F2', 'details'],
    ];
    const hit = map.find(([cond]) => cond);
    if (hit) { e.preventDefault(); return this.run(hit[1]); }
    if (mod && k.toLowerCase() === 'a' && e.target.closest('#gridBody')) {
      e.preventDefault();
      return this.store.select(this.rows.map(i => this.project.tasks[i].id));
    }
    if (k === 'Escape' && this.detailsOpen) this.closeDetails();
  }

  // ---------------------------------------------------------------- files
  async pickFile() {
    if (window.showOpenFilePicker) {
      try {
        const [h] = await showOpenFilePicker({ types: [{ description: 'Schedules', accept: {
          'application/json': ['.sched', '.json'], 'application/xml': ['.xml'], 'text/csv': ['.csv'], 'text/plain': ['.xer'],
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'], 'application/vnd.ms-project': ['.mpp'], 'application/pdf': ['.pdf'],
          'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] } }] });
        return this.openFile(await h.getFile(), h);
      } catch (e) { if (e.name === 'AbortError') return; }
    }
    document.getElementById('fileInput').click();
  }

  async openFile(file, handle = null) {
    const name = file.name, ext = name.split('.').pop().toLowerCase();
    const info = (title, text) => ask(title, text, [{ label: 'OK', value: true, primary: true }]);
    if (/^(mp4|mov|webm|m4v|avi)$/.test(ext)) return this.toast('Turning a video into a schedule is coming soon. Stay tuned!');
    if (ext === 'mpp') return info('Save it from Project as XML', 'Microsoft Project keeps .mpp files in its own closed format. In Project, choose File, Save As, and pick "XML Format (*.xml)". Then open that .xml here. Every file is read on this computer and never uploaded.');
    if (ext === 'xls' || ext === 'xlsb') return info('Save it as .xlsx', 'In Excel, choose File, Save As, and pick "Excel Workbook (*.xlsx)" or CSV. Then open that file here.');
    if (ext === 'ppt' || ext === 'doc') return info(`Save it as .${ext}x`, `Older ${ext === 'ppt' ? 'PowerPoint' : 'Word'} files use a format the browser can't read. Open it and choose File, Save As, and pick the .${ext}x format. Then open that file here.`);
    if (/^(png|jpe?g|gif|bmp|tiff?|webp|heic)$/.test(ext)) return this.toast('Reading schedules from pictures is coming next. For now, open a PDF, slides, Word, P6, Project, Excel or CSV file.');
    if (/^(pdf|pptx|docx)$/.test(ext)) return this.openDocument(file, ext);
    if (this.store.dirty && this.project.tasks.length && !(await ask(`Open ${name}?`, 'Your current project is autosaved in this browser, but not saved to a file.', [{ label: 'Cancel', value: false }, { label: 'Open it', value: true, primary: true }]))) return;
    try {
      let project, warnings = [], keep = false;
      if (ext === 'xlsx' || ext === 'xlsm') ({ project, warnings } = await importXLSX(await file.arrayBuffer(), name));
      else {
        const text = decodeText(await file.arrayBuffer());
        if (ext === 'xer') ({ project, warnings } = importXER(text));
        else if (ext === 'xml') ({ project, warnings } = isP6XML(text) ? importP6XML(text) : importMSPDI(text));
        else if (ext === 'csv') ({ project, warnings } = importCSV(text, name.replace(/\.csv$/i, '')));
        else {
          project = JSON.parse(text);
          if (!Array.isArray(project.tasks)) throw new Error("This file isn't a scaled Schedule project.");
          keep = true;
        }
      }
      this.store.load(project, { fileName: keep ? name : null, handle: keep ? handle : null });
      this.toast(keep ? `Opened ${name}` : `Imported ${name}. Save to keep it as a .sched file.`);
      warnings.slice(0, 3).forEach(w => this.toast(w));
      this.focusGrid();
    } catch (e) { this.toast(e.message || `Couldn't open ${name}.`); }
  }

  // PDFs, slides and Word documents: read the schedule out, show it for review, then create it.
  async openDocument(file, ext) {
    const name = file.name;
    try {
      this.toast(`Reading ${name}…`);
      const buf = await file.arrayBuffer();
      const read = ext === 'pdf' ? await importPDF(buf, name) : ext === 'pptx' ? await importPPTX(buf, name) : await importDOCX(buf, name);
      const picked = await reviewImport({ fileName: name, ...read });
      if (!picked) return;
      const before = { project: structuredClone(this.project), fileName: this.store.fileName, handle: this.store.fileHandle };
      this.store.load(picked.project);
      this.toast(`Created a schedule from ${name}.`, { label: 'Undo', run: () => this.store.load(before.project, { fileName: before.fileName, handle: before.handle }) });
      picked.warnings.slice(0, 2).forEach(w => this.toast(w));
      this.focusGrid();
    } catch (e) { this.toast(e.message || `Couldn't read ${name}.`); }
  }

  async save(as) {
    const { store, project } = this;
    const text = JSON.stringify(project, null, 1);
    const suggested = `${safeName(store.fileName?.replace(/\.sched$/i, '') || project.name)}.sched`;
    if (window.showSaveFilePicker) {
      try {
        let h = !as && store.fileHandle;
        if (!h) h = await showSaveFilePicker({ suggestedName: suggested, types: [{ description: 'scaled Schedule project', accept: { 'application/json': ['.sched'] } }] });
        const w = await h.createWritable();
        await w.write(text);
        await w.close();
        Object.assign(store, { fileHandle: h, fileName: h.name, dirty: false });
        this.renderStatus();
        return this.toast(`Saved ${h.name}`);
      } catch (e) { if (e.name === 'AbortError') return; }
    }
    this.download(suggested, text, 'application/json');
    Object.assign(store, { fileName: suggested, dirty: false });
    this.renderStatus();
  }

  download(name, text, type, what) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    this.toast(what ? `Exported ${what}: ${name}` : `Saved ${name} to your downloads`);
  }

  dropTarget() {
    let hint = null, depth = 0;
    addEventListener('dragenter', e => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      if (depth++ === 0) { hint = Object.assign(document.createElement('div'), { className: 'drop-hint', textContent: 'Drop to open' }); document.body.appendChild(hint); }
    });
    addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; hint?.remove(); } });
    addEventListener('dragover', e => e.preventDefault());
    addEventListener('drop', e => {
      e.preventDefault();
      depth = 0;
      hint?.remove();
      const f = e.dataTransfer.files[0];
      if (f) this.openFile(f);
    });
  }

  splitter() {
    const sp = document.getElementById('splitter'), ws = document.getElementById('ganttView');
    sp.addEventListener('pointerdown', e => {
      sp.setPointerCapture(e.pointerId);
      sp.classList.add('drag');
      const move = ev => ws.style.setProperty('--grid-w', `${Math.max(200, Math.min(innerWidth - 240, ev.clientX - ws.getBoundingClientRect().left))}px`);
      const up = () => { sp.classList.remove('drag'); sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); this.gantt.render(); };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
    });
  }
}

window.app = new App();
