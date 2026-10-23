'use strict';
const router = require('express').Router();
const ctrl = require('../controllers/adminController');
const verify = require('../controllers/verificationController');
const auth = require('../controllers/authController');
const { authenticate, authenticateQuery, authorize } = require('../middleware/auth');

// Dashboards
router.get('/dashboard/student', authenticate, ctrl.studentDashboard);
router.get('/dashboard/admin', authenticate, authorize('ADMIN'), ctrl.adminDashboard);
router.get('/dashboard/faculty', authenticate, authorize('FACULTY', 'ADMIN'), ctrl.facultyDashboard);

// Departments (any authenticated user needs it for forms)
router.get('/departments', authenticate, ctrl.departments);

// User management (admin only)
router.get('/users', authenticate, authorize('ADMIN'), ctrl.listUsers);
router.put('/users/:id/status', authenticate, authorize('ADMIN'), ctrl.toggleUser);
router.put('/users/:id/role', authenticate, authorize('ADMIN'), ctrl.changeRole);
router.post('/users', authenticate, authorize('ADMIN'), auth.adminCreateUserRules, auth.validate, auth.adminCreateUser);

// Official account verification (Phase 2) - admin only
router.get('/verification-requests', authenticate, authorize('ADMIN'), verify.list);
router.put('/verification-requests/:id/approve', authenticate, authorize('ADMIN'), verify.approve);
router.put('/verification-requests/:id/reject', authenticate, authorize('ADMIN'), verify.reject);
router.put('/users/:id/verification', authenticate, authorize('ADMIN'), verify.setForUser);

// CSV reports (admin only, generated live from the database)
// authenticateQuery lets direct-download links pass the token as ?token=
router.get('/reports/:key.csv', authenticateQuery, authorize('ADMIN'), ctrl.exportReport);
router.get('/reports/:key', authenticateQuery, authorize('ADMIN'), ctrl.exportReport);

module.exports = router;
