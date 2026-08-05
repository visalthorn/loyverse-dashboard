-- migrations/015_kds_category_branch.sql
-- Revision 2: a category can belong to at most one KDS terminal per branch.
-- branch_id is denormalized onto kds_terminal_categories (same pattern as
-- pos_orders.branch_id in 009) so the UNIQUE constraint can be branch-scoped
-- without a join. No branch-reassignment endpoint exists for KDS terminals
-- today (routes/terminals.js only has toggle/reset-passcode), so there is no
-- code path that could let this denormalized copy drift out of sync -- if a
-- reassignment endpoint is ever added, it must also rewrite this branch_id
-- for that terminal's existing category rows in the same transaction.
--
-- Idempotent: safe to run more than once.

BEGIN;

ALTER TABLE kds_terminal_categories ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id);

UPDATE kds_terminal_categories ktc
SET branch_id = kt.branch_id
FROM kds_terminals kt
WHERE kt.id = ktc.kds_terminal_id AND ktc.branch_id IS NULL;

ALTER TABLE kds_terminal_categories ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE kds_terminal_categories DROP CONSTRAINT IF EXISTS kds_terminal_categories_kds_terminal_id_category_id_key;
ALTER TABLE kds_terminal_categories DROP CONSTRAINT IF EXISTS kds_terminal_categories_branch_id_category_id_key;

-- The OLD constraint UNIQUE(kds_terminal_id, category_id) legally allowed the
-- same category on two different KDS terminals in the same branch -- exactly
-- the misconfiguration this migration exists to forbid. Collapse any such
-- pre-existing duplicates deterministically (keep the lowest id) first,
-- otherwise ADD CONSTRAINT aborts the whole migration with a bare 23505 and
-- no indication of which rows are at fault. No-op where none exist.
DELETE FROM kds_terminal_categories a
USING kds_terminal_categories b
WHERE a.branch_id = b.branch_id AND a.category_id = b.category_id AND a.id > b.id;

ALTER TABLE kds_terminal_categories ADD CONSTRAINT kds_terminal_categories_branch_id_category_id_key UNIQUE (branch_id, category_id);

COMMIT;

-- Sanity check (both columns must be 0)
SELECT
  (SELECT COUNT(*) FROM kds_terminal_categories WHERE branch_id IS NULL) AS rows_missing_branch,
  (SELECT COALESCE(SUM(n - 1), 0) FROM (
     SELECT COUNT(*) AS n FROM kds_terminal_categories GROUP BY branch_id, category_id HAVING COUNT(*) > 1
   ) d) AS duplicate_rows_to_collapse;
