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
  status          VARCHAR(24) NOT NULL DEFAULT 'VALID'
                  CHECK (status IN ('VALID', 'CHECKED_IN', 'CANCELLED', 'EXPIRED', 'PENDING', 'PENDING_APPROVAL', 'UNDER_REVIEW', 'REJECTED')),
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

-- Widen the existing status constraints without changing the registration
-- endpoint: new registrations still default to REGISTERED and issue VALID tickets.
DO $$
BEGIN
  ALTER TABLE public.event_registrations ALTER COLUMN status TYPE VARCHAR(24);
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.event_registrations'::regclass
      AND conname = 'event_registrations_status_check'
      AND pg_get_constraintdef(oid) LIKE '%PENDING_APPROVAL%'
  ) THEN
    ALTER TABLE public.event_registrations
      DROP CONSTRAINT IF EXISTS event_registrations_status_check;
    ALTER TABLE public.event_registrations
      ADD CONSTRAINT event_registrations_status_check
      CHECK (status IN ('REGISTERED', 'PENDING', 'PENDING_APPROVAL', 'UNDER_REVIEW', 'REJECTED', 'CANCELLED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.event_tickets'::regclass
      AND conname = 'event_tickets_status_check'
      AND pg_get_constraintdef(oid) LIKE '%PENDING_APPROVAL%'
  ) THEN
    ALTER TABLE public.event_tickets
      DROP CONSTRAINT IF EXISTS event_tickets_status_check;
    ALTER TABLE public.event_tickets
      ADD CONSTRAINT event_tickets_status_check
      CHECK (status IN ('VALID', 'CHECKED_IN', 'CANCELLED', 'EXPIRED', 'PENDING', 'PENDING_APPROVAL', 'UNDER_REVIEW', 'REJECTED'));
  END IF;
END $$;

-- These records are accessed through the authenticated CollegeConnect API,
-- not directly from a browser Supabase client. Deny direct PostgREST access
-- to public client roles while allowing the backend database owner/service role.
DO $$
DECLARE
  table_name TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    FOREACH table_name IN ARRAY ARRAY[
      'event_registrations',
      'event_tickets',
      'event_coordinators',
      'ticket_checkin_logs'
    ] LOOP
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
      EXECUTE format('DROP POLICY IF EXISTS collegeconnect_backend_only ON public.%I', table_name);
      EXECUTE format(
        'CREATE POLICY collegeconnect_backend_only ON public.%I AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',
        table_name
      );
    END LOOP;
  END IF;
END $$;
