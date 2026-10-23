'use strict';
const svc = require('../services/complaintService');
const { asyncHandler, ok } = require('../utils/helpers');
const { body } = require('express-validator');
const { uploads, uploadErrorHandler } = require('../middleware/upload');

const CATEGORIES = ['INFRASTRUCTURE','CLASSROOM','LABORATORY','WIFI','HOSTEL','CANTEEN','LIBRARY','TRANSPORT','ACADEMICS','OTHER'];
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

const create = asyncHandler(async (req, res) => {
  const attachment = req.file ? `/uploads/complaints/${req.file.filename}` : null;
  const result = await svc.create(req.user.id, req.body, attachment);
  ok(res, `Complaint submitted. Complaint ID: ${result.public_id}`, result, 201);
});

const list = asyncHandler(async (req, res) => {
  const mine = req.query.mine === '1';
  const rows = await svc.listFor(req.user, {
    status: req.query.status || '', category: req.query.category || '',
    priority: req.query.priority || '', mine,
  });
  ok(res, 'Complaints', rows);
});

const detail = asyncHandler(async (req, res) => {
  const data = await svc.getOne(parseInt(req.params.id, 10), req.user);
  ok(res, 'Complaint details', data);
});

const updateStatus = asyncHandler(async (req, res) => {
  const result = await svc.updateStatus(parseInt(req.params.id, 10), req.user, req.body);
  ok(res, `Complaint marked as ${String(req.body.status).toLowerCase().replace('_', ' ')}`, result);
});

const feedback = asyncHandler(async (req, res) => {
  const result = await svc.studentFeedback(parseInt(req.params.id, 10), req.user.id, req.body);
  const messages = {
    CLOSED: 'Thank you for confirming. Complaint closed.',
    REOPENED: 'Complaint reopened. Our team will look into it again.',
  };
  ok(res, messages[result.status] || 'Feedback saved', result);
});

const createRules = [
  body('title').trim().isLength({ min: 5, max: 160 }).withMessage('Title must be 5-160 characters'),
  body('description').trim().isLength({ min: 20 }).withMessage('Description must be at least 20 characters'),
  body('category').isIn(CATEGORIES).withMessage('Valid category required'),
  body('priority').optional().isIn(PRIORITIES),
  body('location').optional().trim().isLength({ max: 160 }),
];

module.exports = { create, list, detail, updateStatus, feedback, createRules, CATEGORIES, PRIORITIES };
