const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');

after(async () => {
  await pool.end();
});

test('report_categories table exists with expected columns', async () => {
  const result = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'report_categories'
      AND column_name IN ('id', 'name', 'created_at', 'updated_at')
  `);
  assert.equal(result.rows.length, 4);
});

test('report_categories.name is unique', async () => {
  const result = await pool.query(`
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'report_categories'::regclass AND contype = 'u'
  `);
  assert.ok(result.rows.length >= 1);
});

test('items.report_category_id FK is ON DELETE SET NULL', async () => {
  const result = await pool.query(`
    SELECT confdeltype FROM pg_constraint
    WHERE conrelid = 'items'::regclass AND contype = 'f'
      AND confrelid = 'report_categories'::regclass
  `);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].confdeltype, 'n'); // 'n' = SET NULL
});

test('item_categories has a report_category column', async () => {
  const result = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'item_categories' AND column_name = 'report_category'
  `);
  assert.equal(result.rows.length, 1);
});
