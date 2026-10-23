-- ============================================================================
-- CollegeConnect - demo results for the "Latest Event Results" feature
--
-- Idempotent. Marks the CodeSprint sample event as COMPLETED (past date) and
-- adds three VERIFIED result records (1st/2nd/3rd) linked to it, so the
-- Achievements page has a real featured "latest event + winners" section.
--
--   node database/seed-latest-results.js
-- ============================================================================

DO $$
DECLARE
  ev_id INTEGER;
  d0 date := CURRENT_DATE;
BEGIN
  -- Point the CodeSprint sample event into the past + completed
  UPDATE events
     SET event_date = d0 - 3, status = 'COMPLETED', is_published = 1
   WHERE public_id = 'CC-SMP-EVT-003';

  SELECT id INTO ev_id FROM events WHERE public_id = 'CC-SMP-EVT-003';

  -- Remove previous demo results for this event, then re-add
  DELETE FROM achievement_winners WHERE achievement_id IN (
    SELECT id FROM achievements WHERE event_id = ev_id OR title LIKE 'CodeSprint 2026 -%');
  DELETE FROM achievement_media WHERE achievement_id IN (
    SELECT id FROM achievements WHERE event_id = ev_id OR title LIKE 'CodeSprint 2026 -%');
  DELETE FROM achievements WHERE event_id = ev_id OR title LIKE 'CodeSprint 2026 -%';

  INSERT INTO achievements
    (public_id, title, competition_name, category, description, achievement_year, position,
     department_id, event_id, club_id, verification_status, verified_by, verified_at, created_by)
  VALUES
    ('CC-SMP-RES-001', 'CodeSprint 2026 - Champions', 'CodeSprint 24-Hour Hackathon', 'HACKATHON',
     'Champions of the 24-hour hackathon with an AI-powered campus navigation app.', 2026, '1ST_PLACE',
     1, ev_id, 1, 'VERIFIED', 2, NOW() - INTERVAL '2 hours', 2),
    ('CC-SMP-RES-002', 'CodeSprint 2026 - Runners-up', 'CodeSprint 24-Hour Hackathon', 'HACKATHON',
     'Runners-up with a smart attendance analytics dashboard.', 2026, '2ND_PLACE',
     2, ev_id, 1, 'VERIFIED', 2, NOW() - INTERVAL '1 hour', 2),
    ('CC-SMP-RES-003', 'CodeSprint 2026 - Third Place', 'CodeSprint 24-Hour Hackathon', 'HACKATHON',
     'Third place with an accessibility-first learning platform.', 2026, '3RD_PLACE',
     3, ev_id, 1, 'VERIFIED', 2, NOW() - INTERVAL '30 minutes', 2);

  -- Winners: 1st -> Team Innovators (Ahmed, Rahul, Arjun); 2nd -> Code Warriors; 3rd -> Tech Titans
  INSERT INTO achievement_winners (achievement_id, winner_name, team_name, role)
  SELECT id, NULL, 'Team Innovators', 'TEAM' FROM achievements WHERE public_id = 'CC-SMP-RES-001';
  INSERT INTO achievement_winners (achievement_id, winner_name, team_name, role)
  SELECT id, w.name, NULL, 'TEAM_MEMBER' FROM achievements, LATERAL (
    VALUES ('Ahmed Khan'), ('Rahul Verma'), ('Arjun Mehta')) AS w(name)
   WHERE public_id = 'CC-SMP-RES-001';
  INSERT INTO achievement_winners (achievement_id, winner_name, team_name, role)
  SELECT id, NULL, 'Code Warriors', 'TEAM' FROM achievements WHERE public_id = 'CC-SMP-RES-002';
  INSERT INTO achievement_winners (achievement_id, winner_name, team_name, role)
  SELECT id, NULL, 'Tech Titans', 'TEAM' FROM achievements WHERE public_id = 'CC-SMP-RES-003';
END $$;
