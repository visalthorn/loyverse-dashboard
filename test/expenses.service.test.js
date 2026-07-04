const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');
const { insertExpense } = require('../services/expenses');

after(async () => {
  await pool.end();
});

test('insertExpense defaults source to dashboard and telegram_message_id to null', async () => {
  const expense = await insertExpense({
    expense_date: '2026-07-04',
    amount: 15000,
    remark: 'test remark',
    expense_by: 'Test User',
  });

  assert.equal(expense.source, 'dashboard');
  assert.equal(expense.telegram_message_id, null);
  assert.equal(Number(expense.amount), 15000);
  assert.equal(expense.expense_by, 'Test User');

  await pool.query('DELETE FROM expenses WHERE id = $1', [expense.id]);
});

test('insertExpense stores telegram source and message id when provided', async () => {
  const expense = await insertExpense({
    expense_date: '2026-07-04',
    amount: 20000,
    remark: 'diesel',
    expense_by: 'Srey Sister',
    source: 'telegram',
    telegram_message_id: 999001,
  });

  assert.equal(expense.source, 'telegram');
  // pg returns BIGINT columns as strings, since not every bigint value fits a safe JS number
  assert.equal(expense.telegram_message_id, '999001');

  await pool.query('DELETE FROM expenses WHERE id = $1', [expense.id]);
});
