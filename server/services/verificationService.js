'use strict';
/**
 * Verification service (Phase 2): official college / club accounts.
 *
 * SECURITY: account_type and verified are ONLY ever written here, and every
 * write path is admin-authorized at the route layer (authorize('ADMIN')).
 * User-submitted payloads can never carry account_type/verified straight into
 * a user row - they may only create a PENDING verification request.
 */
const db = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { notify } = require('../utils/notify');

const ORG_TYPES = ['college', 'club'];

/** Role a verified organisation needs so it can actually publish official content. */
const ROLE_FOR_TYPE = { college: 'FACULTY', club: 'ORGANIZER' };
const LABEL_FOR_TYPE = { college: 'College / Institution', club: 'Club / Organization' };

/** A user applies to become an official college or club account. */
async function requestVerification(user, payload = {}) {
  const accountType = String(payload.account_type || '').toLowerCase();
  if (!ORG_TYPES.includes(accountType)) {
    throw new ApiError(400, 'Choose whether you are a college or a club');
  }
  const orgName = String(payload.org_name || '').trim();
  if (orgName.length < 3) throw new ApiError(400, 'Organisation name is required');
  const orgDetails = String(payload.org_details || '').trim().slice(0, 2000);

  const [me] = await db.execute('SELECT id, account_type, verified FROM users WHERE id = ?', [user.id]);
  if (!me.length) throw new ApiError(404, 'User not found');
  if (Number(me[0].verified) === 1 && me[0].account_type === accountType) {
    throw new ApiError(409, 'This account is already verified');
  }

  const [pending] = await db.execute(
    "SELECT id FROM verification_requests WHERE user_id = ? AND status = 'PENDING'",
    [user.id]
  );
  if (pending.length) throw new ApiError(409, 'You already have a verification request under review');

  await db.execute(
    'INSERT INTO verification_requests (user_id, account_type, org_name, org_details) VALUES (?, ?, ?, ?)',
    [user.id, accountType, orgName.slice(0, 160), orgDetails]
  );

  const [admins] = await db.execute("SELECT id FROM users WHERE role = 'ADMIN' AND is_active = 1");
  for (const a of admins) {
    await notify(db, {
      recipientId: a.id, type: 'VERIFICATION',
      title: 'Verification request',
      message: `${orgName} requested a verified ${LABEL_FOR_TYPE[accountType]} account.`,
      relatedType: 'VERIFICATION', relatedId: null, link: '/admin/verification.html', priority: 1,
      dedupeKey: `verify-req-${user.id}-${orgName}`,
    });
  }
  return { status: 'PENDING' };
}

/** The signed-in user's latest request (so the UI can show review status). */
async function myRequest(user) {
  const [rows] = await db.execute(
    'SELECT id, account_type, org_name, org_details, status, review_note, created_at, reviewed_at\n' +
    '  FROM verification_requests WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [user.id]
  );
  return rows[0] || null;
}

/** Admin queue, newest first. */
async function listRequests({ status = 'PENDING', limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (ORG_TYPES.includes(status) || ['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
    where.push('v.status = ?');
    params.push(status);
  }
  const [rows] = await db.execute(
    `SELECT v.id, v.account_type, v.org_name, v.org_details, v.status, v.review_note,
            v.created_at, v.reviewed_at, v.user_id,
            u.full_name AS user_name, u.email AS user_email, u.student_id,
            u.account_type AS current_account_type, u.verified AS current_verified,
            r.full_name AS reviewer_name
       FROM verification_requests v
       JOIN users u ON u.id = v.user_id
       LEFT JOIN users r ON r.id = v.reviewed_by
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY v.created_at DESC
       LIMIT ?`,
    [...params, String(Math.min(300, Math.max(1, parseInt(limit, 10) || 100)))]
  );
  return rows.map((r) => ({ ...r, current_verified: !!Number(r.current_verified) }));
}

async function _pendingCount() {
  const [c] = await db.execute("SELECT COUNT(*) AS n FROM verification_requests WHERE status = 'PENDING'");
  return Number(c[0].n);
}

/**
 * Approve: flips the user into an official account.
 * The role is raised so the account can publish official content, but an
 * ADMIN's role is never touched.
 */
async function approve(adminUser, id) {
  const [rows] = await db.execute(
    'SELECT id, user_id, account_type, org_name, status FROM verification_requests WHERE id = ?',
    [parseInt(id, 10)]
  );
  if (!rows.length) throw new ApiError(404, 'Request not found');
  const req = rows[0];
  if (req.status !== 'PENDING') throw new ApiError(409, `This request is already ${req.status.toLowerCase()}`);

  const [users] = await db.execute('SELECT id, role, full_name FROM users WHERE id = ?', [req.user_id]);
  if (!users.length) throw new ApiError(404, 'User not found');
  const target = users[0];

  const nextRole = target.role === 'ADMIN' ? 'ADMIN' : ROLE_FOR_TYPE[req.account_type];
  await db.execute('UPDATE users SET account_type = ?, verified = 1, role = ? WHERE id = ?', [
    req.account_type, nextRole, target.id,
  ]);
  await db.execute(
    "UPDATE verification_requests SET status = 'APPROVED', reviewed_by = ?, reviewed_at = NOW(), review_note = NULL WHERE id = ?",
    [adminUser.id, req.id]
  );
  await notify(db, {
    recipientId: target.id, type: 'VERIFICATION',
    title: 'You are verified',
    message: `${req.org_name} is now an official ${LABEL_FOR_TYPE[req.account_type]} account with a verified badge.`,
    relatedType: 'USER', relatedId: target.id, link: '/profile.html', priority: 1,
    dedupeKey: `verify-ok-${req.id}`,
  });
  return { status: 'APPROVED', account_type: req.account_type, verified: true };
}

async function reject(adminUser, id, note = '') {
  const [rows] = await db.execute(
    'SELECT id, user_id, account_type, org_name, status FROM verification_requests WHERE id = ?',
    [parseInt(id, 10)]
  );
  if (!rows.length) throw new ApiError(404, 'Request not found');
  const req = rows[0];
  if (req.status !== 'PENDING') throw new ApiError(409, `This request is already ${req.status.toLowerCase()}`);
  const clean = String(note || '').trim().slice(0, 500) || null;

  await db.execute(
    "UPDATE verification_requests SET status = 'REJECTED', reviewed_by = ?, reviewed_at = NOW(), review_note = ? WHERE id = ?",
    [adminUser.id, clean, req.id]
  );
  await notify(db, {
    recipientId: req.user_id, type: 'VERIFICATION',
    title: 'Verification request declined',
    message: clean ? `Reason: ${clean}` : `Your verification request for ${req.org_name} was declined.`,
    relatedType: 'VERIFICATION', relatedId: req.id, link: '/profile.html', priority: 1,
    dedupeKey: `verify-no-${req.id}`,
  });
  return { status: 'REJECTED' };
}

/** Direct admin control: grant/revoke the badge without a request. */
async function setVerification(adminUser, userId, payload = {}) {
  const uid = parseInt(userId, 10);
  const [rows] = await db.execute('SELECT id, role, full_name, account_type, verified FROM users WHERE id = ?', [uid]);
  if (!rows.length) throw new ApiError(404, 'User not found');
  const target = rows[0];

  const accountType = String(payload.account_type || target.account_type || 'student').toLowerCase();
  const allowed = ['student', 'college', 'club', 'admin'];
  if (!allowed.includes(accountType)) throw new ApiError(400, 'Invalid account type');
  const verified = payload.verified === true || payload.verified === '1' || payload.verified === 1 ? 1 : 0;

  // Only official account types can hold a badge.
  const finalVerified = ['college', 'club'].includes(accountType) ? verified : 0;
  const nextRole = target.role === 'ADMIN' ? 'ADMIN' : (finalVerified ? ROLE_FOR_TYPE[accountType] : target.role);

  await db.execute('UPDATE users SET account_type = ?, verified = ?, role = ? WHERE id = ?', [
    accountType, finalVerified, nextRole, uid,
  ]);
  if (finalVerified) {
    await notify(db, {
      recipientId: uid, type: 'VERIFICATION',
      title: 'Verified badge granted',
      message: `An administrator granted your account official ${LABEL_FOR_TYPE[accountType]} status.`,
      relatedType: 'USER', relatedId: uid, link: '/profile.html', priority: 1,
      dedupeKey: `verify-grant-${uid}-${Date.now()}`,
    });
  }
  return { account_type: accountType, verified: !!finalVerified, role: nextRole };
}

/** Directory of official accounts (used by the admin page and Explore later). */
async function officialAccounts({ type = '' } = {}) {
  const where = ["u.verified = 1", "u.account_type IN ('college','club')"];
  const params = [];
  if (ORG_TYPES.includes(type)) { where.push('u.account_type = ?'); params.push(type); }
  const [rows] = await db.execute(
    `SELECT u.id, u.full_name, u.account_type, u.avatar_path, u.bio,
            (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id) AS follower_count,
            (SELECT COUNT(*) FROM posts p WHERE p.author_id = u.id) AS post_count
       FROM users u
       WHERE ${where.join(' AND ')}
       ORDER BY u.account_type ASC, u.full_name ASC`,
    params
  );
  return rows;
}

module.exports = {
  requestVerification, myRequest, listRequests, approve, reject, setVerification,
  officialAccounts, pendingCount: _pendingCount,
  ROLE_FOR_TYPE, LABEL_FOR_TYPE, ORG_TYPES,
};
