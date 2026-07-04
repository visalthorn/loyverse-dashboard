const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');

after(async () => {
  await pool.end();
});

test('expenses table has source and telegram_message_id columns', async () => {
  const result = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'expenses' AND column_name IN ('source', 'telegram_message_id')
  `);
  const columns = result.rows.map(r => r.column_name).sort();
  assert.deepEqual(columns, ['source', 'telegram_message_id']);
});
