-- migrations/014_pos_receipts_views.sql
-- Revision 1 follow-up: repoint the v_*_all views from pos_orders onto the
-- new immutable pos_receipts tables (013). Still strictly read-only on
-- receipts/receipt_items/receipt_payments. branch_id no longer needs a
-- pos_devices subquery on the OWN_POS side -- pos_receipts.branch_id is
-- already denormalized at completion time.
--
-- receipt_type stays hardcoded 'SALE' for every OWN_POS row, including
-- refund-copy rows with cancelled_at set -- same reasoning as migrations/010:
-- a cancelled SALE row matches neither branch of the revenue formula
-- (receipt_type='SALE' AND cancelled_at IS NULL) OR
-- (receipt_type='REFUND' AND cancelled_at IS NOT NULL)
-- so it's excluded from revenue while still visible to cancelled_at IS NOT NULL
-- queries (the cancelled/refund panel).
--
-- Idempotent: CREATE OR REPLACE VIEW is safe to run more than once.

BEGIN;

CREATE OR REPLACE VIEW v_receipts_all AS
SELECT
  r.receipt_number, r.receipt_type, r.source, r.dining_option, r.total_money,
  r.receipt_date, r.created_at, r.cancelled_at, r.store_id, r.pos_device_id,
  r.employee_id,
  (SELECT pd.branch_id FROM pos_devices pd WHERE pd.id::varchar = r.pos_device_id) AS branch_id
FROM receipts r

UNION ALL

SELECT
  pr.receipt_number,
  'SALE'                            AS receipt_type,
  'OWN_POS'                         AS source,
  pr.dining_option,
  pr.total                          AS total_money,
  pr.receipt_date,
  pr.created_at,
  pr.cancelled_at,
  NULL::varchar                     AS store_id,
  NULL::varchar                     AS pos_device_id,
  pr.created_by                     AS employee_id,
  pr.branch_id
FROM pos_receipts pr;

CREATE OR REPLACE VIEW v_receipt_items_all AS
SELECT ri.receipt_number, ri.sku, ri.item_name, ri.quantity, ri.price, ri.gross_total
FROM receipt_items ri

UNION ALL

SELECT pr.receipt_number, pri.sku, pri.item_name, pri.quantity, pri.price, pri.gross_total
FROM pos_receipt_items pri
JOIN pos_receipts pr ON pr.id = pri.receipt_id;

CREATE OR REPLACE VIEW v_receipt_payments_all AS
SELECT rp.receipt_number, rp.payment_type_id, rp.payment_name, rp.payment_type, rp.money_amount, rp.paid_at, rp.created_at
FROM receipt_payments rp

UNION ALL

SELECT pr.receipt_number, NULL::varchar AS payment_type_id, prp.payment_name, prp.payment_type::varchar AS payment_type,
       prp.money_amount, prp.paid_at, prp.paid_at AS created_at
FROM pos_receipt_payments prp
JOIN pos_receipts pr ON pr.id = prp.receipt_id;

COMMIT;

-- Sanity check
SELECT
  (SELECT COUNT(*) FROM v_receipts_all)         AS v_receipts_all_count,
  (SELECT COUNT(*) FROM v_receipt_items_all)    AS v_receipt_items_all_count,
  (SELECT COUNT(*) FROM v_receipt_payments_all) AS v_receipt_payments_all_count;
