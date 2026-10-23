-- ============================================================
-- CollegeConnect Bulk Historical Import (provenance layer)
-- Idempotent migration: one ledger table + additive nullable
-- columns so imported records keep their original source.
--
-- Run by: node database/migrate-import.js (also auto-runs on server boot).
--
-- Design notes
--  * Purely ADDITIVE. Existing rows keep working: every new column is
--    nullable or has a DEFAULT, so no existing query or row changes.
--  * No existing table is rewritten or dropped. Records are imported into
--    the tables that already back each section of the site:
--      events       <- historical events, workshops/seminars, fests
--      announcements<- college announcements
--      achievements <- student and college achievements
--  * `source_url` and `academic_year` are stored verbatim from the CSV. The
--    importer never invents a URL or a date: blank cells stay NULL.
-- ============================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1) Import ledger. One row per committed import batch, so an admin can
--    see what was brought in, from which file, and undo-review it later.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_batches (
  id             SERIAL PRIMARY KEY,
  batch_ref      VARCHAR(24) NOT NULL UNIQUE,   -- IMP-2026-0001
  record_type    VARCHAR(20) NOT NULL CHECK (record_type IN (
                   'EVENTS', 'ANNOUNCEMENTS', 'ACHIEVEMENTS', 'WORKSHOPS', 'FESTS'
                 )),
  source_filename VARCHAR(255) NULL,            -- original uploaded file name
  source_url     VARCHAR(500) NULL,             -- batch-level origin, if given
  academic_year  VARCHAR(12) NULL,              -- e.g. 2023-24
  total_rows     INTEGER NOT NULL DEFAULT 0,
  imported_rows  INTEGER NOT NULL DEFAULT 0,
  duplicate_rows INTEGER NOT NULL DEFAULT 0,    -- skipped as already present
  skipped_rows   INTEGER NOT NULL DEFAULT 0,    -- unselected by the admin
  failed_rows    INTEGER NOT NULL DEFAULT 0,    -- rejected by validation
  imported_by    INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  notes          TEXT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ib_type ON import_batches (record_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ib_user ON import_batches (imported_by);

-- ---------------------------------------------------------------------
-- 2) Historical events (also carries workshops/seminars and fests, which
--    are events rows distinguished by their existing `category`).
-- ---------------------------------------------------------------------
ALTER TABLE events ADD COLUMN IF NOT EXISTS source_url      VARCHAR(500) NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS academic_year   VARCHAR(12)  NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_historical   SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN IF NOT EXISTS import_batch_id INTEGER NULL
  REFERENCES import_batches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_events_batch ON events (import_batch_id);
CREATE INDEX IF NOT EXISTS idx_events_historical ON events (is_historical, event_date);

-- ---------------------------------------------------------------------
-- 3) College announcements.
-- ---------------------------------------------------------------------
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS source_url      VARCHAR(500) NULL;
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS academic_year   VARCHAR(12)  NULL;
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS is_historical   SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS import_batch_id INTEGER NULL
  REFERENCES import_batches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ann_batch ON announcements (import_batch_id);

-- ---------------------------------------------------------------------
-- 4) Achievements. `achievement_year` already exists and stays the source
--    of truth for the year; academic_year is kept for the exact
--    "2023-24" style value when the CSV supplies one.
-- ---------------------------------------------------------------------
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS source_url      VARCHAR(500) NULL;
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS academic_year   VARCHAR(12)  NULL;
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS is_historical   SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS import_batch_id INTEGER NULL
    REFERENCES import_batches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ach_batch ON achievements (import_batch_id);

COMMIT;
