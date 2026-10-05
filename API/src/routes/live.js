'use strict';

const { getJSON } = require('../redis');
const KEYS = require('../keys');
const { errors } = require('../errors');
const { setCache } = require('../http');

// ---------------------------------------------------------------------------
// Window resolution
// ---------------------------------------------------------------------------

/**
 * Load a live snapshot, honoring ?window= and auto-falling back to the
 * old slot when the current slot is missing.
 *
 * Returns null if neither slot has data.
 * Otherwise: { snapshot, window, fellBack }
 *   window   = "current" | "old"   (which slot was served)
 *   fellBack = true only when we asked for "current" and got "old"
 */
async function loadLiveSnapshot(requestedWindow) {
  if (requestedWindow === 'old') {
    const old = await getJSON(KEYS.liveOld).catch(() => null);
    if (!old) return null;
    return { snapshot: old, window: 'old', fellBack: false };
  }

  const cur = await getJSON(KEYS.liveCurrent).catch(() => null);
  if (cur) return { snapshot: cur, window: 'current', fellBack: false };

  const old = await getJSON(KEYS.liveOld).catch(() => null);
  if (old) return { snapshot: old, window: 'old', fellBack: true };

  return null;
}

async function loadMeta() {
  return getJSON(KEYS.liveMeta).catch(() => null);
}

function parseWindow(raw) {
  if (raw === 'old' || raw === 'previous') return 'old';
  return 'current';
}

function decorate(snapshot, meta, requestedWindow, resolvedWindow, fellBack) {
  const serverNow = new Date();
  const asOf = snapshot?.asOf ?? meta?.asOf ?? null;
  const ageMs = asOf ? serverNow.getTime() - Date.parse(asOf) : null;
  return {
    ...snapshot,
    serverNow: serverNow.toISOString(),
    asOf,
    ageMs,
    // `stale` means: the underlying producer's last tick failed, OR the
    // client asked for `current` and we had to serve `old`.
    stale: meta?.stale === true || fellBack === true,
    window: resolvedWindow,
    requestedWindow,
    fellBack,
  };
}

// ---------------------------------------------------------------------------
// Field filtering (unchanged)
// ---------------------------------------------------------------------------

function parseFields(raw) {
  if (!raw) return null;
  return new Set(String(raw).split(',').map((s) => s.trim()).filter(Boolean));
}

function pickFields(body, fields) {
  if (!fields) return body;
  const keep = new Set([
    'serverNow', 'asOf', 'ageMs', 'stale', 'staticVersion',
    'window', 'requestedWindow', 'fellBack', 'busCount',
  ]);
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (keep.has(k) || fields.has(k)) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bus filtering (unchanged)
// ---------------------------------------------------------------------------

function parseNameList(raw) {
  if (!raw) return null;
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

function filterBuses(buses, routeParam, routesParam) {
  const list = buses || [];
  if (routeParam) return list.filter((b) => b.route === routeParam);
  const names = parseNameList(routesParam);
  if (names) {
    const set = new Set(names);
    return list.filter((b) => set.has(b.route));
  }
  return list;
}

// ---------------------------------------------------------------------------

module.exports = async function liveRoutes(fastify) {
  // GET /v1/live
  fastify.get('/v1/live', async (req, reply) => {
    const requestedWindow = parseWindow(req.query.window);
    const resolved = await loadLiveSnapshot(requestedWindow);
    if (!resolved) {
      throw errors.upstreamUnavailable('live snapshot not available', 5000);
    }

    const meta = await loadMeta();
    const staticHash = requestedWindow === 'old' ? null : null; // see note below

    let body = decorate(
      resolved.snapshot,
      meta,
      requestedWindow,
      resolved.window,
      resolved.fellBack,
    );

    if (req.query.route || req.query.routes) {
      const filtered = filterBuses(body.buses, req.query.route, req.query.routes);
      body = { ...body, buses: filtered, busCount: filtered.length };
    }

    const fields = parseFields(req.query.fields);
    body = pickFields(body, fields);

    // Cache shorter when we're serving a fallback.
    if (resolved.fellBack || resolved.window === 'old') {
      setCache(reply, { maxAge: 2, swr: 10 });
    } else {
      setCache(reply, { maxAge: 5, swr: 25 });
    }

    if (body.asOf) reply.header('X-Live-As-Of', body.asOf);
    reply.header('X-Live-Window', resolved.window);
    if (resolved.fellBack) reply.header('X-Live-Fell-Back', '1');
    return body;
  });

  // GET /v1/live/buses
  fastify.get('/v1/live/buses', async (req, reply) => {
    const requestedWindow = parseWindow(req.query.window);
    const resolved = await loadLiveSnapshot(requestedWindow);
    if (!resolved) {
      throw errors.upstreamUnavailable('live snapshot not available', 5000);
    }
    const meta = await loadMeta();
    const buses = filterBuses(
      resolved.snapshot.buses,
      req.query.route,
      req.query.routes,
    );

    setCache(reply, resolved.window === 'current' && !resolved.fellBack
      ? { maxAge: 5, swr: 25 }
      : { maxAge: 2, swr: 10 });

    reply.header('X-Live-Window', resolved.window);
    if (resolved.fellBack) reply.header('X-Live-Fell-Back', '1');

    return {
      serverNow: new Date().toISOString(),
      asOf: resolved.snapshot.asOf,
      stale: meta?.stale === true || resolved.fellBack === true,
      window: resolved.window,
      requestedWindow,
      fellBack: resolved.fellBack,
      busCount: buses.length,
      buses,
    };
  });

  // GET /v1/live/buses/:name
  fastify.get('/v1/live/buses/:name', async (req, reply) => {
    const requestedWindow = parseWindow(req.query.window);
    const resolved = await loadLiveSnapshot(requestedWindow);
    if (!resolved) {
      throw errors.upstreamUnavailable('live snapshot not available', 5000);
    }
    const bus = (resolved.snapshot.buses || []).find((b) => b.name === req.params.name);
    if (!bus) throw errors.notFound(`bus "${req.params.name}" not live`);

    const meta = await loadMeta();

    setCache(reply, { maxAge: 5, swr: 25 });
    reply.header('X-Live-Window', resolved.window);

    return {
      serverNow: new Date().toISOString(),
      asOf: resolved.snapshot.asOf,
      stale: meta?.stale === true || resolved.fellBack === true,
      window: resolved.window,
      fellBack: resolved.fellBack,
      bus,
    };
  });

  // GET /v1/live/alerts
  fastify.get('/v1/live/alerts', async (req, reply) => {
    const requestedWindow = parseWindow(req.query.window);
    const resolved = await loadLiveSnapshot(requestedWindow);
    if (!resolved) {
      throw errors.upstreamUnavailable('live snapshot not available', 5000);
    }
    const meta = await loadMeta();

    setCache(reply, { maxAge: 30, swr: 120 });
    reply.header('X-Live-Window', resolved.window);

    return {
      serverNow: new Date().toISOString(),
      asOf: resolved.snapshot.asOf,
      stale: meta?.stale === true || resolved.fellBack === true,
      window: resolved.window,
      alerts: resolved.snapshot.alerts || [],
    };
  });

  // GET /v1/live/schedule
  fastify.get('/v1/live/schedule', async (req, reply) => {
    const requestedWindow = parseWindow(req.query.window);
    const resolved = await loadLiveSnapshot(requestedWindow);
    if (!resolved) {
      throw errors.upstreamUnavailable('live snapshot not available', 5000);
    }
    const meta = await loadMeta();

    setCache(reply, { maxAge: 10, swr: 60 });
    reply.header('X-Live-Window', resolved.window);

    return {
      serverNow: new Date().toISOString(),
      asOf: resolved.snapshot.asOf,
      stale: meta?.stale === true || resolved.fellBack === true,
      window: resolved.window,
      schedule: resolved.snapshot.schedule || null,
    };
  });
};