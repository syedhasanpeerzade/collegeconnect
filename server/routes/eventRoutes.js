'use strict';
const router = require('express').Router();
const ctrl = require('../controllers/eventController');
const admin = require('../controllers/eventAdminController');
const { authenticate, optionalAuth, authorize } = require('../middleware/auth');
const { uploads, uploadErrorHandler } = require('../middleware/upload');
const { validationResult } = require('express-validator');

function checkValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const err = new Error(errors.array()[0].msg);
    err.status = 400;
    err.code = 'VALIDATION';
    return next(err);
  }
  next();
}

// Public browsing — specific routes MUST come before /:id so that
// GET /events/requests is never swallowed by GET /events/:id
// (/:id would parseInt("requests") → NaN → Postgres "invalid input syntax" error).
router.get('/', optionalAuth, ctrl.list);
router.get('/past', optionalAuth, ctrl.past);
router.get('/categories', optionalAuth, ctrl.categories);
router.get('/recommended', authenticate, authorize('STUDENT'), ctrl.recommended);
router.get('/my-registrations', authenticate, ctrl.myRegistrations);

// Event requests
router.post(
  '/requests',
  authenticate, authorize('STUDENT', 'ORGANIZER'),
  uploads.eventFiles, uploadErrorHandler, // multer MUST parse the multipart body before validation reads req.body
  ctrl.requestRules, checkValidation,
  ctrl.createRequest
);
router.get('/requests', authenticate, ctrl.listRequests);
router.get('/requests/:id', authenticate, ctrl.getRequest);
router.put('/requests/:id/approve', authenticate, authorize('ADMIN', 'FACULTY'), ctrl.approve);
router.put('/requests/:id/reject', authenticate, authorize('ADMIN', 'FACULTY'), ctrl.reject);
router.put('/requests/:id/request-changes', authenticate, authorize('ADMIN', 'FACULTY'), ctrl.requestChanges);
router.put('/requests/:id/resubmit', authenticate, authorize('STUDENT', 'ORGANIZER'), uploads.eventFiles, uploadErrorHandler, ctrl.resubmit);
// Student publishes their APPROVED proposal (backend enforces approval - cannot be bypassed)
router.put('/requests/:id/publish', authenticate, authorize('STUDENT', 'ORGANIZER'), ctrl.publishRequest);

router.get('/:id', optionalAuth, ctrl.detail);

// Registration (students only)
router.post('/:id/register', authenticate, authorize('STUDENT'), ctrl.register);
router.delete('/:id/register', authenticate, authorize('STUDENT'), ctrl.cancel);
router.get('/:id/registrations', authenticate, authorize('ADMIN', 'FACULTY', 'ORGANIZER', 'CLUB_COORDINATOR'), ctrl.registrations);
router.get('/:id/previous-winners', optionalAuth, ctrl.previousWinners);

// Direct event management
router.post('/', authenticate, authorize('ADMIN', 'FACULTY', 'ORGANIZER'), uploads.eventFiles, uploadErrorHandler, admin.create);
router.put('/:id', authenticate, authorize('ADMIN', 'FACULTY', 'ORGANIZER'), uploads.eventFiles, uploadErrorHandler, admin.update);
router.delete('/:id', authenticate, authorize('ADMIN'), admin.remove);

module.exports = router;
