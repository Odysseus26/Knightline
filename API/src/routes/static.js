'use strict';

const { get } = require('../redis');
const KEYS = require('../keys');
const { errors } = require('../errors');
const { setCache, etagMatch, strongETag } = require('../http');

const HASH_RE = /^[a-f0-9]{4,64}$/i;

function parseWindow(raw) {
  if (raw === 'old' || raw === 'previous') return 'old';
  return 'current';
}

/**
 * Resolve a static hash, honoring ?window= and auto-falling back to the
 * old pointer when the current one is missing.
 *
 * Returns { hash, window, fellBack } or null.
 */
async function resolveStaticHash(requestedWindow) {
  if (requestedWindow === 'old') {
    const old = await get(KEYS.staticOld);
    if (!old) return null;
    return { hash: old, window: 'old', fellBack: false };
  }

  const cur = await get(KEYS.staticCurrent);
  if (cur) return { hash: cur, window: 'current', fellBack: false };

  const old = await get(KEYS.staticOld);
  if (old) return { hash: old, window: 'old', fellBack: true };

  return null;
}

async function readBlob(hash) {
  const raw = await get(`${KEYS.staticPrefix}${hash}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function readIndexRaw(hash) {
  return get(`${KEYS.indexPrefix}${hash}`);
}

module.exports = async function staticRoutes(fastify) {
  // GET /v1/static — version pointer
  fastify.get('/v1/static', async (req, reply) => {
    const requestedWindow = parseWindow(req.query.window);
    const resolved = await resolveStaticHash(requestedWindow);
    if (!resolved) throw errors.upstreamUnavailable('static not ready', 10_000);

    setCache(reply, { maxAge: 60, swr: 300 });
    reply.header('X-Route-Version', resolved.hash);
    reply.header('X-Static-Window', resolved.window);
    if (resolved.fellBack) reply.header('X-Static-Fell-Back', '1');

    return {
      hash: resolved.hash,
      routeVersion: resolved.hash,
      window: resolved.window,
      requestedWindow,
      fellBack: resolved.fellBack,
    };
  });

  // GET /v1/static/latest — full routes blob
  fastify.get('/v1/static/latest', async (req, reply) => {
    const requestedWindow = parseWindow(req.query.window);
    const resolved = await resolveStaticHash(requestedWindow);
    if (!resolved) throw errors.upstreamUnavailable('static not ready', 10_000);

    const blob = await readBlob(resolved.hash);
    if (!blob) throw errors.notFound(`static blob ${resolved.hash} missing`);

    setCache(reply, { maxAge: 60 });
    reply.header('X-Route-Version', resolved.hash);
    reply.header('X-Static-Window', resolved.window);

    return {
      ...blob,
      hash: resolved.hash,
      window: resolved.window,
      fellBack: resolved.fellBack,
    };
  });

  // GET /v1/static/latest/index — derived index
  fastify.get('/v1/static/latest/index', async (req, reply) => {
    const requestedWindow = parseWindow(req.query.window);
    const resolved = await resolveStaticHash(requestedWindow);
    if (!resolved) throw errors.upstreamUnavailable('static not ready', 10_000);

    const raw = await readIndexRaw(resolved.hash);
    if (!raw) throw errors.notFound(`index blob ${resolved.hash} missing`);

    setCache(reply, { maxAge: 60 });
    reply.header('X-Route-Version', resolved.hash);
    reply.header('X-Static-Window', resolved.window);
    reply.type('application/json').send(raw);
  });

  // GET /v1/static/:hash — immutable routes blob (no window concept)
  fastify.get('/v1/static/:hash', async (req, reply) => {
    const { hash } = req.params;
    if (!HASH_RE.test(hash)) throw errors.badRequest('invalid hash');

    const etag = strongETag(hash);
    if (etagMatch(req.headers['if-none-match'], etag)) {
      reply.code(304).header('ETag', etag).send();
      return;
    }

    const blob = await readBlob(hash);
    if (!blob) throw errors.notFound(`static blob ${hash} not found`);

    setCache(reply, { maxAge: 86_400, immutable: true });
    reply.header('ETag', etag);
    reply.header('X-Route-Version', hash);
    return { ...blob, hash };
  });

  // GET /v1/static/:hash/index — immutable index blob
  fastify.get('/v1/static/:hash/index', async (req, reply) => {
    const { hash } = req.params;
    if (!HASH_RE.test(hash)) throw errors.badRequest('invalid hash');

    const etag = strongETag(`index-${hash}`);
    if (etagMatch(req.headers['if-none-match'], etag)) {
      reply.code(304).header('ETag', etag).send();
      return;
    }

    const raw = await readIndexRaw(hash);
    if (!raw) throw errors.notFound(`index blob ${hash} not found`);

    setCache(reply, { maxAge: 86_400, immutable: true });
    reply.header('ETag', etag);
    reply.header('X-Route-Version', hash);
    reply.type('application/json').send(raw);
  });

  // GET /v1/static/:hash/routes — summaries
  fastify.get('/v1/static/:hash/routes', async (req, reply) => {
    const { hash } = req.params;
    if (!HASH_RE.test(hash)) throw errors.badRequest('invalid hash');

    const blob = await readBlob(hash);
    if (!blob) throw errors.notFound(`static blob ${hash} not found`);

    const routes = Object.entries(blob.routes || {}).map(([name, def]) => ({
      name,
      route: def?.route ?? null,
      stopCount: Array.isArray(def?.stops) ? def.stops.length : 0,
      streetCount: Array.isArray(def?.streets) ? def.streets.length : 0,
      lastGoodAt: def?.lastGoodAt ?? null,
      staleSince: def?.staleSince ?? null,
      stale: !!def?.staleSince,
    }));

    setCache(reply, { maxAge: 86_400, immutable: true });
    reply.header('ETag', strongETag(`routes-${hash}`));
    reply.header('X-Route-Version', hash);
    return { hash, routeCount: routes.length, routes };
  });

  // GET /v1/static/:hash/routes/:name — full route definition
  fastify.get('/v1/static/:hash/routes/:name', async (req, reply) => {
    const { hash, name } = req.params;
    if (!HASH_RE.test(hash)) throw errors.badRequest('invalid hash');

    const blob = await readBlob(hash);
    if (!blob) throw errors.notFound(`static blob ${hash} not found`);

    const def = blob.routes?.[name];
    if (!def) throw errors.notFound(`route "${name}" not found in ${hash}`);

    setCache(reply, { maxAge: 86_400, immutable: true });
    reply.header('X-Route-Version', hash);
    return def;
  });
};