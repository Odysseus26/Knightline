'use strict';

const { get, getJSON } = require('../redis');
const KEYS = require('../keys');
const { errors } = require('../errors');
const { setCache } = require('../http');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readCurrentStatic() {
  const hash = await get(KEYS.staticCurrent);
  if (!hash) return null;
  const [routesRaw, indexRaw] = await Promise.all([
    get(`${KEYS.staticPrefix}${hash}`),
    get(`${KEYS.indexPrefix}${hash}`),
  ]);
  if (!routesRaw) return null;
  try {
    const routes = JSON.parse(routesRaw);
    const index = indexRaw ? JSON.parse(indexRaw) : null;
    return { hash, routes, index };
  } catch {
    return null;
  }
}

/**
 * Read the live snapshot, preferring the current slot and falling back
 * to old so discovery endpoints don't disappear during a rotation
 * hiccup. Returns the snapshot plus the window it came from, or null
 * if neither slot has data.
 */
async function readLiveSnapshot() {
  const cur = await getJSON(KEYS.liveCurrent).catch(() => null);
  if (cur) return { snapshot: cur, window: 'current' };

  const old = await getJSON(KEYS.liveOld).catch(() => null);
  if (old) return { snapshot: old, window: 'old' };

  return null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

module.exports = async function discoveryRoutes(fastify) {
  // GET /v1/routes — list with freshness summary
  fastify.get('/v1/routes', async (req, reply) => {
    const cur = await readCurrentStatic();
    if (!cur) throw errors.upstreamUnavailable('static not ready', 10_000);

    const routes = Object.entries(cur.routes.routes || {}).map(([name, def]) => ({
      name,
      route: def?.route ?? null,
      stopCount: Array.isArray(def?.stops) ? def.stops.length : 0,
      streetCount: Array.isArray(def?.streets) ? def.streets.length : 0,
      lastGoodAt: def?.lastGoodAt ?? null,
      staleSince: def?.staleSince ?? null,
      stale: !!def?.staleSince,
    }));

    setCache(reply, { maxAge: 300 });
    reply.header('X-Route-Version', cur.hash);
    return { routeVersion: cur.hash, routeCount: routes.length, routes };
  });

  // GET /v1/routes/active — routes with at least one live bus
  fastify.get('/v1/routes/active', async (req, reply) => {
    const live = await readLiveSnapshot();
    if (!live) {
      throw errors.upstreamUnavailable('live snapshot not available', 5000);
    }

    const set = new Set();
    for (const b of live.snapshot.buses || []) {
      if (b.route) set.add(b.route);
    }

    setCache(reply, { maxAge: 10, swr: 60 });
    reply.header('X-Live-Window', live.window);
    return {
      serverNow: new Date().toISOString(),
      asOf: live.snapshot.asOf,
      window: live.window,
      activeRoutes: [...set].sort(),
    };
  });

  // GET /v1/routes/:name — full definition (metadata, stops, streets,
  // geometry, freshness)
  fastify.get('/v1/routes/:name', async (req, reply) => {
    const cur = await readCurrentStatic();
    if (!cur) throw errors.upstreamUnavailable('static not ready', 10_000);

    const def = cur.routes.routes?.[req.params.name];
    if (!def) throw errors.notFound(`route "${req.params.name}" not found`);

    setCache(reply, { maxAge: 300 });
    reply.header('X-Route-Version', cur.hash);
    return def;
  });

  // GET /v1/routes/:name/streets — compact street segments only
  fastify.get('/v1/routes/:name/streets', async (req, reply) => {
    const cur = await readCurrentStatic();
    if (!cur) throw errors.upstreamUnavailable('static not ready', 10_000);

    const def = cur.routes.routes?.[req.params.name];
    if (!def) throw errors.notFound(`route "${req.params.name}" not found`);

    setCache(reply, { maxAge: 300 });
    reply.header('X-Route-Version', cur.hash);
    return {
      route: req.params.name,
      routeVersion: cur.hash,
      streetCount: Array.isArray(def.streets) ? def.streets.length : 0,
      streets: def.streets ?? [],
      staleSince: def.staleSince ?? null,
    };
  });

  // GET /v1/stops — deduped across routes; routes list from index
  fastify.get('/v1/stops', async (req, reply) => {
    const cur = await readCurrentStatic();
    if (!cur) throw errors.upstreamUnavailable('static not ready', 10_000);

    const byId = new Map();
    for (const [routeName, def] of Object.entries(cur.routes.routes || {})) {
      for (const stop of def?.stops || []) {
        const key =
          stop.sharedStopId ||
          stop.stopId ||
          stop.gtfsId ||
          `${stop.location?.lat},${stop.location?.lng}`;
        const existing = byId.get(key);
        if (existing) {
          if (!existing.routes.includes(routeName)) {
            existing.routes.push(routeName);
          }
        } else {
          byId.set(key, { ...stop, routes: [routeName] });
        }
      }
    }

    const stops = [...byId.values()].map((stop) => {
      const fromIndex =
        cur.index?.stopsByName?.[stop.name] ??
        (stop.stopId ? cur.index?.stopsById?.[stop.stopId] : null) ??
        (stop.gtfsId ? cur.index?.stopsByGtfsId?.[stop.gtfsId] : null);
      return { ...stop, routes: fromIndex ?? stop.routes };
    });

    stops.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    setCache(reply, { maxAge: 300 });
    reply.header('X-Route-Version', cur.hash);
    return { routeVersion: cur.hash, stopCount: stops.length, stops };
  });

  // GET /v1/stops/:stopId — one stop, all serving routes
  fastify.get('/v1/stops/:stopId', async (req, reply) => {
    const cur = await readCurrentStatic();
    if (!cur) throw errors.upstreamUnavailable('static not ready', 10_000);

    const id = req.params.stopId;

    for (const [routeName, def] of Object.entries(cur.routes.routes || {})) {
      for (const stop of def?.stops || []) {
        if (stop.stopId === id || stop.sharedStopId === id || stop.gtfsId === id) {
          const fromIndex =
            cur.index?.stopsById?.[id] ??
            (stop.gtfsId ? cur.index?.stopsByGtfsId?.[stop.gtfsId] : null) ??
            cur.index?.stopsByName?.[stop.name] ??
            [routeName];
          setCache(reply, { maxAge: 300 });
          reply.header('X-Route-Version', cur.hash);
          return { ...stop, routes: fromIndex };
        }
      }
    }

    throw errors.notFound(`stop "${id}" not found`);
  });
};