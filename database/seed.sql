-- =====================================================================
-- CollegeConnect - Seed Data (PostgreSQL / Supabase)
-- One Platform for Your Campus
--
-- Minimal seed: only the 4 role accounts and the reference data the
-- platform needs to function (departments + one starter club for the
-- coordinator's workspace). NO dummy events, registrations, complaints,
-- announcements, applications, or achievements.
--
-- Usage:  npm run db:seed   (or npm run db:init:seed to rebuild + seed)
--
-- All account passwords:  Password@123
--   Admin ..................... admin@collegeconnect.com
--   Faculty (Event Coord.) .... faculty@collegeconnect.com
--   Organizer ................. organizer@collegeconnect.com
--   Student ................... student@collegeconnect.com
-- =====================================================================

TRUNCATE TABLE
  notifications, achievement_media, achievement_winners, achievements,
  announcements, complaint_updates, complaints,
  club_application_answers, club_custom_questions, club_applications,
  club_members, club_coordinators, clubs,
  event_registrations, event_request_history, event_requests, events,
  users, departments
RESTART IDENTITY CASCADE;

-- ---------------------------------------------------------------------
-- Departments (reference data used by registration & event forms)
-- ---------------------------------------------------------------------
INSERT INTO departments (code, name) VALUES
('CSE',   'Computer Science & Engineering'),
('ECE',   'Electronics & Communication Engineering'),
('ME',    'Mechanical Engineering'),
('CIVIL', 'Civil Engineering'),
('MCA',   'Master of Computer Applications'),
('MBA',   'Business Administration');

-- ---------------------------------------------------------------------
-- The four role accounts
-- (bcrypt hash below is for "Password@123")
-- ---------------------------------------------------------------------
INSERT INTO users (id, role, full_name, student_id, email, phone, password_hash, department_id, year) VALUES
(1,'ADMIN','Principal Admin','ADM001','admin@collegeconnect.com','9900000001','$2a$10$qRrwLHoVa.LiOgUERZMDauZpHfMrXOPvR1r4SAfSJbQSUIgksSCu2',NULL,NULL),
(2,'FACULTY','Event Coordinator','FAC001','faculty@collegeconnect.com','9900000002','$2a$10$qRrwLHoVa.LiOgUERZMDauZpHfMrXOPvR1r4SAfSJbQSUIgksSCu2',NULL,NULL),
(3,'ORGANIZER','Event Organizer','ORG001','organizer@collegeconnect.com','9900000003','$2a$10$qRrwLHoVa.LiOgUERZMDauZpHfMrXOPvR1r4SAfSJbQSUIgksSCu2',NULL,NULL),
(4,'STUDENT','Demo Student','STU001','student@collegeconnect.com','9900000004','$2a$10$qRrwLHoVa.LiOgUERZMDauZpHfMrXOPvR1r4SAfSJbQSUIgksSCu2',1,2),
(5,'CLUB_COORDINATOR','Club Coordinator','CLU001','coordinator@collegeconnect.com','9900000005','$2a$10$qRrwLHoVa.LiOgUERZMDauZpHfMrXOPvR1r4SAfSJbQSUIgksSCu2',NULL,NULL);
SELECT setval('users_id_seq', 4, true);

-- ---------------------------------------------------------------------
-- Starter club so the CLUB_COORDINATOR role (once registered) and the
-- faculty coordinator have something to manage. Rename it or hand it
-- over from Admin → Users if you like.
-- ---------------------------------------------------------------------
INSERT INTO clubs (id, name, category, description, eligibility, faculty_coordinator_id) VALUES
(1,'Campus Club','OTHER',
 'A general campus club. Update this description from the coordinator workspace.',
 'Open to all students', 2);
SELECT setval('clubs_id_seq', 1, true);

-- Assign user 2 (faculty) is the club's faculty context; the club
-- coordinator account is created via registration and can be linked to
-- this club from the admin panel when needed.
