-- Expand table_number column to support longer table identifiers.
-- Task 1: require and dedupe table # for dine-in orders on create.

BEGIN;

ALTER TABLE pos_orders
  ALTER COLUMN table_number TYPE VARCHAR(20);

COMMIT;

-- Sanity check
SELECT
  (SELECT COUNT(*) FROM pos_orders) AS pos_orders_count;
