'use strict';

const { ping, getJSON, get } = require('../redis');
const KEYS = require('../keys');
const { setCache } = require('../http');

module.exports = async function healthRoutes(fastify) {
  fastify.get('/v1/health', async (req, reply) => {
    const redis = await ping().catch((err) => ({ ok: false, error: err.message }));

    const [liveMeta, staticMeta, liveCurrentExists, liveOldExists] =
      await Promise.all([
        getJSON(KEYS.liveMeta).catch(() => null),
        getJSON(KEYS.staticMeta).catch(() => null),
        get(KEYS.liveCurrent).then((v) => v !== null).catch(() => false),
        get(KEYS.liveOld).then((v) => v !== null).catch(() => false),
      ]);

    const now = Date.now();

    const live = liveMeta
      ? {
          updatedAt: liveMeta.updatedAt ?? null,
          asOf: liveMeta.asOf ?? null,
          ageMs: liveMeta.asOf ? now - Date.parse(liveMeta.asOf) : null,
          busCount: liveMeta.busCount ?? null,
          routeCount: liveMeta.routeCount ?? null,
          durationMs: liveMeta.durationMs ?? null,
          rotationBucket: liveMeta.rotationBucket ?? null,
          rotationWindowMs: liveMeta.rotationWindowMs ?? null,
          lastRotatedAt: liveMeta.lastRotatedAt ?? null,
          slots: {
            current: liveCurrentExists,
            old: liveOldExists,
          },
          stale: liveMeta.stale === true,
          lastError: liveMeta.lastError ?? null,
        }
      : null;

    const stat = staticMeta
      ? {
          hash: staticMeta.hash ?? null,
          previousHash: staticMeta.previousHash ?? null,
          updatedAt: staticMeta.updatedAt ?? null,
          checkedAt: staticMeta.checkedAt ?? null,
          routeCount: staticMeta.routeCount ?? null,
          stopCount: staticMeta.stopCount ?? null,
          streetCount: staticMeta.streetCount ?? null,
          durationMs: staticMeta.durationMs ?? null,
          rotationBucket: staticMeta.rotationBucket ?? null,
          stale: staticMeta.stale === true,
          lastError: staticMeta.lastError ?? null,
        }
      : null;

    const ok =
      redis.ok &&
      !!liveMeta &&
      !!staticMeta &&
      live?.stale !== true &&
      stat?.stale !== true &&
      liveCurrentExists;

    setCache(reply, { noStore: true });
    reply.code(ok ? 200 : 503);
    return {
      ok,
      serverNow: new Date().toISOString(),
      redis,
      live,
      static: stat,
    };
  });

  fastify.get('/v1/health/live', async (req, reply) => {
    const meta = await getJSON(KEYS.liveMeta).catch(() => null);
    if (!meta) {
      reply.code(503);
      return { ok: false, reason: 'no live meta' };
    }
    const currentExists = await get(KEYS.liveCurrent).then((v) => v !== null);
    const stale = meta.stale === true || !currentExists;
    setCache(reply, { noStore: true });
    reply.code(stale ? 503 : 200);
    return {
      ok: !stale,
      stale,
      currentExists,
      updatedAt: meta.updatedAt ?? null,
      busCount: meta.busCount ?? null,
      rotationBucket: meta.rotationBucket ?? null,
      lastError: meta.lastError ?? null,
    };
  });

  fastify.get('/v1/health/static', async (req, reply) => {
    const meta = await getJSON(KEYS.staticMeta).catch(() => null);
    if (!meta) {
      reply.code(503);
      return { ok: false, reason: 'no static meta' };
    }
    const stale = meta.stale === true;
    setCache(reply, { noStore: true });
    reply.code(stale ? 503 : 200);
    return {
      ok: !stale,
      stale,
      hash: meta.hash ?? null,
      previousHash: meta.previousHash ?? null,
      updatedAt: meta.updatedAt ?? null,
      checkedAt: meta.checkedAt ?? null,
      routeCount: meta.routeCount ?? null,
      stopCount: meta.stopCount ?? null,
      streetCount: meta.streetCount ?? null,
      rotationBucket: meta.rotationBucket ?? null,
      lastError: meta.lastError ?? null,
    };
  });
};