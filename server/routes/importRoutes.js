'use strict';
/**
 * Bulk historical import — ADMIN ONLY.
 *
 * Official college records may only be created through here by an
 * administrator. The authorization boundary is the same middleware every
 * other admin route uses (`authenticate` + `authorize('ADMIN')`), which is
 * what actually protects the data because the API connects to PostgreSQL as
 * the table owner (RLS is not enabled on this database).
 */
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/importController');
const { authenticate, authenticateQuery, authorize } = require('../middleware/auth');
const { uploads, uploadErrorHandler } = require('../middleware/upload');

// Templates are plain GETs so the browser can download them directly;
// authenticateQuery accepts ?token= exactly like the CSV report downloads.
router.get('/types', authenticate, authorize('ADMIN'), ctrl.listTypes);
router.get('/template/:type', authenticateQuery, authorize('ADMIN'), ctrl.downloadTemplate);
router.get('/history', authenticate, authorize('ADMIN'), ctrl.history);
router.get('/batches/:id', authenticate, authorize('ADMIN'), ctrl.batchDetail);

// Preview parses the uploaded CSV in memory; nothing is stored yet.
router.post('/preview', authenticate, authorize('ADMIN'), uploads.csvImport, uploadErrorHandler, ctrl.preview);
// Commit writes the rows the admin selected (re-validated server-side).
router.post('/commit', authenticate, authorize('ADMIN'), ctrl.commit);

module.exports = router;
