'use strict';

const { get } = require('../redis');
const KEYS = require('../keys');
const { errors } = require('../errors');
const { setCache } = require('../http');

async function readCurrentHash() {
  return get(KEYS.staticCurrent);
}

async function readIndexBlob(hash) {
  const raw = await get(`${KEYS.indexPrefix}${hash}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function readRoutesBlob(hash) {
  const raw = await get(`${KEYS.staticPrefix}${hash}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

module.exports = async function reverseIndexRoutes(fastify) {
  // GET /v1/routes/stale — MUST be registered before /v1/routes/:name so
  // find-my-way resolves the static segment first.
  fastify.get('/v1/routes/stale', async (req, reply) => {
    const hash = await readCurrentHash();
    if (!hash) throw errors.upstreamUnavailable('static not ready', 10_000);

    const blob = await readRoutesBlob(hash);
    if (!blob) throw errors.notFound(`routes blob ${hash} missing`);

    const stale = [];
    for (const [name, def] of Object.entries(blob.routes || {})) {
      if (def?.staleSince) {
        stale.push({
          name,
          staleSince: def.staleSince,
          lastGoodAt: def.lastGoodAt ?? null,
          lastError: def.lastError ?? null,
        });
      }
    }
    stale.sort((a, b) => a.name.localeCompare(b.name));

    setCache(reply, { maxAge: 10, swr: 60 });
    reply.header('X-Route-Version', hash);
    return {
      routeVersion: hash,
      staleCount: stale.length,
      staleRoutes: stale,
    };
  });

  // GET /v1/stops/:stopId/routes — every route that serves this stop.
  // Accepts stopId, sharedStopId, or gtfsId.
  fastify.get('/v1/stops/:stopId/routes', async (req, reply) => {
    const hash = await readCurrentHash();
    if (!hash) throw errors.upstreamUnavailable('static not ready', 10_000);

    const blob = await readIndexBlob(hash);
    if (!blob) throw errors.notFound(`index blob ${hash} missing`);

    const id = req.params.stopId;

    const byStop = blob.stopsById?.[id];
    if (byStop) {
      setCache(reply, { maxAge: 300 });
      reply.header('X-Route-Version', hash);
      return { routeVersion: hash, stopId: id, matchedBy: 'stopId', routes: byStop };
    }

    const byGtfs = blob.stopsByGtfsId?.[id];
    if (byGtfs) {
      setCache(reply, { maxAge: 300 });
      reply.header('X-Route-Version', hash);
      return { routeVersion: hash, stopId: id, matchedBy: 'gtfsId', routes: byGtfs };
    }

    throw errors.notFound(`stop "${id}" not found in index`);
  });

  // GET /v1/streets — every unique street with the routes that use it
  fastify.get('/v1/streets', async (req, reply) => {
    const hash = await readCurrentHash();
    if (!hash) throw errors.upstreamUnavailable('static not ready', 10_000);

    const blob = await readIndexBlob(hash);
    if (!blob) throw errors.notFound(`index blob ${hash} missing`);

    const streets = Object.entries(blob.streetsByName || {})
      .map(([name, routes]) => ({ name, routes }))
      .sort((a, b) => a.name.localeCompare(b.name));

    setCache(reply, { maxAge: 300 });
    reply.header('X-Route-Version', hash);
    return { routeVersion: hash, streetCount: streets.length, streets };
  });

  // GET /v1/streets/:name — one street and which routes use it
  fastify.get('/v1/streets/:name', async (req, reply) => {
    const hash = await readCurrentHash();
    if (!hash) throw errors.upstreamUnavailable('static not ready', 10_000);

    const blob = await readIndexBlob(hash);
    if (!blob) throw errors.notFound(`index blob ${hash} missing`);

    const name = req.params.name;
    const routes = blob.streetsByName?.[name];
    if (!routes) throw errors.notFound(`street "${name}" not found`);

    setCache(reply, { maxAge: 300 });
    reply.header('X-Route-Version', hash);
    return { routeVersion: hash, name, routes };
  });
};