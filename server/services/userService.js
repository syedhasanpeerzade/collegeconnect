'use strict';
const db = require('../config/db');
const { ApiError } = require('../utils/ApiError');

async function listUsers({ search = '', role = '', department = '', status = '', limit = 200 } = {}) {
  const where = ['1=1'];
  const params = [];
  if (search) {
    where.push('(u.full_name LIKE ? OR u.email LIKE ? OR u.student_id LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  if (role) { where.push('u.role = ?'); params.push(role); }
  if (department) { where.push('u.department_id = ?'); params.push(parseInt(department, 10)); }
  if (status === 'active') where.push('u.is_active = 1');
  if (status === 'inactive') where.push('u.is_active = 0');

  const [rows] = await db.execute(
    `SELECT u.id, u.role, u.full_name, u.student_id, u.email, u.phone, u.year, u.is_active,
            u.created_at, u.last_login_at, d.code AS department_code, d.name AS department_name
     FROM users u LEFT JOIN departments d ON d.id = u.department_id
     WHERE ${where.join(' AND ')}
     ORDER BY u.created_at DESC
     LIMIT ${parseInt(limit, 10) || 200}`,
    params
  );
  return rows;
}

async function setUserActive(id, isActive, actor) {
  if (parseInt(id, 10) === actor.id) throw new ApiError(400, 'You cannot deactivate your own account');
  const [rows] = await db.execute('SELECT id, full_name, is_active FROM users WHERE id = ?', [id]);
  if (!rows.length) throw new ApiError(404, 'User not found');
  await db.execute('UPDATE users SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, id]);
  return { name: rows[0].full_name, is_active: isActive };
}

async function setUserRole(id, role, actor) {
  const ROLES = ['STUDENT', 'ORGANIZER', 'CLUB_COORDINATOR', 'FACULTY', 'ADMIN'];
  if (!ROLES.includes(role)) throw new ApiError(400, 'Invalid role');
  if (parseInt(id, 10) === actor.id && role !== 'ADMIN') {
    throw new ApiError(400, 'You cannot demote your own admin account');
  }
  const [r] = await db.execute('UPDATE users SET role = ? WHERE id = ?', [role, id]);
  if (!r.affectedRows) throw new ApiError(404, 'User not found');
}

module.exports = { listUsers, setUserActive, setUserRole };
