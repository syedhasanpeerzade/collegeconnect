'use strict';
const jwt = require('jsonwebtoken');
const { ApiError } = require('../utils/ApiError');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

/** Require a valid Bearer token; attaches req.user = { id, role, email, name }. */
function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new ApiError(401, 'Authentication required', 'NO_TOKEN'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: payload.id,
      role: payload.role,
      email: payload.email,
      name: payload.name,
    };
    next();
  } catch (e) {
    next(new ApiError(401, 'Session expired or invalid. Please log in again.', 'BAD_TOKEN'));
  }
}

/**
 * Same as authenticate but also accepts the token as ?token= for direct
 * downloads (CSV export links cannot set headers). Use only for GET endpoints.
 */
function authenticateQuery(req, _res, next) {
  if (req.headers.authorization) return authenticate(req, _res, next);
  if (req.query && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  authenticate(req, _res, next);
}

/** Allow optional auth: attaches req.user if a valid token is present. */
function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = { id: payload.id, role: payload.role, email: payload.email, name: payload.name };
    } catch (_e) { /* ignore invalid optional tokens */ }
  }
  next();
}

/** Require one of the given roles. */
function authorize(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new ApiError(401, 'Authentication required', 'NO_TOKEN'));
    if (!roles.includes(req.user.role)) {
      return next(new ApiError(403, 'You do not have permission to perform this action', 'FORBIDDEN'));
    }
    next();
  };
}

module.exports = { authenticate, authenticateQuery, optionalAuth, authorize, JWT_SECRET };
