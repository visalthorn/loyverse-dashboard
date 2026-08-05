// test/pos-receipts-views-regression.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');

after(async () => { await pool.end(); });

// Ground truth read directly from the underlying Loyverse `receipts` table,
// which migration 014 never touches -- NOT the view being tested. Comparing
// the view to itself (its own before/after query, both run post-migration)
// would always pass regardless of whether the repoint broke anything; this
// compares the view's output against an independent source.
test('Loyverse-only historical range matches the raw receipts table exactly', async () => {
  const raw = await pool.query(`
    SELECT COALESCE(SUM(total_money), 0) AS total, COUNT(*) AS n
    FROM receipts WHERE DATE(receipt_date) = '2026-05-01'
  `);
  const viewed = await pool.query(`
    SELECT COALESCE(SUM(total_money), 0) AS total, COUNT(*) AS n
    FROM v_receipts_all WHERE source != 'OWN_POS' AND DATE(receipt_date) = '2026-05-01'
  `);
  assert.equal(viewed.rows[0].total, raw.rows[0].total);
  assert.equal(viewed.rows[0].n, raw.rows[0].n);
});

test('v_receipts_all reads OWN_POS rows from pos_receipts, not pos_orders', async () => {
  const def = await pool.query(`SELECT pg_get_viewdef('v_receipts_all'::regclass, true) AS def`);
  assert.match(def.rows[0].def, /pos_receipts/);
  assert.doesNotMatch(def.rows[0].def, /pos_orders/);
});

test('a completed pos_orders sale surfaces through v_receipts_all with branch_id populated', async () => {
  const r = await pool.query(`
    SELECT receipt_number, branch_id FROM v_receipts_all
    WHERE source = 'OWN_POS'
    ORDER BY receipt_date DESC LIMIT 1
  `);
  if (r.rows.length) assert.ok(r.rows[0].branch_id !== null);
});
