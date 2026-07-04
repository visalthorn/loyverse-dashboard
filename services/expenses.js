const pool = require('../db');

async function insertExpense({ expense_date, amount, remark, expense_by, source = 'dashboard', telegram_message_id = null }) {
  const result = await pool.query(`
    INSERT INTO expenses (expense_date, amount, remark, expense_by, source, telegram_message_id)
    VALUES ($1,$2,$3,$4,$5,$6)
    RETURNING id, expense_date, amount, remark, expense_by, source, telegram_message_id, created_at
  `, [expense_date, amount, remark || null, expense_by, source, telegram_message_id]);
  return result.rows[0];
}

module.exports = { insertExpense };
