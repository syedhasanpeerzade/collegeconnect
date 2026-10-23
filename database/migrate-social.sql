-- ============================================================
-- CollegeConnect Social Layer (Phase 1)
-- Idempotent migration: account_type/verified + social tables.
-- Run by: node database/migrate-social.js (also auto-runs on server boot).
-- ============================================================

BEGIN;

-- 1) Social identity on users: account_type + verification are BACKEND-ONLY.
--    Students can never set these; only admins (server-enforced).
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type VARCHAR(10) NOT NULL DEFAULT 'student'
  CHECK (account_type IN ('student', 'college', 'club', 'admin'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified SMALLINT NOT NULL DEFAULT 0;

-- Backfill from existing roles. Only ADMIN maps onto a social account type:
-- a FACULTY member is campus staff, NOT an official college account, and a
-- CLUB_COORDINATOR is not a verified club account. Official identity is
-- granted through verification (admin-approved), never inferred from a role.
UPDATE users SET account_type = 'admin' WHERE role = 'ADMIN' AND account_type <> 'admin';

-- Repair the earlier (incorrect) role->account_type backfill: an unverified
-- account can never be an official account type.
UPDATE users SET account_type = 'student'
WHERE account_type IN ('college', 'club') AND verified = 0;

-- Public profile fields
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_path VARCHAR(255) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS cover_path VARCHAR(255) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS skills TEXT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS projects TEXT NULL;

-- 2) Verification requests (admins approve; only admins change `verified`)
CREATE TABLE IF NOT EXISTS verification_requests (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_type  VARCHAR(10) NOT NULL CHECK (account_type IN ('college', 'club')),
  org_name      VARCHAR(160) NOT NULL,
  org_details   TEXT NULL,
  status        VARCHAR(15) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  reviewed_by   INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vr_status ON verification_requests (status);

-- 3) Posts (text/image/video, anonymous, poll linkage, community linkage)
CREATE TABLE IF NOT EXISTS posts (
  id             SERIAL PRIMARY KEY,
  author_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           VARCHAR(10) NOT NULL DEFAULT 'POST' CHECK (kind IN ('POST','QUESTION','POLL')),
  title          VARCHAR(200) NULL,
  content        TEXT NOT NULL,
  is_anonymous   SMALLINT NOT NULL DEFAULT 0,
  community_id   INTEGER NULL,             -- FK added after communities exist
  image_path     VARCHAR(255) NULL,
  video_path     VARCHAR(255) NULL,
  poll_question  VARCHAR(300) NULL,
  official       SMALLINT NOT NULL DEFAULT 0, -- server-set: author is verified college/club
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts (author_id);
CREATE INDEX IF NOT EXISTS idx_posts_kind ON posts (kind);
CREATE INDEX IF NOT EXISTS idx_posts_official ON posts (official);

-- 4) Poll options + votes
CREATE TABLE IF NOT EXISTS poll_options (
  id         SERIAL PRIMARY KEY,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  label      VARCHAR(120) NOT NULL,
  position   SMALLINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_poll_options_post ON poll_options (post_id, position);

CREATE TABLE IF NOT EXISTS poll_votes (
  id         SERIAL PRIMARY KEY,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  option_id  INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_votes_post ON poll_votes (post_id);

-- 5) Comments (posts + replies, votes on questions-style comments)
CREATE TABLE IF NOT EXISTS post_comments (
  id           SERIAL PRIMARY KEY,
  post_id      INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id    INTEGER NULL,
  content      TEXT NOT NULL,
  is_anonymous SMALLINT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pc_post ON post_comments (post_id, created_at);

-- 6) Reactions (like/dislike on posts and comments) — "likes"
CREATE TABLE IF NOT EXISTS reactions (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type VARCHAR(10) NOT NULL CHECK (target_type IN ('POST','COMMENT')),
  target_id  INTEGER NOT NULL,
  value      SMALLINT NOT NULL DEFAULT 1 CHECK (value IN (-1, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_reactions_target ON reactions (target_type, target_id);

-- 7) Follows
CREATE TABLE IF NOT EXISTS follows (
  id          SERIAL PRIMARY KEY,
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows (followee_id);

-- 8) Saved posts (bookmarks)
CREATE TABLE IF NOT EXISTS saved_posts (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, post_id)
);

-- 9) Communities
CREATE TABLE IF NOT EXISTS communities (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  slug        VARCHAR(140) NOT NULL UNIQUE,
  description TEXT NULL,
  cover_path  VARCHAR(255) NULL,
  created_by  INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  is_official SMALLINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS community_members (
  id            SERIAL PRIMARY KEY,
  community_id  INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          VARCHAR(10) NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('MEMBER','MODERATOR')),
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (community_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_cm_community ON community_members (community_id);

-- Phase 2: link a community to a department and/or club so its page can show
-- department/club events. Idempotent column adds.
ALTER TABLE communities ADD COLUMN IF NOT EXISTS department_id INTEGER NULL REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE communities ADD COLUMN IF NOT EXISTS club_id INTEGER NULL REFERENCES clubs(id) ON DELETE SET NULL;

-- Backfill department links for the seeded department communities.
UPDATE communities c SET department_id = d.id
FROM departments d
WHERE c.department_id IS NULL
  AND LOWER(d.code) = LOWER(c.slug);

UPDATE communities c SET department_id = m.dept_id
FROM (VALUES ('mechanical', 3)) AS m(slug, dept_id)
WHERE c.department_id IS NULL AND c.slug = m.slug
  AND EXISTS (SELECT 1 FROM departments d WHERE d.id = m.dept_id);

-- The Coding community follows the campus coding club's events.
UPDATE communities c SET club_id = cl.id
FROM clubs cl
WHERE c.club_id IS NULL AND c.slug = 'coding' AND cl.id = 1;

-- posts.community_id FK now that communities exists
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_posts_community') THEN
    ALTER TABLE posts ADD CONSTRAINT fk_posts_community
      FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 10) Communities seed (the 14 default communities) - idempotent
INSERT INTO communities (name, slug, description, is_official)
SELECT v.name, v.slug, v.description, 1
FROM (VALUES
  ('CSE', 'cse', 'Computer Science students - assignments, hackathons, tech talk.', 1),
  ('ECE', 'ece', 'Electronics & Communication - circuits, embedded, signals.', 1),
  ('Mechanical', 'mechanical', 'Mechanical engineering - design, CAD, robotics.', 1),
  ('Civil', 'civil', 'Civil engineering - structures, surveying, construction.', 1),
  ('First Year', 'first-year', 'Freshmen zone - orientation, notes, making friends.', 0),
  ('Second Year', 'second-year', 'Sophomore year discussions and shared resources.', 0),
  ('Third Year', 'third-year', 'Junior year - internships, projects, electives.', 0),
  ('Final Year', 'final-year', 'Placement season, finals, future plans.', 0),
  ('Coding', 'coding', 'Code together: contests, open source, language wars.', 0),
  ('Sports', 'sports', 'Matches, fixtures, practice sessions, fantasy leagues.', 0),
  ('Photography', 'photography', 'Campus frames, photo walks, editing tips.', 0),
  ('Gaming', 'gaming', 'Tournaments, LAN parties, new releases.', 0),
  ('Cultural', 'cultural', 'Fests, dance, music, drama, art.', 0),
  ('Placement Preparation', 'placement-preparation', 'Interview experiences, DSA grind, resume reviews.', 0)
) AS v(name, slug, description, is_official)
WHERE NOT EXISTS (SELECT 1 FROM communities c WHERE c.slug = v.slug);

-- 9b) Phase 2: reviewer note on verification requests.
ALTER TABLE verification_requests ADD COLUMN IF NOT EXISTS review_note TEXT NULL;

-- 10b) Event social signals (Phase 2): "Interested" alongside existing registration ("Going").
CREATE TABLE IF NOT EXISTS event_interests (
  id         SERIAL PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_ei_event ON event_interests (event_id);

-- 10d) Stories were removed from the product (a 24-hour ephemeral section that
--      duplicated the feed). No tables are created here. If an older database
--      still has the legacy `stories` / `story_views` tables, they are left
--      untouched (no data is deleted) and are simply unused.

-- 10e) Official accounts (Phase 2 demo data). Password for all: Password@123
--      seed.sql leaves users_id_seq one behind (setval to 4 while id 5 exists),
--      so resync it before inserting anything new.
SELECT setval('users_id_seq', GREATEST((SELECT COALESCE(MAX(id), 1) FROM users), (SELECT last_value FROM users_id_seq)));
--      These are the verified college + club accounts that publish OFFICIAL content.
INSERT INTO users (role, full_name, email, phone, password_hash, account_type, verified, bio)
SELECT 'FACULTY', 'Anjuman Institute of Technology and Management', 'college@collegeconnect.com', '9900000010',
       '$2a$10$qRrwLHoVa.LiOgUERZMDauZpHfMrXOPvR1r4SAfSJbQSUIgksSCu2', 'college', 1,
       'Official account of Anjuman Institute of Technology and Management. Announcements, academic notices and placement updates.'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'college@collegeconnect.com');

INSERT INTO users (role, full_name, email, phone, password_hash, account_type, verified, bio)
SELECT 'ORGANIZER', 'Coding Club', 'codingclub@collegeconnect.com', '9900000011',
       '$2a$10$qRrwLHoVa.LiOgUERZMDauZpHfMrXOPvR1r4SAfSJbQSUIgksSCu2', 'club', 1,
       'The campus Coding Club - contests, workshops, open source and weekly build sessions.'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'codingclub@collegeconnect.com');

INSERT INTO users (role, full_name, email, phone, password_hash, account_type, verified, bio)
SELECT 'ORGANIZER', 'Cultural Committee', 'cultural@collegeconnect.com', '9900000012',
       '$2a$10$qRrwLHoVa.LiOgUERZMDauZpHfMrXOPvR1r4SAfSJbQSUIgksSCu2', 'club', 1,
       'Fests, dance, music and drama - the official Cultural Committee account.'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'cultural@collegeconnect.com');

-- Keep the seeded official accounts official (and never touch the ADMIN row).
UPDATE users SET account_type = 'college', verified = 1
WHERE email = 'college@collegeconnect.com' AND role <> 'ADMIN';
UPDATE users SET account_type = 'club', verified = 1
WHERE email IN ('codingclub@collegeconnect.com', 'cultural@collegeconnect.com') AND role <> 'ADMIN';

-- The Coding community is owned by the Coding Club account.
UPDATE communities c SET created_by = u.id, club_id = NULL
FROM users u
WHERE u.email = 'codingclub@collegeconnect.com' AND c.slug = 'coding' AND c.created_by IS NULL;

-- Keep the stored `official` flag consistent with each author's current
-- identity, so revoking verification also demotes that account's content.
UPDATE posts p SET official = CASE WHEN u.account_type IN ('college','club') AND u.verified = 1 THEN 1 ELSE 0 END
FROM users u WHERE u.id = p.author_id AND p.official <> CASE WHEN u.account_type IN ('college','club') AND u.verified = 1 THEN 1 ELSE 0 END;

-- Official welcome posts from the verified accounts (idempotent).
INSERT INTO posts (author_id, kind, content, official, community_id, created_at)
SELECT u.id, 'POST',
  'Orientation week schedule is now live. Check the Announcements tab for the full day-wise plan, hostel reporting times and the bus routes for first-year students.',
  1, NULL, NOW() - INTERVAL '3 hours'
FROM users u WHERE u.email = 'college@collegeconnect.com'
  AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.author_id = u.id AND p.official = 1);

INSERT INTO posts (author_id, kind, title, content, official, community_id, created_at)
SELECT u.id, 'POLL', 'Which language should the Coding Club teach this semester?',
  'Vote for the language you want in the weekly Coding Club sessions. Highest votes set the curriculum.',
  1, (SELECT id FROM communities WHERE slug = 'coding'), NOW() - INTERVAL '90 minutes'
FROM users u WHERE u.email = 'codingclub@collegeconnect.com'
  AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.author_id = u.id AND p.kind = 'POLL');

-- Poll options for that seeded poll (only when it has none).
INSERT INTO poll_options (post_id, label, position)
SELECT p.id, v.label, v.position
FROM posts p
JOIN users u ON u.id = p.author_id
CROSS JOIN (VALUES ('Python', 1), ('Java', 2), ('C++', 3), ('JavaScript', 4)) AS v(label, position)
WHERE u.email = 'codingclub@collegeconnect.com' AND p.kind = 'POLL'
  AND NOT EXISTS (SELECT 1 FROM poll_options o WHERE o.post_id = p.id);

-- 11) Demo content so the feed is alive immediately (idempotent-ish)
INSERT INTO posts (author_id, kind, title, content, official, created_at)
SELECT 2, 'POST', NULL,
  'Welcome to the new College Connect social feed! Official updates from the college will appear here with the ✓ OFFICIAL badge. Students: create your first post and say hi!',
  1, NOW() - INTERVAL '10 minutes'
WHERE NOT EXISTS (SELECT 1 FROM posts WHERE official = 1 AND content LIKE 'Welcome to the new College Connect social feed%');

INSERT INTO post_comments (post_id, author_id, content, created_at)
SELECT p.id, 3, 'Looking forward to this!', NOW() - INTERVAL '8 minutes'
FROM posts p
WHERE p.official = 1 AND p.content LIKE 'Welcome to the new College Connect social feed%'
  AND NOT EXISTS (SELECT 1 FROM post_comments c WHERE c.post_id = p.id);

COMMIT;
