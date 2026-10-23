'use strict';
const db = require('../config/db');
const { asyncHandler, ok } = require('../utils/helpers');
const stats = require('../services/statsService');
const users = require('../services/userService');
const { body } = require('express-validator');

// ---- Dashboards ----
const studentDashboard = asyncHandler(async (req, res) => {
  const data = await stats.studentDashboard(req.user.id);
  ok(res, 'Student dashboard', data);
});

const adminDashboard = asyncHandler(async (req, res) => {
  const data = await stats.adminStats();
  ok(res, 'Admin dashboard', data);
});

const facultyDashboard = asyncHandler(async (req, res) => {
  const data = await stats.facultyStats(req.user.id);
  ok(res, 'Faculty dashboard', data);
});

// ---- User management ----
const listUsers = asyncHandler(async (req, res) => {
  const rows = await users.listUsers({
    search: req.query.search || '', role: req.query.role || '',
    department: req.query.department || '', status: req.query.status || '',
  });
  ok(res, 'Users', rows);
});

const toggleUser = asyncHandler(async (req, res) => {
  const result = await users.setUserActive(parseInt(req.params.id, 10), !!req.body.is_active, req.user);
  ok(res, `${result.name} is now ${result.is_active ? 'active' : 'deactivated'}`, result);
});

const changeRole = asyncHandler(async (req, res) => {
  await users.setUserRole(parseInt(req.params.id, 10), req.body.role, req.user);
  ok(res, 'Role updated');
});

const createStaffRules = [
  body('full_name').trim().isLength({ min: 3 }).withMessage('Full name required'),
  body('email').trim().isEmail().withMessage('Valid email required'),
  body('phone').trim().matches(/^[0-9+\-\s]{7,20}$/).withMessage('Valid phone required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('role').isIn(['STUDENT', 'ORGANIZER', 'CLUB_COORDINATOR', 'FACULTY', 'ADMIN']),
];

// ---- Departments (simple reference list used by forms) ----
const departments = asyncHandler(async (req, res) => {
  const [rows] = await db.execute('SELECT id, code, name FROM departments ORDER BY name');
  ok(res, 'Departments', rows);
});

// ---- CSV reports ----
function toCsv(rows) {
  if (!rows.length) return 'No data\n';
  const cols = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => escape(r[c])).join(','))].join('\n') + '\n';
}

function sendCsv(res, filename, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\ufeff' + toCsv(rows)); // BOM so Excel opens UTF-8 correctly
}

const REPORTS = {
  'event-registrations': async () => {
    const [rows] = await db.execute(
      `SELECT r.public_id AS registration_id, e.title AS event, e.category, e.event_date, e.venue,
              u.full_name AS student, u.student_id, d.code AS department, r.status, r.registered_at
       FROM event_registrations r
       JOIN events e ON e.id = r.event_id
       JOIN users u ON u.id = r.student_id
       LEFT JOIN departments d ON d.id = u.department_id
       ORDER BY e.event_date DESC, u.full_name`);
    return rows;
  },
  'club-membership': async () => {
    const [rows] = await db.execute(
      `SELECT c.name AS club, u.full_name AS student, u.student_id, d.code AS department,
              m.role, m.joined_at, m.is_active
       FROM club_members m
       JOIN clubs c ON c.id = m.club_id
       JOIN users u ON u.id = m.student_id
       LEFT JOIN departments d ON d.id = u.department_id
       ORDER BY c.name, u.full_name`);
    return rows;
  },
  // Spec alias for the registrations report
  'registrations': async () => {
    const [rows] = await db.execute(
      `SELECT r.public_id AS registration_id, e.title AS event, e.category, e.event_date, e.venue,
              u.full_name AS student, u.student_id, d.code AS department, r.status, r.registered_at
       FROM event_registrations r
       JOIN events e ON e.id = r.event_id
       JOIN users u ON u.id = r.student_id
       LEFT JOIN departments d ON d.id = u.department_id
       ORDER BY e.event_date DESC, u.full_name`);
    return rows;
  },
  'complaints': async () => {
    const [rows] = await db.execute(
      `SELECT c.public_id AS complaint_id, c.title, c.category, c.priority, c.status, c.location,
              u.full_name AS submitted_by, d.code AS department, c.assigned_to, c.created_at, c.resolved_at
       FROM complaints c
       JOIN users u ON u.id = c.student_id
       LEFT JOIN departments d ON d.id = u.department_id
       ORDER BY c.created_at DESC`);
    return rows;
  },
  'event-requests': async () => {
    const [rows] = await db.execute(
      `SELECT r.public_id AS request_id, r.title, r.category, r.status, r.venue, r.proposed_date,
              u.full_name AS requested_by, rv.full_name AS reviewed_by, r.review_remarks, r.created_at
       FROM event_requests r
       JOIN users u ON u.id = r.requester_id
       LEFT JOIN users rv ON rv.id = r.reviewed_by
       ORDER BY r.created_at DESC`);
    return rows;
  },
  'department-complaints': async () => {
    const [rows] = await db.execute(
      `SELECT d.code AS department, c.category, c.priority, COUNT(*) AS total,
              SUM(CASE WHEN c.status IN ('RESOLVED','CLOSED') THEN 1 ELSE 0 END) AS resolved
       FROM complaints c
       JOIN users u ON u.id = c.student_id
       LEFT JOIN departments d ON d.id = u.department_id
       GROUP BY d.id, c.category, c.priority
       ORDER BY department, total DESC`);
    return rows;
  },
  'event-categories': async () => {
    const [rows] = await db.execute(
      `SELECT category, COUNT(*) AS events,
              (SELECT COUNT(*) FROM event_registrations r JOIN events e2 ON e2.id = r.event_id
                 WHERE e2.category = e.category AND r.status = 'REGISTERED') AS registrations
       FROM events e WHERE e.is_published = 1
       GROUP BY category ORDER BY events DESC`);
    return rows;
  },
  'achievements': async () => {
    const [rows] = await db.execute(
      `SELECT a.public_id AS achievement_id, a.title, a.competition_name, a.category, a.achievement_year,
              a.position, a.verification_status,
              COALESCE(a.department_id, w.department_id) AS dept_id,
              d.code AS department, c.name AS club, e.title AS event,
              GROUP_CONCAT(DISTINCT w.winner_name ORDER BY w.winner_name SEPARATOR ', ') AS winners,
              MAX(w.team_name) AS team
       FROM achievements a
       LEFT JOIN departments d ON d.id = a.department_id
       LEFT JOIN clubs c ON c.id = a.club_id
       LEFT JOIN events e ON e.id = a.event_id
       LEFT JOIN achievement_winners w ON w.achievement_id = a.id
       GROUP BY a.id ORDER BY a.achievement_year DESC`);
    return rows;
  },
  'previous-winners': async () => {
    const [rows] = await db.execute(
      `SELECT a.competition_name, a.achievement_year AS year, a.position,
              COALESCE(w.winner_name, w.team_name) AS winner, w.role,
              d.code AS department, a.verification_status
       FROM achievements a
       LEFT JOIN achievement_winners w ON w.achievement_id = a.id
       LEFT JOIN departments d ON d.id = w.department_id
       WHERE a.is_archived = 0
       ORDER BY a.competition_name, a.achievement_year DESC`);
    return rows;
  },
};

const exportReport = asyncHandler(async (req, res) => {
  const key = req.params.key;
  if (!REPORTS[key]) return res.status(404).json({ success: false, message: 'Unknown report' });
  const rows = await REPORTS[key]();
  sendCsv(res, `collegeconnect-${key}-${new Date().toISOString().slice(0, 10)}.csv`, rows);
});

module.exports = {
  studentDashboard, adminDashboard, facultyDashboard,
  listUsers, toggleUser, changeRole, createStaffRules, departments, exportReport,
};
