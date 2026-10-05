'use strict';

const { getJSON } = require('../redis');
const KEYS = require('../keys');
const { errors } = require('../errors');
const { setCache } = require('../http');

module.exports = async function metaRoutes(fastify) {
  fastify.get('/v1/meta/live', async (req, reply) => {
    const meta = await getJSON(KEYS.liveMeta).catch(() => null);
    if (!meta) throw errors.upstreamUnavailable('live meta unavailable', 5000);
    setCache(reply, { noStore: true });
    return meta;
  });

  fastify.get('/v1/meta/static', async (req, reply) => {
    const meta = await getJSON(KEYS.staticMeta).catch(() => null);
    if (!meta) throw errors.upstreamUnavailable('static meta unavailable', 5000);
    setCache(reply, { noStore: true });
    return meta;
  });
};