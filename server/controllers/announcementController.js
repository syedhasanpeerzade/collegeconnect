'use strict';
const svc = require('../services/announcementService');
const { asyncHandler, ok } = require('../utils/helpers');
const { optionalAuth } = require('../middleware/auth');
const { uploads, uploadErrorHandler } = require('../middleware/upload');

const list = asyncHandler(async (req, res) => {
  const rows = await svc.listFor(req.user, { category: req.query.category || '' });
  ok(res, 'Announcements', rows);
});

const create = asyncHandler(async (req, res) => {
  const attachment = req.file ? `/uploads/announcements/${req.file.filename}` : null;
  const result = await svc.create(req.user, req.body, attachment);
  ok(res, 'Announcement published', result, 201);
});

const update = asyncHandler(async (req, res) => {
  const attachment = req.file ? `/uploads/announcements/${req.file.filename}` : null;
  await svc.update(parseInt(req.params.id, 10), req.user, req.body, attachment);
  ok(res, 'Announcement updated');
});

const remove = asyncHandler(async (req, res) => {
  await svc.remove(parseInt(req.params.id, 10));
  ok(res, 'Announcement deleted');
});

module.exports = { list, create, update, remove };
