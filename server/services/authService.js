'use strict';
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { authenticate, authorize } = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const JWT_EXPIRES = process.env.JWT_EXPIRES_IN || '7d';

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, email: user.email, name: user.full_name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

// Roles a user may pick at registration. ADMIN and FACULTY accounts are
// provisioned by an administrator (never self-registered).
const REGISTRABLE_ROLES = ['STUDENT', 'ORGANIZER', 'CLUB_COORDINATOR'];

async function register({ full_name, student_id, email, phone, password, department_id, year, role }) {
  const conn = await db.getConnection();
  try {
    const chosenRole = REGISTRABLE_ROLES.includes(role) ? role : 'STUDENT';
    if (chosenRole === 'STUDENT' && !student_id) {
      throw new ApiError(400, 'Student ID is required for student accounts');
    }
    const [dupe] = await conn.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (dupe.length) fail409('Email already registered');
    if (student_id) {
      const [dupeSid] = await conn.execute('SELECT id FROM users WHERE student_id = ?', [student_id]);
      if (dupeSid.length) fail409('Student ID already registered');
    }

    const hash = await bcrypt.hash(password, 10);
    const [r] = await conn.execute(
      `INSERT INTO users (role, full_name, student_id, email, phone, password_hash, department_id, year)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [chosenRole, full_name, student_id || null, email.toLowerCase(), phone, hash, department_id || null, year || null]
    );
    return r.insertId;
  } finally {
    conn.release();
  }
}

function fail409(msg) {
  throw new ApiError(409, msg);
}

async function login(email, password) {
  const [rows] = await db.execute(
    `SELECT u.*, d.code AS dept_code FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.email = ?`,
    [email.toLowerCase()]
  );
  const user = rows[0];
  if (!user) throw new ApiError(401, 'Invalid email or password');
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) throw new ApiError(401, 'Invalid email or password');
  if (!user.is_active) throw new ApiError(403, 'Your account has been deactivated. Contact the admin office.');

  await db.execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

  return {
    token: signToken(user),
    user: {
      id: user.id,
      role: user.role,
      full_name: user.full_name,
      student_id: user.student_id,
      email: user.email,
      phone: user.phone,
      department_id: user.department_id,
      department_code: user.dept_code,
      year: user.year,
      account_type: user.account_type || 'student',
      verified: !!Number(user.verified),
    },
  };
}

async function getMe(userId) {
  const [rows] = await db.execute(
    `SELECT u.id, u.role, u.full_name, u.student_id, u.email, u.phone, u.department_id, u.year,
            u.is_active, u.created_at, u.account_type, u.verified, u.bio, u.skills, u.projects,
            u.avatar_path, d.code AS department_code, d.name AS department_name
     FROM users u LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.id = ?`,
    [userId]
  );
  if (!rows.length) throw new ApiError(404, 'User not found');
  const u = rows[0];
  delete u.is_active;
  u.verified = !!Number(u.verified);
  return u;
}

async function changePassword(userId, currentPassword, newPassword) {
  const [rows] = await db.execute('SELECT password_hash FROM users WHERE id = ?', [userId]);
  if (!rows.length) throw new ApiError(404, 'User not found');
  const match = await bcrypt.compare(currentPassword, rows[0].password_hash);
  if (!match) throw new ApiError(400, 'Current password is incorrect');
  const hash = await bcrypt.hash(newPassword, 10);
  await db.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
}

/** Generates a reset token; in a real deployment this would be emailed. */
async function forgotPassword(email) {
  const [rows] = await db.execute(
    'SELECT id FROM users WHERE email = ? AND is_active = 1',
    [String(email || '').toLowerCase()]
  );
  // Do not reveal whether the email exists
  if (!rows.length) {
    return { message: 'If the email is registered, a reset token has been generated. Check your notifications after logging in, or contact the admin office.' };
  }
  const crypto = require('crypto');
  const token = crypto.randomBytes(24).toString('hex');
  await db.execute(
    'UPDATE users SET password_reset_token = ?, password_reset_expires = DATE_ADD(NOW(), INTERVAL 30 MINUTE) WHERE id = ?',
    [token, rows[0].id]
  );
  await db.execute(
    `INSERT INTO notifications (recipient_id, type, title, message, link)
     VALUES (?, 'GENERAL', 'Password reset requested', ?, NULL)`,
    [rows[0].id, 'A password reset was requested for your account. Token: ' + token]
  );
  return { message: 'If the email is registered, a reset token has been generated. Check your notifications after logging in, or contact the admin office.' };
}

/** Completes a reset with the token from forgotPassword. */
async function resetPassword(token, newPassword) {
  const [rows] = await db.execute(
    'SELECT id FROM users WHERE password_reset_token = ? AND password_reset_expires > NOW() AND is_active = 1',
    [String(token || '')]
  );
  if (!rows.length) throw new ApiError(400, 'Invalid or expired reset token');
  const hash = await bcrypt.hash(newPassword, 10);
  await db.execute(
    'UPDATE users SET password_hash = ?, password_reset_token = NULL, password_reset_expires = NULL WHERE id = ?',
    [hash, rows[0].id]
  );
}

/** Admin creates staff or student accounts. */
async function adminCreateUser(actor, payload) {
  const [dupe] = await db.execute('SELECT id FROM users WHERE email = ?', [payload.email.toLowerCase()]);
  if (dupe.length) throw new ApiError(409, 'Email already registered');
  const hash = await bcrypt.hash(payload.password, 10);
  const [r] = await db.execute(
    `INSERT INTO users (role, full_name, student_id, email, phone, password_hash, department_id, year)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.role,
      payload.full_name,
      payload.student_id || null,
      payload.email.toLowerCase(),
      payload.phone,
      hash,
      payload.department_id || null,
      payload.year || null,
    ]
  );
  return r.insertId;
}

module.exports = {
  register, login, getMe, changePassword, forgotPassword, resetPassword, adminCreateUser, signToken,
  // re-export middleware helpers for route convenience
  authenticate, authorize,
};
