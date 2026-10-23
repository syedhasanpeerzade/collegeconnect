'use strict';
const router = require('express').Router();
const svc = require('../services/interestService');
const { authenticate } = require('../middleware/auth');
const { asyncHandler, ok } = require('../utils/helpers');

/** Public catalog for onboarding/profile UIs. */
router.get('/options', asyncHandler(async (req, res) => {
  ok(res, 'Interest options', svc.INTERESTS.map(({ key, label, icon, description }) => ({ key, label, icon, description })));
}));

/** Current user's onboarding state + saved interests. */
router.get('/status', authenticate, asyncHandler(async (req, res) => {
  ok(res, 'Interest status', await svc.getStatus(req.user.id));
}));

/** Save interests; body: { interests: ['SPORTS', ...], skip?: true } */
router.put('/', authenticate, asyncHandler(async (req, res) => {
  if (req.user.role !== 'STUDENT') {
    return res.status(403).json({ success: false, message: 'Only students set event interests' });
  }
  const result = await svc.saveInterests(req.user.id, req.body.interests, { skipped: !!req.body.skip });
  ok(res, result.skipped ? 'Preferences skipped - you can set them anytime from Profile' : 'Your interests have been saved', result);
}));

module.exports = router;
