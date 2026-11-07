// Primavera P6 XER export. Summary tasks become WBS elements (P6 can't link to WBS, so links on
// summary tasks are moved onto their first and last child); leaf tasks become activities.
import { dayIndex, weekday } from '../calendar.js';

const PRED = { FS: 'PR_FS', SS: 'PR_SS', FF: 'PR_FF', SF: 'PR_SF' };
const CSTR = { SNET: 'CS_MSOA', SNLT: 'CS_MSOB', FNET: 'CS_MEOA', FNLT: 'CS_MEOB', MSO: 'CS_MSO', MFO: 'CS_MEO', ALAP: 'CS_ALAP' };
const ts = t => (t == null ? '' : new Date(t * 60000).toISOString().slice(0, 16).replace('T', ' '));
const hrs = m => +(m / 60).toFixed(2);
const hm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const clean = s => String(s ?? '').replace(/[\t\r\n]+/g, ' ');

function table(out, name, fields, rows) {
  out.push(`%T\t${name}`, `%F\t${fields.join('\t')}`);
  rows.forEach(r => out.push(`%R\t${fields.map(f => clean(r[f])).join('\t')}`));
}

// P6 calendar data: days 1 (Sunday) to 7, exceptions as days since 1899-12-30.
function clndrData(cal) {
  const day = (i, ranges) => `(0||${i}()(${ranges.map(([a, b], k) => `(0||${k}(s|${hm(a)}|f|${hm(b)})())`).join('')}))`;
  const days = cal.week.map((r, i) => day(i + 1, r)).join('');
  const exc = cal.exceptions.map((e, k) => {
    const serial = Math.round(Date.parse(e.date + 'T00:00:00Z') / 86400000) + 25569;
    return `(0||${k}(d|${serial})(${(e.ranges || []).map(([a, b], j) => `(0||${j}(s|${hm(a)}|f|${hm(b)})())`).join('')}))`;
  }).join('');
  return `(0||CalendarData()((0||DaysOfWeek()(${days}))(0||Exceptions()(${exc}))))`;
}

export function exportXER(project, computed) {
  const c = computed.byId, now = ts(Math.floor(Date.now() / 60000));
  const projId = 1, clndrId = 1;
  const short = (project.name || 'Project').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'Project';
  const dayHrs = project.minutesPerDay / 60, weekHrs = project.minutesPerWeek / 60;
  const out = [`ERMHDR\t19.12\t${now.slice(0, 10)}\tProject\tadmin\tscaled Schedule\tdbxDatabaseNoName\tProject Management\tUSD`];
  const warnings = [];

  table(out, 'CURRTYPE', ['curr_id', 'decimal_digit_cnt', 'curr_symbol', 'decimal_symbol', 'digit_group_symbol',
    'pos_curr_fmt_type', 'neg_curr_fmt_type', 'curr_type', 'curr_short_name', 'group_digit_cnt', 'base_exch_rate'],
  [{ curr_id: 1, decimal_digit_cnt: 2, curr_symbol: project.currency || '$', decimal_symbol: '.', digit_group_symbol: ',',
    pos_curr_fmt_type: '#1.1', neg_curr_fmt_type: '(#1.1)', curr_type: 'US Dollar', curr_short_name: 'USD',
    group_digit_cnt: 3, base_exch_rate: 1 }]);

  table(out, 'PROJECT', ['proj_id', 'fy_start_month_num', 'rsrc_self_add_flag', 'allow_complete_flag',
    'rsrc_multi_assign_flag', 'checkout_flag', 'project_flag', 'step_complete_flag', 'cost_qty_recalc_flag',
    'batch_sum_flag', 'name_sep_char', 'def_complete_pct_type', 'proj_short_name', 'clndr_id', 'task_code_base',
    'task_code_step', 'priority_num', 'wbs_max_sum_level', 'strgy_priority_num', 'critical_drtn_hr_cnt',
    'def_cost_per_qty', 'last_recalc_date', 'plan_start_date', 'scd_end_date', 'add_date', 'def_duration_type',
    'task_code_prefix', 'def_qty_type', 'add_by_name', 'def_rate_type', 'def_task_type', 'critical_path_type',
    'task_code_prefix_flag', 'def_rollup_dates_flag', 'sum_assign_level', 'last_schedule_date', 'export_flag'],
  [{ proj_id: projId, fy_start_month_num: 1, rsrc_self_add_flag: 'Y', allow_complete_flag: 'Y',
    rsrc_multi_assign_flag: 'Y', checkout_flag: 'N', project_flag: 'Y', step_complete_flag: 'N',
    cost_qty_recalc_flag: 'Y', batch_sum_flag: 'Y', name_sep_char: '.', def_complete_pct_type: 'CP_Drtn',
    proj_short_name: short, clndr_id: clndrId, task_code_base: 1000, task_code_step: 10, priority_num: 10,
    wbs_max_sum_level: 0, strgy_priority_num: 100, critical_drtn_hr_cnt: 0, def_cost_per_qty: 0,
    last_recalc_date: ts(computed.start), plan_start_date: ts(computed.start), scd_end_date: ts(computed.finish),
    add_date: now, def_duration_type: 'DT_FixedDUR2', task_code_prefix: 'A', def_qty_type: 'QT_Hour',
    add_by_name: 'scaled Schedule', def_rate_type: 'COST_PER_QTY', def_task_type: 'TT_Task',
    critical_path_type: 'CT_TotFloat', task_code_prefix_flag: 'Y', def_rollup_dates_flag: 'Y',
    sum_assign_level: 'SL_Taskrsrc', last_schedule_date: ts(computed.start), export_flag: 'Y' }]);

  table(out, 'CALENDAR', ['clndr_id', 'default_flag', 'clndr_name', 'proj_id', 'base_clndr_id', 'last_chng_date',
    'clndr_type', 'day_hr_cnt', 'week_hr_cnt', 'month_hr_cnt', 'year_hr_cnt', 'rsrc_private', 'clndr_data'],
  [{ clndr_id: clndrId, default_flag: 'N', clndr_name: `${project.name} calendar`, proj_id: projId, base_clndr_id: '',
    last_chng_date: now, clndr_type: 'CA_Project', day_hr_cnt: dayHrs, week_hr_cnt: weekHrs,
    month_hr_cnt: dayHrs * project.daysPerMonth, year_hr_cnt: weekHrs * 52, rsrc_private: 'N',
    clndr_data: clndrData(project.calendar) }]);

  // WBS: a root node for the project, then one node per summary task.
  const wbsRows = [{ wbs_id: 1, proj_id: projId, seq_num: 0, est_wt: 1, proj_node_flag: 'Y', sum_data_flag: 'Y',
    status_code: 'WS_Open', wbs_short_name: short, wbs_name: project.name, parent_wbs_id: '',
    ev_user_pct: 6, ev_etc_user_value: 0.88, ev_compute_type: 'EC_Cmp_pct', ev_etc_compute_type: 'EE_Rem_hr' }];
  const wbsOf = new Map();
  project.tasks.forEach((t, i) => {
    const k = c.get(t.id);
    if (!k.summary) return;
    const id = wbsRows.length + 1;
    wbsOf.set(t.id, id);
    wbsRows.push({ ...wbsRows[0], wbs_id: id, seq_num: i + 1, proj_node_flag: 'N',
      wbs_short_name: k.wbs, wbs_name: t.name, parent_wbs_id: k.parent ? wbsOf.get(k.parent) : 1 });
  });
  table(out, 'PROJWBS', ['wbs_id', 'proj_id', 'obs_id', 'seq_num', 'est_wt', 'proj_node_flag', 'sum_data_flag',
    'status_code', 'wbs_short_name', 'wbs_name', 'phase_id', 'parent_wbs_id', 'ev_user_pct', 'ev_etc_user_value',
    'orig_cost', 'indep_remain_total_cost', 'indep_remain_work_qty', 'ev_compute_type', 'ev_etc_compute_type'], wbsRows);

  // resources
  const rsrcRows = project.resources.map((r, i) => ({ rsrc_id: r.id, clndr_id: clndrId, rsrc_seq_num: i,
    rsrc_name: r.name, rsrc_short_name: (r.initials || r.name).replace(/\s+/g, '').slice(0, 20) || `R${r.id}`,
    def_qty_per_hr: r.type === 'work' ? r.maxUnits ?? 1 : 0, cost_qty_type: 'QT_Hour', active_flag: 'Y',
    auto_compute_act_flag: 'Y', def_cost_qty_link_flag: 'Y', ot_flag: 'N', curr_id: 1,
    rsrc_type: r.type === 'material' ? 'RT_Mat' : r.type === 'cost' ? 'RT_Equip' : 'RT_Labor' }));
  table(out, 'RSRC', ['rsrc_id', 'parent_rsrc_id', 'clndr_id', 'rsrc_seq_num', 'rsrc_name', 'rsrc_short_name',
    'def_qty_per_hr', 'cost_qty_type', 'active_flag', 'auto_compute_act_flag', 'def_cost_qty_link_flag', 'ot_flag',
    'curr_id', 'rsrc_type'], rsrcRows);
  table(out, 'RSRCRATE', ['rsrc_rate_id', 'rsrc_id', 'max_qty_per_hr', 'cost_per_qty', 'start_date'],
    project.resources.map((r, i) => ({ rsrc_rate_id: i + 1, rsrc_id: r.id, max_qty_per_hr: r.maxUnits ?? 1,
      cost_per_qty: r.rate || 0, start_date: '1990-01-01 00:00' })));

  // activities
  const leaves = project.tasks.filter(t => !c.get(t.id).summary);
  const taskRows = leaves.map((t, i) => {
    const k = c.get(t.id), d = t.milestone ? 0 : t.duration, con = t.constraint || {};
    const pct = Math.round(k.percent);
    return {
      task_id: t.id, proj_id: projId, wbs_id: k.parent ? wbsOf.get(k.parent) : 1, clndr_id: clndrId,
      phys_complete_pct: pct, rev_fdbk_flag: 'N', est_wt: 1, lock_plan_flag: 'N', auto_compute_act_flag: 'Y',
      complete_pct_type: 'CP_Drtn', task_type: t.milestone ? 'TT_FinMile' : 'TT_Task', duration_type: 'DT_FixedDUR2',
      status_code: pct >= 100 ? 'TK_Complete' : pct > 0 ? 'TK_Active' : 'TK_NotStart',
      task_code: `A${1000 + 10 * (i + 1)}`, task_name: t.name, total_float_hr_cnt: hrs(k.float),
      remain_drtn_hr_cnt: hrs(d * (1 - pct / 100)), target_drtn_hr_cnt: hrs(d),
      remain_work_qty: hrs(k.work * (1 - pct / 100)), target_work_qty: hrs(k.work), act_work_qty: 0,
      cstr_date: con.date != null && CSTR[con.type] ? ts(con.date) : '', cstr_type: CSTR[con.type] || '',
      act_start_date: ts(t.actualStart), act_end_date: ts(t.actualFinish),
      early_start_date: ts(k.es), early_end_date: ts(k.ef), late_start_date: ts(k.ls), late_end_date: ts(k.lf),
      restart_date: ts(k.es), reend_date: ts(k.ef), rem_late_start_date: ts(k.ls), rem_late_end_date: ts(k.lf),
      target_start_date: ts(t.baseline?.start ?? k.es), target_end_date: ts(t.baseline?.finish ?? k.ef),
      priority_type: 'PT_Normal', driving_path_flag: k.critical ? 'Y' : 'N', create_date: now, update_date: now,
    };
  });
  table(out, 'TASK', ['task_id', 'proj_id', 'wbs_id', 'clndr_id', 'phys_complete_pct', 'rev_fdbk_flag', 'est_wt',
    'lock_plan_flag', 'auto_compute_act_flag', 'complete_pct_type', 'task_type', 'duration_type', 'status_code',
    'task_code', 'task_name', 'rsrc_id', 'total_float_hr_cnt', 'free_float_hr_cnt', 'remain_drtn_hr_cnt',
    'act_work_qty', 'remain_work_qty', 'target_work_qty', 'target_drtn_hr_cnt', 'target_equip_qty', 'act_equip_qty',
    'remain_equip_qty', 'cstr_date', 'act_start_date', 'act_end_date', 'late_start_date', 'late_end_date',
    'expect_end_date', 'early_start_date', 'early_end_date', 'restart_date', 'reend_date', 'target_start_date',
    'target_end_date', 'rem_late_start_date', 'rem_late_end_date', 'cstr_type', 'priority_type',
    'driving_path_flag', 'create_date', 'update_date'], taskRows);

  // links: summary ends are replaced by their first/last child (P6 links activities only)
  const firstLeaf = id => { const k = c.get(id); return k.summary ? project.tasks[Math.min(...k.leaves)].id : id; };
  const lastLeaf = id => { const k = c.get(id); return k.summary ? project.tasks[Math.max(...k.leaves)].id : id; };
  const predRows = [], seen = new Set();
  project.tasks.forEach(t => t.preds.forEach(p => {
    const from = p.type[0] === 'F' ? lastLeaf(p.id) : firstLeaf(p.id);
    const to = p.type[1] === 'S' ? firstLeaf(t.id) : lastLeaf(t.id);
    if (from === to || seen.has(`${from}-${to}`)) return;
    if (c.get(p.id).summary || c.get(t.id).summary) warnings.push('summary');
    seen.add(`${from}-${to}`);
    predRows.push({ task_pred_id: predRows.length + 1, task_id: to, pred_task_id: from, proj_id: projId,
      pred_proj_id: projId, pred_type: PRED[p.type], lag_hr_cnt: hrs(p.lag || 0) });
  }));
  table(out, 'TASKPRED', ['task_pred_id', 'task_id', 'pred_task_id', 'proj_id', 'pred_proj_id', 'pred_type',
    'lag_hr_cnt', 'comments', 'float_path', 'aref', 'arls'], predRows);

  const asgRows = [];
  leaves.forEach(t => {
    const k = c.get(t.id), d = t.milestone ? 0 : t.duration;
    t.assignments.forEach(a => {
      const r = project.resources.find(x => x.id === a.resourceId);
      if (!r) return;
      const qty = r.type === 'work' ? hrs(d * a.units) : a.units;
      asgRows.push({ taskrsrc_id: asgRows.length + 1, task_id: t.id, proj_id: projId, cost_qty_link_flag: 'Y',
        rsrc_id: r.id, remain_qty: qty, target_qty: qty, remain_qty_per_hr: a.units, target_qty_per_hr: a.units,
        cost_per_qty: r.rate || 0, target_cost: +(qty * (r.rate || 0)).toFixed(2), remain_cost: +(qty * (r.rate || 0)).toFixed(2),
        restart_date: ts(k.es), reend_date: ts(k.ef), target_start_date: ts(k.es), target_end_date: ts(k.ef),
        rem_late_start_date: ts(k.ls), rem_late_end_date: ts(k.lf), rollup_dates_flag: 'Y', rate_type: 'COST_PER_QTY',
        rsrc_type: rsrcRows.find(x => x.rsrc_id === r.id).rsrc_type, create_date: now });
    });
  });
  table(out, 'TASKRSRC', ['taskrsrc_id', 'task_id', 'proj_id', 'cost_qty_link_flag', 'rsrc_id', 'remain_qty',
    'target_qty', 'remain_qty_per_hr', 'target_qty_per_hr', 'cost_per_qty', 'target_cost', 'remain_cost',
    'restart_date', 'reend_date', 'target_start_date', 'target_end_date', 'rem_late_start_date', 'rem_late_end_date',
    'rollup_dates_flag', 'rate_type', 'rsrc_type', 'create_date'], asgRows);

  out.push('%E');
  const moved = warnings.filter(w => w === 'summary').length;
  return { text: out.join('\r\n') + '\r\n',
    warnings: moved ? [`${moved} link${moved > 1 ? 's' : ''} on summary tasks moved to their first or last task (P6 only links activities).`] : [] };
}
export { dayIndex, weekday };
