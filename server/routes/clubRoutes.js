'use strict';
const router = require('express').Router();
const ctrl = require('../controllers/clubController');
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

// Public browsing (static paths must come before /:id)
router.get('/', optionalAuth, ctrl.list);
router.get('/my-applications', authenticate, ctrl.myApplications);
router.get('/coordinator/my-clubs', authenticate, authorize('CLUB_COORDINATOR', 'ADMIN'), ctrl.myClubs);
router.get('/:id', optionalAuth, ctrl.detail);

// Applications (students)
router.post('/:id/apply', authenticate, authorize('STUDENT'), ctrl.applyRules, checkValidation, ctrl.apply);

// Application review (coordinators + staff)
router.get('/:id/applications', authenticate, authorize('CLUB_COORDINATOR', 'ADMIN', 'FACULTY'), ctrl.clubApplications);
router.put('/applications/:id/approve', authenticate, authorize('CLUB_COORDINATOR', 'ADMIN', 'FACULTY'), ctrl.approveApplication);
router.put('/applications/:id/reject', authenticate, authorize('CLUB_COORDINATOR', 'ADMIN', 'FACULTY'), ctrl.rejectApplication);
router.put('/applications/:id/review', authenticate, authorize('CLUB_COORDINATOR', 'ADMIN', 'FACULTY'), ctrl.markUnderReview);

// Members
router.delete('/:id/members/:memberId', authenticate, authorize('CLUB_COORDINATOR', 'ADMIN', 'FACULTY'), ctrl.removeMember);
router.put('/:id/members/:memberId', authenticate, authorize('CLUB_COORDINATOR', 'ADMIN', 'FACULTY'), ctrl.setMemberRole);

// Club management
router.put('/:id', authenticate, authorize('CLUB_COORDINATOR', 'ADMIN', 'FACULTY'), uploads.clubImages, uploadErrorHandler, ctrl.updateClub);
router.post('/:id/questions', authenticate, authorize('CLUB_COORDINATOR', 'ADMIN', 'FACULTY'), ctrl.addQuestion);
router.delete('/:id/questions/:questionId', authenticate, authorize('CLUB_COORDINATOR', 'ADMIN', 'FACULTY'), ctrl.deleteQuestion);

module.exports = router;
