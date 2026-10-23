'use strict';
const svc = require('../services/eventService');
const interestSvc = require('../services/interestService');
const { asyncHandler, ok } = require('../utils/helpers');

const list = asyncHandler(async (req, res) => {
  const { search, category, date, sort, page = 1, limit } = req.query;
  const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 60));
  const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * lim;
  const data = await svc.listEvents({ search, category, date, sort, limit: lim, offset });
  ok(res, 'Events', data);
});

// Past / historical events (Events archive, including bulk-imported records)
const past = asyncHandler(async (req, res) => {
  const { search, category, sort = 'date_desc', page = 1, limit } = req.query;
  const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 60));
  const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * lim;
  const data = await svc.listEvents({ search, category, sort, limit: lim, offset, scope: 'past' });
  ok(res, 'Past events', data);
});

// Discovery groups for the Events Categories page (upcoming counts included)
const categories = asyncHandler(async (req, res) => {
  ok(res, 'Event categories', await svc.categoryCounts());
});

// "Recommended For You" - upcoming events matching the student's interests
const recommended = asyncHandler(async (req, res) => {
  const limit = Math.min(24, Math.max(1, parseInt(req.query.limit, 10) || 6));
  ok(res, 'Recommended events', await interestSvc.recommendedEvents(req.user.id, { limit }));
});

const detail = asyncHandler(async (req, res) => {
  const userId = req.user ? req.user.id : null;
  const event = await svc.getEvent(parseInt(req.params.id, 10), userId);
  ok(res, 'Event details', event);
});

// Previous winners for recurring competitions (spec: /api/events/:id/previous-winners)
const previousWinners = asyncHandler(async (req, res) => {
  const rows = await svc.previousWinners(parseInt(req.params.id, 10));
  ok(res, 'Previous winners', rows);
});

const register = asyncHandler(async (req, res) => {
  const result = await svc.registerStudent(parseInt(req.params.id, 10), req.user.id);
  ok(res, `Registered successfully. Registration ID: ${result.registration_id}`, result, 201);
});

const cancel = asyncHandler(async (req, res) => {
  const result = await svc.cancelRegistration(parseInt(req.params.id, 10), req.user.id);
  ok(res, `Registration cancelled for "${result.event_title}"`);
});

const myRegistrations = asyncHandler(async (req, res) => {
  const rows = await svc.myRegistrations(req.user.id);
  ok(res, 'My registrations', rows);
});

const registrations = asyncHandler(async (req, res) => {
  const rows = await svc.eventRegistrations(parseInt(req.params.id, 10));
  ok(res, 'Event registrations', rows);
});

// ---- Event requests ----
const createRequest = asyncHandler(async (req, res) => {
  const data = await svc.createRequest(req.user.id, req.body);
  ok(res, `Event request submitted. Request ID: ${data.public_id}`, data, 201);
});

const listRequests = asyncHandler(async (req, res) => {
  const mine = req.query.mine === '1';
  const rows = await svc.listRequests(req.user, { status: req.query.status || '', mine });
  ok(res, 'Event requests', rows);
});

const getRequest = asyncHandler(async (req, res) => {
  const data = await svc.getRequest(parseInt(req.params.id, 10));
  ok(res, 'Event request', data);
});

const approve = asyncHandler(async (req, res) => {
  const result = await svc.reviewRequest(parseInt(req.params.id, 10), req.user, 'approve', req.body.remarks);
  ok(res, 'Event approved and published', result);
});

const reject = asyncHandler(async (req, res) => {
  if (!req.body.remarks) return res.status(400).json({ success: false, message: 'Rejection reason is required' });
  const result = await svc.reviewRequest(parseInt(req.params.id, 10), req.user, 'reject', req.body.remarks);
  ok(res, 'Event rejected', result);
});

const requestChanges = asyncHandler(async (req, res) => {
  if (!req.body.remarks) return res.status(400).json({ success: false, message: 'Please describe the required changes' });
  const result = await svc.reviewRequest(parseInt(req.params.id, 10), req.user, 'changes', req.body.remarks);
  ok(res, 'Changes requested from organizer', result);
});

const resubmit = asyncHandler(async (req, res) => {
  const result = await svc.resubmitRequest(parseInt(req.params.id, 10), req.user.id, req.body);
  ok(res, 'Request updated and resubmitted for review', result);
});

// Student publishes their HOD-approved proposal (finalize + go live)
const publishRequest = asyncHandler(async (req, res) => {
  const result = await svc.publishRequestEvent(parseInt(req.params.id, 10), req.user.id, req.body);
  ok(res, `Event published: "${result.title}" is now visible on the Events page`, result, 201);
});

// Simple validators for request payloads
const { body } = require('express-validator');
const requestRules = [
  body('title').trim().isLength({ min: 5, max: 160 }).withMessage('Title must be 5-160 characters'),
  body('description').trim().isLength({ min: 20 }).withMessage('Description must be at least 20 characters'),
  body('category').isIn(svc.EVENT_CATEGORIES),
  body('event_type').optional().isIn(svc.EVENT_TYPES),
  body('venue').trim().notEmpty().withMessage('Venue is required'),
  body('proposed_date').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('Valid date required'),
  body('start_time').matches(/^\d{2}:\d{2}/).withMessage('Valid start time required'),
  body('end_time').matches(/^\d{2}:\d{2}/).withMessage('Valid end time required'),
  body('expected_participants').optional().isInt({ min: 1, max: 100000 }),
];

module.exports = {
  list, past, categories, recommended, detail, previousWinners, register, cancel, myRegistrations, registrations,
  createRequest, listRequests, getRequest, approve, reject, requestChanges, resubmit, publishRequest,
  requestRules,
};
