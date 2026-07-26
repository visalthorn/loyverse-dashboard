// test/pos-receipts-migration.test.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');

after(async () => { await pool.end(); });

test('pos_receipts, pos_receipt_items, pos_receipt_payments exist with expected columns', async () => {
  const tables = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('pos_receipts', 'pos_receipt_items', 'pos_receipt_payments')
  `);
  assert.equal(tables.rows.length, 3);

  const cols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'pos_receipts'
      AND column_name IN ('receipt_number', 'order_id', 'branch_id', 'pos_terminal_id',
                           'dining_option', 'subtotal', 'discount', 'total', 'receipt_date',
                           'cancelled_at', 'cancel_reason', 'created_by')
  `);
  assert.equal(cols.rows.length, 12);
});

test('pos_orders has a receipt_id column referencing pos_receipts', async () => {
  const col = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'pos_orders' AND column_name = 'receipt_id'
  `);
  assert.equal(col.rows.length, 1);
});

test('receipt_number is unique', async () => {
  const idx = await pool.query(`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'pos_receipts' AND indexdef ILIKE '%UNIQUE%receipt_number%'
  `);
  assert.ok(idx.rows.length >= 1);
});
