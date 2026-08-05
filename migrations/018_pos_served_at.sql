-- migrations/018_pos_served_at.sql
-- Adds a served_at milestone column to pos_orders, matching the existing
-- paid_at/cancelled_at per-milestone-timestamp convention on this table
-- (see migrations/008_pos_orders.sql). Written Cambodia-naive via
-- toCambodiaTime(), same as every other timestamp column here.
-- Idempotent: safe to run more than once.

BEGIN;

ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS served_at TIMESTAMP;

COMMIT;

-- Sanity check
SELECT column_name FROM information_schema.columns
WHERE table_name = 'pos_orders' AND column_name = 'served_at';
