const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');

after(async () => {
  await pool.end();
});

test('categories table has override and sync columns', async () => {
  const result = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'categories'
      AND column_name IN ('id', 'name', 'custom_name', 'color', 'deleted_at', 'synced_at')
  `);
  assert.equal(result.rows.length, 6);
});

test('items table has override and sync columns', async () => {
  const result = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'items'
      AND column_name IN ('id', 'sku', 'name', 'custom_name', 'category_id',
                          'custom_category_id', 'price', 'cost', 'image_url',
                          'deleted_at', 'synced_at')
  `);
  assert.equal(result.rows.length, 11);
});

test('item_categories table exists with sku and category', async () => {
  const result = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'item_categories' AND column_name IN ('sku', 'category')
  `);
  assert.equal(result.rows.length, 2);
});

test('sync_logs has sync_type column defaulting to receipts', async () => {
  const result = await pool.query(`
    SELECT column_default FROM information_schema.columns
    WHERE table_name = 'sync_logs' AND column_name = 'sync_type'
  `);
  assert.equal(result.rows.length, 1);
  assert.match(result.rows[0].column_default, /receipts/);
});

test('role_permissions has an items row for manager', async () => {
  const result = await pool.query(
    `SELECT can_write FROM role_permissions WHERE role='manager' AND page='items'`
  );
  assert.equal(result.rows.length, 1);
});
