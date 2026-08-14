// Recurring expense templates -> concrete expenses rows. See
// migrations/037_recurring_expenses.sql for the schema and the reasoning
// behind recurring_period being separate from the editable expense_date.
const cron     = require('node-cron');
const dayjs    = require('dayjs');
const utc      = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const pool = require('../db');
const { tz } = require('../config');
const { getDefaultBranchId } = require('./expenses');

function todayStr() {
  return dayjs().tz(tz).format('YYYY-MM-DD');
}

// day_of_month is clamped to the month's actual last day (e.g. 31 -> 28/29
// in February) rather than skipping the month entirely.
function isDueDay(template, dateStr) {
  const d = dayjs(dateStr);
  if (template.frequency === 'monthly') {
    return d.date() === Math.min(template.day_of_month, d.daysInMonth());
  }
  return d.day() === template.day_of_week; // dayjs: 0=Sunday .. 6=Saturday
}

// Every due date for a template from its start_date through throughDateStr
// (inclusive), bounded by end_date if set. Used by both the daily generator
// (throughDateStr = today) and the backfill preview/run (same call --
// backfill is just "every due date, including ones already generated,
// filtered down to what's missing").
function enumerateDueDates(template, throughDateStr) {
  const start = dayjs(template.start_date);
  let end = dayjs(throughDateStr);
  if (template.end_date && dayjs(template.end_date).isBefore(end)) end = dayjs(template.end_date);
  if (end.isBefore(start)) return [];

  const dates = [];
  if (template.frequency === 'monthly') {
    let cursor = start.startOf('month');
    while (!cursor.isAfter(end)) {
      const due = cursor.date(Math.min(template.day_of_month, cursor.daysInMonth()));
      if (!due.isBefore(start) && !due.isAfter(end)) dates.push(due.format('YYYY-MM-DD'));
      cursor = cursor.add(1, 'month');
    }
  } else {
    let cursor = start;
    while (cursor.day() !== template.day_of_week) cursor = cursor.add(1, 'day');
    while (!cursor.isAfter(end)) {
      dates.push(cursor.format('YYYY-MM-DD'));
      cursor = cursor.add(1, 'week');
    }
  }
  return dates;
}

async function getTemplateById(id) {
  const { rows } = await pool.query('SELECT * FROM recurring_expenses WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getActiveTemplates(asOfDateStr) {
  const { rows } = await pool.query(
    `SELECT * FROM recurring_expenses
     WHERE is_active = true AND start_date <= $1 AND (end_date IS NULL OR end_date >= $1)`,
    [asOfDateStr]
  );
  return rows;
}

// Inserts one generated expense for a due date. The partial unique index on
// (recurring_expense_id, recurring_period) makes this safe to call twice for
// the same period -- the second call is a no-op (returns null).
async function insertGenerated(template, dueDateStr) {
  const branchId = template.branch_id ?? await getDefaultBranchId();
  const { rows } = await pool.query(
    `INSERT INTO expenses (expense_date, amount, remark, expense_by, source, branch_id, recurring_expense_id, recurring_period)
     VALUES ($1, $2, $3, 'System', 'recurring', $4, $5, $6)
     ON CONFLICT (recurring_expense_id, recurring_period) WHERE recurring_expense_id IS NOT NULL DO NOTHING
     RETURNING id, expense_date, amount, remark, branch_id, recurring_expense_id, recurring_period`,
    [dueDateStr, template.amount, template.name, branchId, template.id, dueDateStr]
  );
  return rows[0] || null;
}

// Daily cron entry point: for every active template due *today*, generate
// today's occurrence if it doesn't already exist. Deliberately narrow --
// this does not sweep past periods (that's what backfill is for, and the
// task requires backfill to be an explicit, confirmed action, not something
// that happens implicitly off a missed cron tick).
async function generateDueToday() {
  const today = todayStr();
  const templates = await getActiveTemplates(today);
  const generated = [];
  for (const template of templates) {
    if (!isDueDay(template, today)) continue;
    const row = await insertGenerated(template, today);
    if (row) generated.push(row);
  }
  return { checked: templates.length, generated: generated.length, rows: generated };
}

// Every due date from start_date through today that doesn't already have a
// generated row, without writing anything -- what the UI shows before the
// user confirms.
async function previewBackfill(templateId) {
  const template = await getTemplateById(templateId);
  if (!template) return null;
  const today = todayStr();
  const due = enumerateDueDates(template, today);
  const { rows } = await pool.query(
    'SELECT recurring_period FROM expenses WHERE recurring_expense_id = $1',
    [templateId]
  );
  const existing = new Set(rows.map(r => dayjs(r.recurring_period).format('YYYY-MM-DD')));
  const missing = due.filter(d => !existing.has(d));
  return { template, count: missing.length, dates: missing };
}

// Actually generates the missing past occurrences. Call only after the
// caller has shown previewBackfill's count to the user and gotten
// confirmation -- this function itself does not gate on that, the route
// (two separate endpoints) does.
async function runBackfill(templateId) {
  const template = await getTemplateById(templateId);
  if (!template) return null;
  const today = todayStr();
  const due = enumerateDueDates(template, today);
  let inserted = 0;
  for (const dueDateStr of due) {
    const row = await insertGenerated(template, dueDateStr);
    if (row) inserted++;
  }
  return { checked: due.length, inserted };
}

// 06:00 Cambodia time -- ahead of the 08:45/09:00/09:15 receipts-sync jobs
// (services/sync/scheduler.js) so a recurring expense lands before anyone
// checks the dashboard's morning numbers.
function startRecurringExpenseScheduler() {
  cron.schedule('0 6 * * *', () => {
    generateDueToday()
      .then(({ checked, generated }) => console.log(`💸 [cron] Recurring expenses — checked ${checked} active template(s), generated ${generated}`))
      .catch(err => console.error('❌ [cron] Recurring expense generation failed:', err.message));
  }, { scheduled: true, timezone: tz });
  console.log(`💸  Recurring expense generation scheduled daily (06:00 ${tz})`);
}

module.exports = {
  isDueDay, enumerateDueDates, getTemplateById, getActiveTemplates,
  insertGenerated, generateDueToday, previewBackfill, runBackfill,
  startRecurringExpenseScheduler,
};
