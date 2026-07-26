// scripts/backfill-pos-receipts.js
// Regenerates pos_receipts (+ items + payment) for pos_orders rows that were
// paid before the completion transaction (Task 3 of the POS/KDS revision
// plan) started writing them. Dry-run by default -- prints the count and
// exits. Pass --confirm to actually insert.
//
// Usage: npx cross-env ENV=UAT node scripts/backfill-pos-receipts.js [--confirm]

const pool = require('../db');
const { toCambodiaTime } = require('../utils/date');
const { generateReceiptNumber } = require('../services/pos/receiptNumber');

const PAYMENT_METHODS = {
  cash: { payment_name: 'Cash', payment_type: 'CASH' },
  khqr: { payment_name: 'QR',   payment_type: 'OTHER' },
};

async function main() {
  const confirm = process.argv.includes('--confirm');

  const { rows: orphans } = await pool.query(`
    SELECT id FROM pos_orders WHERE status = 'paid' AND receipt_id IS NULL ORDER BY id
  `);

  console.log(`Found ${orphans.length} paid pos_orders row(s) with no receipt.`);
  if (!orphans.length) return;
  if (!confirm) {
    console.log('Dry run only -- re-run with --confirm to backfill pos_receipts for these orders.');
    return;
  }

  let done = 0;
  for (const { id } of orphans) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const orderRes = await client.query('SELECT * FROM pos_orders WHERE id = $1 FOR UPDATE', [id]);
      const order = orderRes.rows[0];
      if (!order || order.receipt_id) { await client.query('ROLLBACK'); continue; } // raced with a real completion

      const now = order.paid_at ? toCambodiaTime(order.paid_at) : toCambodiaTime(new Date());
      const receiptNumber = await generateReceiptNumber(client);
      const pm = PAYMENT_METHODS[order.payment_method] || { payment_name: order.payment_method, payment_type: 'OTHER' };

      const receiptRes = await client.query(`
        INSERT INTO pos_receipts
          (receipt_number, order_id, branch_id, pos_terminal_id, dining_option, subtotal, discount, total, receipt_date, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id
      `, [receiptNumber, order.id, order.branch_id, order.terminal_id, order.dining_option,
          order.subtotal, order.discount, order.total, now, order.created_by]);
      const receiptId = receiptRes.rows[0].id;

      await client.query(`
        INSERT INTO pos_receipt_items (receipt_id, sku, item_name, quantity, price, gross_total)
        SELECT $1, it.sku, poi.item_name, poi.quantity, poi.price, poi.price * poi.quantity
        FROM pos_order_items poi
        LEFT JOIN items it ON it.id = poi.source_item_id::uuid
        WHERE poi.order_id = $2
      `, [receiptId, order.id]);

      await client.query(`
        INSERT INTO pos_receipt_payments (receipt_id, payment_name, payment_type, money_amount, paid_at)
        VALUES ($1,$2,$3,$4,$5)
      `, [receiptId, pm.payment_name, pm.payment_type, order.total, now]);

      await client.query(`UPDATE pos_orders SET receipt_id = $1 WHERE id = $2`, [receiptId, id]);
      await client.query('COMMIT');
      done++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`Failed to backfill order ${id}:`, err.message);
    } finally {
      client.release();
    }
  }
  console.log(`Backfilled ${done}/${orphans.length} receipt(s).`);
}

main().then(() => pool.end()).catch(err => { console.error(err); pool.end(); process.exit(1); });
