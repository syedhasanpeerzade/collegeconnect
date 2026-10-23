-- ============================================================
-- CollegeConnect Content Reporting + Moderation (Phase 4)
-- Idempotent migration: report tables, user shields, resolution log.
-- Run by: node database/migrate-reports.js (also auto-runs on server boot).
-- ============================================================

BEGIN;

-- 1) Post reports. A report is always against a post; if the post had a
--    reported comment, the comment_id is recorded for context (but the
--    moderation action is taken on the post).
CREATE TABLE IF NOT EXISTS post_reports (
  id          SERIAL PRIMARY KEY,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  comment_id  INTEGER NULL REFERENCES post_comments(id) ON DELETE SET NULL,
  reason      VARCHAR(30) NOT NULL CHECK (reason IN (
                'SPAM', 'HARASSMENT', 'HATE_SPEECH', 'VIOLENCE', 'MISINFO',
                'NDA_IMG', 'OTHER'
              )),
  detail      TEXT NULL,
  status      VARCHAR(15) NOT NULL DEFAULT 'PENDING'
              CHECK (status IN ('PENDING', 'UNDER_REVIEW', 'ADDRESSED', 'DISMISSED')),
  reviewed_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ NULL,
  action_note TEXT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (reporter_id, post_id, reason)
);
CREATE INDEX IF NOT EXISTS idx_pr_post ON post_reports (post_id);
CREATE INDEX IF NOT EXISTS idx_pr_status ON post_reports (status, created_at);

-- 2) Comment reports. Same shape, scoped to a comment.
CREATE TABLE IF NOT EXISTS comment_reports (
  id          SERIAL PRIMARY KEY,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comment_id  INTEGER NOT NULL REFERENCES post_comments(id) ON DELETE CASCADE,
  post_id     INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, -- for admin context
  reason      VARCHAR(30) NOT NULL CHECK (reason IN (
                'SPAM', 'HARASSMENT', 'HATE_SPEECH', 'VIOLENCE', 'MISINFO',
                'NDA_IMG', 'OTHER'
              )),
  detail      TEXT NULL,
  status      VARCHAR(15) NOT NULL DEFAULT 'PENDING'
              CHECK (status IN ('PENDING', 'UNDER_REVIEW', 'ADDRESSED', 'DISMISSED')),
  reviewed_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ NULL,
  action_note TEXT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (reporter_id, comment_id, reason)
);
CREATE INDEX IF NOT EXISTS idx_cr_comment ON comment_reports (comment_id);
CREATE INDEX IF NOT EXISTS idx_cr_status ON comment_reports (status, created_at);

-- 3) User reports (harassment / abusive account). Independent of any post.
CREATE TABLE IF NOT EXISTS user_reports (
  id          SERIAL PRIMARY KEY,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      VARCHAR(30) NOT NULL CHECK (reason IN (
                'HARASSMENT', 'HATE_SPEECH', 'IMPERSONATION', 'SCAM', 'OTHER'
              )),
  detail      TEXT NULL,
  status      VARCHAR(15) NOT NULL DEFAULT 'PENDING'
              CHECK (status IN ('PENDING', 'UNDER_REVIEW', 'ADDRESSED', 'DISMISSED')),
  reviewed_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ NULL,
  action_note TEXT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (reporter_id, target_id, reason)
);
CREATE INDEX IF NOT EXISTS idx_ur_target ON user_reports (target_id);
CREATE INDEX IF NOT EXISTS idx_ur_status ON user_reports (status, created_at);

-- 4) Moderation action log: every admin action on reported content is recorded
--    here for audit. Covers posts, comments, and users. The source table is
--    recorded so admins can filter by "what was this about".
CREATE TABLE IF NOT EXISTS moderation_log (
  id          SERIAL PRIMARY KEY,
  acted_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  table_name  VARCHAR(20) NOT NULL CHECK (table_name IN ('posts', 'post_comments', 'users')),
  record_id   INTEGER NOT NULL,
  action      VARCHAR(20) NOT NULL CHECK (action IN (
                'HIDE', 'UNHIDE', 'DELETE', 'RESTORE', 'FLAG_USER',
                'UNFLAG_USER', 'NOTE'
              )),
  report_id   INTEGER NULL, -- if the action was in response to a specific report
  reason      TEXT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ml_table ON moderation_log (table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_ml_reporter ON moderation_log (acted_by);

-- 5) Per-content "shield" flags set by moderation. Used to soft-hide content
--    pending review WITHOUT deleting it. Once a post/comment is shielded, the
--    UI omits it from feeds/threads for everyone except the author (who sees
--    a generic notice) and admins.
CREATE TABLE IF NOT EXISTS content_shield (
  id          SERIAL PRIMARY KEY,
  table_name  VARCHAR(20) NOT NULL CHECK (table_name IN ('posts', 'post_comments')),
  record_id   INTEGER NOT NULL,
  reason      VARCHAR(40) NOT NULL CHECK (reason IN (
                'AUTOMATIC', 'MANUAL_PENDING', 'ADDRESSED_HIDE', 'REJECTED'
              )),
  set_by      VARCHAR(20) NOT NULL CHECK (set_by IN ('SYSTEM', 'ADMIN')),
  note        TEXT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (table_name, record_id)
);
CREATE INDEX IF NOT EXISTS idx_cs_table ON content_shield (table_name, record_id);

-- 6) User shield: a user flagged for review. Their future posts/comments are
--    automatically shielded (soft-hidden) until an admin clears it. This is
--    the harassment safeguard that stops a bad actor from continuing to post.
CREATE TABLE IF NOT EXISTS user_shield (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      VARCHAR(40) NOT NULL CHECK (reason IN (
                'AUTOMATIC', 'MANUAL_PENDING', 'CLEARED'
              )),
  set_by      VARCHAR(20) NOT NULL CHECK (set_by IN ('SYSTEM', 'ADMIN')),
  note        TEXT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id)
);
CREATE INDEX IF NOT EXISTS idx_us_user ON user_shield (user_id);

-- 7) Rate-limit counters for harassment-prone actions. Tracked per-user, reset
--    by cron/cleanup. When a counter crosses a threshold, the system auto-shields
--    the user and their next post/comment is held for review instead of published.
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key         VARCHAR(30) NOT NULL CHECK (key IN (
                'like_per_hour', 'dislike_per_hour', 'comment_per_hour',
                'reply_per_hour', 'follow_per_hour', 'report_per_hour'
              )),
  count       INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  window_start TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_rlc_user ON rate_limit_counters (user_id, key);

COMMIT;
