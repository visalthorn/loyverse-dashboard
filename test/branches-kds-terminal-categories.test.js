const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { jwtSecret } = require('../config');
const app = require('../app');
const pool = require('../db');

let server, base, branchId, kdsId, categoryId;
const SUFFIX = Date.now();
const adminToken = jwt.sign({ id: 1, username: 't-admin', role: 'admin' }, jwtSecret);

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const b = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`T-KdsMap-${SUFFIX}`]);
  branchId = b.rows[0].id;
  const hash = await bcrypt.hash('000000', 10);
  const k = await pool.query(`INSERT INTO kds_terminals (branch_id, terminal_id, name, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [branchId, `T-KDSM-${SUFFIX}`, `KDS-M`, hash]);
  kdsId = k.rows[0].id;
  categoryId = crypto.randomUUID();
  const cat = await pool.query(`INSERT INTO categories (id, name) VALUES ($1, $2) RETURNING id`, [categoryId, `T-Seafood-${SUFFIX}`]);
  await pool.query(`INSERT INTO kds_terminal_categories (kds_terminal_id, category_id, branch_id) VALUES ($1,$2,$3)`, [kdsId, categoryId, branchId]);
});

after(async () => {
  await pool.query(`DELETE FROM kds_terminal_categories WHERE kds_terminal_id = $1`, [kdsId]);
  await pool.query(`DELETE FROM categories WHERE id = $1`, [categoryId]);
  await pool.query(`DELETE FROM kds_terminals WHERE id = $1`, [kdsId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  server.close();
  await pool.end();
});

test('returns the branch-wide assignment map', async () => {
  const res = await fetch(`${base}/api/branches/${branchId}/kds-terminal-categories`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.ok(rows.some(r => r.category_id === categoryId && r.kds_terminal_id === kdsId && r.name === 'KDS-M'));
});
