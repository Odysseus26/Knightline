// Redis/places.js
'use strict';

/**
 * places.js — daily producer for building/place data.
 *
 * Source:  bus_support/buildings.js (capturePlaces)
 * Cadence: once per 24-hour bucket.
 * Writes:  bus:places:* (only this file writes that namespace)
 *
 * Design mirrors routes.js from the handoff doc, minus the rotation
 * slot — buildings do not have a "previous window".
 *
 * Cardinal rules:
 *   - Single writer for bus:places:*
 *   - Lock before capture (SET NX EX)
 *   - Content-addressed blob; pointer flipped after blob is written
 *   - On rejection: log, mark meta.stale, skip the day. Do not crash.
 *   - On rejection: leave bus:places:current untouched.
 *
 * Redis client: ioredis. Every other producer in this repo uses ioredis;
 * using the same library here keeps the API surface consistent and
 * avoids two competing client implementations in node_modules.
 */

const crypto = require('crypto');
const Redis = require('ioredis');
const { capturePlaces } = require('../Support_Files/buildings');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const CONFIG = {
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',

  // How often the event loop wakes up to ask "is it a new day yet?".
  // This is NOT the capture cadence. 1 hour is fine: the actual gate
  // is rotationMs below.
  tickIntervalMs: Number(process.env.PLACES_TICK_MS || 60 * 60 * 1000),

  // Bucket size. A capture runs when the bucket number changes.
  // 24h means at most one capture per calendar day.
  rotationMs: Number(process.env.PLACES_ROTATION_MS || 24 * 60 * 60 * 1000),

  // TTL applied to the previous blob once it stops being current.
  // 30 days is generous; it only exists so a client that cached the
  // old hash can still read it for a while.
  blobTtlSec: Number(
    process.env.PLACES_BLOB_TTL_SEC || 30 * 24 * 60 * 60,
  ),

  // Lock TTL. Must exceed the worst-case capture time (two HTTP
  // requests with a 30s timeout each). 120s is comfortable.
  lockTtlSec: Number(process.env.PLACES_LOCK_TTL_SEC || 120),

  // Bump when the shape of `Place` changes in a way that would collide
  // with an older blob of the same content. Included in the hash input.
  schemaVersion: 1,
};

// ---------------------------------------------------------------------------
// CONFIG_KEYS — every Redis key this file touches, in one place.
//
// If you ever add a key and forget to put it here, you will see
// `keys 'undefined*'` in redis-cli. That is the symptom of a missing
// field. Keep this block authoritative.
// ---------------------------------------------------------------------------
const CONFIG_KEYS = {
  // Pointer to the current places hash.
  current: 'bus:places:current',
  // Freshness / error state. Never deleted.
  meta: 'bus:places:meta',
  // Single-flight lock. Short TTL.
  lock: 'bus:places:lock',
  // Last successfully captured bucket number.
  // Used to enforce "once per day" even across process restarts.
  rotationLastBucket: 'bus:places:rotation:lastBucket',
  // Immutable content-addressed blob.
  blob: (hash) => `bus:places:${hash}`,
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function staticHash(obj) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(obj))
    .digest('hex')
    .slice(0, 12);
}

function currentBucket(nowMs = Date.now()) {
  return Math.floor(nowMs / CONFIG.rotationMs);
}

async function acquireLock(redis) {
  const token = crypto.randomBytes(16).toString('hex');
  // ioredis variadic form: SET key value NX EX <seconds>
  const ok = await redis.set(
    CONFIG_KEYS.lock,
    token,
    'NX',
    'EX',
    CONFIG.lockTtlSec,
  );
  return ok === 'OK' ? token : null;
}

async function releaseLock(redis, token) {
  if (!token) return;
  // Best-effort: only delete if we still own the lock.
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    else
      return 0
    end
  `;
  try {
    // ioredis eval signature: eval(script, numKeys, ...keysAndArgs)
    await redis.eval(script, 1, CONFIG_KEYS.lock, token);
  } catch (err) {
    console.error('[places] releaseLock failed:', err.message);
  }
}

async function readMeta(redis) {
  const raw = await redis.get(CONFIG_KEYS.meta);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeMeta(redis, patch) {
  const prev = (await readMeta(redis)) || {};
  const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
  await redis.set(CONFIG_KEYS.meta, JSON.stringify(next));
  return next;
}

// ---------------------------------------------------------------------------
// Tick
//
// Returns one of:
//   { status: 'skipped',  reason: 'locked' | 'same-bucket' }
//   { status: 'unchanged', hash, count }
//   { status: 'captured',  hash, count }
//   { status: 'failed',    error }
//
// This function never throws. Every failure path is handled internally
// so the outer interval loop is safe.
// ---------------------------------------------------------------------------
async function tick(redis, { logger = console } = {}) {
  const token = await acquireLock(redis);
  if (!token) {
    if (logger.log) logger.log('[places] lock held elsewhere, skipping');
    return { status: 'skipped', reason: 'locked' };
  }

  try {
    const bucket = currentBucket();
    const lastBucketRaw = await redis.get(CONFIG_KEYS.rotationLastBucket);
    const lastBucket = lastBucketRaw ? Number(lastBucketRaw) : null;

    if (lastBucket != null && bucket === lastBucket) {
      if (logger.log) {
        logger.log(`[places] bucket ${bucket} already handled, skipping`);
      }
      return { status: 'skipped', reason: 'same-bucket' };
    }

    // Mark this bucket as attempted BEFORE capture. If capture fails,
    // we still skip the rest of the day. That is the "skip over that
    // day" behaviour the operator asked for: a bad upstream does not
    // produce a storm of retries.
    await redis.set(CONFIG_KEYS.rotationLastBucket, String(bucket));

    // ---- Capture ----------------------------------------------------------
    let result;
    try {
      result = await capturePlaces({ logger });
    } catch (err) {
      // Rejection path. Log, mark meta, do NOT touch the pointer or blob.
      if (logger.error) {
        logger.error('[places] capture failed, skipping today:', err.message);
      }
      await writeMeta(redis, {
        stale: true,
        lastError: err.message,
        lastAttemptAt: new Date().toISOString(),
        lastFailedAt: new Date().toISOString(),
      });
      return { status: 'failed', error: err.message };
    }

    // ---- Shape + hash -----------------------------------------------------
    // schemaVersion is part of the hash input so a shape change produces
    // a new hash even when the underlying data is unchanged.
    const hash = staticHash({
      schema: CONFIG.schemaVersion,
      places: result.places,
    });
    const payload = {
      version: hash,
      schemaVersion: CONFIG.schemaVersion,
      generatedAt: result.generatedAt,
      count: result.count,
      sourceSyncId: result.sourceSyncId,
      places: result.places,
    };

    const prevHash = await redis.get(CONFIG_KEYS.current);

    // ---- Unchanged --------------------------------------------------------
    if (prevHash === hash) {
      await writeMeta(redis, {
        hash,
        count: result.count,
        sourceSyncId: result.sourceSyncId,
        stale: false,
        lastError: null,
        checkedAt: new Date().toISOString(),
      });
      if (logger.log) {
        logger.log(
          `[places] hash unchanged (${hash}), refreshed meta only`,
        );
      }
      return { status: 'unchanged', hash, count: result.count };
    }

    // ---- Write new blob, then flip pointer --------------------------------
    await redis.set(CONFIG_KEYS.blob(hash), JSON.stringify(payload));
    await redis.set(CONFIG_KEYS.current, hash);

    // Give the previous blob a TTL so it eventually disappears.
    // Failure here is non-fatal — the previous blob simply lingers.
    if (prevHash && prevHash !== hash) {
      try {
        await redis.expire(
          CONFIG_KEYS.blob(prevHash),
          CONFIG.blobTtlSec,
        );
      } catch (err) {
        if (logger.warn) {
          logger.warn(
            '[places] could not set TTL on previous blob:',
            err.message,
          );
        }
      }
    }

    await writeMeta(redis, {
      hash,
      count: result.count,
      sourceSyncId: result.sourceSyncId,
      stale: false,
      lastError: null,
      checkedAt: new Date().toISOString(),
      capturedAt: new Date().toISOString(),
    });

    if (logger.log) {
      logger.log(
        `[places] wrote ${result.count} places -> bus:places:${hash}`,
      );
    }
    return { status: 'captured', hash, count: result.count };
  } finally {
    await releaseLock(redis, token);
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  const redis = new Redis(CONFIG.redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  redis.on('error', (err) =>
    console.error('[places] redis error:', err.message),
  );
  redis.on('connect', () =>
    console.error(`[places] redis connected: ${CONFIG.redisUrl}`),
  );

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[places] received ${sig}, shutting down`);
    try { await redis.del(CONFIG_KEYS.lock); } catch { /* ignore */ }
    try { await redis.quit(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.error(
    `[places] starting; rotation window = ${CONFIG.rotationMs} ms; ` +
    `tick = ${CONFIG.tickIntervalMs} ms; ` +
    `schema = ${CONFIG.schemaVersion}`,
  );

  const runTick = async () => {
    try {
      const result = await tick(redis, { logger: console });
      console.error(
        `[places] tick: ${result.status}` +
        (result.hash ? ` (${result.hash}, ${result.count})` : '') +
        (result.reason ? ` [${result.reason}]` : ''),
      );
    } catch (err) {
      // tick() is supposed to never throw. If it does, log and keep
      // the loop alive — one bad tick must not kill the process.
      console.error('[places] unexpected tick error:', err);
    }
  };

  await runTick();
  setInterval(runTick, CONFIG.tickIntervalMs);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[places] fatal:', err);
    process.exit(1);
  });
}

module.exports = {
  CONFIG,
  CONFIG_KEYS,
  tick,
  staticHash,
  currentBucket,
};