'use strict';
const router = require('express').Router();
const db = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { asyncHandler, ok } = require('../utils/helpers');
const { authenticate, authorize } = require('../middleware/auth');
const { uploads, uploadErrorHandler } = require('../middleware/upload');
const svc = require('../services/adminContentService');

// ---- Events: full management list + publish toggle ----
router.get('/events', authenticate, authorize('ADMIN', 'FACULTY'), asyncHandler(async (req, res) => {
  const rows = await svc.listAllEvents();
  ok(res, 'All events', rows);
}));

// Dashboard counts (draft / scheduled / ongoing / completed / cancelled /
// upcoming). Reuses the admin event controller's stats handler so numbers
// come from exactly one source of truth.
router.get('/event-stats', authenticate, authorize('ADMIN', 'FACULTY'),
  require('../controllers/eventAdminController').stats);

router.put('/events/:id/publish', authenticate, authorize('ADMIN'), asyncHandler(async (req, res) => {
  const result = await svc.setEventPublished(parseInt(req.params.id, 10), !!req.body.is_published);
  ok(res, result.is_published ? 'Event published — it is now visible to students' : 'Event unpublished — hidden from students', result);
}));

// ---- Clubs: create / update / delete ----
router.post('/clubs', authenticate, authorize('ADMIN'), uploads.clubImages, uploadErrorHandler,
  asyncHandler(async (req, res) => {
    const logoPath = req.files && req.files.logo ? `/uploads/clubs/${req.files.logo[0].filename}` : null;
    const result = await svc.createClub(req.body, logoPath);
    ok(res, 'Club created', result, 201);
  }));

router.put('/clubs/:id', authenticate, authorize('ADMIN'), uploads.clubImages, uploadErrorHandler,
  asyncHandler(async (req, res) => {
    const logoPath = req.files && req.files.logo ? `/uploads/clubs/${req.files.logo[0].filename}` : null;
    const result = await svc.updateClub(parseInt(req.params.id, 10), req.body, logoPath);
    ok(res, 'Club updated', result);
  }));

router.delete('/clubs/:id', authenticate, authorize('ADMIN'), asyncHandler(async (req, res) => {
  const result = await svc.deleteClub(parseInt(req.params.id, 10));
  ok(res, `Club "${result.name}" deleted`);
}));

// ---- Departments: CRUD ----
router.get('/departments-managed', authenticate, authorize('ADMIN'), asyncHandler(async (req, res) => {
  const rows = await svc.listDepartments();
  ok(res, 'Departments', rows);
}));

router.post('/departments', authenticate, authorize('ADMIN'), asyncHandler(async (req, res) => {
  const result = await svc.createDepartment(req.body);
  ok(res, 'Department created', result, 201);
}));

router.put('/departments/:id', authenticate, authorize('ADMIN'), asyncHandler(async (req, res) => {
  const result = await svc.updateDepartment(parseInt(req.params.id, 10), req.body);
  ok(res, 'Department updated', result);
}));

router.delete('/departments/:id', authenticate, authorize('ADMIN'), asyncHandler(async (req, res) => {
  const result = await svc.deleteDepartment(parseInt(req.params.id, 10));
  ok(res, `Department "${result.name}" deleted`);
}));

// ---- Coordinator assignment (link a CLUB_COORDINATOR to a club) ----
router.get('/coordinators', authenticate, authorize('ADMIN'), asyncHandler(async (req, res) => {
  const [rows] = await db.execute(
    `SELECT cc.id, cc.club_id, cc.user_id, c.name AS club_name, u.full_name, u.email
     FROM club_coordinators cc
     JOIN clubs c ON c.id = cc.club_id
     JOIN users u ON u.id = cc.user_id
     ORDER BY c.name`
  );
  ok(res, 'Club coordinators', rows);
}));

router.post('/coordinators', authenticate, authorize('ADMIN'), asyncHandler(async (req, res) => {
  const { user_id, club_id } = req.body;
  const uid = parseInt(user_id, 10);
  const cid = parseInt(club_id, 10);
  if (!uid || !cid) throw new ApiError(400, 'user_id and club_id are required');
  const [u] = await db.execute(`SELECT id, role FROM users WHERE id = ? AND is_active = 1`, [uid]);
  if (!u.length) throw new ApiError(404, 'User not found');
  if (u[0].role !== 'CLUB_COORDINATOR') throw new ApiError(400, 'User must have the CLUB_COORDINATOR role first');
  const [c] = await db.execute('SELECT id FROM clubs WHERE id = ?', [cid]);
  if (!c.length) throw new ApiError(404, 'Club not found');
  await db.execute(
    'INSERT INTO club_coordinators (club_id, user_id) VALUES (?, ?) ON CONFLICT (club_id, user_id) DO NOTHING',
    [cid, uid]
  );
  ok(res, 'Coordinator assigned to club', { user_id: uid, club_id: cid }, 201);
}));

router.delete('/coordinators/:id', authenticate, authorize('ADMIN'), asyncHandler(async (req, res) => {
  await db.execute('DELETE FROM club_coordinators WHERE id = ?', [parseInt(req.params.id, 10)]);
  ok(res, 'Coordinator removed from club');
}));

module.exports = router;
