'use strict';

class ApiError extends Error {
  constructor(code, message, status, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const errors = {
  badRequest: (msg, extra) => new ApiError('BAD_REQUEST', msg, 400, extra),
  notFound: (msg, extra) => new ApiError('NOT_FOUND', msg, 404, extra),
  upstreamUnavailable: (msg, retryAfterMs = 5000) =>
    new ApiError('UPSTREAM_UNAVAILABLE', msg, 503, { retryAfterMs }),
  internal: (msg) => new ApiError('INTERNAL', msg, 500),
};

function errorBody(err, requestId) {
  const body = {
    error: {
      code: err.code || 'INTERNAL',
      message: err.message || 'Unexpected error',
    },
    requestId: requestId || null,
  };
  if (err.extra?.retryAfterMs) {
    body.error.retryAfterMs = err.extra.retryAfterMs;
  }
  return body;
}

module.exports = { ApiError, errors, errorBody };