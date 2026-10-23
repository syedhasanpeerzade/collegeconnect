'use strict';
const svc = require('../services/clubService');
const { asyncHandler, ok } = require('../utils/helpers');
const { body } = require('express-validator');

const list = asyncHandler(async (req, res) => {
  const rows = await svc.listClubs({
    search: req.query.search || '',
    category: req.query.category || '',
    recruitment: req.query.recruitment || '',
  });
  ok(res, 'Clubs', rows);
});

const detail = asyncHandler(async (req, res) => {
  const userId = req.user ? req.user.id : null;
  const club = await svc.getClub(parseInt(req.params.id, 10), userId);
  ok(res, 'Club details', club);
});

const apply = asyncHandler(async (req, res) => {
  const result = await svc.apply(parseInt(req.params.id, 10), req.user.id, req.body);
  ok(res, `Application submitted. Application ID: ${result.public_id}`, result, 201);
});

const myApplications = asyncHandler(async (req, res) => {
  const data = await svc.myApplications(req.user.id);
  ok(res, 'My club applications and memberships', data);
});

const clubApplications = asyncHandler(async (req, res) => {
  const rows = await svc.clubApplications(parseInt(req.params.id, 10), req.user, req.query.status || '');
  ok(res, 'Club applications', rows);
});

const approveApplication = asyncHandler(async (req, res) => {
  const result = await svc.reviewApplication(parseInt(req.params.id, 10), req.user, 'approve');
  ok(res, 'Application approved. Member added to the club.', result);
});

const rejectApplication = asyncHandler(async (req, res) => {
  if (!req.body.rejection_reason) {
    return res.status(400).json({ success: false, message: 'Rejection reason is required' });
  }
  const result = await svc.reviewApplication(parseInt(req.params.id, 10), req.user, 'reject', req.body.rejection_reason);
  ok(res, 'Application rejected', result);
});

const markUnderReview = asyncHandler(async (req, res) => {
  await svc.markUnderReview(parseInt(req.params.id, 10), req.user);
  ok(res, 'Application moved to under review');
});

const removeMember = asyncHandler(async (req, res) => {
  const clubId = parseInt(req.params.id, 10);
  const result = await svc.removeMember(clubId, parseInt(req.params.memberId, 10), req.user);
  ok(res, `${result.name} removed from the club`);
});

const setMemberRole = asyncHandler(async (req, res) => {
  const clubId = parseInt(req.params.id, 10);
  await svc.setMemberRole(clubId, parseInt(req.params.memberId, 10), req.body.role, req.user);
  ok(res, 'Member role updated');
});

const updateClub = asyncHandler(async (req, res) => {
  const payload = { ...req.body };
  if (req.files) {
    if (req.files.logo) payload.logo_path = `/uploads/clubs/${req.files.logo[0].filename}`;
    if (req.files.banner) payload.banner_path = `/uploads/clubs/${req.files.banner[0].filename}`;
  }
  await svc.updateClub(parseInt(req.params.id, 10), req.user, payload);
  ok(res, 'Club updated');
});

const addQuestion = asyncHandler(async (req, res) => {
  const result = await svc.addCustomQuestion(parseInt(req.params.id, 10), req.user, req.body);
  ok(res, 'Question added', result, 201);
});

const deleteQuestion = asyncHandler(async (req, res) => {
  await svc.deleteCustomQuestion(parseInt(req.params.id, 10), parseInt(req.params.questionId, 10), req.user);
  ok(res, 'Question removed');
});

const myClubs = asyncHandler(async (req, res) => {
  const rows = await svc.myCoordinatedClubs(req.user.id);
  ok(res, 'Coordinated clubs', rows);
});

const applyRules = [
  body('why_join').trim().isLength({ min: 20 }).withMessage('Please write at least 20 characters about why you want to join'),
];

module.exports = {
  list, detail, apply, myApplications, clubApplications, approveApplication,
  rejectApplication, markUnderReview, removeMember, setMemberRole, updateClub,
  addQuestion, deleteQuestion, myClubs, applyRules,
};
