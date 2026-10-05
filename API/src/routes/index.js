'use strict';

const health = require('./health');
const meta = require('./meta');
const staticRoutes = require('./static');
const live = require('./live');
const bootstrap = require('./bootstrap');
const reverseIndex = require('./reverse-index');
const discovery = require('./discovery');
const places = require('./places');
const summary = require('./summary');

async function registerRoutes(fastify) {
  fastify.get('/v1', async () => ({
    version: 'v1',
    serverNow: new Date().toISOString(),
    endpoints: [
      'GET /v1/health',
      'GET /v1/health/live',
      'GET /v1/health/static',
      'GET /v1/meta/live',
      'GET /v1/meta/static',
      'GET /v1/static',
      'GET /v1/static/latest',
      'GET /v1/static/latest/index',
      'GET /v1/static/:hash',
      'GET /v1/static/:hash/index',
      'GET /v1/static/:hash/routes',
      'GET /v1/static/:hash/routes/:name',
      'GET /v1/live',
      'GET /v1/live/buses',
      'GET /v1/live/buses/:name',
      'GET /v1/live/alerts',
      'GET /v1/live/schedule',
      'GET /v1/bootstrap',
      'GET /v1/routes',
      'GET /v1/routes/active',
      'GET /v1/routes/stale',
      'GET /v1/routes/:name',
      'GET /v1/routes/:name/streets',
      'GET /v1/stops',
      'GET /v1/stops/:stopId',
      'GET /v1/stops/:stopId/routes',
      'GET /v1/streets',
      'GET /v1/streets/:name',
      // places
      'GET /v1/places',
      'GET /v1/places/meta',
      'GET /v1/places/latest',
      'GET /v1/places/:hash',
      'GET /v1/places/:hash/items/:id',
      // summary
      'GET /v1/summary',
    ],
  }));

  await fastify.register(health);
  await fastify.register(meta);
  await fastify.register(staticRoutes);
  await fastify.register(live);
  await fastify.register(bootstrap);
  await fastify.register(reverseIndex);
  await fastify.register(discovery);

  // places registers both static-segment and param-segment routes:
  //   /v1/places/meta       (static)
  //   /v1/places/latest     (static)
  //   /v1/places/:hash      (param)
  //   /v1/places/:hash/...  (param)
  // Registering places after reverse-index keeps the /v1/routes and
  // /v1/stops ordering untouched.
  await fastify.register(places);

  await fastify.register(summary);
}

module.exports = registerRoutes;