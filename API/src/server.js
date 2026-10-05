#!/usr/bin/env node
'use strict';

const Fastify = require('fastify');
const cors = require('@fastify/cors');
const compress = require('@fastify/compress');

const { CONFIG } = require('./config');
const { close, ping } = require('./redis');
const { ApiError, errorBody } = require('./errors');
const registerRoutes = require('./routes');

async function build() {
  const isDev = process.env.NODE_ENV !== 'production';

  const fastify = Fastify({
    logger: {
      level: CONFIG.logLevel,
      transport: isDev
        ? {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss' },
          }
        : undefined,
    },
    bodyLimit: CONFIG.bodyLimit,
    disableRequestLogging: false,
    requestIdHeader: 'x-request-id',
    genReqId: (req) =>
      req.headers['x-request-id'] ||
      `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  });

  await fastify.register(cors, {
    origin: CONFIG.corsOrigin === '*' ? true : CONFIG.corsOrigin.split(','),
    methods: ['GET', 'OPTIONS'],
    credentials: false,
  });

  await fastify.register(compress, {
    global: true,
    threshold: 1024,
    encodings: ['br', 'gzip', 'deflate'],
  });

  fastify.setErrorHandler((err, req, reply) => {
    const isApi = err instanceof ApiError;
    const status = isApi ? err.status : err.statusCode || 500;

    if (!isApi && status >= 500) {
      req.log.error({ err }, 'unhandled error');
    }

    if (isApi && err.code === 'UPSTREAM_UNAVAILABLE' && err.extra?.retryAfterMs) {
      reply.header('Retry-After', String(Math.ceil(err.extra.retryAfterMs / 1000)));
    }

    reply.code(status).send(errorBody(err, req.id));
  });

  fastify.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `No route for ${req.method} ${req.url}`,
      },
      requestId: req.id,
    });
  });

  await registerRoutes(fastify);
  return fastify;
}

async function main() {
  const state = await ping().catch((err) => ({ ok: false, error: err.message }));
  if (!state.ok) {
    console.error('Redis unreachable at startup:', state.error || 'no PONG');
    process.exitCode = 1;
    return;
  }

  const fastify = await build();

  const shutdown = async (sig) => {
    fastify.log.info({ sig }, 'shutting down');
    try { await fastify.close(); } catch { /* ignore */ }
    try { await close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await fastify.listen({ port: CONFIG.port, host: CONFIG.host });
  fastify.log.info(
    `API listening on http://${CONFIG.host}:${CONFIG.port} (${process.env.NODE_ENV || 'development'})`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exitCode = 1;
  });
}

module.exports = { build, main };