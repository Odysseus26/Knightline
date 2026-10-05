'use strict';

const CONFIG = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '0.0.0.0',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  logLevel: process.env.LOG_LEVEL || 'info',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  redisTimeoutMs: Number(process.env.REDIS_TIMEOUT_MS) || 500,
  allowDebug: process.env.ALLOW_DEBUG === 'true',
  bodyLimit: Number(process.env.BODY_LIMIT) || 1024 * 1024,
};

module.exports = { CONFIG };