const dayjs    = require('dayjs');
const utc      = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = 'Asia/Phnom_Penh';

// Must be called inside the same transaction as the pos_receipts INSERT --
// the advisory lock is held until COMMIT/ROLLBACK, serializing concurrent
// receipt creation for the same Cambodia calendar day. Separate counter and
// lock key from generateOrderNumber (services/pos/orderNumber.js) -- a
// receipt is issued once, at completion, not at order creation. RCP- prefix
// (not POS-) so a receipt_number can never be visually confused with an
// order_number once the two counters diverge (first cancellation or refund).
//
// MAX()-based, not COUNT()-based: receipt_number is UNIQUE, so a deleted row
// for the day (test cleanup, a future admin action) must never let the next
// call collide with a still-existing higher-sequence row.
async function generateReceiptNumber(client) {
  const yymmdd = dayjs().tz(TZ).format('YYMMDD');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pos_receipt_seq_${yymmdd}`]);
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(SUBSTRING(receipt_number FROM '[0-9]+$')::int), 0) AS last
     FROM pos_receipts WHERE receipt_number LIKE $1`,
    [`RCP-${yymmdd}-%`]
  );
  const seq = rows[0].last + 1;
  return `RCP-${yymmdd}-${String(seq).padStart(4, '0')}`;
}

module.exports = { generateReceiptNumber };
