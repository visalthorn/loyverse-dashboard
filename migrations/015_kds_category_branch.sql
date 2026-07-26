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
ALTER TABLE kds_terminal_categories ADD CONSTRAINT kds_terminal_categories_branch_id_category_id_key UNIQUE (branch_id, category_id);

COMMIT;

-- Sanity check
SELECT COUNT(*) AS rows_missing_branch FROM kds_terminal_categories WHERE branch_id IS NULL;
