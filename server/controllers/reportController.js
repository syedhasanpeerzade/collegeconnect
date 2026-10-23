'use strict';
const report = require('../services/reportService');
const { asyncHandler } = require('../utils/helpers');
const { authorize } = require('../middleware/auth');

const ok = (res, data, message, status = 200) => res.status(status).json({ success: true, message: message || 'OK', data });

async function reportPost(req, res) {
  try {
    const r = await report.reportPost(req.user, req.body || {});
    return ok(res, r, 'Reported', 201);
  } catch (err) {
    if (err.status === 409) return ok(res, { reported: true }, 'Already reported', 200);
    throw err;
  }
}

async function reportComment(req, res) {
  try {
    const r = await report.reportComment(req.user, req.body || {});
    return ok(res, r, 'Reported', 201);
  } catch (err) {
    if (err.status === 409) return ok(res, { reported: true }, 'Already reported', 200);
    throw err;
  }
}

async function reportUser(req, res) {
  try {
    const r = await report.reportUser(req.user, req.body || {});
    return ok(res, r, 'Reported', 201);
  } catch (err) {
    if (err.status === 409) return ok(res, { reported: true }, 'Already reported', 200);
    throw err;
  }
}

async function pendingReports(req, res) {
  const data = await report.listPendingReports({
    type: req.query.type || 'post',
    limit: req.query.limit,
  });
  ok(res, data);
}

async function reportCounts(req, res) {
  ok(res, await report.pendingCounts());
}

async function resolveReport(req, res) {
  const r = await report.resolveReport(req.user, req.body || {});
  ok(res, r);
}

async function restoreContent(req, res) {
  const r = await report.restoreContent(req.user, req.body || {});
  ok(res, r);
}

async function deleteContent(req, res) {
  const r = await report.deleteContent(req.user, req.body || {});
  ok(res, r);
}

module.exports = {
  reportPost: asyncHandler(reportPost),
  reportComment: asyncHandler(reportComment),
  reportUser: asyncHandler(reportUser),
  pendingReports: asyncHandler(pendingReports),
  reportCounts: asyncHandler(reportCounts),
  resolveReport: asyncHandler(resolveReport),
  restoreContent: asyncHandler(restoreContent),
  deleteContent: asyncHandler(deleteContent),
};
