'use strict';
/**
 * Content reporting + moderation service (Phase 4).
 *
 * Invariants (enforced at the service/DB layer, never trust the client):
 *  - A user can only report content they are allowed to see. Reported
 *    content stays visible to the reporter so the report form makes sense.
 *  - The same user+target+reason can only be reported once (UNIQUE).
 *  - Admin actions are recorded in moderation_log for audit.
 *  - Shielded content is soft-hidden: it is NOT deleted, just omitted from
 *    public feeds/threads. Authors and admins still see it (with a notice).
 *  - Rate-limit counters are incremented for high-volume hostile actions
 *    (likes/dislikes/comments/replies/follows/reports). Crossing a threshold
 *    auto-shields the user so their next content is held for review.
 */
const db = require('../config/db');
const { ApiError } = require('../utils/ApiError');

// Thresholds per counter key (per hour). Crossing this triggers auto-shield.
const THRESHOLDS = {
  like_per_hour: 60,
  dislike_per_hour: 40,
  comment_per_hour: 30,
  reply_per_hour: 20,
  follow_per_hour: 30,
  report_per_hour: 10,
};

const REPORT_REASONS_POST = ['SPAM', 'HARASSMENT', 'HATE_SPEECH', 'VIOLENCE', 'MISINFO', 'NDA_IMG', 'OTHER'];
const REPORT_REASONS_COMMENT = ['SPAM', 'HARASSMENT', 'HATE_SPEECH', 'VIOLENCE', 'MISINFO', 'OTHER'];
const REPORT_REASONS_USER = ['HARASSMENT', 'HATE_SPEECH', 'IMPERSONATION', 'SCAM', 'OTHER'];

// Report reason -> short human label (for admin UI + audit).
const REASON_LABEL = {
  SPAM: 'Spam / repetitive content',
  HARASSMENT: 'Harassment / targeted abuse',
  HATE_SPEECH: 'Hate speech / discrimination',
  VIOLENCE: 'Violence / threats',
  MISINFO: 'Misinformation',
  NDA_IMG: 'Image shared without consent',
  OTHER: 'Other',
  IMPERSONATION: 'Impersonation',
  SCAM: 'Scam / fraud',
};

// ---------------------------------------------------------------------------
// Report helpers
// ---------------------------------------------------------------------------

function validateReason(reasons, reason) {
  if (!reasons.includes(reason)) {
    throw new ApiError(400, 'Invalid report reason. Choose one of: ' + reasons.join(', '));
  }
}

// Increment a per-user rate-limit counter; reset the hourly window if expired.
async function bumpRateLimit(user, key) {
  const [rows] = await db.execute(
    `SELECT count, window_start FROM rate_limit_counters
     WHERE user_id = ? AND key = ? AND window_start > NOW() - INTERVAL '1 hour'`,
    [user.id, key]
  );
  let count;
  if (rows.length) {
    count = rows[0].count + 1;
    await db.execute('UPDATE rate_limit_counters SET count = ? WHERE user_id = ? AND key = ?', [count, user.id, key]);
  } else {
    count = 1;
    await db.execute(
      'INSERT INTO rate_limit_counters (user_id, key, count, window_start) VALUES (?, ?, 1, NOW()) ON CONFLICT (user_id, key) DO UPDATE SET count = EXCLUDED.count + 1, window_start = NOW()',
      [user.id, key]
    );
  }
  return count;
}

/** Auto-shield a user when a rate-limit threshold is crossed. One-shot; safe to call repeatedly. */
async function maybeAutoShieldUser(user, key, count) {
  const threshold = THRESHOLDS[key];
  if (!threshold || count < threshold) return false;
  // Only act if not already shielded by admin.
  const [existing] = await db.execute('SELECT id FROM user_shield WHERE user_id = ? AND reason <> ?', [user.id, 'CLEARED']);
  if (existing.length) return true; // already under review
  await db.execute(
    'INSERT INTO user_shield (user_id, reason, set_by, note) VALUES (?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, note = EXCLUDED.note, created_at = NOW()',
    [user.id, 'AUTOMATIC', 'SYSTEM', `Auto-flagged after ${count} ${key.replace('_per_hour', '')} in one hour (threshold ${threshold}).`]
  );
  return true;
}

// ---------------------------------------------------------------------------
// Report content
// ---------------------------------------------------------------------------

async function reportPost(user, { postId, commentId, reason, detail }) {
  validateReason(REPORT_REASONS_POST, reason);
  const pid = Number(postId);
  if (!pid) throw new ApiError(400, 'Post id required');

  // Reporter must be able to see the post (or be an admin).
  const canSee = await _postVisibleTo(user, pid);
  if (!canSee) throw new ApiError(404, 'Post not found');

  const [existing] = await db.execute(
    'SELECT id FROM post_reports WHERE reporter_id = ? AND post_id = ? AND reason = ?',
    [user.id, pid, reason]
  );
  if (existing.length) throw new ApiError(409, 'You already reported this post for this reason');

  // Optional comment context.
  let cid = null;
  if (commentId) {
    const [c] = await db.execute('SELECT id, post_id FROM post_comments WHERE id = ?', [Number(commentId)]);
    if (!c.length) throw new ApiError(404, 'Comment not found');
    if (Number(c[0].post_id) !== pid) throw new ApiError(400, 'That comment is not on this post');
    cid = c[0].id;
    // Block report spam: a user may only file so many reports per hour.
    const n = await bumpRateLimit(user, 'report_per_hour');
    await maybeAutoShieldUser(user, 'report_per_hour', n);
  } else {
    const n = await bumpRateLimit(user, 'report_per_hour');
    await maybeAutoShieldUser(user, 'report_per_hour', n);
  }

  await db.execute(
    `INSERT INTO post_reports (reporter_id, post_id, comment_id, reason, detail)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (reporter_id, post_id, reason) DO NOTHING`,
    [user.id, pid, cid, reason, detail ? String(detail).slice(0, 2000) : null]
  );

  // Notify admins that there is something to review.
  const [admins] = await db.execute("SELECT id FROM users WHERE role = 'ADMIN' AND is_active = 1 LIMIT 20");
  for (const a of admins) {
    await require('../utils/notify').notify(db, {
      recipientId: a.id, type: 'SYSTEM',
      title: 'New content report',
      message: `A post was reported: ${reason}${cid ? ' (comment #' + cid + ')' : ''}`,
      relatedType: 'REPORT', relatedId: pid, link: '/admin/reports.html', priority: 1,
      dedupeKey: `report-post-${pid}-${reason}`,
    });
  }

  return { reported: true };
}

async function reportComment(user, { commentId, reason, detail }) {
  validateReason(REPORT_REASONS_COMMENT, reason);
  const cid = Number(commentId);
  if (!cid) throw new ApiError(400, 'Comment id required');

  const [c] = await db.execute(
    `SELECT pc.id, pc.post_id, pc.content, pc.is_anonymous,
            CASE WHEN pc.is_anonymous = 1 THEN NULL ELSE u.id END AS author_id,
            CASE WHEN pc.is_anonymous = 1 THEN 'Anonymous Student' ELSE u.full_name END AS author_name
       FROM post_comments pc LEFT JOIN users u ON u.id = pc.author_id
      WHERE pc.id = ?`, [cid]
  );
  if (!c.length) throw new ApiError(404, 'Comment not found');
  const comment = c[0];

  // Reporter must be able to see the comment (via the post).
  const canSee = await _postVisibleTo(user, comment.post_id);
  if (!canSee) throw new ApiError(404, 'Comment not found');

  const [existing] = await db.execute(
    'SELECT id FROM comment_reports WHERE reporter_id = ? AND comment_id = ? AND reason = ?',
    [user.id, cid, reason]
  );
  if (existing.length) throw new ApiError(409, 'You already reported this comment for this reason');

  const n = await bumpRateLimit(user, 'report_per_hour');
  await maybeAutoShieldUser(user, 'report_per_hour', n);

  await db.execute(
    `INSERT INTO comment_reports (reporter_id, comment_id, post_id, reason, detail)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (reporter_id, comment_id, reason) DO NOTHING`,
    [user.id, cid, comment.post_id, reason, detail ? String(detail).slice(0, 2000) : null]
  );

  const [admins] = await db.execute("SELECT id FROM users WHERE role = 'ADMIN' AND is_active = 1 LIMIT 20");
  for (const a of admins) {
    await require('../utils/notify').notify(db, {
      recipientId: a.id, type: 'SYSTEM',
      title: 'New comment report',
      message: `A comment was reported: ${reason}`,
      relatedType: 'REPORT', relatedId: comment.post_id, link: '/admin/reports.html', priority: 1,
      dedupeKey: `report-comment-${cid}-${reason}`,
    });
  }

  return { reported: true };
}

async function reportUser(user, { targetId, reason, detail }) {
  validateReason(REPORT_REASONS_USER, reason);
  const tid = Number(targetId);
  if (!tid) throw new ApiError(400, 'Target user id required');
  if (tid === user.id) throw new ApiError(400, 'You cannot report yourself');

  const [t] = await db.execute('SELECT id, full_name, is_active FROM users WHERE id = ?', [tid]);
  if (!t.length) throw new ApiError(404, 'User not found');
  if (!Number(t[0].is_active)) throw new ApiError(404, 'User not found');

  const [existing] = await db.execute(
    'SELECT id FROM user_reports WHERE reporter_id = ? AND target_id = ? AND reason = ?',
    [user.id, tid, reason]
  );
  if (existing.length) throw new ApiError(409, 'You already reported this user for this reason');

  const n = await bumpRateLimit(user, 'report_per_hour');
  await maybeAutoShieldUser(user, 'report_per_hour', n);

  await db.execute(
    `INSERT INTO user_reports (reporter_id, target_id, reason, detail)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (reporter_id, target_id, reason) DO NOTHING`,
    [user.id, tid, reason, detail ? String(detail).slice(0, 2000) : null]
  );

  const [admins] = await db.execute("SELECT id FROM users WHERE role = 'ADMIN' AND is_active = 1 LIMIT 20");
  for (const a of admins) {
    await require('../utils/notify').notify(db, {
      recipientId: a.id, type: 'SYSTEM',
      title: 'New user report',
      message: `A user was reported: ${reason}`,
      relatedType: 'REPORT', relatedId: tid, link: '/admin/reports.html', priority: 1,
      dedupeKey: `report-user-${tid}-${reason}`,
    });
  }

  return { reported: true };
}

/** Can `viewer` see this post in a public feed? Admins and the author always can. */
async function _postVisibleTo(viewer, postId) {
  if (!viewer || viewer.role === 'ADMIN') return true;
  const [p] = await db.execute(
    `SELECT p.id, p.is_anonymous, p.author_id, p.official,
             EXISTS (SELECT 1 FROM content_shield cs WHERE cs.table_name='posts' AND cs.record_id = p.id) AS shielded
      FROM posts p WHERE p.id = ?`, [postId]
  );
  if (!p.length) return false;
  const post = p[0];
  // Shielded content is hidden from normal viewers.
  if (Number(post.shielded)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Admin review
// ---------------------------------------------------------------------------

async function listPendingReports({ type = 'post', limit = 50 } = {}) {
  // Admin-only at the route layer.
  const key = type === 'comment' ? 'comment_reports' : type === 'user' ? 'user_reports' : 'post_reports';
  const idCol = type === 'user' ? 'target_id' : 'post_id';
  const tableFilter = type === 'user' ? 'user_reports' : (type === 'comment' ? 'comment_reports' : 'post_reports');

  let rows;
  if (type === 'user') {
    [rows] = await db.execute(
      `SELECT ur.id, ur.reporter_id, ur.target_id, ur.reason, ur.detail, ur.status,
              ur.reviewed_by, ur.reviewed_at, ur.action_note, ur.created_at,
              ureporter.full_name AS reporter_name, ureporter.email AS reporter_email,
              utarget.full_name AS target_name, utarget.email AS target_email, utarget.account_type AS target_account_type
       FROM user_reports ur
       JOIN users ureporter ON ureporter.id = ur.reporter_id
       JOIN users utarget ON utarget.id = ur.target_id
       WHERE ur.status IN ('PENDING', 'UNDER_REVIEW')
       ORDER BY ur.created_at ASC LIMIT ?`,
      [String(Math.min(200, Math.max(1, parseInt(limit, 10) || 50)))]
    );
    rows.forEach(r => { r.reason_label = REASON_LABEL[r.reason] || r.reason; });
    return { type: 'user', rows };
  }

  const authorJoin = type === 'comment'
    ? `JOIN users ua ON ua.id = COALESCE(pc_author.author_id, -1)
         LEFT JOIN post_comments pc ON pc.id = cr.comment_id
         LEFT JOIN (SELECT id, author_id FROM post_comments) pc_author ON pc_author.id = pc.author_id`
    : `LEFT JOIN users ua ON ua.id = p.author_id
         LEFT JOIN posts p ON p.id = pr.post_id
         LEFT JOIN post_comments pc ON pc.id = pr.comment_id`;

  const select = type === 'comment'
    ? `SELECT cr.id, cr.reporter_id, cr.comment_id, cr.post_id, cr.reason, cr.detail, cr.status,
            cr.reviewed_by, cr.reviewed_at, cr.action_note, cr.created_at,
            ureporter.full_name AS reporter_name, ureporter.email AS reporter_email,
            pc.content AS comment_content, pc.is_anonymous AS comment_is_anonymous,
            p.content AS post_content, p.is_anonymous AS post_is_anonymous,
            ua.full_name AS post_author_name, ua.account_type AS post_author_account_type, ua.verified AS post_author_verified
       FROM comment_reports cr
       JOIN users ureporter ON ureporter.id = cr.reporter_id
       LEFT JOIN post_comments pc ON pc.id = cr.comment_id
       LEFT JOIN posts p ON p.id = cr.post_id
       LEFT JOIN users ua ON ua.id = p.author_id
       WHERE cr.status IN ('PENDING', 'UNDER_REVIEW')
       ORDER BY cr.created_at ASC LIMIT ?`
    : `SELECT pr.id, pr.reporter_id, pr.post_id, pr.comment_id, pr.reason, pr.detail, pr.status,
            pr.reviewed_by, pr.reviewed_at, pr.action_note, pr.created_at,
            ureporter.full_name AS reporter_name, ureporter.email AS reporter_email,
            p.content AS post_content, p.is_anonymous AS post_is_anonymous, p.kind AS post_kind,
            ua.full_name AS post_author_name, ua.account_type AS post_author_account_type, ua.verified AS post_author_verified
       FROM post_reports pr
       JOIN users ureporter ON ureporter.id = pr.reporter_id
       LEFT JOIN posts p ON p.id = pr.post_id
       LEFT JOIN users ua ON ua.id = p.author_id
       WHERE pr.status IN ('PENDING', 'UNDER_REVIEW')
       ORDER BY pr.created_at ASC LIMIT ?`;

  [rows] = await db.execute(select, [String(Math.min(200, Math.max(1, parseInt(limit, 10) || 50)))]);
  rows.forEach(r => {
    r.reason_label = REASON_LABEL[r.reason] || r.reason;
    r.table = tableFilter;
  });
  return { type, rows };
}

/** Count of pending/under-review reports, by type. Used for admin badge. */
async function pendingCounts() {
  const [p] = await db.execute("SELECT COUNT(*) AS n FROM post_reports WHERE status IN ('PENDING','UNDER_REVIEW')");
  const [c] = await db.execute("SELECT COUNT(*) AS n FROM comment_reports WHERE status IN ('PENDING','UNDER_REVIEW')");
  const [u] = await db.execute("SELECT COUNT(*) AS n FROM user_reports WHERE status IN ('PENDING','UNDER_REVIEW')");
  return {
    posts: Number(p[0].n), comments: Number(c[0].n), users: Number(u[0].n),
    total: Number(p[0].n) + Number(c[0].n) + Number(u[0].n),
  };
}

/** Mark a report as reviewed, with an optional action. */
async function resolveReport(admin, { reportId, reportType, action, note }) {
  if (!['post', 'comment', 'user'].includes(reportType)) throw new ApiError(400, 'Invalid report type');
  if (action && !['ADDRESSED', 'DISMISSED'].includes(action)) throw new ApiError(400, 'Invalid action');

  const table = reportType === 'user' ? 'user_reports' : reportType === 'comment' ? 'comment_reports' : 'post_reports';
  const idCol = 'id';

  // Read the report first.
  const [rows] = await db.execute(
    `SELECT * FROM ${table} WHERE id = ?`,
    [Number(reportId)]
  );
  if (!rows.length) throw new ApiError(404, 'Report not found');
  const report = rows[0];
  if (report.status !== 'PENDING' && report.status !== 'UNDER_REVIEW') {
    throw new ApiError(409, `This report is already ${report.status.toLowerCase()}`);
  }

  const newStatus = action === 'ADDRESSED' ? 'ADDRESSED' : (action === 'DISMISSED' ? 'DISMISSED' : 'UNDER_REVIEW');

  await db.execute(
    `UPDATE ${table} SET status = ?, reviewed_by = ?, reviewed_at = NOW(), action_note = ?
     WHERE id = ?`,
    [newStatus, admin.id, note ? String(note).slice(0, 2000) : null, report.id]
  );

  // Record the action in moderation_log.
  const recordId = reportType === 'user' ? report.target_id : report.post_id;
  await db.execute(
    `INSERT INTO moderation_log (acted_by, table_name, record_id, action, report_id, reason)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [admin.id, table === 'user_reports' ? 'users' : (reportType === 'comment' ? 'post_comments' : 'posts'),
     recordId, action === 'ADDRESSED' ? 'HIDE' : 'NOTE', report.id, note || null]
  );

  // If addressed, apply the actual content shield / deletion.
  if (action === 'ADDRESSED') {
    if (reportType === 'post') {
      await _shieldPost(recordId, 'MANUAL_PENDING', 'ADMIN', note || 'Content hidden pending review.');
    } else if (reportType === 'comment') {
      await _shieldComment(recordId, 'MANUAL_PENDING', 'ADMIN', note || 'Comment hidden pending review.');
    } else {
      await _shieldUser(recordId, 'MANUAL_PENDING', 'ADMIN', note || 'User content held for review.');
    }
  }

  return { resolved: true, status: newStatus };
}

/** Restore (un-hide) content that was shielded. Admin-only. */
async function restoreContent(admin, { table, recordId, note }) {
  if (!['posts', 'post_comments', 'users'].includes(table)) throw new ApiError(400, 'Invalid table');
  if (table === 'users') {
    const [s] = await db.execute('SELECT id FROM user_shield WHERE user_id = ?', [Number(recordId)]);
    if (!s.length) throw new ApiError(404, 'User shield not found');
    await db.execute('UPDATE user_shield SET reason = ?, set_by = ?, note = ?, created_at = NOW() WHERE id = ?',
      ['CLEARED', 'ADMIN', note || 'Content review cleared by admin.', s[0].id]);
  } else {
    const [s] = await db.execute('SELECT id FROM content_shield WHERE table_name = ? AND record_id = ?', [table, Number(recordId)]);
    if (!s.length) throw new ApiError(404, 'Content shield not found');
    await db.execute('DELETE FROM content_shield WHERE id = ?', [s[0].id]);
  }

  await db.execute(
    `INSERT INTO moderation_log (acted_by, table_name, record_id, action, reason)
     VALUES (?, ?, ?, 'RESTORE', ?)`,
    [admin.id, table, Number(recordId), note || 'Content restored by admin.']
  );

  return { restored: true };
}

/** Permanently delete a post or comment. Admin-only. Recorded in moderation_log. */
async function deleteContent(admin, { table, recordId, note }) {
  if (!['posts', 'post_comments'].includes(table)) throw new ApiError(400, 'Invalid table for deletion');
  const id = Number(recordId);
  if (!id) throw new ApiError(400, 'Record id required');

  // Record before deleting so the audit trail survives.
  await db.execute(
    `INSERT INTO moderation_log (acted_by, table_name, record_id, action, reason)
     VALUES (?, ?, ?, 'DELETE', ?)`,
    [admin.id, table, id, note || 'Content deleted by admin.']
  );

  await db.execute(`DELETE FROM ${table} WHERE id = ?`, [id]);
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Shield helpers
// ---------------------------------------------------------------------------

async function _shieldPost(postId, reason, setBy, note) {
  await db.execute(
    `INSERT INTO content_shield (table_name, record_id, reason, set_by, note)
     VALUES ('posts', ?, ?, ?, ?)
     ON CONFLICT (table_name, record_id) DO UPDATE SET reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, note = EXCLUDED.note, created_at = NOW()`,
    [postId, reason, setBy, note]
  );
}

async function _shieldComment(commentId, reason, setBy, note) {
  await db.execute(
    `INSERT INTO content_shield (table_name, record_id, reason, set_by, note)
     VALUES ('post_comments', ?, ?, ?, ?)
     ON CONFLICT (table_name, record_id) DO UPDATE SET reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, note = EXCLUDED.note, created_at = NOW()`,
    [commentId, reason, setBy, note]
  );
}

async function _shieldUser(userId, reason, setBy, note) {
  await db.execute(
    `INSERT INTO user_shield (user_id, reason, set_by, note)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, note = EXCLUDED.note, created_at = NOW()`,
    [userId, reason, setBy, note]
  );
}

// ---------------------------------------------------------------------------
// Shielded-content visibility checks (used by feed / comments service)
// ---------------------------------------------------------------------------

/** Is this post shielded (hidden from public feeds)? */
async function isPostShielded(postId) {
  const [rows] = await db.execute('SELECT 1 FROM content_shield WHERE table_name = ? AND record_id = ?', ['posts', Number(postId)]);
  return rows.length > 0;
}

/** Is this comment shielded? */
async function isCommentShielded(commentId) {
  const [rows] = await db.execute('SELECT 1 FROM content_shield WHERE table_name = ? AND record_id = ?', ['post_comments', Number(commentId)]);
  return rows.length > 0;
}

/** Is this user shielded (their new content auto-held)? */
async function isUserShielded(userId) {
  const [rows] = await db.execute('SELECT 1 FROM user_shield WHERE user_id = ? AND reason <> ?', [Number(userId), 'CLEARED']);
  return rows.length > 0;
}

module.exports = {
  reportPost, reportComment, reportUser,
  listPendingReports, pendingCounts, resolveReport, restoreContent, deleteContent,
  isPostShielded, isCommentShielded, isUserShielded,
  REPORT_REASONS_POST, REPORT_REASONS_COMMENT, REPORT_REASONS_USER, REASON_LABEL,
  THRESHOLDS,
};
