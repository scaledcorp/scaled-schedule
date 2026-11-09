// The review screen for schedules read out of documents (PDF, PowerPoint, Word). Shows the tasks that
// were found, which column was read as which field (changeable), and marks in amber anything that
// was guessed or couldn't be read. Nothing becomes the schedule until "Create schedule".
import { FIELDS, importTable } from '../io/csv.js';
import { fmtDate, formatDuration, formatPreds } from '../model.js';
import { schedule } from '../scheduler.js';
import { dialog } from './panels.js';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SHOW = 400;

function preview(result) {
  const { project, guessed } = result;
  const computed = schedule(project);
  const rowOf = new Map(project.tasks.map((t, i) => [t.id, i + 1]));
  let amber = 0;
  const body = project.tasks.slice(0, SHOW).map((t, i) => {
    const k = computed.byId.get(t.id), g = guessed[i] || new Set();
    const mark = f => {
      const on = g.has(f) && !(k.summary && f !== 'name' && f !== 'pred');
      if (on) amber++;
      return on ? ' class="rv-guess"' : '';
    };
    return `<tr class="${k.summary ? 'rv-sum' : ''}"><td class="rv-n">${i + 1}</td>
      <td${mark('name')}><span style="padding-left:${(t.level - 1) * 16}px">${esc(t.name) || '<em>no name</em>'}</span></td>
      <td${mark('dur')}>${t.milestone && !k.summary ? 'Milestone' : esc(formatDuration(k.duration, project))}</td>
      <td${mark('start')}>${esc(fmtDate(k.es))}</td><td${mark('finish')}>${esc(fmtDate(k.ef))}</td>
      <td${mark('pred')}>${esc(formatPreds(t, project, rowOf))}</td></tr>`;
  }).join('');
  const more = project.tasks.length > SHOW ? `<tr><td></td><td colspan="5" class="rv-more">and ${project.tasks.length - SHOW} more</td></tr>` : '';
  return { html: body + more, amber };
}

// -> Promise of the chosen { project, warnings } or null when cancelled.
export function reviewImport({ fileName, table, result }) {
  return new Promise(resolve => {
    let current = result;
    const header = result.header.map(h => String(h ?? ''));
    const mapping = !table.shapes && header.length ? `<div class="rv-map" aria-label="Columns">${header.map((h, c) => {
      const field = Object.keys(FIELDS).find(f => result.map[f] === c) || '';
      return `<label><span title="${esc(h)}">${esc(h) || `Column ${c + 1}`}</span><select data-col="${c}">
        <option value="">Not used</option>${Object.entries(FIELDS).map(([f, label]) => `<option value="${f}"${f === field ? ' selected' : ''}>${label}</option>`).join('')}</select></label>`;
    }).join('')}</div>` : '';
    const source = table.shapes ? 'Dates were read from where each bar sits on the timeline, so check them.' : 'Each column below shows what it was read as; change one if it\'s wrong.';
    const d = dialog(`<div class="dlg-body review">
        <h2 id="rvTitle"></h2>
        <p class="hint">${esc(source)} <span id="rvAmber"></span></p>
        ${mapping}
        <div class="rv-table"><table><thead><tr><th>#</th><th>Task</th><th>Duration</th><th>Start</th><th>Finish</th><th>Links</th></tr></thead>
        <tbody id="rvBody"></tbody></table></div>
        <p class="rv-error" id="rvError" hidden></p>
      </div>
      <div class="actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="ok">Create schedule</button></div>`);
    d.classList.add('wide');
    const ok = d.querySelector('[data-act="ok"]');
    const render = () => {
      const err = d.querySelector('#rvError');
      if (!current) { ok.disabled = true; return; }
      err.hidden = true; ok.disabled = false;
      const { html, amber } = preview(current);
      d.querySelector('#rvTitle').textContent = `Found ${current.project.tasks.length} task${current.project.tasks.length === 1 ? '' : 's'} in ${fileName}`;
      d.querySelector('#rvAmber').textContent = amber ? 'Amber cells were guessed or couldn\'t be read.' : '';
      d.querySelector('#rvBody').innerHTML = html;
    };
    d.querySelectorAll('select[data-col]').forEach(sel => sel.addEventListener('change', () => {
      if (sel.value) d.querySelectorAll('select[data-col]').forEach(o => { if (o !== sel && o.value === sel.value) o.value = ''; });
      const map = {};
      d.querySelectorAll('select[data-col]').forEach(o => { if (o.value) map[o.value] = +o.dataset.col; });
      try {
        current = importTable(table.rows, { name: table.name, indents: table.indents, guess: table.guess || [], map });
        render();
      } catch (e) {
        current = null;
        ok.disabled = true;
        const err = d.querySelector('#rvError');
        err.textContent = map.name == null ? 'Pick the column that holds the task names.' : e.message;
        err.hidden = false;
      }
    }));
    const close = value => { d.classList.remove('wide'); d.close(); resolve(value); };
    d.onclick = e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') close(null);
      if (act === 'ok' && current) close(current);
    };
    d.oncancel = () => { d.classList.remove('wide'); resolve(null); };
    render();
  });
}
