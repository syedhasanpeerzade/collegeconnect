'use strict';
const router = require('express').Router();
const ctrl = require('../controllers/achievementController');
const achievementPhotoCtrl = require('../controllers/achievementPhotoController');
const { authenticate, authorize, optionalAuth } = require('../middleware/auth');
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

// ---- Photos (ADMIN/FACULTY manage; files never stored in DB text fields) ----
// Uploads go through the existing multer middleware (field "media"), which
// writes to /uploads/achievements/ and stores only the path in the DB.
router.get('/year/:year/photos', optionalAuth, achievementPhotoCtrl.listYearPhotos);
router.get('/:id/photos', authenticate, authorize('ADMIN', 'FACULTY'), achievementPhotoCtrl.listPhotos);
router.post('/:id/photos', authenticate, authorize('ADMIN', 'FACULTY'),
  uploads.achievementMedia, uploadErrorHandler, achievementPhotoCtrl.addPhotos);
router.put('/:id/photos/:photoId', authenticate, authorize('ADMIN', 'FACULTY'),
  uploads.achievementMedia, uploadErrorHandler, achievementPhotoCtrl.replacePhoto);
router.delete('/:id/photos/:photoId', authenticate, authorize('ADMIN', 'FACULTY'), achievementPhotoCtrl.removePhoto);

// ---- Hall of Fame (public read; staff also see pending) ----
router.get('/years', optionalAuth, ctrl.yearIndex);
router.get('/stats', optionalAuth, ctrl.stats);
router.get('/year/:year', optionalAuth, ctrl.byYear);
router.get('/', optionalAuth, ctrl.list);

// Submission / management — write access is staff-only (students are read-only;
// the backend must reject student writes regardless of any UI they try).
router.post('/', authenticate, authorize('ADMIN', 'FACULTY'), uploads.achievementMedia, uploadErrorHandler, ctrl.createRules, checkValidation, ctrl.create);
router.get('/:id', optionalAuth, ctrl.detail);
router.put('/:id', authenticate, authorize('ADMIN', 'FACULTY'), ctrl.update);
router.delete('/:id', authenticate, authorize('ADMIN', 'FACULTY'), ctrl.remove);
router.put('/:id/verify', authenticate, authorize('ADMIN', 'FACULTY'), ctrl.verify);
router.put('/:id/unverify', authenticate, authorize('ADMIN', 'FACULTY'), ctrl.unverify);
router.put('/:id/reject', authenticate, authorize('ADMIN', 'FACULTY'), ctrl.reject);
router.put('/:id/archive', authenticate, authorize('ADMIN', 'FACULTY'), ctrl.archive);

// Winners management
router.post('/:id/winners', authenticate, authorize('ADMIN', 'FACULTY'), ctrl.addWinner);
router.put('/:id/winners/:winnerId', authenticate, authorize('ADMIN', 'FACULTY'), ctrl.updateWinner);
router.delete('/:id/winners/:winnerId', authenticate, authorize('ADMIN', 'FACULTY'), ctrl.deleteWinner);

module.exports = router;
