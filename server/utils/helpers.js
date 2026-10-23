'use strict';
const { ApiError } = require('./ApiError');

/** Wrap async route handlers so rejected promises reach the error handler. */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/** Success response: { success, message, data } */
function ok(res, message, data = null, status = 200) {
  res.status(status).json({ success: true, message, data });
}

/** Throw a standard error. */
function fail(status, message, code) {
  throw new ApiError(status, message, code);
}

/** Assert a condition or throw. */
function assert(condition, status, message, code) {
  if (!condition) fail(status, message, code);
}

/** "2026" -> sequence formatting helper */
function pad(n, width) {
  return String(n).padStart(width, '0');
}

/**
 * Generate the next public ID for a table, e.g. CC-EVT-2026-00125.
 * Uses MAX(id)+1 per year prefix inside the caller's transaction
 * (InnoDB row locks on the index gap make this safe enough for a college app).
 */
async function nextPublicId(conn, table, column, prefix) {
  const year = new Date().getFullYear();
  const like = `${prefix}-${year}-%`;
  const [rows] = await conn.execute(
    `SELECT ${column} FROM ${table} WHERE ${column} LIKE ? ORDER BY ${column} DESC LIMIT 1 FOR UPDATE`,
    [like]
  );
  let seq = 1;
  if (rows.length) {
    const m = String(rows[0][column]).match(/(\d+)$/);
    if (m) seq = parseInt(m[1], 10) + 1;
  } else {
    // No rows for this year yet - fall back to counting existing ids
    const [c] = await conn.execute(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} LIKE ?`, [like]);
    seq = (c[0].n | 0) + 1;
  }
  return `${prefix}-${year}-${pad(seq, 5)}`;
}

/** Shorter request ID: REQ-2026-0015 */
async function nextRequestId(conn) {
  const year = new Date().getFullYear();
  const like = `REQ-${year}-%`;
  const [rows] = await conn.execute(
    `SELECT public_id FROM event_requests WHERE public_id LIKE ? ORDER BY public_id DESC LIMIT 1 FOR UPDATE`,
    [like]
  );
  let seq = 1;
  if (rows.length) {
    const m = String(rows[0].public_id).match(/(\d+)$/);
    if (m) seq = parseInt(m[1], 10) + 1;
  }
  return `REQ-${year}-${pad(seq, 4)}`;
}

module.exports = { asyncHandler, ok, fail, assert, pad, nextPublicId, nextRequestId };
