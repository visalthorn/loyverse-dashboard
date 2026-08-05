-- migrations/017_kds_display_settings.sql
-- One global row backing the KDS order-card color thresholds (Good/Warning/
-- Late), configurable from the dashboard's Branches page. Deliberately a
-- single row, not per-branch -- confirmed as a global setting, not a
-- per-branch override. Idempotent: safe to run more than once.

BEGIN;

CREATE TABLE IF NOT EXISTS kds_display_settings (
  id SERIAL PRIMARY KEY,
  warn_minutes INT NOT NULL DEFAULT 10,
  danger_minutes INT NOT NULL DEFAULT 20,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO kds_display_settings (warn_minutes, danger_minutes)
SELECT 10, 20
WHERE NOT EXISTS (SELECT 1 FROM kds_display_settings);

COMMIT;

-- Sanity check
SELECT COUNT(*) AS kds_display_settings_count FROM kds_display_settings;
