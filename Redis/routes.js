#!/usr/bin/env node
/**
 * routes.js
 *
 * Long-running producer for the STATIC route-definition tier.
 *
 * Every tick:
 *
 *   1. Acquires a Redis single-flight lock.
 *   2. Runs the full capture pipeline from complete-routes.js:
 *        captureAllRoutes() → analyzeRouteCapture() per route.
 *        Each definition carries: route, stops, streets, geometry,
 *        plus freshness stamps (lastGoodAt / staleSince / lastError).
 *   3. Merges the new definitions with the previous tier so a single
 *      timed-out or errored route does not wipe out a good definition.
 *   4. Validates each definition's shape; logs per-route warnings.
 *   5. Derives reverse indexes (stop → routes, street → routes).
 *   6. Rotates the "old" pointer on a fixed wall-clock window
 *      (ROUTES_ROTATION_MS, default 10 min):
 *        bus:static:old     ← bus:static:current
 *        bus:static:current ← new hash (only when content changed)
 *      Clients read `bus:static:old` → hash → `bus:static:<hash>`.
 *   7. Hashes the merged route map. Writes a new immutable routes blob
 *      AND its derived index blob, only when the hash changes.
 *   8. Expires the previous blob (routes + index) after a grace period.
 *   9. Writes a meta record, preserving prior fields on both success
 *      and failure so monitoring never loses the current hash.
 *  10. Releases the lock.
 *
 * On failure the previous static blob is left untouched. Clients keep
 * serving the last good version until a new one lands.
 *
 * Usage:
 *   node routes.js                        # 30 min cadence, defaults
 *   node routes.js --interval 600000      # 10 min cadence
 *   node routes.js --once                 # one tick, then exit
 *   node routes.js --route "LX Route"     # one route only (debug)
 *   node routes.js --headed               # visible browser (debug)
 *   node routes.js --help
 *
 * Env:
 *   REDIS_URL              default redis://127.0.0.1:6379
 *   ROUTES_INTERVAL_MS     default 1800000 (30 min)
 *   ROUTES_ROTATION_MS     default 600000  (10 min)
 *   ROUTES_BLOB_TTL_SEC    default 604800  (7 days)
 *
 * Requires: ioredis, playwright, complete-routes.js alongside.
 */

'use strict';

const crypto = require('crypto');
const Redis = require('ioredis');

const {
  captureAllRoutes,
  analyzeRouteCapture,
  resolveRouteName,
  CONFIG: ROUTES_CONFIG,
} = require('../Support_Files/complete-routes');

const { getAllRutgersTripShotUrls } = require('../bus_support/configURL');


// ===========================================================================
// CONFIGURATION
// ===========================================================================


const CONFIG = {
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',

  // Routes change rarely. 30 min is a defensive ceiling — the hash gate
  // means most ticks are no-ops even at this cadence.
  intervalMs: Number(process.env.ROUTES_INTERVAL_MS) || 30 * 60 * 1000,

  // Lock TTL must exceed the longest expected tick. Capturing every route
  // at concurrency 4 can take a couple of minutes on a cold machine.
  lockTtlSec: 300,

  // Rotation window for the "old" pointer. Every time the wall-clock
  // crosses a multiple of this value, bus:static:old is set to the
  // current hash before the new hash is written.
  //
  // Note: the actual rotation happens only on ticks. If your tick
  // interval is longer than this window (e.g. default 30 min vs 10 min
  // window), rotation will happen on every tick — not literally every
  // 10 minutes. Set --interval to something <= window for finer-grained
  // rotation.
  rotationWindowMs: Number(process.env.ROUTES_ROTATION_MS) || 10 * 60 * 1000,

  // Option A: previous immutable blobs (routes AND indexes) are expired
  // this long after a new version lands.
  previousBlobTtlSec:
    Number(process.env.ROUTES_BLOB_TTL_SEC) || 7 * 24 * 60 * 60, // 7 days

  keys: {
    current: 'bus:static:current',      // pointer to current routes hash
    old: 'bus:static:old',              // pointer to previous window's hash
    lastBucket: 'bus:static:rotation:lastBucket',
    prefix: 'bus:static:',              // routes blob namespace
    indexPrefix: 'bus:index:',          // derived reverse-index blob namespace
    meta: 'bus:static:meta',            // freshness / error state
    lock: 'bus:static:lock',            // single-flight lock
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
    concurrency: null,
    timeout: null,
    noBlock: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];

    if (a === '--interval' || a === '-i') {
      const n = Number(next);
      if (Number.isFinite(n) && n >= 60_000) { out.interval = Math.floor(n); i++; }
    } else if (a === '--once') {
      out.once = true;
    } else if (a === '--route' || a === '-r') {
      if (next && !next.startsWith('-')) { out.route = next; i++; }
    } else if (a === '--concurrency') {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) { out.concurrency = Math.floor(n); i++; }
    } else if (a === '--timeout') {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) { out.timeout = Math.floor(n); i++; }
    } else if (a === '--no-block') {
      out.noBlock = true;
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
routes.js — Rutgers static route-definition producer → Redis

Usage:
  node routes.js [options]

Options:
  -i, --interval <ms>   Tick interval (default ${CONFIG.intervalMs}, min 60000)
      --once            Run exactly one tick and exit
  -r, --route <name>    Capture one route only (default: all)
      --concurrency <n> Parallel route pages (default ${ROUTES_CONFIG.concurrency})
      --timeout <ms>    Per-route response wait (default ${ROUTES_CONFIG.responseTimeoutMs})
      --no-block        Disable request blocking (Maps + heavy UI)
      --headed          Visible browser (debug only, slow)
  -h, --help            Show this help

Environment:
  REDIS_URL              default ${CONFIG.redisUrl}
  ROUTES_INTERVAL_MS     default ${CONFIG.intervalMs}
  ROUTES_ROTATION_MS     default ${CONFIG.rotationWindowMs} (10 min)
  ROUTES_BLOB_TTL_SEC    default ${CONFIG.previousBlobTtlSec} (7 days)

Redis keys written:
  ${CONFIG.keys.current}               pointer to current routes hash
  ${CONFIG.keys.old}                   pointer to previous window's hash
  ${CONFIG.keys.lastBucket}            rotation bookkeeping (bucket number)
  ${CONFIG.keys.prefix}<hash>          immutable routes blob
                                       { capturedAt, routeCount, routes }
  ${CONFIG.keys.indexPrefix}<hash>     immutable derived index blob
                                       { stopsByName, stopsById,
                                         stopsByGtfsId, streetsByName }
  ${CONFIG.keys.meta}                  freshness / error state
`);
}


// ===========================================================================
// CAPTURE PIPELINE
// ===========================================================================

async function captureAndAnalyze(options = {}) {
  const allUrls = getAllRutgersTripShotUrls();
  const allNames = Object.keys(allUrls);

  if (!allNames.length) {
    throw new Error(
      'No routes found. Check that links.txt sits next to configURL.js.',
    );
  }

  let routeList;
  if (options.route) {
    const resolved = resolveRouteName(allUrls, options.route);
    if (!resolved) {
      throw new Error(
        `Unknown route: "${options.route}". Available: ${allNames.join(', ')}`,
      );
    }
    routeList = [{ name: resolved, url: allUrls[resolved] }];
  } else {
    routeList = allNames.map((n) => ({ name: n, url: allUrls[n] }));
  }

  const rawPerRoute = await captureAllRoutes({
    routeList,
    headed: options.headed ?? false,
    concurrency: options.concurrency ?? ROUTES_CONFIG.concurrency,
    timeoutMs: options.timeoutMs ?? ROUTES_CONFIG.responseTimeoutMs,
    blockResources: options.blockResources !== false,
  });

  const definitions = {};
  for (const [name, raw] of Object.entries(rawPerRoute)) {
    const def = analyzeRouteCapture(raw.captured, raw.error);
    def.timedOut = raw.timedOut;
    definitions[name] = def;
  }

  return { definitions, routeList };
}


// ===========================================================================
// MERGE + HASH
// ===========================================================================

function mergeWithPrevious(newDefs, previousRoutes) {
  const merged = {};
  const now = new Date().toISOString();

  const FRESHNESS = ['lastGoodAt', 'staleSince', 'lastError'];

  const stripFreshness = (d) => {
    if (!d) return d;
    const out = { ...d };
    for (const k of FRESHNESS) delete out[k];
    return out;
  };

  const sameContent = (a, b) =>
    !!a &&
    !!b &&
    JSON.stringify(stripFreshness(a)) === JSON.stringify(stripFreshness(b));

  for (const [name, def] of Object.entries(newDefs)) {
    const failed = !!def.error || !!def.timedOut;
    const prev = previousRoutes?.[name];

    if (failed) {
      if (prev) {
        merged[name] = {
          ...prev,
          staleSince: prev.staleSince ?? now,
          lastError: def.error ?? 'timeout',
        };
      } else {
        const { timedOut, ...clean } = def;
        merged[name] = {
          ...clean,
          lastGoodAt: null,
          staleSince: now,
          lastError: clean.error ?? 'timeout',
        };
      }
      continue;
    }

    const { timedOut, error, ...clean } = def;

    if (prev && !prev.staleSince && sameContent(clean, prev)) {
      merged[name] = {
        ...clean,
        lastGoodAt: prev.lastGoodAt ?? now,
        staleSince: null,
        lastError: null,
      };
    } else {
      merged[name] = {
        ...clean,
        lastGoodAt: now,
        staleSince: null,
        lastError: null,
      };
    }
  }

  return merged;
}

function validateDefinition(name, def) {
  const warnings = [];
  if (!def || typeof def !== 'object') {
    return [`${name}: definition is not an object`];
  }
  if (!def.route || typeof def.route !== 'object') {
    warnings.push(`${name}: missing route metadata`);
  } else if (!def.route.name) {
    warnings.push(`${name}: route.name is empty`);
  }
  if (!Array.isArray(def.stops)) {
    warnings.push(`${name}: stops is not an array`);
  }
  if (!Array.isArray(def.streets)) {
    warnings.push(`${name}: streets is not an array (did complete-routes.js pick up the change?)`);
  }
  if (!def.geometry || typeof def.geometry !== 'object') {
    warnings.push(`${name}: missing geometry`);
  } else if (
    !def.geometry.navigations ||
    typeof def.geometry.navigations !== 'object'
  ) {
    warnings.push(`${name}: geometry.navigations missing`);
  }
  return warnings;
}

function staticHash(routeMap) {
  const names = Object.keys(routeMap).sort();
  const canonical = {};
  for (const n of names) canonical[n] = routeMap[n];
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .slice(0, 12);
}


// ===========================================================================
// INDEX DERIVATION
// ===========================================================================

function deriveIndexes(routeMap) {
  const stopsByName = {};
  const stopsById = {};
  const stopsByGtfsId = {};
  const streetsByName = {};

  const push = (map, key, routeName) => {
    if (!key) return;
    if (!map[key]) map[key] = [];
    if (!map[key].includes(routeName)) map[key].push(routeName);
  };

  for (const [routeName, def] of Object.entries(routeMap)) {
    for (const stop of def.stops ?? []) {
      push(stopsByName, stop.name, routeName);
      push(stopsById, stop.stopId, routeName);
      push(stopsByGtfsId, stop.gtfsId, routeName);
    }
    for (const seg of def.streets ?? []) {
      push(streetsByName, seg.street, routeName);
    }
  }

  for (const m of [stopsByName, stopsById, stopsByGtfsId, streetsByName]) {
    for (const k of Object.keys(m)) m[k].sort();
  }

  return { stopsByName, stopsById, stopsByGtfsId, streetsByName };
}


// ===========================================================================
// ROTATION
// ===========================================================================

function currentBucket(now = Date.now()) {
  return Math.floor(now / CONFIG.rotationWindowMs);
}

/**
 * Plan the "old pointer" rotation for this tick. Does NOT mutate Redis.
 *
 *   rotate === true   → this tick crosses a window boundary; the
 *                       caller should snapshot current → old.
 *   isFirstEver       → no window has ever been recorded; initialise
 *                       the bucket without snapshotting.
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

/**
 * Apply the rotation: bus:static:old ← bus:static:current.
 * Called BEFORE writing the new current hash so `old` captures the
 * pre-write state. Uses a MULTI so the two writes are atomic.
 */
async function applyRotation(redis, rotation) {
  if (!rotation.rotate && !rotation.isFirstEver) return;

  const tx = redis.multi();

  if (rotation.rotate) {
    const prevCurrent = await redis.get(CONFIG.keys.current);
    if (prevCurrent) {
      tx.set(CONFIG.keys.old, prevCurrent);
    } else {
      tx.del(CONFIG.keys.old);
    }
  }

  tx.set(CONFIG.keys.lastBucket, String(rotation.bucket));

  await tx.exec();
}


// ===========================================================================
// REDIS WRITERS
// ===========================================================================

async function readPreviousStatic(redis) {
  const hash = await redis.get(CONFIG.keys.current);
  if (!hash) return { hash: null, routeMap: null };

  const raw = await redis.get(`${CONFIG.keys.prefix}${hash}`);
  if (!raw) return { hash, routeMap: null };

  try {
    const blob = JSON.parse(raw);
    return { hash, routeMap: blob.routes || null };
  } catch {
    return { hash, routeMap: null };
  }
}

async function writeStaticTier(redis, routeMap, indexes, hash, previousHash) {
  const routesBlob = {
    capturedAt: new Date().toISOString(),
    routeCount: Object.keys(routeMap).length,
    routes: routeMap,
  };

  const indexBlob = {
    derivedAt: routesBlob.capturedAt,
    fromStaticHash: hash,
    ...indexes,
  };

  await redis.set(`${CONFIG.keys.prefix}${hash}`, JSON.stringify(routesBlob));
  await redis.set(`${CONFIG.keys.indexPrefix}${hash}`, JSON.stringify(indexBlob));
  await redis.set(CONFIG.keys.current, hash);

  if (previousHash && previousHash !== hash) {
    try {
      await redis.expire(
        `${CONFIG.keys.prefix}${previousHash}`,
        CONFIG.previousBlobTtlSec,
      );
      await redis.expire(
        `${CONFIG.keys.indexPrefix}${previousHash}`,
        CONFIG.previousBlobTtlSec,
      );
    } catch (err) {
      console.error(
        `[routes] failed to expire previous blobs ${previousHash}:`,
        err.message,
      );
    }
  }

  await redis.set(
    CONFIG.keys.meta,
    JSON.stringify({
      hash,
      previousHash: previousHash ?? null,
      updatedAt: new Date().toISOString(),
      routeCount: routesBlob.routeCount,
      stopCount: Object.keys(indexes.stopsByName).length,
      streetCount: Object.keys(indexes.streetsByName).length,
    }),
  );
}

async function writeMeta(redis, meta) {
  await redis.set(CONFIG.keys.meta, JSON.stringify(meta));
}


// ===========================================================================
// ONE TICK
// ===========================================================================

async function tick(redis, options = {}) {
  const startedAt = Date.now();

  const locked = await redis.set(
    CONFIG.keys.lock,
    String(process.pid),
    'NX',
    'EX',
    CONFIG.lockTtlSec,
  );
  if (!locked) {
    console.error('[routes] previous tick still running, skipping');
    return { skipped: true };
  }

  try {
    // 1. Plan + apply rotation BEFORE any writes so `old` captures the
    //    pre-tick current pointer.
    const rotation = await planRotation(redis);

    // 2. Capture.
    const { definitions } = await captureAndAnalyze({
      route: options.route,
      headed: options.headed ?? false,
      concurrency: options.concurrency,
      timeoutMs: options.timeoutMs,
      blockResources: options.blockResources,
    });

    // 3. Validate shape.
    const validationWarnings = [];
    for (const [name, def] of Object.entries(definitions)) {
      if (def.timedOut || def.error) continue;
      validationWarnings.push(...validateDefinition(name, def));
    }

    // 4. Read previous so we can merge and detect changes.
    const { hash: previousHash, routeMap: previousRoutes } =
      await readPreviousStatic(redis);

    // 5. Merge (stamps freshness per route).
    const routeMap = mergeWithPrevious(definitions, previousRoutes);
    const hash = staticHash(routeMap);
    const changed = hash !== previousHash;

    const failedRoutes = Object.entries(definitions)
      .filter(([, d]) => d.timedOut || d.error)
      .map(([name]) => name);

    const staleRoutes = Object.entries(routeMap)
      .filter(([, d]) => d.staleSince)
      .map(([name]) => name);

    // 6. Derive indexes.
    const indexes = deriveIndexes(routeMap);

    // 7. Apply rotation (moves current → old if we crossed a window).
    //    Do this BEFORE writeStaticTier so `old` sees the pre-write hash.
    await applyRotation(redis, rotation);

    // 8. Write new content only when the hash changed.
    if (changed) {
      await writeStaticTier(redis, routeMap, indexes, hash, previousHash);
      console.error(
        `[routes] static tier updated: ${previousHash ?? '(none)'} -> ${hash}`,
      );
    } else {
      const existingMeta = await redis.get(CONFIG.keys.meta);
      const parsed = existingMeta ? safeParse(existingMeta) : {};
      await writeMeta(redis, {
        ...parsed,
        hash,
        checkedAt: new Date().toISOString(),
        rotationBucket: rotation.bucket,
      });
    }

    if (rotation.rotate) {
      console.error(
        `[routes] rotated static window: bucket ${rotation.lastBucket} -> ${rotation.bucket}`,
      );
    } else if (rotation.isFirstEver) {
      console.error(`[routes] initialised static window: bucket ${rotation.bucket}`);
    }

    const durationMs = Date.now() - startedAt;
    console.error(
      `[routes] ok — ${Object.keys(routeMap).length} routes, ` +
      `${Object.keys(indexes.stopsByName).length} unique stops, ` +
      `${Object.keys(indexes.streetsByName).length} unique streets, ` +
      `${durationMs}ms` +
      (changed ? ' (new version)' : ' (unchanged)') +
      (rotation.rotate ? ' (rotated)' : '') +
      (failedRoutes.length
        ? `, ${failedRoutes.length} failed this tick: ${failedRoutes.join(', ')}`
        : ''),
    );

    if (staleRoutes.length) {
      console.error(
        `[routes] WARNING: ${staleRoutes.length} stale route(s): ` +
        `${staleRoutes.join(', ')}`,
      );
    }
    if (validationWarnings.length) {
      console.error(
        `[routes] WARNING: ${validationWarnings.length} validation issue(s):`,
      );
      for (const w of validationWarnings) console.error(`  - ${w}`);
    }

    return {
      ok: true,
      durationMs,
      routeCount: Object.keys(routeMap).length,
      stopCount: Object.keys(indexes.stopsByName).length,
      streetCount: Object.keys(indexes.streetsByName).length,
      changed,
      rotated: rotation.rotate,
      hash,
      failedRoutes,
      staleRoutes,
      validationWarnings,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    try {
      const existingMeta = await redis.get(CONFIG.keys.meta);
      const parsed = existingMeta ? safeParse(existingMeta) : {};
      await writeMeta(redis, {
        ...parsed,
        checkedAt: new Date().toISOString(),
        stale: true,
        lastError: err.message,
        durationMs,
      });
    } catch (metaErr) {
      console.error('[routes] failed to write meta:', metaErr.message);
    }
    console.error(`[routes] tick failed after ${durationMs}ms:`, err.message);
    return { ok: false, error: err.message, durationMs };
  } finally {
    try { await redis.del(CONFIG.keys.lock); } catch { /* ignore */ }
  }
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
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
    console.error('[routes] redis error:', err.message);
  });
  redis.on('connect', () => {
    console.error(`[routes] redis connected: ${CONFIG.redisUrl}`);
  });

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[routes] received ${sig}, shutting down`);
    try { await redis.del(CONFIG.keys.lock); } catch { /* ignore */ }
    try { await redis.quit(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (args.once) {
    const result = await tick(redis, {
      route: args.route,
      headed: args.headed,
      concurrency: args.concurrency,
      timeoutMs: args.timeout,
      blockResources: !args.noBlock,
    });
    await redis.quit();
    process.exit(result.ok ? 0 : 1);
  }

  console.error(
    `[routes] starting — interval ${intervalMs}ms, ` +
    `lock TTL ${CONFIG.lockTtlSec}s, ` +
    `blob TTL ${CONFIG.previousBlobTtlSec}s, ` +
    `rotation window ${CONFIG.rotationWindowMs}ms`,
  );

  await tick(redis, {
    route: args.route,
    headed: args.headed,
    concurrency: args.concurrency,
    timeoutMs: args.timeout,
    blockResources: !args.noBlock,
  });

  const handle = setInterval(() => {
    tick(redis, {
      route: args.route,
      headed: args.headed,
      concurrency: args.concurrency,
      timeoutMs: args.timeout,
      blockResources: !args.noBlock,
    }).catch((err) => {
      console.error('[routes] unhandled tick error:', err.message);
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
  captureAndAnalyze,
  mergeWithPrevious,
  validateDefinition,
  deriveIndexes,
  staticHash,
  currentBucket,
  planRotation,
  applyRotation,
  CONFIG,
};