'use strict';
const router = require('express').Router();
const { latestEventResults } = require('../services/latestResultsService');
const { asyncHandler, ok } = require('../utils/helpers');

// Public: featured "latest completed event + winners" for the Achievements page
router.get('/', asyncHandler(async (req, res) => {
  ok(res, 'Latest event results', await latestEventResults());
}));

module.exports = router;
