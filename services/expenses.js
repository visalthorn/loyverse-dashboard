const pool = require('../db');

async function getDefaultBranchId() {
  const r = await pool.query('SELECT id FROM branches WHERE is_default LIMIT 1');
  return r.rows[0]?.id ?? null;
}

async function insertExpense({ expense_date, amount, remark, expense_by, source = 'dashboard', telegram_message_id = null, branch_id = null }) {
  // Server-side default so every entry point (dashboard, Telegram bot) lands
  // on the default branch without knowing branches exist.
  const branchId = branch_id ?? await getDefaultBranchId();
  const result = await pool.query(`
    INSERT INTO expenses (expense_date, amount, remark, expense_by, source, telegram_message_id, branch_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING id, expense_date, amount, remark, expense_by, source, telegram_message_id, branch_id, created_at
  `, [expense_date, amount, remark || null, expense_by, source, telegram_message_id, branchId]);
  return result.rows[0];
}

module.exports = { insertExpense, getDefaultBranchId };
