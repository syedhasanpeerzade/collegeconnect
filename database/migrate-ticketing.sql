-- =====================================================================
-- CollegeConnect — Two-Sided Event Ticketing System Migration
-- Idempotent schema additions for tickets, coordinators, and check-in audit logs
-- =====================================================================

-- 1. Event Tickets table
CREATE TABLE IF NOT EXISTS event_tickets (
  id              SERIAL PRIMARY KEY,
  ticket_code     VARCHAR(40) NOT NULL UNIQUE,
  registration_id INTEGER NOT NULL UNIQUE REFERENCES event_registrations(id) ON DELETE CASCADE,
  event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  student_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          VARCHAR(20) NOT NULL DEFAULT 'VALID' CHECK (status IN ('VALID', 'CHECKED_IN', 'CANCELLED', 'EXPIRED')),
  qr_code_data    TEXT NOT NULL,
  checked_in_at   TIMESTAMPTZ NULL,
  checked_in_by   INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at    TIMESTAMPTZ NULL,
  cancelled_reason TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tickets_code ON event_tickets(ticket_code);
CREATE INDEX IF NOT EXISTS idx_tickets_event ON event_tickets(event_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_student ON event_tickets(student_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_reg ON event_tickets(registration_id);

-- 2. Event Coordinators table (event-to-coordinator assignments)
CREATE TABLE IF NOT EXISTS event_coordinators (
  id          SERIAL PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ev_coord_event ON event_coordinators(event_id);
CREATE INDEX IF NOT EXISTS idx_ev_coord_user ON event_coordinators(user_id);

-- 3. Ticket Check-In History / Audit Logs table
CREATE TABLE IF NOT EXISTS ticket_checkin_logs (
  id             SERIAL PRIMARY KEY,
  ticket_id      INTEGER NULL REFERENCES event_tickets(id) ON DELETE CASCADE,
  event_id       INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  student_id     INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  coordinator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scanned_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  scan_method    VARCHAR(20) NOT NULL DEFAULT 'QR_SCAN',
  status         VARCHAR(30) NOT NULL,
  notes          TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_checkin_logs_event ON ticket_checkin_logs(event_id, scanned_at);
CREATE INDEX IF NOT EXISTS idx_checkin_logs_ticket ON ticket_checkin_logs(ticket_id);
