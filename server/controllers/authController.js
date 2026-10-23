'use strict';
const authService = require('../services/authService');
const { asyncHandler, ok } = require('../utils/helpers');

// Validation rules (kept here so each route binds them directly)
const { body } = require('express-validator');

const registerRules = [
  body('full_name').trim().isLength({ min: 3, max: 120 }).withMessage('Full name must be 3-120 characters'),
  body('student_id').trim().isLength({ min: 3, max: 40 }).withMessage('Student ID is required').optional({ nullable: true }),
  body('email').trim().isEmail().withMessage('Valid email required').normalizeEmail(),
  body('phone').trim().matches(/^[0-9+\-\s]{7,20}$/).withMessage('Valid phone number required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('department_id').optional({ nullable: true }).isInt(),
  body('year').optional({ nullable: true }).isInt({ min: 1, max: 5 }),
  body('role').optional().isIn(['STUDENT', 'ORGANIZER', 'CLUB_COORDINATOR']).withMessage('Invalid role selection'),
];

const loginRules = [
  body('email').trim().isEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password required'),
];

const changePasswordRules = [
  body('current_password').notEmpty(),
  body('new_password').isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
];

const forgotRules = [body('email').trim().isEmail().withMessage('Valid email required')];
const resetRules = [
  body('token').notEmpty().withMessage('Reset token required'),
  body('new_password').isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
];

const adminCreateUserRules = [
  body('full_name').trim().isLength({ min: 3 }),
  body('email').trim().isEmail().normalizeEmail(),
  body('phone').trim().matches(/^[0-9+\-\s]{7,20}$/),
  body('password').isLength({ min: 8 }),
  body('role').isIn(['STUDENT', 'ORGANIZER', 'CLUB_COORDINATOR', 'FACULTY', 'ADMIN']),
];

// Runs the express-validator chain and converts failures into ApiError-style JSON
function validate(req, _res, next) {
  const { validationResult } = require('express-validator');
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const err = new Error(errors.array()[0].msg);
    err.status = 400;
    err.code = 'VALIDATION';
    err.details = errors.array();
    return next(err);
  }
  next();
}

const register = asyncHandler(async (req, res) => {
  const id = await authService.register(req.body);
  // Auto-login: return token + user so the UI can redirect straight to the role dashboard.
  const result = await authService.login(req.body.email, req.body.password);
  ok(res, 'Registration successful', result, 201);
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const result = await authService.login(email, password);
  ok(res, 'Login successful', result);
});

// Stateless JWT logout: client discards the token; server just acknowledges.
const logout = asyncHandler(async (req, res) => {
  ok(res, 'Logged out successfully');
});

const me = asyncHandler(async (req, res) => {
  const user = await authService.getMe(req.user.id);
  ok(res, 'User profile', user);
});

const changePassword = asyncHandler(async (req, res) => {
  await authService.changePassword(req.user.id, req.body.current_password, req.body.new_password);
  ok(res, 'Password changed successfully');
});

const forgotPassword = asyncHandler(async (req, res) => {
  const result = await authService.forgotPassword(req.body.email);
  ok(res, result.message);
});

const resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword(req.body.token, req.body.new_password);
  ok(res, 'Password reset successful. Please log in with your new password.');
});

const adminCreateUser = asyncHandler(async (req, res) => {
  const id = await authService.adminCreateUser(req.user, req.body);
  ok(res, 'Account created', { id }, 201);
});

module.exports = {
  register, login, logout, me, changePassword, forgotPassword, resetPassword, adminCreateUser,
  registerRules, loginRules, changePasswordRules, forgotRules, resetRules, adminCreateUserRules, validate,
};
