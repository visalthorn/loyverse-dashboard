const pool = require('../db');

async function columns(table) {
  const { rows } = await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  );
  return rows;
}

async function sample(table, n = 3) {
  const { rows } = await pool.query(`SELECT * FROM ${table} LIMIT ${n}`);
  return rows;
}

async function distinctList(sql, label) {
  const { rows } = await pool.query(sql);
  console.log(`\n--- ${label} ---`);
  console.log(rows);
}

async function main() {
  console.log('========================================');
  console.log('a) SCHEMA: items / categories / item_categories');
  console.log('========================================');
  console.log(await columns('items'));
  console.log('\nSample rows (items):');
  console.log(await sample('items'));
  console.log(await columns('categories'));
  console.log('\nSample rows (categories):');
  console.log(await sample('categories'));
  console.log(await columns('item_categories'));
  console.log('\nSample rows (item_categories):');
  console.log(await sample('item_categories'));

  console.log('\n========================================');
  console.log('a2) SCHEMA: receipts / receipt_items / receipt_payments / pos_devices / branches');
  console.log('   (context needed to map own POS orders into the same shape)');
  console.log('========================================');
  console.log(await columns('receipts'));
  console.log(await columns('receipt_items'));
  console.log(await columns('receipt_payments'));
  console.log(await columns('pos_devices'));
  console.log('\nSample rows (pos_devices):');
  console.log(await sample('pos_devices', 5));
  console.log(await columns('branches'));
  console.log('\nSample rows (branches):');
  console.log(await sample('branches'));

  console.log('\n========================================');
  console.log('b) VALUE VOCABULARY');
  console.log('========================================');

  await distinctList(`SELECT DISTINCT dining_option FROM receipts`, 'dining_option (receipts)');
  await distinctList(`SELECT DISTINCT receipt_type FROM receipts`, 'receipt_type (receipts)');
  await distinctList(`SELECT DISTINCT source FROM receipts`, 'source (receipts)');
  await distinctList(`SELECT DISTINCT store_id FROM receipts`, 'store_id (receipts)');
  await distinctList(`SELECT DISTINCT payment_name, payment_type FROM receipt_payments`, 'payment_name/payment_type (receipt_payments)');
  await distinctList(`SELECT pg_typeof(receipt_date) FROM receipts LIMIT 1`, 'pg_typeof(receipt_date)');

  console.log('\n========================================');
  console.log('c) SYNC STYLE (read directly from services/sync/*.js — not asked, verified in code)');
  console.log('========================================');
  console.log('receipts.js       : INSERT ... ON CONFLICT (receipt_number) DO NOTHING   -> additive, insert-only, never deletes');
  console.log('receipt_items.js  : INSERT ... ON CONFLICT DO NOTHING                     -> additive, insert-only');
  console.log('receipt_payments  : INSERT ... ON CONFLICT (receipt_number,payment_type_id) DO NOTHING');
  console.log('items.js/categories: INSERT ... ON CONFLICT (id/sku) DO UPDATE            -> upsert, never truncates');
  console.log('=> No table in the sync path is ever TRUNCATEd. Confirms: safe to read live from items/categories,');
  console.log('   but still forbidden to write into receipts/receipt_items/receipt_payments/items/categories —');
  console.log('   a future sync could silently DO NOTHING over rows we inserted with a colliding key, or our rows');
  console.log('   would simply sit mixed in with Loyverse rows with no way to distinguish provenance.');

  await pool.end();
}

main().catch((err) => {
  console.error('❌ Inspection failed:', err.message);
  process.exit(1);
});
