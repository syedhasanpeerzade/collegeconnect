'use strict';
const router = require('express').Router();
const ctrl = require('../controllers/complaintController');
const { authenticate, authorize } = require('../middleware/auth');
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

// Students submit and view their own; staff see all
router.post('/', authenticate, authorize('STUDENT'), uploads.complaintAttachment, uploadErrorHandler, ctrl.createRules, checkValidation, ctrl.create);
router.get('/', authenticate, ctrl.list);
router.get('/:id', authenticate, ctrl.detail);

// Staff actions
router.put('/:id/status', authenticate, authorize('ADMIN', 'FACULTY'), ctrl.updateStatus);
// Alias used by the staff UI
router.post('/:id/update', authenticate, authorize('ADMIN', 'FACULTY'), ctrl.updateStatus);

// Student confirm / reopen / feedback
router.post('/:id/feedback', authenticate, authorize('STUDENT'), ctrl.feedback);

module.exports = router;
