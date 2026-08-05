-- migrations/019_expand_table_number.sql
-- Expand table_number column to support longer table identifiers.
-- Task 1: require and dedupe table # for dine-in orders on create.
--
-- MUST RUN BEFORE THIS BRANCH'S CODE IS DEPLOYED. The app's own validation
-- (routes/pos.js) already allows table_number up to 20 characters, but on an
-- un-migrated database the column is still VARCHAR(10). Deploying the code
-- before this migration means any dine-in order with an 11-20 character
-- table number throws a Postgres error that surfaces as a bare 500 to the
-- cashier.
-- Idempotent: re-running ALTER COLUMN ... TYPE VARCHAR(20) when the column
-- is already VARCHAR(20) is a safe no-op in Postgres.

BEGIN;

ALTER TABLE pos_orders
  ALTER COLUMN table_number TYPE VARCHAR(20);

COMMIT;

-- Sanity check: confirm the column really is VARCHAR(20)
SELECT column_name, character_maximum_length
FROM information_schema.columns
WHERE table_name = 'pos_orders' AND column_name = 'table_number'
  AND character_maximum_length = 20;
