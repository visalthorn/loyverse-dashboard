const pool = require('../db');

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_summary (
      day                DATE PRIMARY KEY,
      sales_gross        NUMERIC  NOT NULL DEFAULT 0,
      sales_orders       INTEGER  NOT NULL DEFAULT 0,
      refund_amount      NUMERIC  NOT NULL DEFAULT 0,
      refund_count       INTEGER  NOT NULL DEFAULT 0,
      refund_open_amount NUMERIC  NOT NULL DEFAULT 0,
      refund_open_count  INTEGER  NOT NULL DEFAULT 0,
      cancelled_amount   NUMERIC  NOT NULL DEFAULT 0,
      cancelled_count    INTEGER  NOT NULL DEFAULT 0,
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log('✅ daily_summary table present');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_dining_summary (
      day           DATE    NOT NULL,
      dining_option TEXT    NOT NULL,
      orders        INTEGER NOT NULL DEFAULT 0,
      revenue       NUMERIC NOT NULL DEFAULT 0,
      PRIMARY KEY (day, dining_option)
    )
  `);
  console.log('✅ daily_dining_summary table present');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_payment_summary (
      day          DATE    NOT NULL,
      payment_name TEXT    NOT NULL,
      payment_type TEXT    NOT NULL DEFAULT '',
      transactions INTEGER NOT NULL DEFAULT 0,
      total        NUMERIC NOT NULL DEFAULT 0,
      PRIMARY KEY (day, payment_name, payment_type)
    )
  `);
  console.log('✅ daily_payment_summary table present');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_item_summary (
      day       DATE    NOT NULL,
      sku       TEXT    NOT NULL DEFAULT '',
      item_name TEXT,
      qty       NUMERIC NOT NULL DEFAULT 0,
      revenue   NUMERIC NOT NULL DEFAULT 0,
      PRIMARY KEY (day, sku)
    )
  `);
  console.log('✅ daily_item_summary table present');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_hour_summary (
      day     DATE     NOT NULL,
      hour    SMALLINT NOT NULL,
      orders  INTEGER  NOT NULL DEFAULT 0,
      revenue NUMERIC  NOT NULL DEFAULT 0,
      PRIMARY KEY (day, hour)
    )
  `);
  console.log('✅ daily_hour_summary table present');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_device_summary (
      day           DATE    NOT NULL,
      pos_device_id TEXT    NOT NULL DEFAULT '',
      device_name   TEXT,
      orders        INTEGER NOT NULL DEFAULT 0,
      revenue       NUMERIC NOT NULL DEFAULT 0,
      PRIMARY KEY (day, pos_device_id)
    )
  `);
  console.log('✅ daily_device_summary table present');

  await pool.query(`CREATE TABLE IF NOT EXISTS receipts_archive         (LIKE receipts         INCLUDING ALL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS receipt_items_archive    (LIKE receipt_items    INCLUDING ALL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS receipt_payments_archive (LIKE receipt_payments INCLUDING ALL)`);
  console.log('✅ archive tables present');
}

migrate()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  });
