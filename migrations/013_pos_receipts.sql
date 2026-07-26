-- migrations/013_pos_receipts.sql
-- Phase 8 (Revision 1): immutable financial record, split from the mutable
-- pos_orders operational table. Written ONCE at order completion inside the
-- same transaction as the pay/complete endpoint -- never UPDATEd afterward.
-- A refund is a brand-new row (see routes/receipts.js POST /:id/refund),
-- never a mutation of an existing row.
--
-- Same Cambodia-local timestamp convention as pos_orders (008): receipt_date/
-- cancelled_at/created_at here are written by toCambodiaTime(), not raw
-- Postgres NOW() -- DEFAULT NOW() on created_at is a non-null fallback only.
--
-- Idempotent: safe to run more than once.

BEGIN;

CREATE TABLE IF NOT EXISTS pos_receipts (
  id              SERIAL PRIMARY KEY,
  receipt_number  VARCHAR(20) UNIQUE NOT NULL,
  -- POS-YYMMDD-#### issued HERE at completion time (own counter, separate
  -- from pos_orders.order_number's counter -- see services/pos/receiptNumber.js).
  order_id        INT NOT NULL REFERENCES pos_orders(id),
  branch_id       INT NOT NULL REFERENCES branches(id),
  pos_terminal_id INT REFERENCES pos_terminals(id),
  -- NULL for a dashboard-issued refund row (no POS terminal involved).
  dining_option   VARCHAR(50) NOT NULL,
  subtotal        NUMERIC(12,0) NOT NULL,
  discount        NUMERIC(12,0) NOT NULL,
  total           NUMERIC(12,0) NOT NULL,
  receipt_date    TIMESTAMP NOT NULL,
  cancelled_at    TIMESTAMP NULL,
  -- A refund is its own row with cancelled_at set (mirrors Loyverse) --
  -- the original SALE row it refers back to via order_id is never touched.
  cancel_reason   TEXT,
  created_by      VARCHAR(50),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pos_receipt_items (
  id           SERIAL PRIMARY KEY,
  receipt_id   INT NOT NULL REFERENCES pos_receipts(id) ON DELETE RESTRICT,
  sku          TEXT,
  item_name    TEXT NOT NULL,
  quantity     INT NOT NULL,
  price        NUMERIC(12,0) NOT NULL,
  gross_total  NUMERIC(12,0) NOT NULL
);

CREATE TABLE IF NOT EXISTS pos_receipt_payments (
  id            SERIAL PRIMARY KEY,
  receipt_id    INT NOT NULL REFERENCES pos_receipts(id) ON DELETE RESTRICT,
  payment_name  VARCHAR(50),
  payment_type  VARCHAR(50),
  money_amount  NUMERIC(12,0) NOT NULL,
  paid_at       TIMESTAMP NOT NULL
);

-- Back-reference from the operational row to the financial record generated
-- when it completed. NULL until the order is paid.
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS receipt_id INT REFERENCES pos_receipts(id);

CREATE INDEX IF NOT EXISTS idx_pos_receipts_branch_id    ON pos_receipts(branch_id);
CREATE INDEX IF NOT EXISTS idx_pos_receipts_receipt_date ON pos_receipts(receipt_date);
CREATE INDEX IF NOT EXISTS idx_pos_receipts_order_id     ON pos_receipts(order_id);
CREATE INDEX IF NOT EXISTS idx_pos_receipt_items_receipt_id    ON pos_receipt_items(receipt_id);
CREATE INDEX IF NOT EXISTS idx_pos_receipt_payments_receipt_id ON pos_receipt_payments(receipt_id);

COMMIT;

-- Sanity check
SELECT
  (SELECT COUNT(*) FROM pos_receipts)         AS pos_receipts_count,
  (SELECT COUNT(*) FROM pos_receipt_items)    AS pos_receipt_items_count,
  (SELECT COUNT(*) FROM pos_receipt_payments) AS pos_receipt_payments_count;
