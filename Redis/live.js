#!/usr/bin/env node
/**
 * live.js
 *
 * Long-running producer. Every tick:
 *
 *   1. Acquires a Redis single-flight lock (skips tick if held).
 *   2. Runs captureAndAggregate() from rutgers-server-full.js.
 *   3. Splits the aggregate into two tiers:
 *        - route tier  → route identity + timetable (hash-gated)
 *        - live tier   → buses + alerts + schedule (always overwritten)
 *   4. Rotates the live snapshot on a fixed wall-clock window
 *      (LIVE_ROTATION_MS, default 10 min):
 *        bus:live:old     ← bus:live:current    (previous window's data)
 *        bus:live:current ← fresh snapshot      (overwrites)
 *      Any content older than one full window is implicitly discarded —
 *      we only ever retain two slots.
 *   5. Writes both tiers and a meta record into Redis.
 *   6. Releases the lock.
 *
 * On failure the last good snapshot is left in place; its TTL provides
 * the grace window and `bus:live:meta.stale` flips to true.
 *
 * Usage:
 *   node live.js                       # 30s cadence, defaults
 *   node live.js --interval 60000      # 60s cadence
 *   node live.js --once                # one tick, then exit (for tests)
 *   node live.js --route "LX Route"    # one route only
 *   node live.js --headed              # visible browser (debug)
 *   node live.js --help
 *
 * Env:
 *   REDIS_URL          default redis://127.0.0.1:6379
 *   LIVE_INTERVAL_MS   default 30000
 *   LIVE_ROTATION_MS   default 600000  (10 min)
 *   LIVE_OLD_TTL_SEC   default 900     (15 min)
 *
 * Requires: ioredis, playwright, and rutgers-server-full.js alongside.
 */

'use strict';

const crypto = require('crypto');
const Redis = require('ioredis');

const {
  captureAndAggregate,
  buildAggregate,
  CONFIG: SERVER_CONFIG,
} = require('../Support_Files/rutgers-server-full');


// ===========================================================================
// CONFIGURATION
// ===========================================================================

const CONFIG = {
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',

  // How often the live producer runs. Must be longer than the slowest
  // expected tick, or overlapping ticks will be skipped by the lock.
  intervalMs: Number(process.env.LIVE_INTERVAL_MS) || 30_000,

  // Live snapshot lifetime. Must be longer than intervalMs so a single
  // missed tick doesn't wipe the key; must be short enough that a dead
  // producer eventually stops serving stale data.
  liveTtlSec: 120,

  // Rotation window. Every time the wall-clock crosses a multiple of
  // this value, the current snapshot is copied to the "old" slot and
  // the current slot is overwritten with the fresh capture.
  rotationWindowMs: Number(process.env.LIVE_ROTATION_MS) || 5 * 60 * 1000,

  // TTL for the "old" slot. Must exceed rotationWindowMs so that a
  // rotation always refreshes it before it can expire naturally. When
  // the producer dies, both slots eventually expire and clients see
  // "no data" instead of silently-stale data.
  oldTtlSec: Number(process.env.LIVE_OLD_TTL_SEC) || 15 * 60,

  // Lock TTL. Short enough that a crashed tick self-heals; long enough
  // that a slow Playwright capture isn't preempted by the next tick.
  lockTtlSec: 45,

  keys: {
    // Live tier — two rotating slots plus rotation bookkeeping.
    current: 'bus:live:current',
    old: 'bus:live:old',
    lastBucket: 'bus:live:rotation:lastBucket',
    liveMeta: 'bus:live:meta',
    liveLock: 'bus:live:lock',

    // Route tier — unchanged from before (already content-addressed).
    routeCurrent: 'bus:routes:current',
    routePrefix: 'bus:routes:',
    routeMeta: 'bus:routes:meta',
  },
};


// ===========================================================================
// CLI
// ===========================================================================

function parseArgs(argv) {
  const out = {
    interval: null,
    once: false,
    route: null,
    headed: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--interval' || a === '-i') {
      const n = Number(next);
      if (Number.isFinite(n) && n >= 1000) { out.interval = Math.floor(n); i++; }
    } else if (a === '--once') {
      out.once = true;
    } else if (a === '--route' || a === '-r') {
      if (next && !next.startsWith('-')) { out.route = next; i++; }
    } else if (a === '--headed') {
      out.headed = true;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`
live.js — Rutgers live producer → Redis

Usage:
  node live.js [options]

Options:
  -i, --interval <ms>   Tick interval (default ${CONFIG.intervalMs}, min 1000)
      --once            Run exactly one tick and exit
  -r, --route <name>    Capture one route only (default: all)
      --headed          Visible browser (debug only, slow)
  -h, --help            Show this help

Environment:
  REDIS_URL             default ${CONFIG.redisUrl}
  LIVE_INTERVAL_MS      default ${CONFIG.intervalMs}
  LIVE_ROTATION_MS      default ${CONFIG.rotationWindowMs} (10 min)
  LIVE_OLD_TTL_SEC      default ${CONFIG.oldTtlSec} (15 min)

Redis keys written:
  ${CONFIG.keys.current}                 live snapshot for the current window
  ${CONFIG.keys.old}                     live snapshot from the previous window
  ${CONFIG.keys.lastBucket}              rotation bookkeeping (bucket number)
  ${CONFIG.keys.liveMeta}                live freshness / error state
  ${CONFIG.keys.routeCurrent}            pointer to current route-tier hash
  ${CONFIG.keys.routePrefix}<hash>       immutable route-tier blob
  ${CONFIG.keys.routeMeta}               route-tier freshness
`);
}


// ===========================================================================
// TIER SPLITTING
// ===========================================================================

/**
 * A bus is "publishable" only if it has a usable name. TripShot
 * occasionally emits live rides with a null or empty vehicle name — these
 * are usually buses being pre-positioned or deadheaded, and they render
 * as "Bus " with no identifier in the client. We drop them at the
 * producer so nothing downstream has to know about the edge case.
 */
function isPublishableBus(bus) {
  return (
    bus != null &&
    typeof bus.name === 'string' &&
    bus.name.trim().length > 0
  );
}

/**
 * Live tier — the hot data the client polls. Small, always overwritten.
 * Shape mirrors the aggregated payload minus the per-route static data.
 *
 * Nameless buses are filtered out here, before the payload reaches Redis.
 * `busCount` reflects the filtered count, and `droppedNameless` records
 * how many were dropped this tick for observability.
 */
function extractLiveTier(aggregate) {
  const rawBuses = Array.isArray(aggregate.buses) ? aggregate.buses : [];
  const buses = rawBuses.filter(isPublishableBus);
  const droppedNameless = rawBuses.length - buses.length;

  return {
    asOf: aggregate.asOf,
    capturedAt: aggregate.capturedAt,
    routeCount: aggregate.routeCount,
    busCount: buses.length,
    droppedNameless,
    timedOutRoutes: aggregate.timedOutRoutes,
    buses,
    alerts: aggregate.alerts,
    schedule: aggregate.schedule,
  };
}

/**
 * Route tier — the cold data. Route identity + timetable per route.
 * Bumped only when the hash changes (see routeIdentityHash below).
 */
function extractRouteTier(aggregate) {
  const routes = {};
  for (const [name, perRoute] of Object.entries(aggregate.routes)) {
    routes[name] = {
      route: perRoute.route ?? null,
      timetable: perRoute.timetable ?? null,
    };
  }
  return { routes };
}

/**
 * Stable hash of the route tier. Only route identity is hashed, so
 * timetable churn (past rides accumulating actuals) does NOT bump the
 * route version on every tick.
 */
function routeIdentityHash(routeTier) {
  const identity = {};
  for (const [name, r] of Object.entries(routeTier.routes)) {
    identity[name] = r.route;
  }
  const canonical = JSON.stringify(identity, Object.keys(identity).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}


// ===========================================================================
// ROTATION
// ===========================================================================

/**
 * Which wall-clock bucket are we in right now?
 * Bucket size = CONFIG.rotationWindowMs. Consecutive ticks within the
 * same window return the same number.
 */
function currentBucket(now = Date.now()) {
  return Math.floor(now / CONFIG.rotationWindowMs);
}

/**
 * Decide whether this tick needs to rotate.
 *
 * Returns { bucket, lastBucket, rotate } where:
 *   rotate === true  → this is the first tick of a new window
 *   rotate === false → same window as the previous tick
 *
 * The first tick ever (lastBucket === null) initialises the bucket
 * WITHOUT rotating (there's nothing to rotate into "old").
 */
async function planRotation(redis) {
  const bucket = currentBucket();
  const lastStr = await redis.get(CONFIG.keys.lastBucket);
  const lastBucket = lastStr != null ? Number(lastStr) : null;

  return {
    bucket,
    lastBucket,
    isFirstEver: lastBucket === null,
    rotate: lastBucket !== null && lastBucket !== bucket,
  };
}


// ===========================================================================
// WRITERS
// ===========================================================================

/**
 * Write the live tier, rotating first if we crossed a window boundary.
 *
 * Order of operations (all inside one MULTI where possible):
 *   1. If rotating: bus:live:old ← the current value (read before MULTI)
 *   2. If rotating: bus:live:rotation:lastBucket ← new bucket
 *   3. Always:      bus:live:current ← fresh snapshot
 *
 * The single-flight lock guarantees no other writer races us between
 * the pre-read and the MULTI, so the "read then write" pattern is safe.
 */
async function writeLiveTier(
  redis,
  liveTier,
  routeHash,
  { rotate, bucket, isFirstEver },
) {
  const payload = JSON.stringify({ ...liveTier, routeVersion: routeHash });

  // Pre-read the current value ONLY if we're about to rotate. Reading
  // unconditionally would waste a round-trip on 19 out of every 20 ticks.
  let previousCurrent = null;
  if (rotate) {
    previousCurrent = await redis.get(CONFIG.keys.current);
  }

  const tx = redis.multi();

  if (rotate && previousCurrent !== null) {
    tx.set(CONFIG.keys.old, previousCurrent, 'EX', CONFIG.oldTtlSec);
  } else if (rotate && previousCurrent === null) {
    // We're rotating but there's nothing to rotate. Clear the old slot
    // so clients don't read a stale leftover from a previous era.
    tx.del(CONFIG.keys.old);
  }

  if (rotate || isFirstEver) {
    tx.set(CONFIG.keys.lastBucket, String(bucket));
  }

  tx.set(CONFIG.keys.current, payload, 'EX', CONFIG.liveTtlSec);

  await tx.exec();
}

async function writeLiveMeta(redis, meta) {
  await redis.set(CONFIG.keys.liveMeta, JSON.stringify(meta));
}

async function writeRouteTier(redis, routeTier, routeHash, previousHash) {
  // Immutable blob, no TTL. Old versions linger for rollback.
  await redis.set(
    `${CONFIG.keys.routePrefix}${routeHash}`,
    JSON.stringify(routeTier),
  );
  await redis.set(CONFIG.keys.routeCurrent, routeHash);
  await redis.set(
    CONFIG.keys.routeMeta,
    JSON.stringify({
      hash: routeHash,
      previousHash: previousHash ?? null,
      updatedAt: new Date().toISOString(),
    }),
  );
}


// ===========================================================================
// ONE TICK
// ===========================================================================

async function tick(redis, options = {}) {
  const startedAt = Date.now();

  // 1. Single-flight lock.
  const locked = await redis.set(
    CONFIG.keys.liveLock,
    String(process.pid),
    'NX',
    'EX',
    CONFIG.lockTtlSec,
  );
  if (!locked) {
    console.error('[live] previous tick still running, skipping');
    return { skipped: true };
  }

  try {
    // 2. Plan rotation early so we know whether to snapshot current.
    const rotation = await planRotation(redis);

    // 3. Capture.
    const { perRoute } = await captureAndAggregate({
      route: options.route,
      headed: options.headed ?? false,
    });
    const aggregate = buildAggregate(perRoute);

    // 4. Split tiers. Live tier drops nameless buses before they hit Redis.
    const liveTier = extractLiveTier(aggregate);
    const routeTier = extractRouteTier(aggregate);
    const routeHash = routeIdentityHash(routeTier);

    // 5. Write route tier (only when identity changes).
    const previousHash = await redis.get(CONFIG.keys.routeCurrent);
    const routeChanged = previousHash !== routeHash;
    if (routeChanged) {
      await writeRouteTier(redis, routeTier, routeHash, previousHash);
      console.error(
        `[live] route tier updated: ${previousHash ?? '(none)'} -> ${routeHash}`,
      );
    }

    // 6. Write live tier (always) — rotates if we crossed a boundary.
    await writeLiveTier(redis, liveTier, routeHash, rotation);

    if (rotation.rotate) {
      console.error(
        `[live] rotated live window: bucket ${rotation.lastBucket} -> ${rotation.bucket}`,
      );
    } else if (rotation.isFirstEver) {
      console.error(`[live] initialised live window: bucket ${rotation.bucket}`);
    }

    // 7. Write meta.
    const durationMs = Date.now() - startedAt;
    await writeLiveMeta(redis, {
      updatedAt: new Date().toISOString(),
      asOf: aggregate.asOf,
      capturedAt: aggregate.capturedAt,
      routeCount: aggregate.routeCount,
      busCount: liveTier.busCount,
      droppedNameless: liveTier.droppedNameless,
      timedOutRoutes: aggregate.timedOutRoutes,
      routeHash,
      routeChanged,
      rotationBucket: rotation.bucket,
      rotationWindowMs: CONFIG.rotationWindowMs,
      lastRotatedAt: rotation.rotate
        ? new Date(rotation.bucket * CONFIG.rotationWindowMs).toISOString()
        : undefined,
      durationMs,
      stale: false,
      lastError: null,
    });

    console.error(
      `[live] ok — ${aggregate.routeCount} routes, ` +
      `${liveTier.busCount} buses` +
      (liveTier.droppedNameless > 0
        ? ` (${liveTier.droppedNameless} nameless dropped)`
        : '') +
      `, ${durationMs}ms` +
      (routeChanged ? ' (route tier updated)' : '') +
      (rotation.rotate ? ' (rotated)' : ''),
    );

    return {
      ok: true,
      durationMs,
      busCount: liveTier.busCount,
      droppedNameless: liveTier.droppedNameless,
      routeChanged,
      rotated: rotation.rotate,
    };
  } catch (err) {
    // Do NOT touch bus:live:current. Its TTL keeps the last good
    // snapshot alive; bus:live:old keeps the previous window's alive.
    const durationMs = Date.now() - startedAt;
    try {
      await writeLiveMeta(redis, {
        updatedAt: new Date().toISOString(),
        durationMs,
        stale: true,
        lastError: err.message,
      });
    } catch (metaErr) {
      console.error('[live] failed to write meta:', metaErr.message);
    }
    console.error(`[live] tick failed after ${durationMs}ms:`, err.message);
    return { ok: false, error: err.message, durationMs };
  } finally {
    try { await redis.del(CONFIG.keys.liveLock); } catch { /* ignore */ }
  }
}


// ===========================================================================
// MAIN LOOP
// ===========================================================================

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const intervalMs = args.interval ?? CONFIG.intervalMs;

  const redis = new Redis(CONFIG.redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  redis.on('error', (err) => {
    console.error('[live] redis error:', err.message);
  });
  redis.on('connect', () => {
    console.error(`[live] redis connected: ${CONFIG.redisUrl}`);
  });

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[live] received ${sig}, shutting down`);
    try { await redis.del(CONFIG.keys.liveLock); } catch { /* ignore */ }
    try { await redis.quit(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (args.once) {
    const result = await tick(redis, { route: args.route, headed: args.headed });
    await redis.quit();
    process.exit(result.ok ? 0 : 1);
  }

  console.error(
    `[live] starting — interval ${intervalMs}ms, ` +
    `live TTL ${CONFIG.liveTtlSec}s, lock TTL ${CONFIG.lockTtlSec}s, ` +
    `rotation window ${CONFIG.rotationWindowMs}ms, ` +
    `old TTL ${CONFIG.oldTtlSec}s`,
  );

  await tick(redis, { route: args.route, headed: args.headed });

  const handle = setInterval(() => {
    tick(redis, { route: args.route, headed: args.headed }).catch((err) => {
      console.error('[live] unhandled tick error:', err.message);
    });
  }, intervalMs);

  process.on('beforeExit', () => clearInterval(handle));
}


// ===========================================================================
// ENTRY
// ===========================================================================

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exitCode = 1;
  });
}

module.exports = {
  tick,
  extractLiveTier,
  extractRouteTier,
  routeIdentityHash,
  currentBucket,
  planRotation,
  isPublishableBus,
  CONFIG,
};