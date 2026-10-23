-- ============================================================================
-- CollegeConnect - migration: personalized interests + priority notifications
--
-- Idempotent. Run once per environment:
--   node database/migrate-interests.js
-- Also applied automatically on server startup (server/server.js).
-- ============================================================================
DO $$
BEGIN
  -- users.interests_configured flag (first-login onboarding)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'users' AND column_name = 'interests_configured') THEN
    ALTER TABLE users ADD COLUMN interests_configured SMALLINT NOT NULL DEFAULT 0;
  END IF;

  -- notifications.priority: 1 = personalized/interest-matched notification
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'notifications' AND column_name = 'priority') THEN
    ALTER TABLE notifications ADD COLUMN priority SMALLINT NOT NULL DEFAULT 0;
  END IF;

  -- notifications.dedupe_key: groups related notifications (e.g. same event)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'notifications' AND column_name = 'dedupe_key') THEN
    ALTER TABLE notifications ADD COLUMN dedupe_key VARCHAR(80) NULL;
  END IF;
END $$;

-- One notification per (recipient, dedupe key) so repeat fan-outs never spam.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_recipient_dedupe_key_key') THEN
    ALTER TABLE notifications ADD CONSTRAINT notifications_recipient_dedupe_key_key
      UNIQUE (recipient_id, dedupe_key);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS student_interests (
  id          SERIAL PRIMARY KEY,
  student_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  interest_key VARCHAR(30) NOT NULL
              CHECK (interest_key IN ('SPORTS','TECH','CLUB_EVENT','CULTURAL','ARTS','TECH_AI','ACADEMIC','CAREER','WORKSHOP_SEMINAR','OTHER')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (student_id, interest_key)
);
CREATE INDEX IF NOT EXISTS idx_student_interests_student ON student_interests (student_id);
CREATE INDEX IF NOT EXISTS idx_student_interests_key     ON student_interests (interest_key);
-- Event proposal objectives ("Apply to Organize an Event" workflow)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'event_requests' AND column_name = 'objectives') THEN
    ALTER TABLE event_requests ADD COLUMN objectives TEXT NULL;
  END IF;
END $$;

-- Achievements: event_date for result entries + extra positions
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'achievements' AND column_name = 'event_date') THEN
    ALTER TABLE achievements ADD COLUMN event_date DATE NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'achievements_position_check') THEN
    ALTER TABLE achievements DROP CONSTRAINT IF EXISTS achievements_position_check;
    ALTER TABLE achievements ADD CONSTRAINT achievements_position_check
      CHECK (position IN ('1ST_PLACE','2ND_PLACE','3RD_PLACE','WINNER','RUNNER_UP','FINALIST','PARTICIPATION','OTHER'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_notif_priority            ON notifications (recipient_id, priority, is_read, created_at DESC);
