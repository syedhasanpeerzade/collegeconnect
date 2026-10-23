'use strict';
const { ApiError } = require('../utils/ApiError');

// Human-readable messages for common MySQL errors
const DB_MESSAGES = {
  ER_DUP_ENTRY: 'A record with these details already exists.',
  ER_BAD_NULL_ERROR: 'A required field was missing.',
  ER_NO_REFERENCED_ROW_2: 'Related record not found.',
  ER_ROW_IS_REFERENCED_2: 'This record is referenced by other data and cannot be deleted.',
  ER_DATA_TOO_LONG: 'One of the fields is too long.',
  ER_TRUNCATED_WRONG_VALUE: 'One of the fields has an invalid value.',
};

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  let status = err instanceof ApiError ? err.status : (err.status || 500);
  let message = err.message || 'Something went wrong';
  let code = err.code || 'ERROR';

  if (err.code && DB_MESSAGES[err.code]) {
    status = status === 500 ? 409 : status;
    message = DB_MESSAGES[err.code];
    code = err.code;
  }
  if (status >= 500) {
    console.error('[error]', err);
    if (process.env.NODE_ENV === 'production') message = 'Internal server error';
  }

  res.status(status).json({ success: false, message, code });
}

function notFound(req, res) {
  res.status(404).json({ success: false, message: 'Not found' });
}

module.exports = { errorHandler, notFound };
