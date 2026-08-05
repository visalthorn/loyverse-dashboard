// test/receipt-number.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const dayjs = require('dayjs');
const pool = require('../db');
const { generateReceiptNumber } = require('../services/pos/receiptNumber');

// Self-contained test fixtures created in before() and cleaned up in after()
let testBranchId, testOrderId;

before(async () => {
  // Create test branch with unique name (short to fit varchar(20))
  const timestamp = Math.random().toString(36).substr(2, 8);
  const branchResult = await pool.query(
    `INSERT INTO branches (name) VALUES ($1) RETURNING id`,
    [`T-RcptSeq-${timestamp}`]
  );
  testBranchId = branchResult.rows[0].id;

  // Create test order with that branch_id, providing all required columns
  const orderResult = await pool.query(
    `INSERT INTO pos_orders (order_number, status, dining_option, subtotal, discount, total, branch_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      `T-RcptSeq-o-${timestamp}`,
      'completed',
      'ក្នុងហាង',
      1000,
      0,
      1000,
      testBranchId
    ]
  );
  testOrderId = orderResult.rows[0].id;
});

after(async () => {
  // Clean up test fixtures (explicit cleanup; receipt rows inside transactions rollback automatically)
  if (testOrderId) {
    await pool.query(`DELETE FROM pos_orders WHERE id = $1`, [testOrderId]);
  }
  if (testBranchId) {
    await pool.query(`DELETE FROM branches WHERE id = $1`, [testBranchId]);
  }
  await pool.end();
});

test('generates RCP-YYMMDD-#### with a sequential suffix', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const first = await generateReceiptNumber(client);
    const yymmdd = dayjs().tz('Asia/Phnom_Penh').format('YYMMDD');
    assert.match(first, new RegExp(`^RCP-${yymmdd}-\\d{4}$`));
    await client.query('ROLLBACK'); // don't actually insert a receipt row
  } finally {
    client.release();
  }
});

test('increments per existing pos_receipts row for the day', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await generateReceiptNumber(client);
    const seqBefore = parseInt(before.split('-')[2], 10);

    // Insert a throwaway receipt row using our test fixtures' guaranteed-valid branch_id
    await client.query(`
      INSERT INTO pos_receipts (receipt_number, order_id, branch_id, dining_option, subtotal, discount, total, receipt_date)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    `, [
      before,
      testOrderId,
      testBranchId,
      'ក្នុងហាង',
      1000,
      0,
      1000
    ]);

    const after = await generateReceiptNumber(client);
    const seqAfter = parseInt(after.split('-')[2], 10);
    assert.equal(seqAfter, seqBefore + 1);

    await client.query('ROLLBACK'); // transaction cleanup; fixtures cleaned up in after()
  } finally {
    client.release();
  }
});
