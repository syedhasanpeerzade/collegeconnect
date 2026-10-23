'use strict';
/**
 * Spec-compliant path aliases. The primary implementations live under their
 * modules (e.g. /api/events/requests); these expose the documented REST paths:
 *   POST/GET /api/event-requests, PUT /api/event-requests/:id/...
 *   GET  /api/my-registrations
 *   GET  /api/my-club-applications
 *   PUT  /api/club-applications/:id/approve|reject
 */
const router = require('express').Router();
const eventCtrl = require('../controllers/eventController');
const clubCtrl = require('../controllers/clubController');
const { authenticate, authorize } = require('../middleware/auth');
const { uploads, uploadErrorHandler } = require('../middleware/upload');

function checkValidation(req, res, next) {
  const { validationResult } = require('express-validator');
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const err = new Error(errors.array()[0].msg);
    err.status = 400;
    err.code = 'VALIDATION';
    return next(err);
  }
  next();
}

// ---- Event requests (spec paths) ----
router.post('/event-requests', authenticate, authorize('STUDENT', 'ORGANIZER'),
  eventCtrl.requestRules, checkValidation, uploads.eventFiles, uploadErrorHandler, eventCtrl.createRequest);
router.get('/event-requests', authenticate, eventCtrl.listRequests);
router.get('/event-requests/:id', authenticate, eventCtrl.getRequest);
router.put('/event-requests/:id/approve', authenticate, authorize('ADMIN', 'FACULTY'), eventCtrl.approve);
router.put('/event-requests/:id/reject', authenticate, authorize('ADMIN', 'FACULTY'), eventCtrl.reject);
router.put('/event-requests/:id/request-changes', authenticate, authorize('ADMIN', 'FACULTY'), eventCtrl.requestChanges);
router.put('/event-requests/:id/resubmit', authenticate, authorize('STUDENT', 'ORGANIZER'),
  uploads.eventFiles, uploadErrorHandler, eventCtrl.resubmit);

// ---- My registrations (spec path) ----
router.get('/my-registrations', authenticate, eventCtrl.myRegistrations);

// ---- Faculty list (event-request form coordinator dropdown) ----
router.get('/faculty/list', require('../utils/helpers').asyncHandler(async (req, res) => {
  const db = require('../config/db');
  const [rows] = await db.execute(
    `SELECT id, full_name, email FROM users WHERE role = 'FACULTY' AND is_active = 1 ORDER BY full_name`
  );
  require('../utils/helpers').ok(res, 'Faculty', rows);
}));

// ---- My club applications (spec path) ----
router.get('/my-club-applications', authenticate, clubCtrl.myApplications);

// ---- Club application review (spec paths) ----
router.put('/club-applications/:id/approve', authenticate, authorize('CLUB_COORDINATOR', 'ADMIN', 'FACULTY'), clubCtrl.approveApplication);
router.put('/club-applications/:id/reject', authenticate, authorize('CLUB_COORDINATOR', 'ADMIN', 'FACULTY'), clubCtrl.rejectApplication);

module.exports = router;
