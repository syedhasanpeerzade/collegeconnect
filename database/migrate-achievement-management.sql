-- ============================================================
-- CollegeConnect Achievement Management Feature
-- Idempotent, purely ADDITIVE migration.
--
-- Run by: node database/migrate-achievement-management.js
--         (also auto-runs on server boot, before the app boots).
--
-- Why:
--   The new ADMIN ACHIEVEMENT MANAGEMENT feature reuses the existing
--   `achievements` table and adds a set of descriptive + reference
--   columns that the old result form did not capture. Every existing
--   achievement row keeps working unchanged; new admin-edited fields
--   are stored in these columns so nothing is lost.
--
--   The migration also adds a lightweight `achievement_stats` helper
--   view used by the frontend to display total/verified counts.
-- ============================================================

BEGIN;

-- 1) Administrative / descriptive columns for the achievement record.
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS description_text TEXT NULL;
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS prize_details TEXT NULL;
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS event_venue VARCHAR(200) NULL;
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS competitive_event VARCHAR(200) NULL;
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS team_members TEXT NULL;

-- 2) Reference / foreign keys (nullable, so existing rows are unaffected).
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS organizing_club_id INTEGER REFERENCES clubs(id) ON DELETE SET NULL;

-- 3) Backfill: mirror the closest existing data where possible.
--    description -> description_text
UPDATE achievements SET description_text = description WHERE description_text IS NULL AND description IS NOT NULL;

-- 4) Achievement categories are the same vocabulary as events: map them
--    so the old rows are still meaningful.
UPDATE achievements SET competitive_event = competition_name WHERE competitive_event IS NULL AND competition_name IS NOT NULL;

-- 5) achievement_stats helper view for the admin toolbar.
DROP VIEW IF EXISTS achievement_stats;

CREATE VIEW achievement_stats AS
SELECT
  COUNT(*)::int AS total,
  COALESCE(SUM(CASE WHEN a.verification_status = 'VERIFIED' THEN 1 ELSE 0 END), 0)::int AS verified,
  COALESCE(SUM(CASE WHEN a.verification_status = 'PENDING_VERIFICATION' THEN 1 ELSE 0 END), 0)::int AS pending_verification,
  COALESCE(SUM(CASE WHEN a.verification_status = 'REJECTED' THEN 1 ELSE 0 END), 0)::int AS rejected,
  COALESCE(SUM(CASE WHEN a.is_archived = 1 THEN 1 ELSE 0 END), 0)::int AS archived,
  COALESCE((
    SELECT COUNT(*) FROM achievements
    WHERE is_archived = 0 AND verification_status = 'VERIFIED'
  ), 0)::int AS hall_of_fame_active
FROM achievements a;

COMMIT;
