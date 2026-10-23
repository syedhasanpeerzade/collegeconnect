'use strict';
const svc = require('../services/importService');
const { asyncHandler, ok } = require('../utils/helpers');
const { ApiError } = require('../utils/ApiError');

/** GET /api/admin/import/types - the 5 importable record types + their columns. */
async function listTypes(req, res) {
  ok(res, 'Import types', svc.listTypes());
}

/** GET /api/admin/import/template/:type - downloadable CSV template. */
async function downloadTemplate(req, res) {
  const type = String(req.params.type || '').toUpperCase();
  const spec = svc.typeSpecs[type];
  if (!spec) throw new ApiError(404, `Unknown import type "${req.params.type}"`);

  const header = spec.columns.map((c) => c.label);
  // Header + one clearly-marked example row so the shape is obvious. The
  // example is NOT imported - the admin replaces it with real archive data.
  const example = spec.columns.map((c) => c.example || '');
  const csv = svc.toCsv(header, [example]);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="collegeconnect-${type.toLowerCase()}-template.csv"`);
  res.send('\ufeff' + csv); // BOM so Excel opens UTF-8 correctly
}

/**
 * POST /api/admin/import/preview - parse + validate an uploaded CSV.
 * Writes nothing; returns every row with its status, errors and notes.
 */
async function preview(req, res) {
  if (!req.file || !req.file.buffer) throw new ApiError(400, 'Upload a CSV file first');
  const type = String((req.body && req.body.type) || '').toUpperCase();
  const text = req.file.buffer.toString('utf8');
  const analysis = await svc.analyseCsv({ type, text });
  ok(res, `Preview ready: ${analysis.summary.valid} valid, ${analysis.summary.invalid} invalid, ${analysis.summary.duplicate} duplicate`, {
    ...analysis,
    filename: req.file.originalname || null,
  });
}

/** POST /api/admin/import/commit - insert the selected, re-validated rows. */
async function commit(req, res) {
  const body = req.body || {};
  const summary = await svc.commitImport(req.user, body);
  ok(res, `Imported ${summary.imported} record(s)${summary.duplicates ? `, ${summary.duplicates} duplicate(s) skipped` : ''}${summary.failed ? `, ${summary.failed} failed` : ''}`, summary, 201);
}

/** GET /api/admin/import/history - recent import batches. */
async function history(req, res) {
  ok(res, 'Import history', await svc.history({ limit: req.query.limit }));
}

/** GET /api/admin/import/batches/:id - the records a batch created. */
async function batchDetail(req, res) {
  ok(res, 'Batch records', await svc.batchRecords(req.params.id));
}

module.exports = {
  listTypes: asyncHandler(listTypes),
  downloadTemplate: asyncHandler(downloadTemplate),
  preview: asyncHandler(preview),
  commit: asyncHandler(commit),
  history: asyncHandler(history),
  batchDetail: asyncHandler(batchDetail),
};
