'use strict';

const { get } = require('../redis');
const KEYS = require('../keys');
const { errors } = require('../errors');
const { setCache, etagMatch, strongETag } = require('../http');

const HASH_RE = /^[a-f0-9]{4,64}$/i;

async function readCurrentHash() {
  return get(KEYS.placesCurrent);
}

async function readBlob(hash) {
  const raw = await get(`${KEYS.placesPrefix}${hash}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readMeta() {
  const raw = await get(KEYS.placesMeta);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

module.exports = async function placesRoutes(fastify) {
  // -------------------------------------------------------------------------
  // GET /v1/places — pointer only
  //
  // Tiny response. Clients call this on cold start to learn the current
  // version, then fetch the full blob only when the hash changes.
  // -------------------------------------------------------------------------
  fastify.get('/v1/places', async (req, reply) => {
    const hash = await readCurrentHash();
    if (!hash) {
      throw errors.upstreamUnavailable('places not ready', 10_000);
    }

    const meta = await readMeta();

    setCache(reply, { maxAge: 60, swr: 300 });
    reply.header('X-Places-Version', hash);

    return {
      hash,
      version: hash,
      count: meta?.count ?? null,
      generatedAt: meta?.capturedAt ?? null,
      sourceSyncId: meta?.sourceSyncId ?? null,
      stale: meta?.stale === true,
    };
  });

  // -------------------------------------------------------------------------
  // GET /v1/places/meta — raw meta record
  //
  // For ops and debugging. Not cached.
  // -------------------------------------------------------------------------
  fastify.get('/v1/places/meta', async (req, reply) => {
    const meta = await readMeta();
    if (!meta) {
      throw errors.upstreamUnavailable('places meta unavailable', 5000);
    }
    setCache(reply, { noStore: true });
    return meta;
  });

  // -------------------------------------------------------------------------
  // GET /v1/places/latest — full blob at the current version
  //
  // Short cache, since the pointer could flip at any tick boundary.
  // -------------------------------------------------------------------------
  fastify.get('/v1/places/latest', async (req, reply) => {
    const hash = await readCurrentHash();
    if (!hash) {
      throw errors.upstreamUnavailable('places not ready', 10_000);
    }
    const blob = await readBlob(hash);
    if (!blob) {
      throw errors.notFound(`places blob ${hash} missing`);
    }

    setCache(reply, { maxAge: 60 });
    reply.header('X-Places-Version', hash);
    return { ...blob, hash };
  });

  // -------------------------------------------------------------------------
  // GET /v1/places/:hash — full blob at a specific version
  //
  // Immutable. Strong ETag equal to the hash. CDN- and client-cacheable
  // for a day, effectively forever since the content never changes.
  // -------------------------------------------------------------------------
  fastify.get('/v1/places/:hash', async (req, reply) => {
    const { hash } = req.params;
    if (!HASH_RE.test(hash)) throw errors.badRequest('invalid hash');

    const etag = strongETag(hash);
    if (etagMatch(req.headers['if-none-match'], etag)) {
      reply.code(304).header('ETag', etag).send();
      return;
    }

    const blob = await readBlob(hash);
    if (!blob) throw errors.notFound(`places blob ${hash} not found`);

    setCache(reply, { maxAge: 86_400, immutable: true });
    reply.header('ETag', etag);
    reply.header('X-Places-Version', hash);
    return { ...blob, hash };
  });

  // -------------------------------------------------------------------------
  // GET /v1/places/:hash/items/:id — one place from a specific version
  //
  // Convenience for a "place detail" screen that already knows the
  // version. Returns the item plus the version it belongs to so the
  // client can cache by `${hash}|${id}`.
  // -------------------------------------------------------------------------
  fastify.get('/v1/places/:hash/items/:id', async (req, reply) => {
    const { hash, id } = req.params;
    if (!HASH_RE.test(hash)) throw errors.badRequest('invalid hash');

    const etag = strongETag(`${hash}-${id}`);
    if (etagMatch(req.headers['if-none-match'], etag)) {
      reply.code(304).header('ETag', etag).send();
      return;
    }

    const blob = await readBlob(hash);
    if (!blob) throw errors.notFound(`places blob ${hash} not found`);

    const place = (blob.places ?? []).find((p) => p.id === id);
    if (!place) {
      throw errors.notFound(`place "${id}" not found in ${hash}`);
    }

    setCache(reply, { maxAge: 86_400, immutable: true });
    reply.header('ETag', etag);
    reply.header('X-Places-Version', hash);
    return { hash, place };
  });
};