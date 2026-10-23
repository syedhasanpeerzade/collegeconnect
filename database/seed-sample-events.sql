-- ============================================================================
-- CollegeConnect - sample events for the discovery flow
--
-- OPTIONAL and IDEMPOTENT. The canonical `db:seed` stays intentionally empty
-- of events; this script only exists so the new Events Categories discovery
-- page can be demonstrated right away.
--
--   node database/seed-sample-events.js   (or)   npm run db:seed:events
--
-- Safe to run multiple times (deletes only its own CC-SMP-EVT rows).
-- Dates are computed relative to the current date so "This Week" always
-- has matches.
-- ============================================================================

DO $$
DECLARE
  d0 date := CURRENT_DATE;
BEGIN
  DELETE FROM event_registrations WHERE event_id IN (SELECT id FROM events WHERE public_id LIKE 'CC-SMP-EVT%');
  DELETE FROM events WHERE public_id LIKE 'CC-SMP-EVT%';

  INSERT INTO events
    (public_id, title, description, rules, eligibility, contact_details, category, event_type,
     club_id, venue, event_date, start_time, end_time, max_participants, registration_deadline,
     organizer_id, faculty_coordinator_id, status, is_published)
  VALUES
  -- SPORTS -------------------------------------------------------------
  ('CC-SMP-EVT-001', 'Inter-Department Cricket Tournament', 'The biggest sporting showdown of the semester. Department teams battle it out across the week in T20 format matches. Register as a team through your department representative or as an individual to be drafted.', NULL, 'Open to all enrolled students', 'sports.office@collegeconnect.edu', 'SPORTS', 'COLLEGE_WIDE',
   NULL, 'Main Cricket Ground', d0 + 3, '09:00', '17:00', 200, d0 + 1 + time '23:59', 3, 2, 'SCHEDULED', 1),

  ('CC-SMP-EVT-002', 'Morning Badminton Open Session', 'Casual badminton session for all skill levels. Rackets and shuttles provided; just bring your sports shoes and energy. Great for freshers looking to make friends on court.', NULL, 'Open to all students', 'sports.office@collegeconnect.edu', 'SPORTS', 'COLLEGE_WIDE',
   NULL, 'Indoor Sports Complex, Court 2', d0 + 6, '06:30', '08:00', 24, NULL, 3, NULL, 'SCHEDULED', 1),

  -- TECHNICAL / WORKSHOP / COMPETITION (Coding & Tech group) ------------
  ('CC-SMP-EVT-003', 'CodeSprint 24-Hour Hackathon', 'Build, break and rebuild. A 24-hour hackathon with tracks in AI/ML, web development and open innovation. Mentors from the industry, snacks through the night, and exciting prizes for the top three teams.', 'Teams of 2-4. Bring your own laptop. One track per team.', 'All departments welcome', 'codesprint@collegeconnect.edu', 'TECHNICAL', 'COLLEGE_WIDE',
   1, 'Innovation Lab, Block C', d0 + 9, '09:00', '09:00', 120, d0 + 6 + time '23:59', 3, 2, 'SCHEDULED', 1),

  ('CC-SMP-EVT-004', 'Hands-on Web Development Workshop', 'A beginner-friendly workshop covering HTML, CSS and modern JavaScript by building a personal portfolio page live. No prior coding experience needed; perfect for first and second year students.', NULL, 'Bring a laptop with a modern browser', 'web.club@collegeconnect.edu', 'WORKSHOP', 'CLUB',
   1, 'Computer Lab 204', d0 + 2, '14:00', '16:30', 40, d0 + 1 + time '18:00', 3, NULL, 'SCHEDULED', 1),

  ('CC-SMP-EVT-005', 'AI/ML Project Showcase & Mini-Contest', 'Student teams present AI/ML projects to a panel, followed by a rapid mini-contest on prompt engineering and model debugging. Walk away with feedback, contacts and prize money.', 'Individual or teams up to 3', 'Basic Python recommended', 'aiml.club@collegeconnect.edu', 'COMPETITION', 'CLUB',
   1, 'Seminar Hall B', d0 + 5, '10:00', '13:00', 60, d0 + 4 + time '23:59', 3, NULL, 'SCHEDULED', 1),

  -- CLUB_EVENT (College Clubs group) ------------------------------------
  ('CC-SMP-EVT-006', 'Campus Club Weekly Meetup', 'Weekly gathering of the Campus Club: this week features a public-speaking circle, a chess corner and planning for the upcoming fresher talent hunt. Open to members and curious newcomers alike.', NULL, 'Open to everyone', 'club@collegeconnect.edu', 'CLUB_EVENT', 'CLUB',
   1, 'Student Activity Center, Room 12', d0 + 1, '16:00', '17:30', 50, NULL, 3, 2, 'SCHEDULED', 1),

  -- CULTURAL / FEST (Cultural group) ------------------------------------
  ('CC-SMP-EVT-007', 'Rhythm & Beats - Annual Cultural Night', 'An evening of music, dance and drama on the main stage. Solo and group performances, live band, and a surprise celebrity guest. Auditions close one week before the show.', NULL, 'Audition required for stage performances', 'cultural.committee@collegeconnect.edu', 'CULTURAL', 'COLLEGE_WIDE',
   NULL, 'Open Air Auditorium', d0 + 12, '17:30', '21:30', 500, d0 + 9 + time '23:59', 3, 2, 'SCHEDULED', 1),

  ('CC-SMP-EVT-008', 'Spring Fest 2026 - Day 1', 'The flagship fest kicks off: food stalls, flea market, gaming zone, tech arcade and the inter-college band competition. Day passes are free for enrolled students.', NULL, 'Open to all students with ID', 'fest.core@collegeconnect.edu', 'FEST', 'COLLEGE_WIDE',
   NULL, 'Campus Main Quadrangle', d0 + 15, '10:00', '22:00', 1000, d0 + 12 + time '23:59', 3, 2, 'SCHEDULED', 1),

  -- SEMINAR (Academic group) --------------------------------------------
  ('CC-SMP-EVT-009', 'Research Seminar: From Classroom to Published Paper', 'A faculty-led seminar on turning course projects into publishable research: picking a problem, literature review, and approaching journals. Q&A with recently published seniors.', NULL, 'Open to all departments', 'research.cell@collegeconnect.edu', 'SEMINAR', 'DEPARTMENT',
   NULL, 'Library Reading Hall', d0 + 4, '11:00', '12:30', 80, d0 + 3 + time '23:59', 3, 2, 'SCHEDULED', 1),

  -- CAREER (Career & Placement group) -----------------------------------
  ('CC-SMP-EVT-010', 'Placement Readiness Drive', 'Mock aptitude tests, group discussion rounds and one-on-one resume reviews with alumni working in top tech firms. Walk out with a concrete 30-day preparation plan.', NULL, 'Priority to pre-final and final year students', 'placement.cell@collegeconnect.edu', 'CAREER', 'COLLEGE_WIDE',
   NULL, 'Placement Cell Auditorium', d0 + 7, '09:30', '15:00', 150, d0 + 5 + time '23:59', 3, 2, 'SCHEDULED', 1),

  -- ARTS (Arts & Creativity group) --------------------------------------
  ('CC-SMP-EVT-011', 'Open Mic & Sketch Walk', 'An unhurried evening of poetry, stand-up and acoustic sets, followed by a guided sketch walk around the lake trail. Art supplies provided; just bring yourself.', NULL, 'Open to all', 'arts.circle@collegeconnect.edu', 'ARTS', 'CLUB',
   1, 'Amphitheatre & Lake Trail', d0 + 8, '16:30', '19:00', 70, NULL, 3, NULL, 'SCHEDULED', 1),

  -- OTHER ---------------------------------------------------------------
  ('CC-SMP-EVT-012', 'Campus Cleanliness & Tree Plantation Drive', 'Join the sustainability volunteer drive: a two-hour campus cleanup followed by planting native saplings near the hostels. Certificates for all volunteers.', NULL, 'Open to all students and staff', 'eco.club@collegeconnect.edu', 'OTHER', 'COLLEGE_WIDE',
   NULL, 'Assembly Point: Main Gate', d0 + 10, '08:00', '10:30', 100, NULL, 3, 2, 'SCHEDULED', 1);
END $$;
