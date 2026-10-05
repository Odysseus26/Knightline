'use strict';

const { get, getJSON } = require('../redis');
const KEYS = require('../keys');
const { errors } = require('../errors');
const { setCache } = require('../http');

function parseWindow(raw) {
  if (raw === 'old' || raw === 'previous') return 'old';
  return 'current';
}

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

async function loadLive(requestedWindow) {
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

module.exports = async function bootstrapRoutes(fastify) {
  fastify.get('/v1/bootstrap', async (req, reply) => {
    const have = typeof req.query.have === 'string' ? req.query.have : null;
    const includeIndex = req.query.index !== 'false';
    const requestedWindow = parseWindow(req.query.window);

    const [staticResolved, liveResolved, liveMeta] = await Promise.all([
      resolveStaticHash(requestedWindow),
      loadLive(requestedWindow),
      getJSON(KEYS.liveMeta).catch(() => null),
    ]);

    if (!staticResolved && !liveResolved) {
      throw errors.upstreamUnavailable('no data available', 5000);
    }

    const serverNow = new Date();
    const asOf = liveResolved?.snapshot?.asOf ?? null;
    const ageMs = asOf ? serverNow.getTime() - Date.parse(asOf) : null;

    let staticPayload = null;
    let indexPayload = null;

    const haveMatches =
      staticResolved != null && staticResolved.hash === have;

    if (staticResolved && !haveMatches) {
      const [routesRaw, indexRaw] = await Promise.all([
        get(`${KEYS.staticPrefix}${staticResolved.hash}`),
        includeIndex
          ? get(`${KEYS.indexPrefix}${staticResolved.hash}`)
          : Promise.resolve(null),
      ]);
      if (routesRaw) {
        try { staticPayload = JSON.parse(routesRaw); } catch { staticPayload = null; }
      }
      if (indexRaw) {
        try { indexPayload = JSON.parse(indexRaw); } catch { indexPayload = null; }
      }
    }

    setCache(reply, { noStore: true });

    const routeVersion = staticResolved?.hash ?? null;
    if (routeVersion) reply.header('X-Route-Version', routeVersion);
    if (staticResolved) reply.header('X-Static-Window', staticResolved.window);
    if (liveResolved) reply.header('X-Live-Window', liveResolved.window);
    if (liveResolved?.fellBack) reply.header('X-Live-Fell-Back', '1');

    return {
      routeVersion,
      staticWindow: staticResolved?.window ?? null,
      staticFellBack: staticResolved?.fellBack ?? false,
      serverNow: serverNow.toISOString(),
      haveMatches,
      static: staticPayload,
      index: indexPayload,
      live: liveResolved
        ? {
            ...liveResolved.snapshot,
            serverNow: serverNow.toISOString(),
            ageMs,
            stale: liveMeta?.stale === true || liveResolved.fellBack === true,
            window: liveResolved.window,
            fellBack: liveResolved.fellBack,
          }
        : null,
    };
  });
};