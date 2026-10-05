'use strict';

const { getJSON } = require('../redis');
const KEYS = require('../keys');
const { errors } = require('../errors');
const { setCache } = require('../http');

module.exports = async function summaryRoutes(fastify) {
  fastify.get('/v1/summary', async (req, reply) => {
    // Summary always reads the current slot. If it's missing, fall back
    // to old so the banner still renders something.
    let snapshot = await getJSON(KEYS.liveCurrent).catch(() => null);
    let window = 'current';
    if (!snapshot) {
      snapshot = await getJSON(KEYS.liveOld).catch(() => null);
      window = 'old';
    }
    if (!snapshot) throw errors.upstreamUnavailable('live snapshot not available', 5000);

    const routes = new Set();
    for (const b of snapshot.buses || []) if (b.route) routes.add(b.route);
    const routeList = [...routes].sort();
    const busCount = (snapshot.buses || []).length;

    const headline = busCount
      ? `${routeList.length} route${routeList.length === 1 ? '' : 's'} — ` +
        `${busCount} bus${busCount === 1 ? '' : 'es'} live`
      : `${routeList.length} route${routeList.length === 1 ? '' : 's'} — ` +
        `no buses currently live`;

    setCache(reply, { maxAge: 10, swr: 60 });
    return {
      serverNow: new Date().toISOString(),
      asOf: snapshot.asOf,
      window,
      headline,
      activeRoutes: routeList,
      busCount,
      alertCount: (snapshot.alerts || []).length,
      note:
        'Rider counts may reflect APC-derived rolling totals rather than ' +
        'current onboard passengers.',
    };
  });
};