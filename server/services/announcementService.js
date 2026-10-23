'use strict';
const db = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { notify } = require('../utils/notify');

const CATEGORIES = ['GENERAL', 'EVENT', 'CLUB', 'ACADEMIC', 'URGENT'];
const AUDIENCES = ['ALL', 'STUDENTS', 'FACULTY', 'STAFF'];

async function listFor(user, { category = '' } = {}) {
  const where = ['(a.expiry_date IS NULL OR a.expiry_date >= CURDATE())'];
  const params = [];
  if (user && user.role === 'STUDENT') {
    where.push("a.audience IN ('ALL','STUDENTS')");
  } else if (user && user.role === 'FACULTY') {
    where.push("a.audience IN ('ALL','FACULTY')");
  }
  if (category && CATEGORIES.includes(category)) { where.push('a.category = ?'); params.push(category); }

  const [rows] = await db.execute(
    `SELECT a.*, u.full_name AS created_by_name, u.role AS created_by_role
     FROM announcements a LEFT JOIN users u ON u.id = a.created_by
     WHERE ${where.join(' AND ')}
     ORDER BY a.published_at DESC LIMIT 100`,
    params
  );
  return rows;
}

async function create(user, payload, attachmentPath) {
  if (!payload.title || !payload.description) throw new ApiError(400, 'Title and description are required');
  const [r] = await db.execute(
    `INSERT INTO announcements (title, description, category, audience, expiry_date, attachment_path, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [payload.title, payload.description, payload.category || 'GENERAL', payload.audience || 'ALL',
     payload.expiry_date || null, attachmentPath, user.id]
  );
  // Notify students about new announcements (admins choose urgent vs normal)
  if ((payload.category || 'GENERAL') === 'URGENT' || (payload.audience || 'ALL') === 'ALL') {
    const [students] = await db.execute(`SELECT id FROM users WHERE role = 'STUDENT' AND is_active = 1 LIMIT 500`);
    for (const s of students) {
      await notify(db, {
        recipientId: s.id, type: 'ANNOUNCEMENT',
        title: 'New announcement', message: payload.title,
        relatedType: 'ANNOUNCEMENT', relatedId: r.insertId, link: '/announcements.html',
      });
    }
  }
  return { id: r.insertId };
}

async function update(id, user, payload, attachmentPath) {
  const [rows] = await db.execute('SELECT id FROM announcements WHERE id = ?', [id]);
  if (!rows.length) throw new ApiError(404, 'Announcement not found');
  await db.execute(
    `UPDATE announcements SET title = ?, description = ?, category = ?, audience = ?, expiry_date = ?
     ${attachmentPath ? ', attachment_path = ?' : ''}
     WHERE id = ?`,
    attachmentPath
      ? [payload.title, payload.description, payload.category || 'GENERAL', payload.audience || 'ALL', payload.expiry_date || null, attachmentPath, id]
      : [payload.title, payload.description, payload.category || 'GENERAL', payload.audience || 'ALL', payload.expiry_date || null, id]
  );
}

async function remove(id) {
  const [r] = await db.execute('DELETE FROM announcements WHERE id = ?', [id]);
  if (!r.affectedRows) throw new ApiError(404, 'Announcement not found');
}

module.exports = { listFor, create, update, remove, CATEGORIES, AUDIENCES };
