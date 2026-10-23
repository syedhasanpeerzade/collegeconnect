'use strict';
const db = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { nextPublicId } = require('../utils/helpers');
const { notify } = require('../utils/notify');

const STATUSES = ['SUBMITTED', 'UNDER_REVIEW', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REOPENED'];

async function create(userId, payload, attachmentPath) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const publicId = await nextPublicId(conn, 'complaints', 'public_id', 'CC-CMP');
    const [r] = await conn.execute(
      `INSERT INTO complaints (public_id, student_id, title, description, category, location, priority, attachment_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [publicId, userId, payload.title, payload.description, payload.category,
       payload.location || null, payload.priority || 'MEDIUM', attachmentPath]
    );
    await conn.execute(
      `INSERT INTO complaint_updates (complaint_id, old_status, new_status, remarks, changed_by)
       VALUES (?, NULL, 'SUBMITTED', 'Complaint submitted', ?)`,
      [r.insertId, userId]
    );
    await conn.commit();
    return { id: r.insertId, public_id: publicId };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function listFor(user, { status = '', category = '', priority = '', mine = false }) {
  const where = [];
  const params = [];
  if (mine || user.role === 'STUDENT') { where.push('c.student_id = ?'); params.push(user.id); }
  if (status) { where.push('c.status = ?'); params.push(status); }
  if (category) { where.push('c.category = ?'); params.push(category); }
  if (priority) { where.push('c.priority = ?'); params.push(priority); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await db.execute(
    `SELECT c.*, u.full_name AS student_name, u.student_id AS student_number, d.code AS department_code
     FROM complaints c
     JOIN users u ON u.id = c.student_id
     LEFT JOIN departments d ON d.id = u.department_id
     ${w}
     ORDER BY FIELD(c.priority,'URGENT','HIGH','MEDIUM','LOW'), c.created_at DESC
     LIMIT 200`,
    params
  );
  return rows;
}

async function getOne(id, user) {
  const [rows] = await db.execute(
    `SELECT c.*, u.full_name AS student_name, u.student_id AS student_number, u.email AS student_email,
            d.code AS department_code
     FROM complaints c
     JOIN users u ON u.id = c.student_id
     LEFT JOIN departments d ON d.id = u.department_id
     WHERE c.id = ?`,
    [id]
  );
  const complaint = rows[0];
  if (!complaint) throw new ApiError(404, 'Complaint not found');
  if (user.role === 'STUDENT' && complaint.student_id !== user.id) {
    throw new ApiError(403, 'You can only view your own complaints');
  }
  const [history] = await db.execute(
    `SELECT cu.*, u.full_name AS changed_by_name
     FROM complaint_updates cu LEFT JOIN users u ON u.id = cu.changed_by
     WHERE cu.complaint_id = ? ORDER BY cu.created_at ASC`,
    [id]
  );
  return { ...complaint, history };
}

async function updateStatus(id, user, { status, remarks, assigned_to }) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT * FROM complaints WHERE id = ? FOR UPDATE', [id]);
    const complaint = rows[0];
    if (!complaint) throw new ApiError(404, 'Complaint not found');
    if (!STATUSES.includes(status)) throw new ApiError(400, 'Invalid status');
    if (complaint.status === 'CLOSED') throw new ApiError(400, 'Complaint is closed and cannot be updated');

    // Simple lifecycle sanity checks
    const flow = { SUBMITTED: 0, UNDER_REVIEW: 1, ASSIGNED: 2, IN_PROGRESS: 3, RESOLVED: 4, CLOSED: 5, REOPENED: 1 };
    if (flow[status] < flow[complaint.status] && !(complaint.status === 'RESOLVED' && status === 'IN_PROGRESS')) {
      throw new ApiError(400, `Cannot move from ${complaint.status} back to ${status}`);
    }

    await conn.execute(
      `UPDATE complaints SET status = ?, assigned_to = COALESCE(?, assigned_to),
        resolved_at = ${status === 'RESOLVED' ? 'NOW()' : 'resolved_at'},
        closed_at = ${status === 'CLOSED' ? 'NOW()' : 'closed_at'}
       WHERE id = ?`,
      [status, assigned_to || null, id]
    );
    await conn.execute(
      `INSERT INTO complaint_updates (complaint_id, old_status, new_status, remarks, changed_by)
       VALUES (?, ?, ?, ?, ?)`,
      [id, complaint.status, status, remarks || null, user.id]
    );

    // Notify the student
    const type = status === 'RESOLVED' ? 'COMPLAINT_RESOLVED' : 'COMPLAINT_STATUS';
    await notify(conn, {
      recipientId: complaint.student_id, type,
      title: status === 'RESOLVED' ? 'Complaint resolved' : 'Complaint status updated',
      message: `Your complaint "${complaint.title}" is now ${status.replace('_', ' ')}${remarks ? ` - ${remarks}` : ''}.`,
      relatedType: 'COMPLAINT', relatedId: id, link: `/complaint-details.html?id=${id}`,
    });

    await conn.commit();
    return { status };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** Student confirms resolution or reopens. */
async function studentFeedback(id, userId, { action, feedback, rating }) {
  const [rows] = await db.execute('SELECT * FROM complaints WHERE id = ?', [id]);
  const complaint = rows[0];
  if (!complaint) throw new ApiError(404, 'Complaint not found');
  if (complaint.student_id !== userId) throw new ApiError(403, 'You can only manage your own complaints');

  if (action === 'confirm') {
    if (complaint.status !== 'RESOLVED') throw new ApiError(400, 'Only resolved complaints can be confirmed');
    await db.execute(
      'UPDATE complaints SET status = ?, closed_at = NOW(), feedback = ?, feedback_rating = ? WHERE id = ?',
      ['CLOSED', feedback || complaint.feedback, rating || complaint.feedback_rating, id]
    );
    await db.execute(
      `INSERT INTO complaint_updates (complaint_id, old_status, new_status, remarks, changed_by)
       VALUES (?, 'RESOLVED', 'CLOSED', ?, ?)`,
      [id, feedback || 'Student confirmed resolution', userId]
    );
    return { status: 'CLOSED' };
  }

  if (action === 'reopen') {
    if (!['RESOLVED', 'CLOSED'].includes(complaint.status)) {
      throw new ApiError(400, 'Only resolved or closed complaints can be reopened');
    }
    if (!feedback || feedback.trim().length < 10) {
      throw new ApiError(400, 'Please describe why you are reopening this complaint (min 10 characters)');
    }
    await db.execute(
      `UPDATE complaints SET status = 'REOPENED', feedback = NULL, feedback_rating = NULL, resolved_at = NULL, closed_at = NULL WHERE id = ?`,
      [id]
    );
    await db.execute(
      `INSERT INTO complaint_updates (complaint_id, old_status, new_status, remarks, changed_by)
       VALUES (?, ?, 'REOPENED', ?, ?)`,
      [id, complaint.status, feedback, userId]
    );
    // Notify all admins/faculty
    const [staff] = await db.execute(`SELECT id FROM users WHERE role IN ('ADMIN','FACULTY') AND is_active = 1`);
    for (const s of staff) {
      await notify(db, {
        recipientId: s.id, type: 'COMPLAINT_STATUS',
        title: 'Complaint reopened',
        message: `"${complaint.title}" was reopened by the student. Reason: ${feedback}`,
        relatedType: 'COMPLAINT', relatedId: id, link: `/faculty/complaints.html`,
      });
    }
    return { status: 'REOPENED' };
  }

  if (action === 'feedback') {
    await db.execute('UPDATE complaints SET feedback = ?, feedback_rating = ? WHERE id = ?',
      [feedback || null, rating || null, id]);
    return { status: complaint.status };
  }

  throw new ApiError(400, 'Invalid action');
}

module.exports = { create, listFor, getOne, updateStatus, studentFeedback, STATUSES };
