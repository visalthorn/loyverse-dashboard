// test/kds-category-branch-migration.test.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');

after(async () => { await pool.end(); });

test('kds_terminal_categories has a NOT NULL branch_id', async () => {
  const col = await pool.query(`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_name = 'kds_terminal_categories' AND column_name = 'branch_id'
  `);
  assert.equal(col.rows.length, 1);
  assert.equal(col.rows[0].is_nullable, 'NO');
});

test('UNIQUE constraint is (branch_id, category_id), not (kds_terminal_id, category_id)', async () => {
  const idx = await pool.query(`
    SELECT indexdef FROM pg_indexes
    WHERE tablename = 'kds_terminal_categories' AND indexdef ILIKE '%UNIQUE%'
  `);
  assert.ok(idx.rows.some(r => r.indexdef.includes('branch_id') && r.indexdef.includes('category_id')));
  assert.ok(!idx.rows.some(r => r.indexdef.includes('kds_terminal_id') && r.indexdef.includes('category_id') && !r.indexdef.includes('branch_id')));
});
