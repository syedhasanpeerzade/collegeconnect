'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/reportController');
const { authenticate } = require('../middleware/auth');
const { authorize } = require('../middleware/auth');

// Authenticated: anyone can report content / users.
router.post('/posts', authenticate, ctrl.reportPost);
router.post('/comments', authenticate, ctrl.reportComment);
router.post('/users', authenticate, ctrl.reportUser);

// Admin only: review queue + actions.
router.get('/pending', authenticate, authorize('ADMIN'), ctrl.pendingReports);
router.get('/counts', authenticate, authorize('ADMIN'), ctrl.reportCounts);
router.put('/resolve', authenticate, authorize('ADMIN'), ctrl.resolveReport);
router.put('/restore', authenticate, authorize('ADMIN'), ctrl.restoreContent);
router.delete('/content', authenticate, authorize('ADMIN'), ctrl.deleteContent);

module.exports = router;
