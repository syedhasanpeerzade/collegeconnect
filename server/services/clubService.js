'use strict';
const db = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { nextPublicId } = require('../utils/helpers');
const { notify } = require('../utils/notify');

async function listClubs({ search = '', category = '', recruitment = '' } = {}) {
  const where = ["c.status = 'ACTIVE'"];
  const params = [];
  if (search) {
    where.push('(c.name LIKE ? OR c.description LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s);
  }
  if (category) { where.push('c.category = ?'); params.push(category); }
  if (recruitment) { where.push('c.recruitment_status = ?'); params.push(recruitment); }

  const [rows] = await db.execute(
    `SELECT c.id, c.name, c.category, c.description, c.recruitment_status, c.logo_path, c.banner_path,
            u.full_name AS faculty_coordinator,
            (SELECT COUNT(*) FROM club_members m WHERE m.club_id = c.id AND m.is_active = 1) AS member_count,
            (SELECT COUNT(*) FROM events e WHERE e.club_id = c.id AND e.is_published = 1
               AND e.status IN ('SCHEDULED','ONGOING')) AS upcoming_events
     FROM clubs c
     LEFT JOIN users u ON u.id = c.faculty_coordinator_id
     WHERE ${where.join(' AND ')}
     ORDER BY c.name ASC`,
    params
  );
  return rows;
}

async function getClub(id, userId) {
  const [rows] = await db.execute(
    `SELECT c.*, u.full_name AS faculty_coordinator, u.email AS faculty_email
     FROM clubs c LEFT JOIN users u ON u.id = c.faculty_coordinator_id
     WHERE c.id = ?`,
    [id]
  );
  const club = rows[0];
  if (!club) throw new ApiError(404, 'Club not found');

  const [[members], [coordinators], [upcoming], [past], [questions], [achievements]] = await Promise.all([
    db.execute(
      `SELECT m.id, m.role, m.joined_at, u.id AS user_id, u.full_name, u.student_id, d.code AS department, u.year
       FROM club_members m JOIN users u ON u.id = m.student_id
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE m.club_id = ? AND m.is_active = 1
       ORDER BY FIELD(m.role,'STUDENT_COORDINATOR','CORE_MEMBER','MEMBER'), u.full_name`,
      [id]
    ),
    db.execute(
      `SELECT u.id, u.full_name, u.email, u.department_id FROM club_coordinators cc
       JOIN users u ON u.id = cc.user_id WHERE cc.club_id = ?`,
      [id]
    ),
    db.execute(
      `SELECT id, public_id, title, category, event_date, start_time, venue
       FROM events WHERE club_id = ? AND is_published = 1 AND status IN ('SCHEDULED','ONGOING')
       ORDER BY event_date ASC LIMIT 10`,
      [id]
    ),
    db.execute(
      `SELECT id, public_id, title, category, event_date
       FROM events WHERE club_id = ? AND (status = 'COMPLETED' OR event_date < CURDATE())
       ORDER BY event_date DESC LIMIT 10`,
      [id]
    ),
    db.execute(
      `SELECT id, question, field_type, options, is_required FROM club_custom_questions
       WHERE club_id = ? ORDER BY display_order ASC, id ASC`,
      [id]
    ),
    db.execute(
      `SELECT id, public_id, title, achievement_year, position FROM achievements
       WHERE club_id = ? AND verification_status = 'VERIFIED' AND is_archived = 0
       ORDER BY achievement_year DESC LIMIT 10`,
      [id]
    ),
  ]);

  let myMembership = null;
  let myApplication = null;
  if (userId) {
    const [m] = await db.execute(
      'SELECT id, role, joined_at, is_active FROM club_members WHERE club_id = ? AND student_id = ?',
      [id, userId]
    );
    myMembership = m[0] || null;
    const [a] = await db.execute(
      `SELECT id, public_id, status, created_at, rejection_reason FROM club_applications
       WHERE club_id = ? AND student_id = ? ORDER BY id DESC LIMIT 1`,
      [id, userId]
    );
    myApplication = a[0] || null;
  }

  const activeMembers = members.filter((m) => m.role !== 'STUDENT_COORDINATOR').length + coordinators.length;
  delete club.created_by;
  return {
    ...club,
    member_count: members.length,
    members: members.map(({ user_id, ...rest }) => rest),
    coordinators,
    upcoming_events: upcoming,
    past_events: past,
    custom_questions: questions,
    achievements,
    my_membership: myMembership,
    my_application: myApplication,
  };
}

/** Student applies to a club with answers to custom questions. */
async function apply(clubId, userId, payload) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [clubs] = await conn.execute('SELECT id, name, status, recruitment_status FROM clubs WHERE id = ? FOR UPDATE', [clubId]);
    const club = clubs[0];
    if (!club) throw new ApiError(404, 'Club not found');
    if (club.recruitment_status !== 'OPEN') throw new ApiError(400, 'Recruitment is closed for this club');
    if (club.status !== 'ACTIVE') throw new ApiError(400, 'This club is not active');

    const [dupeApp] = await conn.execute(
      'SELECT id, status FROM club_applications WHERE club_id = ? AND student_id = ? FOR UPDATE',
      [clubId, userId]
    );
    if (dupeApp.length && ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED'].includes(String(dupeApp[0].status))) {
      throw new ApiError(409, 'You have already applied to this club');
    }
    const [dupeMember] = await conn.execute(
      'SELECT id FROM club_members WHERE club_id = ? AND student_id = ? AND is_active = 1 FOR UPDATE',
      [clubId, userId]
    );
    if (dupeMember.length) throw new ApiError(409, 'You are already a member of this club');

    const publicId = await nextPublicId(conn, 'club_applications', 'public_id', 'CC-APP');
    const [ins] = await conn.execute(
      `INSERT INTO club_applications (public_id, club_id, student_id, why_join, experience, skills, interests, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'SUBMITTED')`,
      [publicId, clubId, userId, payload.why_join, payload.experience || null, payload.skills || null, payload.interests || null]
    );
    const applicationId = ins.insertId;

    // Save custom question answers (required ones enforced)
    const [questions] = await conn.execute('SELECT id, question, is_required FROM club_custom_questions WHERE club_id = ?', [clubId]);
    const answers = payload.answers || {};
    for (const q of questions) {
      const val = answers[q.id] !== undefined ? String(answers[q.id]).trim() : '';
      if (q.is_required && !val) throw new ApiError(400, `Please answer: ${q.question}`);
      if (val) {
        await conn.execute(
          'INSERT INTO club_application_answers (application_id, question_id, answer) VALUES (?, ?, ?)',
          [applicationId, q.id, val]
        );
      }
    }

    // Notify club coordinators
    const [coords] = await conn.execute('SELECT user_id FROM club_coordinators WHERE club_id = ?', [clubId]);
    for (const c of coords) {
      await notify(conn, {
        recipientId: c.user_id, type: 'CLUB_APPLICATION',
        title: 'New club application', message: `A new application was submitted to ${club.name}.`,
        relatedType: 'CLUB_APPLICATION', relatedId: applicationId, link: '/coordinator/applications.html',
      });
    }

    await conn.commit();
    return { id: applicationId, public_id: publicId, club_name: club.name };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function myApplications(userId) {
  const [rows] = await db.execute(
    `SELECT a.id, a.public_id, a.status, a.created_at, a.rejection_reason,
            c.id AS club_id, c.name AS club_name, c.logo_path
     FROM club_applications a JOIN clubs c ON c.id = a.club_id
     WHERE a.student_id = ?
     ORDER BY a.created_at DESC`,
    [userId]
  );
  const [memberRows] = await db.execute(
    `SELECT m.id, m.role, m.joined_at, m.is_active, c.id AS club_id, c.name AS club_name, c.logo_path
     FROM club_members m JOIN clubs c ON c.id = m.club_id
     WHERE m.student_id = ?
     ORDER BY m.joined_at DESC`,
    [userId]
  );
  return { applications: rows, memberships: memberRows };
}

function assertCoordinatorAccess(user, clubId) {
  // Returns true if user is an assigned coordinator of the club
  return db.execute('SELECT id FROM club_coordinators WHERE club_id = ? AND user_id = ?', [clubId, user.id])
    .then(([rows]) => {
      if (!rows.length) throw new ApiError(403, 'You are not the coordinator of this club');
      return true;
    });
}

async function clubApplications(clubId, user, status = '') {
  if (user.role === 'CLUB_COORDINATOR') await assertCoordinatorAccess(user, clubId);
  const params = [clubId];
  let w = '';
  if (status) { w = 'AND a.status = ?'; params.push(status); }
  const [rows] = await db.execute(
    `SELECT a.*, u.full_name, u.student_id, u.email, u.phone, u.year, d.code AS department, d.name AS department_name
     FROM club_applications a
     JOIN users u ON u.id = a.student_id
     LEFT JOIN departments d ON d.id = u.department_id
     WHERE a.club_id = ? ${w}
     ORDER BY FIELD(a.status,'SUBMITTED','UNDER_REVIEW','APPROVED','REJECTED'), a.created_at DESC`,
    params
  );
  // attach custom answers
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    const [ans] = await db.execute(
      `SELECT aa.application_id, aa.question_id, aa.answer, q.question
       FROM club_application_answers aa JOIN club_custom_questions q ON q.id = aa.question_id
       WHERE aa.application_id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    const map = new Map();
    for (const a of ans) {
      if (!map.has(a.application_id)) map.set(a.application_id, []);
      map.get(a.application_id).push({ question: a.question, answer: a.answer });
    }
    rows.forEach((r) => { r.custom_answers = map.get(r.id) || []; });
  }
  return rows;
}

async function reviewApplication(applicationId, reviewer, decision, rejectionReason) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT a.*, c.name AS club_name FROM club_applications a JOIN clubs c ON c.id = a.club_id
       WHERE a.id = ? FOR UPDATE`,
      [applicationId]
    );
    const app = rows[0];
    if (!app) throw new ApiError(404, 'Application not found');
    if (reviewer.role === 'CLUB_COORDINATOR') await assertCoordinatorAccess(reviewer, app.club_id);
    if (app.status === 'APPROVED') throw new ApiError(400, 'Application is already approved');
    if (app.status === 'REJECTED') throw new ApiError(400, 'Application is already rejected');

    if (decision === 'approve') {
      await conn.execute(
        `UPDATE club_applications SET status = 'APPROVED', reviewed_by = ?, reviewed_at = NOW() WHERE id = ?`,
        [reviewer.id, applicationId]
      );
      // Create membership if not present (unique key protects duplicates)
      const [existing] = await conn.execute(
        'SELECT id, is_active FROM club_members WHERE club_id = ? AND student_id = ? FOR UPDATE',
        [app.club_id, app.student_id]
      );
      if (existing.length) {
        await conn.execute('UPDATE club_members SET is_active = 1 WHERE id = ?', [existing[0].id]);
      } else {
        await conn.execute(
          'INSERT INTO club_members (club_id, student_id, role) VALUES (?, ?, "MEMBER")',
          [app.club_id, app.student_id]
        );
      }
      await notify(conn, {
        recipientId: app.student_id, type: 'CLUB_APPLICATION_APPROVED',
        title: 'Club application approved',
        message: `Congratulations! Your application to ${app.club_name} has been approved.`,
        relatedType: 'CLUB', relatedId: app.club_id, link: '/clubs.html',
      });
    } else {
      await conn.execute(
        `UPDATE club_applications SET status = 'REJECTED', rejection_reason = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?`,
        [rejectionReason || 'Not specified', reviewer.id, applicationId]
      );
      await notify(conn, {
        recipientId: app.student_id, type: 'CLUB_APPLICATION_REJECTED',
        title: 'Club application rejected',
        message: `Your application to ${app.club_name} was not accepted. Reason: ${rejectionReason || 'Not specified'}`,
        relatedType: 'CLUB', relatedId: app.club_id, link: '/clubs.html',
      });
    }

    await conn.commit();
    return { status: decision === 'approve' ? 'APPROVED' : 'REJECTED' };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** Coordinators can mark an application under review. */
async function markUnderReview(applicationId, user) {
  const [rows] = await db.execute('SELECT club_id, status FROM club_applications WHERE id = ?', [applicationId]);
  if (!rows.length) throw new ApiError(404, 'Application not found');
  if (user.role === 'CLUB_COORDINATOR') await assertCoordinatorAccess(user, rows[0].club_id);
  if (rows[0].status !== 'SUBMITTED') throw new ApiError(400, 'Only submitted applications can move to review');
  await db.execute(`UPDATE club_applications SET status = 'UNDER_REVIEW' WHERE id = ?`, [applicationId]);
}

async function removeMember(clubId, memberId, user) {
  if (user.role === 'CLUB_COORDINATOR') await assertCoordinatorAccess(user, clubId);
  const [rows] = await db.execute(
    `SELECT m.id, u.full_name FROM club_members m JOIN users u ON u.id = m.student_id
     WHERE m.id = ? AND m.club_id = ?`,
    [memberId, clubId]
  );
  if (!rows.length) throw new ApiError(404, 'Member not found in this club');
  await db.execute('UPDATE club_members SET is_active = 0 WHERE id = ?', [memberId]);
  return { name: rows[0].full_name };
}

async function setMemberRole(clubId, memberId, role, user) {
  if (user.role === 'CLUB_COORDINATOR') await assertCoordinatorAccess(user, clubId);
  if (!['MEMBER', 'CORE_MEMBER', 'STUDENT_COORDINATOR'].includes(role)) throw new ApiError(400, 'Invalid role');
  const [r] = await db.execute('UPDATE club_members SET role = ? WHERE id = ? AND club_id = ?', [role, memberId, clubId]);
  if (!r.affectedRows) throw new ApiError(404, 'Member not found in this club');
}

/** Coordinator updates club info / recruitment status. */
async function updateClub(clubId, user, payload) {
  if (user.role === 'CLUB_COORDINATOR') await assertCoordinatorAccess(user, clubId);
  const allowed = ['description', 'objectives', 'activities', 'achievements', 'eligibility', 'recruitment_status', 'status'];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (payload[k] !== undefined) {
      if (k === 'recruitment_status' && !['OPEN', 'CLOSED'].includes(payload[k])) throw new ApiError(400, 'Invalid recruitment status');
      if (k === 'status' && !['ACTIVE', 'INACTIVE'].includes(payload[k])) throw new ApiError(400, 'Invalid status');
      sets.push(`${k} = ?`);
      params.push(payload[k]);
    }
  }
  if (payload.logo_path) { sets.push('logo_path = ?'); params.push(payload.logo_path); }
  if (payload.banner_path) { sets.push('banner_path = ?'); params.push(payload.banner_path); }
  if (!sets.length) throw new ApiError(400, 'Nothing to update');
  params.push(clubId);
  await db.execute(`UPDATE clubs SET ${sets.join(', ')} WHERE id = ?`, params);
}

async function addCustomQuestion(clubId, user, payload) {
  if (user.role === 'CLUB_COORDINATOR') await assertCoordinatorAccess(user, clubId);
  if (!payload.question || !String(payload.question).trim()) throw new ApiError(400, 'Question text is required');
  const fieldType = ['TEXT', 'TEXTAREA', 'SELECT'].includes(payload.field_type) ? payload.field_type : 'TEXT';
  if (fieldType === 'SELECT' && !payload.options) throw new ApiError(400, 'SELECT questions need options');
  const [maxRow] = await db.execute('SELECT COALESCE(MAX(display_order),0)+1 AS next FROM club_custom_questions WHERE club_id = ?', [clubId]);
  const [r] = await db.execute(
    `INSERT INTO club_custom_questions (club_id, question, field_type, options, is_required, display_order)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [clubId, String(payload.question).trim(), fieldType, payload.options || null, payload.is_required === false ? 0 : 1, maxRow[0].next]
  );
  return { id: r.insertId };
}

async function deleteCustomQuestion(clubId, questionId, user) {
  if (user.role === 'CLUB_COORDINATOR') await assertCoordinatorAccess(user, clubId);
  const [r] = await db.execute('DELETE FROM club_custom_questions WHERE id = ? AND club_id = ?', [questionId, clubId]);
  if (!r.affectedRows) throw new ApiError(404, 'Question not found');
}

/** Coordinator-only: clubs this user coordinates. */
async function myCoordinatedClubs(userId) {
  const [rows] = await db.execute(
    `SELECT c.*, u.full_name AS faculty_coordinator,
            (SELECT COUNT(*) FROM club_members m WHERE m.club_id = c.id AND m.is_active = 1) AS member_count,
            (SELECT COUNT(*) FROM club_applications a WHERE a.club_id = c.id AND a.status IN ('SUBMITTED','UNDER_REVIEW')) AS pending_applications,
            (SELECT COUNT(*) FROM events e WHERE e.club_id = c.id AND e.status IN ('SCHEDULED','ONGOING') AND e.is_published = 1) AS upcoming_events,
            (SELECT COUNT(*) FROM event_registrations r JOIN events e2 ON e2.id = r.event_id
               WHERE e2.club_id = c.id AND r.status = 'REGISTERED') AS total_registrations
     FROM club_coordinators cc
     JOIN clubs c ON c.id = cc.club_id
     LEFT JOIN users u ON u.id = c.faculty_coordinator_id
     WHERE cc.user_id = ?
     ORDER BY c.name`,
    [userId]
  );
  return rows;
}

module.exports = {
  listClubs, getClub, apply, myApplications, clubApplications, reviewApplication,
  markUnderReview, removeMember, setMemberRole, updateClub, addCustomQuestion,
  deleteCustomQuestion, myCoordinatedClubs, assertCoordinatorAccess,
};
