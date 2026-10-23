-- ============================================================
-- CollegeConnect Achievement Winners (award + note)
-- Idempotent, purely ADDITIVE migration.
--
-- Run by: node database/migrate-achievement-winners.js
--         (also auto-runs on server boot).
--
-- Why: the improved "Add Winner" flow records the award/position
-- (Winner, Runner-up, Third Place, ...) and an optional short note
-- for each winner. The existing `achievement_winners` table is
-- EXTENDED (no duplicate table, no rewrite, no drop). Both new
-- columns are nullable so every existing winner row keeps working
-- exactly as before.
--
-- Winner photos are NOT stored here: image bytes never go in the
-- database. Photos live on disk under /uploads/achievements/ and are
-- referenced by path in the existing `achievement_media` table, so the
-- winner's photo is simply the achievement's cover (first) photo.
-- ============================================================

BEGIN;

-- Award / position for this winner (same vocabulary as achievements.position).
ALTER TABLE achievement_winners ADD COLUMN IF NOT EXISTS position VARCHAR(15) NULL;

-- Optional short note about the win.
ALTER TABLE achievement_winners ADD COLUMN IF NOT EXISTS description TEXT NULL;

COMMIT;
