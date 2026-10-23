'use strict';
const router = require('express').Router();
const ctrl = require('../controllers/announcementController');
const { authenticate, optionalAuth, authorize } = require('../middleware/auth');
const { uploads, uploadErrorHandler } = require('../middleware/upload');

router.get('/', optionalAuth, ctrl.list);
router.post('/', authenticate, authorize('ADMIN', 'FACULTY'), uploads.announcementFile, uploadErrorHandler, ctrl.create);
router.put('/:id', authenticate, authorize('ADMIN', 'FACULTY'), uploads.announcementFile, uploadErrorHandler, ctrl.update);
router.delete('/:id', authenticate, authorize('ADMIN', 'FACULTY'), ctrl.remove);

module.exports = router;
