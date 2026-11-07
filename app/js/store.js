// App state: the project, its computed schedule, selection, undo/redo and autosave.
import { schedule } from './scheduler.js';
import { createResource, createTask, FORMAT, newProject, normalizeLevels, VERSION } from './model.js';
import { standardCalendar } from './calendar.js';

const AUTOSAVE_KEY = 'scaled-schedule:autosave';
const HISTORY = 200;

// Fill in anything missing (older files, imports) so the rest of the app can rely on every field.
export function hydrate(raw) {
  const base = newProject({ name: raw.name || 'Untitled project', start: raw.start });
  const p = { ...base, ...raw, format: FORMAT, version: VERSION };
  p.calendar = raw.calendar?.week ? { exceptions: [], ...raw.calendar } : standardCalendar();
  let maxId = 0;
  const seed = { nextId: 0 };
  p.tasks = (raw.tasks || []).map(t => {
    const full = { ...createTask(seed), ...t, constraint: { type: 'ASAP', date: null, ...(t.constraint || {}) } };
    full.preds = (full.preds || []).map(x => ({ type: 'FS', lag: 0, ...x }));
    full.assignments = full.assignments || [];
    maxId = Math.max(maxId, full.id);
    return full;
  });
  p.resources = (raw.resources || []).map(r => {
    const full = { ...createResource(seed), ...r };
    maxId = Math.max(maxId, full.id);
    return full;
  });
  p.nextId = Math.max(raw.nextId || 0, maxId + 1);
  normalizeLevels(p.tasks);
  return p;
}

export class Store {
  constructor() {
    this.listeners = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.selection = new Set();
    this.focusId = null;
    this.fileName = null;
    this.fileHandle = null;
    this.dirty = false;
    this.load(newProject());
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind, detail) { this.listeners.forEach(fn => fn(kind, detail)); }

  load(project, { fileName = null, handle = null } = {}) {
    this.project = hydrate(project);
    this.fileName = fileName;
    this.fileHandle = handle;
    this.undoStack = [];
    this.redoStack = [];
    this.selection = new Set();
    this.focusId = this.project.tasks[0]?.id ?? null;
    this.dirty = false;
    this.recompute();
    this.emit('load');
    this.autosave();
  }

  recompute() {
    try { this.computed = schedule(this.project); this.error = null; }
    catch (e) { this.error = e; console.error(e); }
  }

  // Every edit goes through here: snapshot for undo, apply, reschedule, notify, autosave.
  update(label, fn) {
    const before = JSON.stringify(this.project);
    let result;
    try { result = fn(this.project); }
    catch (e) { this.project = JSON.parse(before); throw e; }
    if (result === false) return false;
    this.undoStack.push({ label, snap: before });
    if (this.undoStack.length > HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.dirty = true;
    this.recompute();
    this.emit('change', label);
    this.autosave();
    return result;
  }

  undo() { return this.step(this.undoStack, this.redoStack, 'Undid'); }
  redo() { return this.step(this.redoStack, this.undoStack, 'Redid'); }
  step(from, to, verb) {
    const entry = from.pop();
    if (!entry) return null;
    to.push({ label: entry.label, snap: JSON.stringify(this.project) });
    this.project = JSON.parse(entry.snap);
    const ids = new Set(this.project.tasks.map(t => t.id));
    this.selection = new Set([...this.selection].filter(id => ids.has(id)));
    this.dirty = true;
    this.recompute();
    this.emit('change', `${verb}: ${entry.label}`);
    this.autosave();
    return entry.label;
  }

  select(ids, focusId) {
    this.selection = new Set(ids);
    this.focusId = focusId ?? ids[ids.length - 1] ?? null;
    this.emit('select');
  }

  autosave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ project: this.project, fileName: this.fileName, at: Date.now() }));
      } catch { /* storage full or blocked: autosave is only a convenience */ }
    }, 400);
  }

  static restore() {
    try {
      const raw = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) || 'null');
      return raw?.project?.tasks ? raw : null;
    } catch { return null; }
  }
}
