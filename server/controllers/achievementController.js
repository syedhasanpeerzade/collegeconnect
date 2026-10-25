'use strict';

const svc = require('../services/achievementService');
const { asyncHandler, ok } = require('../utils/helpers');
const { body } = require('express-validator');

const list = asyncHandler(async (req, res) => {
  const rows = await svc.list(req.user, {
    search: req.query.search || '',
    category: req.query.category || '',
    year: req.query.year || '',
    department: req.query.department || '',
    club: req.query.club || '',
    status: req.query.status || '',
    sort: req.query.sort || 'year_desc',
    limit: req.query.limit || 12,
    offset: req.query.offset || 0,
  });
  ok(res, 'Achievements', rows);
});

const detail = asyncHandler(async (req, res) => {
  const data = await svc.detail(parseInt(req.params.id, 10), req.user);
  ok(res, 'Achievement details', data);
});

const create = asyncHandler(async (req, res) => {
  const media_paths = (req.files || []).map((f) => ({
    path: `/uploads/achievements/${f.filename}`,
    type: /\.pdf$/i.test(f.filename) ? 'CERTIFICATE' : 'PHOTO',
  }));
  let winners = [];
  if (req.body.winners) {
    try { winners = JSON.parse(req.body.winners); } catch (_e) { winners = []; }
  }
  const payload = { ...req.body, winners, media_paths };
  const result = await svc.create(req.user, payload);
  ok(res, result.status === 'VERIFIED' ? 'Achievement added to the Hall of Fame' : 'Achievement submitted for verification', result, 201);
});

const update = asyncHandler(async (req, res) => {
  await svc.update(parseInt(req.params.id, 10), req.user, req.body);
  ok(res, 'Achievement updated');
});

const unverify = asyncHandler(async (req, res) => {
  await svc.unverify(parseInt(req.params.id, 10), req.user);
  ok(res, 'Achievement unverified and removed from the Hall of Fame');
});

const verify = asyncHandler(async (req, res) => {
  await svc.verify(parseInt(req.params.id, 10), req.user);
  ok(res, 'Achievement verified and published in the Hall of Fame');
});

const reject = asyncHandler(async (req, res) => {
  await svc.reject(parseInt(req.params.id, 10), req.user, req.body.reason);
  ok(res, 'Achievement rejected');
});

const archive = asyncHandler(async (req, res) => {
  await svc.archive(parseInt(req.params.id, 10));
  ok(res, 'Achievement archived');
});

const remove = asyncHandler(async (req, res) => {
  await svc.remove(parseInt(req.params.id, 10), req.user);
  ok(res, 'Achievement deleted');
});

const addWinner = asyncHandler(async (req, res) => {
  const result = await svc.addWinner(parseInt(req.params.id, 10), req.body, req.user);
  ok(res, 'Winner added', result, 201);
});

const updateWinner = asyncHandler(async (req, res) => {
  const result = await svc.updateWinner(parseInt(req.params.id, 10), parseInt(req.params.winnerId, 10), req.body, req.user);
  ok(res, 'Winner updated', result);
});

const deleteWinner = asyncHandler(async (req, res) => {
  await svc.deleteWinner(parseInt(req.params.id, 10), parseInt(req.params.winnerId, 10), req.user);
  ok(res, 'Winner removed');
});

const byYear = asyncHandler(async (req, res) => {
  const rows = await svc.byYear(parseInt(req.params.year, 10));
  ok(res, `Achievements of ${req.params.year}`, rows);
});

const yearIndex = asyncHandler(async (req, res) => {
  const rows = await svc.yearIndex();
  ok(res, 'Achievement years', rows);
});

const stats = asyncHandler(async (req, res) => {
  const [stats] = await db.execute('SELECT * FROM achievement_stats');
  ok(res, 'Achievement statistics', stats[0]);
});

const createRules = [
  body('title').trim().isLength({ min: 5, max: 200 }).withMessage('Title must be 5-200 characters'),
  body('competition_name').trim().isLength({ min: 3, max: 200 }).withMessage('Competition name is required'),
  body('category').isIn(svc.CATEGORIES).withMessage('Valid category required'),
  body('achievement_year').optional().isInt({ min: 1990, max: 2100 }).withMessage('Valid year required'),
  body('event_date').optional().matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('Valid event date required'),
  body('position').optional().isIn(svc.POSITIONS),
];

module.exports = {
  list, detail, create, update, verify, unverify, reject, archive, remove,
  addWinner, updateWinner, deleteWinner, byYear, yearIndex, stats, createRules,
};
