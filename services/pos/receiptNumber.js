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
// receipt is issued once, at completion, not at order creation.
async function generateReceiptNumber(client) {
  const yymmdd = dayjs().tz(TZ).format('YYMMDD');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pos_receipt_seq_${yymmdd}`]);
  const { rows } = await client.query(
    `SELECT COUNT(*) AS count FROM pos_receipts WHERE receipt_number LIKE $1`,
    [`POS-${yymmdd}-%`]
  );
  const seq = parseInt(rows[0].count, 10) + 1;
  return `POS-${yymmdd}-${String(seq).padStart(4, '0')}`;
}

module.exports = { generateReceiptNumber };
