'use strict';
const svc = require('../services/verificationService');
const { asyncHandler, ok } = require('../utils/helpers');

const request = asyncHandler(async (req, res) => {
  const r = await svc.requestVerification(req.user, req.body || {});
  ok(res, 'Verification request submitted for review', r, 201);
});

const mine = asyncHandler(async (req, res) => {
  ok(res, 'Latest verification request', await svc.myRequest(req.user));
});

const officially = asyncHandler(async (req, res) => {
  ok(res, 'Official accounts', await svc.officialAccounts({ type: req.query.type }));
});

// ---- admin ----
const list = asyncHandler(async (req, res) => {
  ok(res, 'Verification requests', await svc.listRequests({ status: req.query.status }));
});

const approve = asyncHandler(async (req, res) => {
  ok(res, 'Account verified', await svc.approve(req.user, req.params.id));
});

const reject = asyncHandler(async (req, res) => {
  ok(res, 'Request declined', await svc.reject(req.user, req.params.id, (req.body || {}).note));
});

const setForUser = asyncHandler(async (req, res) => {
  ok(res, 'Verification updated', await svc.setVerification(req.user, req.params.id, req.body || {}));
});

module.exports = { request, mine, officially, list, approve, reject, setForUser };
