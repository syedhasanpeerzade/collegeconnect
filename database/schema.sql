-- =====================================================================
-- CollegeConnect - Database Schema (PostgreSQL / Supabase)
-- One Platform for Your Campus
--
-- Usage (with a Supabase connection string in .env):
--   npm run db:init     -> applies database/schema.sql
--   npm run db:seed     -> loads demo data (database/seed.sql)
--
-- Requires PostgreSQL 13+. Boolean-ish columns are SMALLINT 0/1 to
-- match application SQL (is_active = 1, is_read = 0, ...).
-- =====================================================================

DROP TABLE IF EXISTS achievement_media, achievement_winners, achievements,
  club_application_answers, club_custom_questions, club_applications, club_members, club_coordinators, clubs,
  event_registrations, event_request_history, event_requests, events,
  complaint_updates, complaints, notifications, announcements, users, departments
CASCADE;

-- ---------------------------------------------------------------------
-- Departments
-- ---------------------------------------------------------------------
CREATE TABLE departments (
  id          SERIAL PRIMARY KEY,
  code        VARCHAR(16)  NOT NULL UNIQUE,
  name        VARCHAR(120) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------
-- Users (students, organizers, coordinators, faculty, admins)
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id                     SERIAL PRIMARY KEY,
  role                   VARCHAR(20) NOT NULL DEFAULT 'STUDENT'
                         CHECK (role IN ('STUDENT','ORGANIZER','CLUB_COORDINATOR','FACULTY','ADMIN')),
  full_name              VARCHAR(120) NOT NULL,
  student_id             VARCHAR(40)  NULL UNIQUE,
  email                  VARCHAR(160) NOT NULL UNIQUE,
  phone                  VARCHAR(20)  NOT NULL,
  password_hash          VARCHAR(100) NOT NULL,
  department_id          INTEGER NULL REFERENCES departments(id) ON DELETE SET NULL,
  year                   SMALLINT NULL CHECK (year IS NULL OR year BETWEEN 1 AND 5),
  is_active              SMALLINT NOT NULL DEFAULT 1,
  password_reset_token   VARCHAR(64) NULL,
  password_reset_expires TIMESTAMPTZ NULL,
  last_login_at          TIMESTAMPTZ NULL,
  interests_configured   SMALLINT NOT NULL DEFAULT 0,  -- 1 once the student saved/skipped interest onboarding
  created_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_users_role       ON users (role);
CREATE INDEX idx_users_department ON users (department_id);
CREATE INDEX idx_users_active     ON users (is_active);

-- ---------------------------------------------------------------------
-- Student event interests (personalization)
-- One row per selected interest; INTEREST_KEYS drive the onboarding UI
-- and the mapping to event categories (see server/services/interestService.js).
-- ---------------------------------------------------------------------
CREATE TABLE student_interests (
  id          SERIAL PRIMARY KEY,
  student_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  interest_key VARCHAR(30) NOT NULL
              CHECK (interest_key IN ('SPORTS','TECH','CLUB_EVENT','CULTURAL','ARTS','TECH_AI','ACADEMIC','CAREER','WORKSHOP_SEMINAR','OTHER')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (student_id, interest_key)
);
CREATE INDEX idx_student_interests_student ON student_interests (student_id);
CREATE INDEX idx_student_interests_key     ON student_interests (interest_key);

-- ---------------------------------------------------------------------
-- Clubs
-- ---------------------------------------------------------------------
CREATE TABLE clubs (
  id                     SERIAL PRIMARY KEY,
  name                   VARCHAR(120) NOT NULL UNIQUE,
  category               VARCHAR(20) NOT NULL
                         CHECK (category IN ('TECHNICAL','CULTURAL','SPORTS','ACADEMIC','SOCIAL_SERVICE','OTHER')),
  description            TEXT NOT NULL,
  objectives             TEXT NULL,
  activities             TEXT NULL,
  achievements           TEXT NULL,
  eligibility            VARCHAR(255) NULL,
  recruitment_status     VARCHAR(10) NOT NULL DEFAULT 'OPEN' CHECK (recruitment_status IN ('OPEN','CLOSED')),
  status                 VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  logo_path              VARCHAR(255) NULL,
  banner_path            VARCHAR(255) NULL,
  faculty_coordinator_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  created_by             INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_clubs_status      ON clubs (status);
CREATE INDEX idx_clubs_recruitment ON clubs (recruitment_status);
CREATE INDEX idx_clubs_category    ON clubs (category);

-- Club coordinators (a club can have several; a coordinator can lead several)
CREATE TABLE club_coordinators (
  id          SERIAL PRIMARY KEY,
  club_id     INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (club_id, user_id)
);

-- ---------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------
CREATE TABLE events (
  id                      SERIAL PRIMARY KEY,
  public_id               VARCHAR(24) NOT NULL UNIQUE,           -- CC-EVT-2026-00125
  created_from_request_id INTEGER NULL,
  title                   VARCHAR(160) NOT NULL,
  description             TEXT NOT NULL,
  rules                   TEXT NULL,
  eligibility             VARCHAR(255) NULL,
  contact_details         VARCHAR(255) NULL,
  category                VARCHAR(20) NOT NULL
                          CHECK (category IN ('TECHNICAL','CULTURAL','SPORTS','WORKSHOP','SEMINAR','COMPETITION','FEST','CLUB_EVENT','CAREER','ARTS','OTHER')),
  event_type              VARCHAR(15) NOT NULL DEFAULT 'COLLEGE_WIDE'
                          CHECK (event_type IN ('COLLEGE_WIDE','DEPARTMENT','CLUB')),
  department_id           INTEGER NULL REFERENCES departments(id) ON DELETE SET NULL,
  club_id                 INTEGER NULL REFERENCES clubs(id) ON DELETE SET NULL,
  venue                   VARCHAR(160) NOT NULL,
  event_date              DATE NOT NULL,
  start_time              TIME NOT NULL,
  end_time                TIME NOT NULL,
  max_participants        INTEGER NOT NULL DEFAULT 100 CHECK (max_participants > 0),
  registration_deadline   TIMESTAMPTZ NULL, -- NULL = open until the event starts
  poster_path             VARCHAR(255) NULL,
  organizer_id            INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  faculty_coordinator_id  INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  status                  VARCHAR(12) NOT NULL DEFAULT 'SCHEDULED'
                          CHECK (status IN ('SCHEDULED','ONGOING','COMPLETED','CANCELLED')),
  is_published            SMALLINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_events_status   ON events (status, is_published);
CREATE INDEX idx_events_date     ON events (event_date);
CREATE INDEX idx_events_category ON events (category);
CREATE INDEX idx_events_deadline ON events (registration_deadline);
CREATE INDEX idx_events_request  ON events (created_from_request_id);

-- ---------------------------------------------------------------------
-- Event requests (proposal -> approval workflow)
-- ---------------------------------------------------------------------
CREATE TABLE event_requests (
  id                    SERIAL PRIMARY KEY,
  public_id             VARCHAR(24) NOT NULL UNIQUE,             -- REQ-2026-0015
  requester_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                 VARCHAR(160) NOT NULL,
  description           TEXT NOT NULL,
  rules                 TEXT NULL,
  objectives            TEXT NULL, -- event objectives from the proposal form
  eligibility           VARCHAR(255) NULL,
  contact_details       VARCHAR(255) NULL,  category                VARCHAR(20) NOT NULL
                          CHECK (category IN ('TECHNICAL','CULTURAL','SPORTS','WORKSHOP','SEMINAR','COMPETITION','FEST','CLUB_EVENT','CAREER','ARTS','OTHER')),
  event_type            VARCHAR(15) NOT NULL DEFAULT 'COLLEGE_WIDE'
                        CHECK (event_type IN ('COLLEGE_WIDE','DEPARTMENT','CLUB')),
  department_id         INTEGER NULL REFERENCES departments(id) ON DELETE SET NULL,
  club_id               INTEGER NULL REFERENCES clubs(id) ON DELETE SET NULL,
  venue                 VARCHAR(160) NOT NULL,
  proposed_date         DATE NOT NULL,
  start_time            TIME NOT NULL,
  end_time              TIME NOT NULL,
  expected_participants INTEGER NOT NULL DEFAULT 50,
  required_facilities   VARCHAR(500) NULL,
  estimated_budget      NUMERIC(10,2) NULL,
  faculty_coordinator_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  poster_path           VARCHAR(255) NULL,
  proposal_path         VARCHAR(255) NULL,
  status                VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','UNDER_REVIEW','APPROVED','REJECTED','CHANGES_REQUESTED')),
  review_remarks        TEXT NULL,
  reviewed_by           INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at           TIMESTAMPTZ NULL,
  event_id              INTEGER NULL REFERENCES events(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_er_status    ON event_requests (status);
CREATE INDEX idx_er_requester ON event_requests (requester_id);

CREATE TABLE event_request_history (
  id          SERIAL PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES event_requests(id) ON DELETE CASCADE,
  old_status  VARCHAR(20) NULL,
  new_status  VARCHAR(20) NOT NULL,
  remarks     TEXT NULL,
  changed_by  INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_erh_request ON event_request_history (request_id, created_at);

-- ---------------------------------------------------------------------
-- Event registrations (DB-level duplicate prevention: UNIQUE(event, student))
-- ---------------------------------------------------------------------
CREATE TABLE event_registrations (
  id             SERIAL PRIMARY KEY,
  public_id      VARCHAR(24) NOT NULL UNIQUE,                   -- CC-REG-2026-00125
  event_id       INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  student_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status         VARCHAR(12) NOT NULL DEFAULT 'REGISTERED' CHECK (status IN ('REGISTERED','CANCELLED')),
  registered_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cancelled_at   TIMESTAMPTZ NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (event_id, student_id)
);
CREATE INDEX idx_reg_student ON event_registrations (student_id, status);
CREATE INDEX idx_reg_event   ON event_registrations (event_id, status);

-- ---------------------------------------------------------------------
-- Club members (DB-level duplicate membership prevention)
-- ---------------------------------------------------------------------
CREATE TABLE club_members (
  id          SERIAL PRIMARY KEY,
  club_id     INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  student_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        VARCHAR(20) NOT NULL DEFAULT 'MEMBER'
              CHECK (role IN ('MEMBER','CORE_MEMBER','STUDENT_COORDINATOR')),
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_active   SMALLINT NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (club_id, student_id)
);
CREATE INDEX idx_cm_student ON club_members (student_id, is_active);

-- ---------------------------------------------------------------------
-- Club applications (DB-level duplicate application prevention)
-- ---------------------------------------------------------------------
CREATE TABLE club_applications (
  id               SERIAL PRIMARY KEY,
  public_id        VARCHAR(24) NOT NULL UNIQUE,                 -- CC-APP-2026-0031
  club_id          INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  student_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  why_join         TEXT NOT NULL,
  experience       TEXT NULL,
  skills           VARCHAR(500) NULL,
  interests        VARCHAR(500) NULL,
  status           VARCHAR(15) NOT NULL DEFAULT 'SUBMITTED'
                   CHECK (status IN ('SUBMITTED','UNDER_REVIEW','APPROVED','REJECTED')),
  rejection_reason TEXT NULL,
  reviewed_by      INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at      TIMESTAMPTZ NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (club_id, student_id)
);
CREATE INDEX idx_ca_club    ON club_applications (club_id, status);
CREATE INDEX idx_ca_student ON club_applications (student_id, status);

CREATE TABLE club_custom_questions (
  id            SERIAL PRIMARY KEY,
  club_id       INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  question      VARCHAR(500) NOT NULL,
  field_type    VARCHAR(10) NOT NULL DEFAULT 'TEXT' CHECK (field_type IN ('TEXT','TEXTAREA','SELECT')),
  options       VARCHAR(1000) NULL,                              -- comma-separated for SELECT
  is_required   SMALLINT NOT NULL DEFAULT 1,
  display_order SMALLINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_cq_club ON club_custom_questions (club_id, display_order);

CREATE TABLE club_application_answers (
  id             SERIAL PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES club_applications(id) ON DELETE CASCADE,
  question_id    INTEGER NOT NULL REFERENCES club_custom_questions(id) ON DELETE CASCADE,
  answer         TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (application_id, question_id)
);

-- ---------------------------------------------------------------------
-- Complaints
-- ---------------------------------------------------------------------
CREATE TABLE complaints (
  id              SERIAL PRIMARY KEY,
  public_id       VARCHAR(24) NOT NULL UNIQUE,                  -- CC-CMP-2026-0042
  student_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           VARCHAR(160) NOT NULL,
  description     TEXT NOT NULL,
  category        VARCHAR(20) NOT NULL
                  CHECK (category IN ('INFRASTRUCTURE','CLASSROOM','LABORATORY','WIFI','HOSTEL','CANTEEN','LIBRARY','TRANSPORT','ACADEMICS','OTHER')),
  location        VARCHAR(160) NULL,
  priority        VARCHAR(8) NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
  status          VARCHAR(15) NOT NULL DEFAULT 'SUBMITTED'
                  CHECK (status IN ('SUBMITTED','UNDER_REVIEW','ASSIGNED','IN_PROGRESS','RESOLVED','CLOSED','REOPENED')),
  assigned_to     VARCHAR(160) NULL,                             -- department / staff handling it
  attachment_path VARCHAR(255) NULL,
  feedback        TEXT NULL,
  feedback_rating SMALLINT NULL CHECK (feedback_rating IS NULL OR feedback_rating BETWEEN 1 AND 5),
  resolved_at     TIMESTAMPTZ NULL,
  closed_at       TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_cmp_status  ON complaints (status);
CREATE INDEX idx_cmp_student ON complaints (student_id, status);
CREATE INDEX idx_cmp_cat     ON complaints (category);

CREATE TABLE complaint_updates (
  id           SERIAL PRIMARY KEY,
  complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  old_status   VARCHAR(15) NULL,
  new_status   VARCHAR(15) NOT NULL,
  remarks      TEXT NULL,
  changed_by   INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_cu_complaint ON complaint_updates (complaint_id, created_at);

-- ---------------------------------------------------------------------
-- Announcements
-- ---------------------------------------------------------------------
CREATE TABLE announcements (
  id              SERIAL PRIMARY KEY,
  title           VARCHAR(200) NOT NULL,
  description     TEXT NOT NULL,
  category        VARCHAR(10) NOT NULL DEFAULT 'GENERAL'
                  CHECK (category IN ('GENERAL','EVENT','CLUB','ACADEMIC','URGENT')),
  audience        VARCHAR(10) NOT NULL DEFAULT 'ALL'
                  CHECK (audience IN ('ALL','STUDENTS','FACULTY','STAFF')),
  published_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expiry_date     DATE NULL,
  attachment_path VARCHAR(255) NULL,
  created_by      INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_ann_published ON announcements (published_at DESC);
CREATE INDEX idx_ann_category  ON announcements (category);

-- ---------------------------------------------------------------------
-- Achievements & Hall of Fame
-- (All seeded achievements/winners are DEMO DATA, not real results.)
-- ---------------------------------------------------------------------
CREATE TABLE achievements (
  id                  SERIAL PRIMARY KEY,
  public_id           VARCHAR(24) NOT NULL UNIQUE,               -- CC-ACH-2026-0007
  title               VARCHAR(200) NOT NULL,
  competition_name    VARCHAR(200) NOT NULL,
  category            VARCHAR(20) NOT NULL
                      CHECK (category IN ('TECHNICAL','SPORTS','CULTURAL','ACADEMIC','HACKATHON','INNOVATION','RESEARCH','LEADERSHIP','SOCIAL_SERVICE','OTHER')),
  description         TEXT NULL,
  achievement_year    SMALLINT NOT NULL CHECK (achievement_year BETWEEN 1990 AND 2100),
  position            VARCHAR(15) NOT NULL
                      CHECK (position IN ('1ST_PLACE','2ND_PLACE','3RD_PLACE','WINNER','RUNNER_UP','FINALIST','PARTICIPATION','OTHER')),
  event_date          DATE NULL, -- date of the event the result belongs to
  department_id       INTEGER NULL REFERENCES departments(id) ON DELETE SET NULL,
  event_id            INTEGER NULL REFERENCES events(id) ON DELETE SET NULL,
  club_id             INTEGER NULL REFERENCES clubs(id) ON DELETE SET NULL,
  verification_status VARCHAR(25) NOT NULL DEFAULT 'PENDING_VERIFICATION'
                      CHECK (verification_status IN ('SUBMITTED','PENDING_VERIFICATION','VERIFIED','REJECTED')),
  verified_by         INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  verified_at         TIMESTAMPTZ NULL,
  created_by          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_archived         SMALLINT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_ach_status ON achievements (verification_status, is_archived);
CREATE INDEX idx_ach_year   ON achievements (achievement_year);
CREATE INDEX idx_ach_cat    ON achievements (category);
CREATE INDEX idx_ach_event  ON achievements (event_id);
CREATE INDEX idx_ach_club   ON achievements (club_id);

CREATE TABLE achievement_winners (
  id             SERIAL PRIMARY KEY,
  achievement_id INTEGER NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  user_id        INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  winner_name    VARCHAR(160) NULL,
  team_name      VARCHAR(160) NULL,
  department_id  INTEGER NULL REFERENCES departments(id) ON DELETE SET NULL,
  role           VARCHAR(15) NOT NULL DEFAULT 'INDIVIDUAL'
                 CHECK (role IN ('INDIVIDUAL','TEAM_MEMBER','TEAM')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (winner_name IS NOT NULL OR team_name IS NOT NULL)
);
CREATE INDEX idx_aw_achievement ON achievement_winners (achievement_id);

CREATE TABLE achievement_media (
  id             SERIAL PRIMARY KEY,
  achievement_id INTEGER NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  file_path      VARCHAR(255) NOT NULL,
  file_type      VARCHAR(12) NOT NULL DEFAULT 'PHOTO' CHECK (file_type IN ('PHOTO','CERTIFICATE','OTHER')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_am_achievement ON achievement_media (achievement_id);

-- ---------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------
CREATE TABLE notifications (
  id           SERIAL PRIMARY KEY,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         VARCHAR(30) NOT NULL DEFAULT 'GENERAL',
  title        VARCHAR(160) NOT NULL,
  message      TEXT NOT NULL,
  related_type VARCHAR(40) NULL,
  related_id   INTEGER NULL,
  link         VARCHAR(255) NULL,
  is_read      SMALLINT NOT NULL DEFAULT 0,
  priority     SMALLINT NOT NULL DEFAULT 0,   -- 1 = personalized/interest-matched notification
  dedupe_key   VARCHAR(80) NULL,              -- groups related notifications (e.g. same event)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (recipient_id, dedupe_key)
);
CREATE INDEX idx_notif_recipient ON notifications (recipient_id, is_read, created_at DESC);
CREATE INDEX idx_notif_priority  ON notifications (recipient_id, priority, is_read, created_at DESC);

-- ---------------------------------------------------------------------
-- updated_at touch triggers (equivalent of MySQL ON UPDATE CURRENT_TIMESTAMP)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['departments','users','clubs','events','event_requests',
    'event_registrations','club_members','club_applications','club_custom_questions',
    'club_application_answers','complaints','announcements','achievements']
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_touch BEFORE UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t, t);
  END LOOP;
END $$;
