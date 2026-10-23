-- Idempotent demo announcements for the student Announcements landing page.
-- Deletes (by exact title) and re-inserts the demo rows, so it can be re-run
-- safely and demo titles never collide with real announcements.
BEGIN;

DELETE FROM announcements
WHERE title IN (
  'Mid-semester examination timetable published',
  'CodeSprint 2026: Final results are out',
  'TechClub: robotics workshop registrations close Friday',
  'Library extends opening hours during exam season',
  'URGENT: Campus will remain closed tomorrow',
  'Sports division: inter-department football fixtures'
);

INSERT INTO announcements (title, description, category, audience, published_at, attachment_path, created_by)
SELECT v.title, v.description, v.category, v.audience, NOW() - v.age, v.attachment_path, v.author_id
FROM (VALUES
  ('Mid-semester examination timetable published',
   E'The mid-semester examination timetable for all departments is now available.\n\nExams begin Monday next week, 9:30 AM sharp. Hall allocations are printed on the notice board and shared with your class mentors. Carry your college ID and hall ticket to every exam.',
   'ACADEMIC', 'ALL', INTERVAL '2 hours', NULL,
   (SELECT id FROM users WHERE email = 'faculty@collegeconnect.com' LIMIT 1)),
  ('URGENT: Campus will remain closed tomorrow',
   E'The campus will remain closed tomorrow (all classes and events suspended) due to an unscheduled power maintenance outage in the main block.\n\nHostels remain open. Staff and students should check email for the revised schedule. Normal functioning resumes the day after.',
   'URGENT', 'ALL', INTERVAL '4 hours', NULL,
   (SELECT id FROM users WHERE email = 'admin@collegeconnect.com' LIMIT 1)),
  ('CodeSprint 2026: Final results are out',
   E'Congratulations to Team Compilers (winners), Team Bitwise (runners-up) and Team NullPointers (second runners-up)!\n\nCertificates and prize money will be distributed at the Achievements Desk this Friday, 3 PM. Full results and the Hall of Fame are on the Achievements page.',
   'EVENT', 'ALL', INTERVAL '1 day', '/uploads/announcements/demo-announcement-banner.png',
   (SELECT id FROM users WHERE email = 'organizer@collegeconnect.com' LIMIT 1)),
  ('TechClub: robotics workshop registrations close Friday',
   E'TechClub is hosting a hands-on robotics workshop this weekend, open to all departments and no prior experience is needed.\n\nSeats are limited to 40. Registrations close Friday 5 PM - grab your spot from the Clubs page before they fill up.',
   'CLUB', 'STUDENTS', INTERVAL '2 days', NULL,
   (SELECT id FROM users WHERE email = 'organizer@collegeconnect.com' LIMIT 1)),
  ('Library extends opening hours during exam season',
   E'The central library will remain open until 11 PM on all weekdays for the next three weeks. The reading-room wing is reserved for silent study after 7 PM. Please carry your ID card for late entry.',
   'GENERAL', 'ALL', INTERVAL '3 days', NULL,
   (SELECT id FROM users WHERE email = 'admin@collegeconnect.com' LIMIT 1)),
  ('Sports division: inter-department football fixtures',
   E'Fixtures for the inter-department football tournament are posted. First matches kick off Saturday morning at the main ground. Teams must report 30 minutes before kickoff in their department jersey.',
   'GENERAL', 'STUDENTS', INTERVAL '5 days', NULL,
   (SELECT id FROM users WHERE email = 'admin@collegeconnect.com' LIMIT 1))
) AS v(title, description, category, audience, age, attachment_path, author_id)
WHERE v.author_id IS NOT NULL;

COMMIT;
