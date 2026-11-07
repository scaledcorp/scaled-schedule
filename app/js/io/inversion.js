// Inversion model export (inversion.jxzlabs.com): a native .json file Inversion opens directly.
// Phases (top-level summary tasks) become clusters holding their tasks, milestones become Goals with a
// target date, tasks become a "Task" node type with date fields, and every link becomes a "requires"
// connection (the later task requires the earlier one). Built-in types match Inversion's own.
import { formatAssignments, formatDuration, isoDay } from '../model.js';

const W = 200, H = 84, COL = 240, ROW = 130, PER_ROW = 4, PAD = 30;   // Inversion's own node size and spacing

export function exportInversionModel(project, computed, now = new Date().toISOString()) {
  const uuid = () => crypto.randomUUID();
  const modelId = uuid();
  // Same bookkeeping fields Inversion writes on its own nodes and connections.
  const stamp = { rev: 1, createdAt: now, createdBy: 'scaled Schedule', updatedAt: now, updatedBy: 'scaled Schedule' };
  const type = (name, glyph, color, fields, isBuiltin = true) => ({ id: uuid(), modelId, name, glyph, color, fields, isBuiltin });
  const goal = type('Goal', 'G', '#22c55e', [
    { id: 'goal.successCriteria', label: 'Success criteria', kind: 'textarea' },
    { id: 'goal.targetDate', label: 'Target date', kind: 'date' }]);
  const task = type('Task', 'T', '#0B6BCB', [
    { id: 'task.start', label: 'Start', kind: 'date' }, { id: 'task.end', label: 'End', kind: 'date' },
    { id: 'task.duration', label: 'Duration', kind: 'text' }, { id: 'task.resources', label: 'Resources', kind: 'text' },
    { id: 'task.percent', label: '% complete', kind: 'text' }, { id: 'task.notes', label: 'Notes', kind: 'textarea' }], false);
  const nodeTypes = [
    goal,
    type('Requirement', 'R', '#3b82f6', [
      { id: 'req.priority', label: 'Priority', kind: 'select', options: ['must', 'should', 'could', 'wont'] },
      { id: 'req.acceptance', label: 'Acceptance', kind: 'textarea', required: true }]),
    type('Decision', 'D', '#a855f7', [
      { id: 'dec.options', label: 'Options', kind: 'tags', spawnsNodes: true }, { id: 'dec.chosen', label: 'Chosen', kind: 'text' }]),
    type('Question', 'Q', '#f59e0b', [
      { id: 'q.urgency', label: 'Urgency', kind: 'select', options: ['low', 'medium', 'high'] },
      { id: 'q.blocking', label: 'Blocking', kind: 'boolean' }]),
    type('Note', 'N', '#94a3b8', []),
    task,
  ];
  const conn = (name, color, directed, symmetric) => ({ id: uuid(), modelId, name, color, directed, symmetric, fields: [], isBuiltin: true });
  const connectionTypes = [conn('enables', '#22c55e', true, false), conn('boundary', '#f59e0b', true, false),
    conn('requires', '#ef4444', true, false), conn('relates to', '#64748b', false, true)];
  const requires = connectionTypes[2];

  // Group rows under their top-level phase; tasks outside any phase go in a final group.
  const resById = new Map(project.resources.map(r => [r.id, r]));
  const groups = [], loose = [];
  let current = null;
  project.tasks.forEach((t, i) => {
    const k = computed.tasks[i];
    if (t.level === 1) {
      current = k.summary ? { phase: t, items: [] } : null;
      if (current) groups.push(current); else loose.push(t);
    } else if (current) current.items.push(t);
    else loose.push(t);
  });
  if (loose.length) groups.push({ phase: null, items: loose });

  const nodes = [], nodeOf = new Map();
  let y = 0;
  for (const g of groups) {
    const rows = Math.max(1, Math.ceil(g.items.length / PER_ROW));
    let cluster = null;
    if (g.phase) {
      const k = computed.byId.get(g.phase.id);
      cluster = { id: uuid(), modelId, typeId: null, title: g.phase.name || 'Phase', cluster: true, containerId: null,
        geometry: { x: 0, y, w: PER_ROW * COL - (COL - W) + 2 * PAD, h: rows * ROW - (ROW - H) + 2 * PAD + 20 },
        properties: { 'phase.start': isoDay(k.es), 'phase.end': isoDay(k.ef) }, ...stamp };
      nodes.push(cluster);
      nodeOf.set(g.phase.id, cluster.id);
    }
    g.items.forEach((t, j) => {
      const k = computed.byId.get(t.id);
      const ms = t.milestone && !k.summary;
      const props = ms ? { 'goal.targetDate': isoDay(k.es) } : Object.fromEntries(Object.entries({
        'task.start': isoDay(k.es), 'task.end': isoDay(k.ef), 'task.duration': formatDuration(k.duration, project),
        'task.resources': formatAssignments(t, resById), 'task.percent': k.percent ? `${Math.round(k.percent)}%` : '',
        'task.notes': t.notes,
      }).filter(([, v]) => v));
      if (ms && t.notes) props['goal.successCriteria'] = t.notes;
      const node = { id: uuid(), modelId, typeId: ms ? goal.id : task.id, title: t.name || 'Untitled', cluster: false,
        containerId: cluster?.id ?? null,
        geometry: { x: PAD + (j % PER_ROW) * COL, y: y + PAD + 20 + Math.floor(j / PER_ROW) * ROW, w: W, h: H },
        properties: props, ...stamp };
      nodes.push(node);
      nodeOf.set(t.id, node.id);
    });
    y += rows * ROW + 2 * PAD + 80;
  }

  const connections = [];
  project.tasks.forEach(t => t.preds.forEach(p => {
    const sourceId = nodeOf.get(t.id), targetId = nodeOf.get(p.id);
    if (sourceId && targetId && sourceId !== targetId) {
      connections.push({ id: uuid(), modelId, typeId: requires.id, sourceId, targetId, sourcePort: null, targetPort: null,
        description: null, openLabel: null, properties: {}, ...stamp });
    }
  }));

  const model = {
    schemaVersion: 1,
    model: { id: modelId, name: project.name, settings: { defaultConnectionTypeId: requires.id,
      boundaryConnectionTypeId: connectionTypes[1].id },
      createdAt: now, createdBy: 'scaled Schedule', updatedAt: now, updatedBy: 'scaled Schedule' },
    nodeTypes, connectionTypes, nodes, connections,
  };
  return JSON.stringify({ format: 'inversion.model', formatVersion: 1,
    meta: { name: project.name, savedAt: now, appVersion: 'scaled Schedule' }, model }, null, 2);
}
