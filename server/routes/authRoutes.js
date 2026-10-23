'use strict';
const router = require('express').Router();
const ctrl = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { asyncHandler, ok } = require('../utils/helpers');

router.post('/register', ctrl.registerRules, ctrl.validate, ctrl.register);
router.post('/login', ctrl.loginRules, ctrl.validate, ctrl.login);
router.post('/logout', authenticate, ctrl.logout);
router.get('/me', authenticate, ctrl.me);
router.post('/forgot-password', ctrl.forgotRules, ctrl.validate, ctrl.forgotPassword);
router.post('/reset-password', ctrl.resetRules, ctrl.validate, ctrl.resetPassword);
router.post('/change-password', authenticate, ctrl.changePasswordRules, ctrl.validate, ctrl.changePassword);

// Admin-only staff/user creation
const { authorize } = require('../middleware/auth');
router.post('/users', authenticate, authorize('ADMIN'), ctrl.adminCreateUserRules, ctrl.validate, ctrl.adminCreateUser);

// Public department list for the registration form
router.get('/register-options', asyncHandler(async (req, res) => {
  const db = require('../config/db');
  const [rows] = await db.execute('SELECT id, code, name FROM departments ORDER BY name');
  ok(res, 'Departments', rows);
}));

// Spec alias: GET /api/auth/departments
router.get('/departments', asyncHandler(async (req, res) => {
  const db = require('../config/db');
  const [rows] = await db.execute('SELECT id, code, name FROM departments ORDER BY name');
  ok(res, 'Departments', rows);
}));

// Faculty list for coordinator dropdowns (used by event-request form: /api/faculty/list)
router.get('/faculty/list', asyncHandler(async (req, res) => {
  const db = require('../config/db');
  const [rows] = await db.execute(
    `SELECT id, full_name, email FROM users WHERE role = 'FACULTY' AND is_active = 1 ORDER BY full_name`
  );
  ok(res, 'Faculty', rows);
}));

module.exports = router;
