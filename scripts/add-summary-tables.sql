-- SQL mirror of scripts/add-summary-tables.js for manual PROD (Supabase) execution.
-- Idempotent: safe to run more than once.
-- After running this on PROD, deploy the app and call POST /api/reports/rebuild
-- once with {"start":"2026-06-09","end":"<yesterday>"} as an admin to backfill.

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
);

CREATE TABLE IF NOT EXISTS daily_dining_summary (
  day           DATE    NOT NULL,
  dining_option TEXT    NOT NULL,
  orders        INTEGER NOT NULL DEFAULT 0,
  revenue       NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (day, dining_option)
);

CREATE TABLE IF NOT EXISTS daily_payment_summary (
  day          DATE    NOT NULL,
  payment_name TEXT    NOT NULL,
  payment_type TEXT    NOT NULL DEFAULT '',
  transactions INTEGER NOT NULL DEFAULT 0,
  total        NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (day, payment_name, payment_type)
);

CREATE TABLE IF NOT EXISTS daily_item_summary (
  day       DATE    NOT NULL,
  sku       TEXT    NOT NULL DEFAULT '',
  item_name TEXT,
  qty       NUMERIC NOT NULL DEFAULT 0,
  revenue   NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (day, sku)
);

CREATE TABLE IF NOT EXISTS daily_hour_summary (
  day     DATE     NOT NULL,
  hour    SMALLINT NOT NULL,
  orders  INTEGER  NOT NULL DEFAULT 0,
  revenue NUMERIC  NOT NULL DEFAULT 0,
  PRIMARY KEY (day, hour)
);

CREATE TABLE IF NOT EXISTS daily_device_summary (
  day           DATE    NOT NULL,
  pos_device_id TEXT    NOT NULL DEFAULT '',
  device_name   TEXT,
  orders        INTEGER NOT NULL DEFAULT 0,
  revenue       NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (day, pos_device_id)
);

CREATE TABLE IF NOT EXISTS receipts_archive         (LIKE receipts         INCLUDING ALL);
CREATE TABLE IF NOT EXISTS receipt_items_archive    (LIKE receipt_items    INCLUDING ALL);
CREATE TABLE IF NOT EXISTS receipt_payments_archive (LIKE receipt_payments INCLUDING ALL);
