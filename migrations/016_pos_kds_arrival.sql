-- migrations/016_pos_kds_arrival.sql
-- The KDS elapsed-time watch needs the moment an order actually entered the
-- kitchen, not pos_orders.created_at -- an order can sit as 'open' (saved,
-- not yet sent) for a while before send-to-kitchen, and updated_at is
-- already reused by unrelated mutations (e.g. appending items) that happen
-- while still 'open'. Set once, in send-to-kitchen, never touched again.
-- Idempotent: safe to run more than once.

BEGIN;

ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS sent_to_kitchen_at TIMESTAMP;

COMMIT;

-- Sanity check
SELECT COUNT(*) AS pos_orders_count FROM pos_orders;
