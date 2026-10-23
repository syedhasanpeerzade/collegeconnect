'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { nextPublicId } = require('../utils/helpers');
const { notify } = require('../utils/notify');
const { UPLOAD_ROOT } = require('../middleware/upload');

const CATEGORIES = [
  'TECHNICAL', 'SPORTS', 'CULTURAL', 'ACADEMIC', 'HACKATHON', 'INNOVATION',
  'RESEARCH', 'LEADERSHIP', 'SOCIAL_SERVICE', 'OTHER',
];
const POSITIONS = [
  '1ST_PLACE', '2ND_PLACE', '3RD_PLACE', 'WINNER', 'RUNNER_UP',
  'FINALIST', 'PARTICIPATION', 'OTHER',
];

/**
 * Photos are stored on disk under server/uploads/achievements/ by the existing
 * multer upload middleware. The database only ever stores the resulting path in
 * achievement_media.file_path (e.g. /uploads/achievements/photo.jpg) - image
 * bytes are never written into a text column.
 */
const PHOTO_DIR = 'achievements';

const LIST_SELECT = `
  SELECT a.id, a.public_id, a.title, a.competition_name, a.category, a.description,
         a.achievement_year, a.position, a.verification_status, a.is_archived,
         a.created_at, a.created_by,
         a.event_date, a.event_venue AS venue, a.prize_details,
         d.name AS department_name, d.code AS department_code,
         c.name AS club_name, c.id AS club_id,
         e.title AS event_title, e.id AS event_id,
         u.full_name AS created_by_name,
         v.full_name AS verified_by_name,
         (SELECT GROUP_CONCAT(w.winner_name SEPARATOR ', ') FROM achievement_winners w
            WHERE w.achievement_id = a.id AND w.winner_name IS NOT NULL) AS winner_names,
         (SELECT w2.team_name FROM achievement_winners w2
            WHERE w2.achievement_id = a.id AND w2.team_name IS NOT NULL LIMIT 1) AS team_name,
         (SELECT GROUP_CONCAT(w3.user_id) FROM achievement_winners w3
            WHERE w3.achievement_id = a.id AND w3.user_id IS NOT NULL) AS winner_user_ids,
         (SELECT m2.file_path FROM achievement_media m2
            WHERE m2.achievement_id = a.id AND m2.file_type = 'PHOTO'
            ORDER BY m2.id ASC LIMIT 1) AS thumbnail_path,
         (SELECT m3.file_path FROM achievement_media m3
            WHERE m3.achievement_id = a.id AND m3.file_type = 'CERTIFICATE'
            ORDER BY m3.id ASC LIMIT 1) AS certificate_path,
         (SELECT COUNT(*) FROM achievement_media m WHERE m.achievement_id = a.id) AS media_count,
         (SELECT COUNT(*) FROM achievement_media m4 WHERE m4.achievement_id = a.id
            AND m4.file_type = 'PHOTO') AS photo_count
  FROM achievements a
  LEFT JOIN departments d ON d.id = a.department_id
  LEFT JOIN clubs c ON c.id = a.club_id
  LEFT JOIN events e ON e.id = a.event_id
  LEFT JOIN users u ON u.id = a.created_by
  LEFT JOIN users v ON v.id = a.verified_by
`;

function visibilityClause(user) {
  if (user && ['ADMIN', 'FACULTY'].includes(user.role)) {
    return { sql: 'a.is_archived = 0', params: [] };
  }
  return {
    sql: "a.is_archived = 0 AND a.verification_status = 'VERIFIED'",
    params: [],
  };
}

async function list(user, { search = '', category = '', year = '', department = '',
  club = '', status = '', sort = 'year_desc', limit = 12, offset = 0 } = {}) {
  const vis = visibilityClause(user);
  const where = [vis.sql];
  const params = [...vis.params];
  if (search) {
    where.push('(a.title LIKE ? OR a.competition_name LIKE ? OR a.description LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  if (category && CATEGORIES.includes(category)) { where.push('a.category = ?'); params.push(category); }
  if (year) { where.push('a.achievement_year = ?'); params.push(parseInt(year, 10)); }
  if (department) { where.push('a.department_id = ?'); params.push(parseInt(department, 10)); }
  if (club) { where.push('a.club_id = ?'); params.push(parseInt(club, 10)); }
  if (status && user && ['ADMIN', 'FACULTY'].includes(user.role)) {
    where.push('a.verification_status = ?');
    params.push(status);
  }

  const order = {
    year_desc: 'a.achievement_year DESC, a.created_at DESC',
    year_asc: 'a.achievement_year ASC, a.created_at ASC',
    newest: 'a.created_at DESC',
  }[sort] || 'a.achievement_year DESC';

  const lim = Math.min(Math.max(parseInt(limit, 10) || 12, 1), 100);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const [rows] = await db.execute(
    `${LIST_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${lim} OFFSET ${off}`,
    params,
  );
  return rows;
}

async function detail(id, user) {
  const [rows] = await db.execute(`${LIST_SELECT} WHERE a.id = ?`, [id]);
  const a = rows[0];
  if (!a) throw new ApiError(404, 'Achievement not found');
  const isStaff = user && ['ADMIN', 'FACULTY'].includes(user.role);
  if (!isStaff && a.verification_status !== 'VERIFIED') throw new ApiError(404, 'Achievement not found');

  const [winners] = await db.execute(
    `SELECT w.id, w.user_id, w.winner_name, w.team_name, w.role, w.position, w.description,
            u.full_name AS linked_user_name, d.code AS department_code
     FROM achievement_winners w
     LEFT JOIN users u ON u.id = w.user_id
     LEFT JOIN departments d ON d.id = w.department_id
     WHERE w.achievement_id = ? ORDER BY w.id ASC`,
    [id],
  );
  const [media] = await db.execute(
    'SELECT id, file_path, file_type FROM achievement_media WHERE achievement_id = ? ORDER BY id ASC',
    [id],
  );
  return { ...a, winners, media };
}

const SUBMITTERS = ['ADMIN', 'FACULTY', 'STUDENT', 'ORGANIZER', 'CLUB_COORDINATOR'];
const STATUSES = ['SUBMITTED', 'PENDING_VERIFICATION', 'VERIFIED', 'REJECTED'];
const UNVERIFY_STATUS = 'PENDING_VERIFICATION';

async function create(user, payload) {
  if (!SUBMITTERS.includes(user.role)) {
    throw new ApiError(403, 'Only the HOD / Event Coordinator can add achievements and results');
  }
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const publicId = await nextPublicId(conn, 'achievements', 'public_id', 'CC-ACH');
    const status =
      payload.verification_status === 'PENDING_VERIFICATION'
        ? 'PENDING_VERIFICATION'
        : 'VERIFIED';
    const [r] = await conn.execute(
      `INSERT INTO achievements
        (public_id, title, competition_name, category, description, achievement_year, position,
         event_date, event_venue, prize_details, department_id, event_id, club_id, verification_status, verified_by, verified_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        publicId, payload.title, payload.competition_name, payload.category,
        payload.description || null, parseInt(payload.achievement_year, 10) || new Date().getFullYear(),
        payload.position || 'OTHER',
        payload.event_date || null,
        payload.venue || null, payload.prize_details || null,
        payload.department_id || null, payload.event_id || null, payload.club_id || null,
        status,
        status === 'VERIFIED' ? user.id : null,
        status === 'VERIFIED' ? new Date() : null,
        user.id,
      ],
    );
    const achievementId = r.insertId;

    for (const w of payload.winners || []) {
      await conn.execute(
        `INSERT INTO achievement_winners (achievement_id, user_id, winner_name, team_name, department_id, role, position, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [achievementId, w.user_id || null, w.winner_name || null, w.team_name || null,
          w.department_id || null, ['INDIVIDUAL', 'TEAM_MEMBER', 'TEAM'].includes(w.role) ? w.role : 'INDIVIDUAL',
          w.position || null, w.description || null],
      );
    }

    if (payload.media_paths) {
      for (const m of payload.media_paths) {
        await conn.execute(
          `INSERT INTO achievement_media (achievement_id, file_path, file_type) VALUES (?, ?, ?)`,
          [achievementId, m.path, m.type || 'PHOTO'],
        );
      }
    }

    if (status === 'PENDING_VERIFICATION') {
      const [admins] = await conn.execute(
        `SELECT id FROM users WHERE role IN ('ADMIN','FACULTY') AND is_active = 1`,
      );
      for (const adm of admins) {
        await notify(conn, {
          recipientId: adm.id, type: 'ACHIEVEMENT',
          title: 'Achievement pending verification',
          message: `"${payload.title}" was submitted and needs verification.`,
          relatedType: 'ACHIEVEMENT', relatedId: achievementId, link: '/admin/achievements.html',
        });
      }
    }
    await conn.commit();
    return { id: achievementId, public_id: publicId, status };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** Update an achievement's editable fields (never touches verification state). */
async function update(id, user, payload) {
  if (!SUBMITTERS.includes(user.role)) {
    throw new ApiError(403, 'Only the HOD / Event Coordinator can edit achievements');
  }
  const [rows] = await db.execute('SELECT id, verification_status FROM achievements WHERE id = ?', [id]);
  if (!rows.length) throw new ApiError(404, 'Achievement not found');

  const fields = [];
  const params = [];
  const setIf = (cond, col, val) => { if (cond !== undefined && cond !== null) { fields.push(`${col} = ?`); params.push(val); } };
  setIf(payload.title, 'title', payload.title);
  setIf(payload.competition_name, 'competition_name', payload.competition_name);
  setIf(payload.category, 'category', payload.category);
  if (payload.description !== undefined) { fields.push('description = ?'); params.push(payload.description || null); }
  setIf(payload.achievement_year, 'achievement_year', parseInt(payload.achievement_year, 10));
  setIf(payload.position, 'position', payload.position);
  setIf(payload.event_date, 'event_date', payload.event_date || null);
  if (payload.venue !== undefined) { fields.push('event_venue = ?'); params.push(payload.venue || null); }
  if (payload.prize_details !== undefined) { fields.push('prize_details = ?'); params.push(payload.prize_details || null); }
  if (payload.department_id !== undefined) { fields.push('department_id = ?'); params.push(payload.department_id ? parseInt(payload.department_id, 10) : null); }
  if (payload.event_id !== undefined) { fields.push('event_id = ?'); params.push(payload.event_id ? parseInt(payload.event_id, 10) : null); }
  if (payload.club_id !== undefined) { fields.push('club_id = ?'); params.push(payload.club_id ? parseInt(payload.club_id, 10) : null); }
  if (!fields.length) return { updated: false };
  params.push(id);
  await db.execute(`UPDATE achievements SET ${fields.join(', ')} WHERE id = ?`, params);
  return { updated: true };
}

/** Verify (publish) an achievement and notify its creator. */
async function verify(id, user) {
  const [rows] = await db.execute(
    'SELECT id, title, created_by, verification_status FROM achievements WHERE id = ?', [id]);
  if (!rows.length) throw new ApiError(404, 'Achievement not found');
  await db.execute(
    'UPDATE achievements SET verification_status = ?, verified_by = ?, verified_at = ? WHERE id = ?',
    ['VERIFIED', user.id, new Date(), id],
  );
  if (rows[0].created_by && rows[0].created_by !== user.id) {
    await notify(db, {
      recipientId: rows[0].created_by, type: 'ACHIEVEMENT',
      title: 'Achievement verified',
      message: `Your achievement "${rows[0].title}" was verified and published.`,
      relatedType: 'ACHIEVEMENT', relatedId: id, link: `/achievement-details.html?id=${id}`,
    });
  }
  return { verified: true };
}

/** Reject an achievement with a reason and notify its creator. */
async function reject(id, user, reason) {
  const [rows] = await db.execute(
    'SELECT id, title, created_by FROM achievements WHERE id = ?', [id]);
  if (!rows.length) throw new ApiError(404, 'Achievement not found');
  await db.execute(
    'UPDATE achievements SET verification_status = ?, verified_by = ?, verified_at = ? WHERE id = ?',
    ['REJECTED', user.id, new Date(), id],
  );
  if (rows[0].created_by && rows[0].created_by !== user.id) {
    await notify(db, {
      recipientId: rows[0].created_by, type: 'ACHIEVEMENT',
      title: 'Achievement rejected',
      message: `"${rows[0].title}" was rejected.${reason ? ' Reason: ' + reason : ''}`,
      relatedType: 'ACHIEVEMENT', relatedId: id, link: `/achievement-details.html?id=${id}`,
    });
  }
  return { rejected: true };
}

/** Archive (hide from the public Hall of Fame) without deleting the record. */
async function archive(id) {
  const [r] = await db.execute('UPDATE achievements SET is_archived = 1 WHERE id = ?', [id]);
  if (!r.affectedRows) throw new ApiError(404, 'Achievement not found');
  return { archived: true };
}

/** Permanently delete an achievement (cascades winners + media) and its files. */
async function remove(id, user) {
  if (!SUBMITTERS.includes(user.role)) throw new ApiError(403, 'Not allowed to delete achievements');
  const [rows] = await db.execute('SELECT id FROM achievements WHERE id = ?', [id]);
  if (!rows.length) throw new ApiError(404, 'Achievement not found');
  const [media] = await db.execute(
    'SELECT file_path FROM achievement_media WHERE achievement_id = ?', [id]);
  // DB cascade removes winners + media rows; best-effort disk cleanup after.
  await db.execute('DELETE FROM achievements WHERE id = ?', [id]);
  for (const m of media) unlinkUpload(m.file_path);
  return { deleted: true };
}

/** Unverify (un-publish) an achievement through the authorized admin workflow. */
async function unverify(id, user) {
  const [rows] = await db.execute(
    'SELECT id, title, created_by, verification_status FROM achievements WHERE id = ?', [id]);
  if (!rows.length) throw new ApiError(404, 'Achievement not found');
  if (rows[0].verification_status !== 'VERIFIED') {
    throw new ApiError(400, 'Only a verified achievement can be unverified');
  }
  await db.execute(
    'UPDATE achievements SET verification_status = ?, verified_by = ?, verified_at = ? WHERE id = ?',
    [UNVERIFY_STATUS, user.id, null, id],
  );
  return { unverified: true };
}

// ---- Winners -----------------------------------------------------------------

/** Add a winner (individual or team) to an achievement, with award + note. */
async function addWinner(id, payload, user) {
  if (!SUBMITTERS.includes(user.role)) throw new ApiError(403, 'Not allowed to manage winners');
  const [rows] = await db.execute('SELECT id FROM achievements WHERE id = ?', [id]);
  if (!rows.length) throw new ApiError(404, 'Achievement not found');
  const winnerName = (payload.winner_name || '').trim();
  const teamName = (payload.team_name || '').trim();
  if (!winnerName && !teamName) {
    throw new ApiError(400, 'Enter a winner name or a team name');
  }
  const role = payload.role || (teamName && !winnerName ? 'TEAM' : 'INDIVIDUAL');
  const position = POSITIONS.includes(payload.position) ? payload.position : null;
  const [r] = await db.execute(
    `INSERT INTO achievement_winners (achievement_id, user_id, winner_name, team_name, department_id, role, position, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, payload.user_id || null, winnerName || null, teamName || null,
      payload.department_id || null,
      ['INDIVIDUAL', 'TEAM_MEMBER', 'TEAM'].includes(role) ? role : 'INDIVIDUAL',
      position, (payload.description || '').trim() || null],
  );
  return { id: r.insertId };
}

/** Update a winner's fields (name/team/award/description) within its achievement. */
async function updateWinner(id, winnerId, payload, user) {
  if (!SUBMITTERS.includes(user.role)) throw new ApiError(403, 'Not allowed to manage winners');
  const [rows] = await db.execute(
    'SELECT id FROM achievement_winners WHERE id = ? AND achievement_id = ?', [winnerId, id]);
  if (!rows.length) throw new ApiError(404, 'Winner not found');
  const fields = [];
  const params = [];
  if (payload.winner_name !== undefined) { fields.push('winner_name = ?'); params.push((payload.winner_name || '').trim() || null); }
  if (payload.team_name !== undefined) { fields.push('team_name = ?'); params.push((payload.team_name || '').trim() || null); }
  if (payload.position !== undefined) { fields.push('position = ?'); params.push(POSITIONS.includes(payload.position) ? payload.position : null); }
  if (payload.description !== undefined) { fields.push('description = ?'); params.push((payload.description || '').trim() || null); }
  if (payload.role !== undefined) { fields.push('role = ?'); params.push(['INDIVIDUAL', 'TEAM_MEMBER', 'TEAM'].includes(payload.role) ? payload.role : 'INDIVIDUAL'); }
  if (payload.department_id !== undefined) { fields.push('department_id = ?'); params.push(payload.department_id ? parseInt(payload.department_id, 10) : null); }
  if (!fields.length) throw new ApiError(400, 'Nothing to update');
  params.push(winnerId, id);
  await db.execute(`UPDATE achievement_winners SET ${fields.join(', ')} WHERE id = ? AND achievement_id = ?`, params);
  return { updated: true, id: winnerId };
}

/** Remove a single winner row; never touches the achievement itself. */
async function deleteWinner(id, winnerId, user) {
  if (!SUBMITTERS.includes(user.role)) throw new ApiError(403, 'Not allowed to manage winners');
  const [r] = await db.execute(
    'DELETE FROM achievement_winners WHERE id = ? AND achievement_id = ?', [winnerId, id]);
  if (!r.affectedRows) throw new ApiError(404, 'Winner not found');
  return { deleted: true };
}

// ---- Year views -------------------------------------------------------------

async function byYear(year) {
  const [rows] = await db.execute(
    `${LIST_SELECT} WHERE a.is_archived = 0 AND a.verification_status = 'VERIFIED'
       AND a.achievement_year = ? ORDER BY a.created_at DESC`, [year]);
  return rows;
}

async function yearIndex() {
  const [rows] = await db.execute(
    `SELECT a.achievement_year AS year, COUNT(*) AS count
     FROM achievements a
     WHERE a.is_archived = 0 AND a.verification_status = 'VERIFIED'
     GROUP BY a.achievement_year ORDER BY a.achievement_year DESC`);
  return rows;
}

// ---- Photos -----------------------------------------------------------------

const ALLOWED_IMAGE_MIMES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
];
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

function validatePhoto(file) {
  if (!ALLOWED_IMAGE_MIMES.includes(file.mimetype || '')) {
    throw new ApiError(400, 'Photo must be a JPEG, PNG, WebP, GIF, HEIC or HEIF image.');
  }
  if (file.size > MAX_PHOTO_BYTES) {
    throw new ApiError(400, 'Photo is too large. Maximum size is 5 MB.');
  }
}

/** Map a multer file object to the public /uploads path we store in the DB. */
function storedPathFor(file) {
  // Multer already wrote the file to uploads/achievements/<filename>.
  return `/uploads/${PHOTO_DIR}/${file.filename}`;
}

/** Best-effort unlink of an uploaded file given its /uploads/... path. */
function unlinkUpload(storedPath) {
  if (!storedPath) return;
  try {
    const rel = String(storedPath).replace(/^\/uploads\//, '');
    const abs = path.join(UPLOAD_ROOT, rel);
    // Stay inside the upload root (never delete arbitrary paths).
    if (!abs.startsWith(UPLOAD_ROOT)) return;
    fs.unlink(abs, () => {});
  } catch (_e) { /* non-fatal */ }
}

async function assertAchievement(id) {
  if (!id) throw new ApiError(400, 'Achievement id is required.');
  const [rows] = await db.execute('SELECT id FROM achievements WHERE id = ?', [id]);
  if (!rows.length) throw new ApiError(404, 'Achievement not found');
}

/** Append uploaded photo file(s) to an achievement's gallery. */
async function addPhotos(user, { achievementId, files }) {
  if (!SUBMITTERS.includes(user.role)) throw new ApiError(403, 'Not allowed to upload photos');
  await assertAchievement(achievementId);
  const created = [];
  for (const file of (files || [])) {
    validatePhoto(file);
    const filePath = storedPathFor(file);
    const [r] = await db.execute(
      'INSERT INTO achievement_media (achievement_id, file_path, file_type) VALUES (?, ?, ?)',
      [achievementId, filePath, 'PHOTO'],
    );
    created.push({ id: r.insertId, path: filePath });
  }
  return created;
}

/** Back-compat single-photo helper used by older callers. */
async function addPhoto(user, { achievementId, file }) {
  const created = await addPhotos(user, { achievementId, files: [file] });
  return created[0];
}

/** Replace one photo's file: update the path, then remove the old file. */
async function replacePhotoFile(user, { achievementId, photoId, file }) {
  if (!SUBMITTERS.includes(user.role)) throw new ApiError(403, 'Not allowed to replace photos');
  validatePhoto(file);
  const [rows] = await db.execute(
    'SELECT id, file_path FROM achievement_media WHERE achievement_id = ? AND id = ?',
    [achievementId, photoId]);
  if (!rows.length) throw new ApiError(404, 'Photo not found');
  const oldPath = rows[0].file_path;
  const newPath = storedPathFor(file);
  await db.execute('UPDATE achievement_media SET file_path = ? WHERE id = ?', [newPath, photoId]);
  unlinkUpload(oldPath);
  return { replaced: true, id: photoId, path: newPath, old_path: oldPath };
}

/** Remove a single photo row + its file. Never deletes the achievement. */
async function removePhoto(user, { achievementId, photoId }) {
  if (!SUBMITTERS.includes(user.role)) throw new ApiError(403, 'Not allowed to remove photos');
  const [rows] = await db.execute(
    'SELECT id, file_path FROM achievement_media WHERE achievement_id = ? AND id = ?',
    [achievementId, photoId]);
  if (!rows.length) throw new ApiError(404, 'Photo not found');
  await db.execute('DELETE FROM achievement_media WHERE id = ?', [photoId]);
  unlinkUpload(rows[0].file_path);
  return { deleted: true, id: photoId, path: rows[0].file_path };
}

/** Alias used by the photo controller. */
const deletePhoto = removePhoto;

// ---- Year-scoped photo endpoints ----------------------------------------------

async function getYearPhotos(year, { page = 1, perPage = 24 } = {}) {
  const rows = await list(null, { year: String(year), sort: 'year_desc', limit: 200 });
  const achievements = rows.filter((a) => Number(a.achievement_year) === Number(year));
  const photos = [];
  for (const a of achievements) {
    const [mediaRows] = await db.execute(
      `SELECT id, file_path FROM achievement_media
       WHERE achievement_id = ? AND file_type = 'PHOTO'
       ORDER BY id ASC`, [a.id]);
    for (const m of mediaRows) {
      photos.push({ achievement_id: a.id, achievement_public_id: a.public_id,
        achievement_title: a.title, id: m.id, file_path: m.file_path });
    }
  }
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const per = Math.max(1, parseInt(perPage, 10) || 24);
  const total = photos.length;
  const start = (pageNum - 1) * per;
  const pagePhotos = photos.slice(start, start + per);
  return {
    year, page: pageNum, per_page: per, total,
    has_more: start + pagePhotos.length < total,
    photos: pagePhotos,
  };
}

module.exports = {
  LIST_SELECT,
  STATUSES, UNVERIFY_STATUS,
  list, detail, create, update, verify, unverify, reject, archive, remove,
  addWinner, updateWinner, deleteWinner, byYear, yearIndex, CATEGORIES, POSITIONS, SUBMITTERS,
  addPhoto, addPhotos, replacePhotoFile, removePhoto, deletePhoto,
  getYearPhotos, validatePhoto, storedPathFor,
};
