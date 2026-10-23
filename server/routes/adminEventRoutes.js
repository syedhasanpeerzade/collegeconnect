'use strict';
const router = require('express').Router();
const admin = require('../controllers/eventAdminController');
const { authenticate, authorize } = require('../middleware/auth');

// PATCH /api/events/:id/status - cancel/complete/reopen + publish/draft toggle
router.patch('/:id/status', authenticate, authorize('ADMIN', 'FACULTY', 'ORGANIZER'), admin.setStatus);
// NOTE: dashboard stats live at GET /api/admin/content/event-stats
// (adminContentRoutes) — a GET /api/events/admin/... path would be swallowed
// by eventRoutes' GET /:id (the same shadowing their /requests routes guard
// against).

module.exports = router;
