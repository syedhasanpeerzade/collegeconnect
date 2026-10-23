'use strict';

const svc = require('../services/achievementService');
const db = require('../config/db');
const { asyncHandler, ok } = require('../utils/helpers');

/**
 * Achievement photo actions.
 *
 * Photos are uploaded through the existing multer middleware
 * (uploads.achievementMedia, field name "media"), which writes them to disk
 * under /uploads/achievements/. Only the resulting path is stored in
 * achievement_media - image bytes never enter the database.
 *
 * Every mutating route is ADMIN/FACULTY only (see achievementRoutes.js).
 */

/** List all photos (empty = placeholder shown on the card) for an achievement. */
async function listPhotos(req, res) {
  const achievementId = parseInt(req.params.id, 10);
  const [rows] = await db.execute(
    'SELECT id, file_path, file_type FROM achievement_media WHERE achievement_id = ? ORDER BY id ASC',
    [achievementId],
  );
  const photos = rows.map((m) => ({ id: m.id, file_path: m.file_path, file_type: m.file_type }));
  return ok(res, 'Photos', { photos, count: photos.length });
}

/** Append one or more uploaded photos to an achievement's gallery. */
async function addPhotos(req, res) {
  const achievementId = parseInt(req.params.id, 10);
  const files = req.files || [];
  if (!files.length) {
    return res.status(400).json({ success: false, message: 'No files were uploaded.' });
  }
  const created = await svc.addPhotos(req.user, { achievementId, files });
  return res.status(201).json({ success: true, message: 'Photos added', data: created });
}

/** Replace a specific photo's file with a newly uploaded one. */
async function replacePhoto(req, res) {
  const achievementId = parseInt(req.params.id, 10);
  const photoId = parseInt(req.params.photoId, 10);
  const file = (req.files || [])[0];
  if (!file) {
    return res.status(400).json({ success: false, message: 'No file provided. Upload the replacement image in the "media" field.' });
  }
  const result = await svc.replacePhotoFile(req.user, { achievementId, photoId, file });
  return ok(res, 'Photo replaced', result);
}

/** Remove a single photo (never the achievement itself). */
async function removePhoto(req, res) {
  const achievementId = parseInt(req.params.id, 10);
  const photoId = parseInt(req.params.photoId, 10);
  const result = await svc.removePhoto(req.user, { achievementId, photoId });
  return ok(res, 'Photo removed', result);
}

/** Public year-scoped photo listing (paginated, direct file paths). */
async function listYearPhotos(req, res) {
  const year = parseInt(req.params.year, 10);
  if (Number.isNaN(year)) return res.status(400).json({ success: false, message: 'Invalid year.' });
  const page = parseInt(req.query.page, 10) || 1;
  const perPage = parseInt(req.query.perPage, 10) || 24;
  const data = await svc.getYearPhotos(year, { page, perPage });
  return ok(res, 'Year photos', data);
}

module.exports = {
  listPhotos: asyncHandler(listPhotos),
  addPhotos: asyncHandler(addPhotos),
  replacePhoto: asyncHandler(replacePhoto),
  removePhoto: asyncHandler(removePhoto),
  listYearPhotos: asyncHandler(listYearPhotos),
};
