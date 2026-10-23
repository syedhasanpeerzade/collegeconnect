'use strict';
const db = require('../config/db');

/** Student dashboard aggregate. */
async function studentDashboard(userId) {
  const [[upcomingEvents], [myRegs], [myClubs], [pendingApps], [myComplaints], [recentAnnouncements], [unreadNotifs], [recentAchievements]] = await Promise.all([
    db.execute(
      `SELECT id, title, category, event_date, start_time, venue, poster_path FROM events
       WHERE is_published = 1 AND status IN ('SCHEDULED','ONGOING') AND event_date >= CURDATE()
       ORDER BY event_date ASC LIMIT 5`
    ),
    db.execute(
      `SELECT r.public_id, r.status, e.title, e.event_date, e.venue, e.id AS event_id
       FROM event_registrations r JOIN events e ON e.id = r.event_id
       WHERE r.student_id = ? AND r.status = 'REGISTERED' AND e.event_date >= CURDATE()
       ORDER BY e.event_date ASC LIMIT 5`,
      [userId]
    ),
    db.execute(
      `SELECT c.id, c.name, c.logo_path, m.role FROM club_members m JOIN clubs c ON c.id = m.club_id
       WHERE m.student_id = ? AND m.is_active = 1 LIMIT 6`,
      [userId]
    ),
    db.execute(
      `SELECT a.id, a.status, c.name AS club_name FROM club_applications a JOIN clubs c ON c.id = a.club_id
       WHERE a.student_id = ? AND a.status IN ('SUBMITTED','UNDER_REVIEW')`,
      [userId]
    ),
    db.execute(
      `SELECT id, public_id, title, status, priority, created_at FROM complaints
       WHERE student_id = ? ORDER BY created_at DESC LIMIT 5`,
      [userId]
    ),
    db.execute(
      `SELECT id, title, category, published_at FROM announcements
       WHERE (expiry_date IS NULL OR expiry_date >= CURDATE()) AND audience IN ('ALL','STUDENTS')
       ORDER BY published_at DESC LIMIT 5`
    ),
    db.execute(
      `SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ? AND is_read = 0`,
      [userId]
    ),
    db.execute(
      `SELECT id, title, achievement_year, position FROM achievements
       WHERE verification_status = 'VERIFIED' AND is_archived = 0
       ORDER BY achievement_year DESC, created_at DESC LIMIT 5`
    ),
  ]);
  return {
    upcoming_events: upcomingEvents,
    my_registrations: myRegs,
    my_clubs: myClubs,
    pending_applications: pendingApps,
    my_complaints: myComplaints,
    announcements: recentAnnouncements,
    unread_notifications: unreadNotifs[0].n,
    recent_achievements: recentAchievements,
  };
}

/** Admin dashboard statistics. */
async function adminStats() {
  const [[counts], [eventsByCategory], [complaintsByStatus], [complaintsByCategory],
    [monthlyRegs], [clubMembership], [achByYear]] = await Promise.all([
    db.execute(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE role='STUDENT' AND is_active=1) AS total_students,
        (SELECT COUNT(*) FROM users WHERE role='FACULTY' AND is_active=1) AS total_faculty,
        (SELECT COUNT(*) FROM users WHERE role='ORGANIZER' AND is_active=1) AS total_organizers,
        (SELECT COUNT(*) FROM users WHERE role='CLUB_COORDINATOR' AND is_active=1) AS total_coordinators,
        (SELECT COUNT(*) FROM clubs WHERE status='ACTIVE') AS total_clubs,
        (SELECT COUNT(*) FROM events WHERE is_published=1) AS total_events,
        (SELECT COUNT(*) FROM events WHERE is_published=1 AND status IN ('SCHEDULED','ONGOING') AND event_date >= CURDATE()) AS upcoming_events,
        (SELECT COUNT(*) FROM event_requests WHERE status='PENDING') AS pending_event_requests,
        (SELECT COUNT(*) FROM event_registrations WHERE status='REGISTERED') AS total_registrations,
        (SELECT COUNT(*) FROM complaints) AS total_complaints,
        (SELECT COUNT(*) FROM complaints WHERE status IN ('SUBMITTED','UNDER_REVIEW','ASSIGNED','IN_PROGRESS','REOPENED')) AS pending_complaints,
        (SELECT COUNT(*) FROM complaints WHERE status IN ('RESOLVED','CLOSED')) AS resolved_complaints,
        (SELECT COUNT(*) FROM achievements WHERE verification_status='VERIFIED' AND is_archived=0) AS verified_achievements,
        (SELECT COUNT(*) FROM achievements WHERE verification_status='PENDING_VERIFICATION') AS pending_achievements,
        (SELECT COUNT(*) FROM club_applications WHERE status IN ('SUBMITTED','UNDER_REVIEW')) AS pending_club_applications
    `),
    db.execute(`SELECT category, COUNT(*) AS count FROM events WHERE is_published=1 GROUP BY category ORDER BY count DESC`),
    db.execute(`SELECT status, COUNT(*) AS count FROM complaints GROUP BY status`),
    db.execute(`SELECT category, COUNT(*) AS count FROM complaints GROUP BY category ORDER BY count DESC`),
    db.execute(`
      SELECT DATE_FORMAT(registered_at, '%Y-%m') AS month, COUNT(*) AS count
      FROM event_registrations
      WHERE registered_at >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
      GROUP BY month ORDER BY month ASC`),
    db.execute(`
      SELECT c.name, COUNT(m.id) AS members FROM clubs c
      LEFT JOIN club_members m ON m.club_id = c.id AND m.is_active = 1
      GROUP BY c.id ORDER BY members DESC`),
    db.execute(`
      SELECT achievement_year AS year, COUNT(*) AS count FROM achievements
      WHERE verification_status='VERIFIED' AND is_archived=0
      GROUP BY achievement_year ORDER BY year DESC LIMIT 10`),
  ]);
  return {
    counts: counts[0],
    events_by_category: eventsByCategory,
    complaints_by_status: complaintsByStatus,
    complaints_by_category: complaintsByCategory,
    monthly_registrations: monthlyRegs,
    club_membership: clubMembership,
    achievements_by_year: achByYear,
  };
}

/** Faculty review queue summary. */
async function facultyStats(userId) {
  const [[pendingRequests], [pendingComplaints], [pendingAchievements], [recentApproved], [rejectedRequests]] = await Promise.all([
    db.execute(`SELECT COUNT(*) AS n FROM event_requests WHERE status IN ('PENDING','UNDER_REVIEW')`),
    db.execute(`SELECT COUNT(*) AS n FROM complaints WHERE status IN ('SUBMITTED','UNDER_REVIEW','REOPENED')`),
    db.execute(`SELECT COUNT(*) AS n FROM achievements WHERE verification_status = 'PENDING_VERIFICATION'`),
    db.execute(`SELECT COUNT(*) AS n FROM event_requests WHERE status = 'APPROVED'`),
    db.execute(`SELECT COUNT(*) AS n FROM event_requests WHERE status = 'REJECTED'`),
  ]);
  return {
    pending_event_requests: pendingRequests[0].n,
    pending_complaints: pendingComplaints[0].n,
    pending_achievements: pendingAchievements[0].n,
    approved_requests: recentApproved[0].n,
    rejected_requests: rejectedRequests[0].n,
  };
}

/** Coordinator stats per club are computed in clubService.myCoordinatedClubs. */

module.exports = { studentDashboard, adminStats, facultyStats };
