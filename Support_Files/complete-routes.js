#!/usr/bin/env node
/**
 * complete-routes.js
 *
 * Captures the STATIC route definition for every Rutgers TripShot route in
 * links.txt and writes routes.json:
 *
 *   - Route identity:  name, shortName, color, type, direction, regionId
 *   - Stops:           ordered, with locations, stable UUIDs, geofences
 *   - Streets:         derived street segments (merged consecutive steps),
 *                      each with entry/exit coords, duration, distance
 *   - Geometry:        per navigation variant — legs, steps, polylines,
 *                      street names, distances, durations
 *
 * The live / time-sensitive data (buses, ETAs, alerts, schedule, timetable)
 * lives in rutgers-server-full.js → rutgers-summary.json.
 *
 * This file also exports the shared Playwright capture toolkit
 * (captureAllRoutes, installRouteAborts, attachCapture, ...) so that
 * rutgers-server-full.js does not have to duplicate it. Requiring this
 * module does NOT run its CLI.
 *
 * Usage:
 *   node complete-routes.js                     # all routes → routes.json
 *   node complete-routes.js --route "A Route"   # single route
 *   node complete-routes.js --list              # list route names
 *   node complete-routes.js --save custom.json
 *   node complete-routes.js --concurrency 6
 *   node complete-routes.js --timeout 20000
 *   node complete-routes.js --no-block
 *   node complete-routes.js --headed
 *   node complete-routes.js --help
 *
 * Requires: playwright (npm i playwright)
 * Optional: @mapbox/polyline (npm i @mapbox/polyline) — used to decode
 *           step polylines into entry/exit coordinates for street
 *           segments. Without it, streets still get names and durations
 *           but entry/exit are null.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const {
  getAllRutgersTripShotUrls,
  getAllRutgersTripShotUrlList,
} = require('./configURL');

// Optional dependency for polyline decoding. Loaded lazily so the module
// still works (with reduced street output) if it's not installed.
let polylineDecoder = null;
try {
  polylineDecoder = require('@mapbox/polyline');
} catch {
  /* optional */
}


// ===========================================================================
// CONFIGURATION
// ===========================================================================

const CONFIG = {
  defaultSavePath: 'routes.json',

  // How long to wait for the route-details response (v3/p/shared/route/...).
  responseTimeoutMs: 20_000,

  // Short settle after the main response so any trailing JSON lands.
  settleMs: 800,

  // Cap simultaneous open route pages.
  concurrency: 4,
};


// ===========================================================================
// CLI
// ===========================================================================

function parseArgs(argv) {
  const out = {
    save: false,
    savePath: null,
    headed: false,
    help: false,
    list: false,
    route: null,
    concurrency: null,
    timeout: null,
    noBlock: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === '--save' || a === '-s') {
      out.save = true;
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) { out.savePath = next; i++; }
    } else if (a === '--route' || a === '-r') {
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) { out.route = next; i++; }
    } else if (a === '--concurrency') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) { out.concurrency = Math.floor(n); i++; }
    } else if (a === '--timeout') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) { out.timeout = Math.floor(n); i++; }
    } else if (a === '--no-block') {
      out.noBlock = true;
    } else if (a === '--list' || a === '-l') {
      out.list = true;
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
Complete Routes — static route definition capture

Usage:
  node complete-routes.js [options]

Route selection:
  -r, --route <name>      Capture ONLY one named route from links.txt.
  -l, --list              Print available route names and exit.
                          (Default: capture EVERY route in links.txt.)

Tuning:
      --concurrency <n>   Parallel route pages (default ${CONFIG.concurrency}).
      --timeout <ms>      Route-response wait timeout
                          (default ${CONFIG.responseTimeoutMs}).
      --no-block          Disable request blocking (Maps + heavy UI).

Options:
  -s, --save [file]       Write routes JSON to file
                          (default ${CONFIG.defaultSavePath})
      --headed            Run the browser with a visible UI
  -h, --help              Show this help text

Output: routes.json — static route definition for every captured route.
`);
}

// Case-insensitive route name lookup against the configURL map.
function resolveRouteName(allUrls, query) {
  if (!query) return null;
  if (Object.prototype.hasOwnProperty.call(allUrls, query)) return query;
  const lower = query.toLowerCase();
  for (const name of Object.keys(allUrls)) {
    if (name.toLowerCase() === lower) return name;
  }
  return null;
}


// ===========================================================================
// LOW-LEVEL UTILITIES (shared with rutgers-server-full.js)
// ===========================================================================

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function shorten(url, max = 100) {
  return url.length <= max ? url : url.slice(0, max - 1) + '…';
}

function findByUrl(captured, re) {
  return captured.find((c) => re.test(c.url)) || null;
}

function bodyOf(resp) {
  return resp ? resp.body : null;
}

function loc(l) {
  if (!l) return null;
  if (typeof l.lt === 'number' && typeof l.lg === 'number') {
    return { lat: l.lt, lng: l.lg };
  }
  return null;
}

function stateName(state) {
  if (!state || typeof state !== 'object') return null;
  const keys = Object.keys(state);
  return keys.length ? keys[0] : null;
}

function formatDay(d) {
  if (!d) return null;
  const mm = String(d.month).padStart(2, '0');
  const dd = String(d.day).padStart(2, '0');
  return `${d.year}-${mm}-${dd}`;
}

function extractStreet(html) {
  if (!html) return null;
  let m = html.match(/onto <b>(.*?)<\/b>/i);
  if (m) return m[1];
  m = html.match(/ on <b>(.*?)<\/b>/i);
  if (m) return m[1];
  return null;
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function next() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }

  const lanes = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    () => next(),
  );
  await Promise.all(lanes);
  return results;
}


// ===========================================================================
// PLAYWRIGHT CAPTURE (shared with rutgers-server-full.js)
// ===========================================================================

function isInterestingResponse(url, contentType) {
  const isJson = contentType.includes('json');
  const looksApi =
    url.includes('/api/') ||
    url.includes('tripshot.com/v1/') ||
    url.includes('tripshot.com/v2/') ||
    url.includes('tripshot.com/v3/') ||
    url.includes('tripshot.com/u/');
  return isJson || looksApi;
}

// The URL pattern that signals "the route JSON we analyze has landed."
const ROUTE_DETAILS_RE = /\/v3\/p\/shared\/route\//;

// Block Google Maps telemetry beacons, the internal viewport RPC, and
// heavy UI resources (images/fonts/media). Everything else — including the
// Maps bootstrap at /maps/api/js — passes through so the page's own JS
// doesn't throw on `google` being undefined.
async function installRouteAborts(page) {
  await page.route('**/*', (route) => {
    const req = route.request();
    const url = req.url();
    const type = req.resourceType();

    if (/maps\.googleapis\.com\/maps\/api\/mapsjs\//.test(url)) {
      return route.abort();
    }
    if (/\$rpc\/google\.internal\.maps/.test(url)) {
      return route.abort();
    }
    if (type === 'image' || type === 'font' || type === 'media') {
      return route.abort();
    }
    return route.continue();
  });
}

function attachCapture(page) {
  const captured = [];
  const pending = [];

  page.on('response', (res) => {
    const u = res.url();
    const ct = res.headers()['content-type'] || '';
    if (!isInterestingResponse(u, ct)) return;

    const task = (async () => {
      try {
        const body = await res.json();
        captured.push({ url: u, body });
        process.stderr.write(`CAPTURED: ${shorten(u)}\n`);
      } catch {
        /* not JSON, skip */
      }
    })();
    pending.push(task);
  });

  return {
    captured,
    async drain() {
      await Promise.allSettled(pending);
      return captured;
    },
  };
}

// One browser, one page per route, bounded concurrency.
// Waits for the /v3/p/shared/route/ response rather than a fixed sleep.
// On timeout, still drains whatever was captured and marks timedOut:true.
//
// Returns: { [routeName]: { captured: [...], timedOut, error } }
async function captureAllRoutes({
  routeList,
  headed = false,
  concurrency,
  timeoutMs,
  blockResources = true,
}) {
  const limit = concurrency || CONFIG.concurrency;
  const timeout = timeoutMs || CONFIG.responseTimeoutMs;
  const browser = await chromium.launch({ headless: !headed });

  const results = await runWithConcurrency(routeList, limit, async (item) => {
    process.stderr.write(`\n=== [${item.name}] Opening ${shorten(item.url)}\n`);
    const page = await browser.newPage();
    if (blockResources) await installRouteAborts(page);
    const cap = attachCapture(page);

    // --- Safe wait-for-response -------------------------------------------
    //
    // A bare `page.waitForResponse(...)` promise that is never awaited (for
    // example because `page.goto` threw and we bailed out of the try block)
    // will reject in the background and, on Node 20+, take the whole process
    // down as an unhandled rejection.
    //
    // Attaching `.catch()` immediately makes the promise resolve to a
    // sentinel instead. It can no longer orphan. The resolved value tells us
    // whether the route JSON ever arrived:
    //
    //   { ok: true }  → route response fired
    //   { ok: false } → timed out or was cancelled (message already logged)
    const routeRespPromise = page
      .waitForResponse(
        (r) => ROUTE_DETAILS_RE.test(r.url()) && r.status() === 200,
        { timeout },
      )
      .then(() => ({ ok: true, error: null }))
      .catch((err) => {
        const msg = /Timeout/i.test(err.message) ? 'TIMED OUT' : err.message;
        process.stderr.write(
          `=== [${item.name}] - REJECTION: ${msg}\n`,
        );
        return { ok: false, error: msg };
      });

    let gotoFailed = false;
    try {
      await page.goto(item.url, { waitUntil: 'domcontentloaded' });
    } catch (err) {
      gotoFailed = true;
      const msg = /Timeout/i.test(err.message) ? 'TIMED OUT' : err.message;
      process.stderr.write(
        `=== [${item.name}] - REJECTION: ${msg}\n`,
      );
    }

    // Always await the response promise, even on goto failure. It is
    // guaranteed not to reject, so this cannot crash the process. When the
    // route timed out, this call is what waits for the 20s timeout to burn
    // out — after which the tick moves on to the next route.
    const respResult = await routeRespPromise;

    try {
      await page.waitForTimeout(CONFIG.settleMs);
      const captured = await cap.drain();
      const timedOut = !respResult.ok || gotoFailed;

      process.stderr.write(
        `=== [${item.name}] Captured ${captured.length} JSON responses` +
        `${timedOut ? ' (no route response)' : ''}.\n`,
      );

      return {
        name: item.name,
        captured,
        timedOut,
        error: respResult.error ?? (gotoFailed ? 'goto failed' : null),
      };
    } catch (err) {
      const msg = /Timeout/i.test(err.message) ? 'TIMED OUT' : err.message;
      process.stderr.write(
        `=== [${item.name}] - REJECTION: ${msg}\n`,
      );
      return { name: item.name, captured: [], timedOut: false, error: msg };
    } finally {
      await page.close().catch(() => {});
    }
  });

  await browser.close();

  const perRoute = {};
  for (const r of results) {
    perRoute[r.name] = {
      captured: r.captured,
      timedOut: !!r.timedOut,
      error: r.error ?? null,
    };
  }
  return perRoute;
}


// ===========================================================================
// ROUTE DEFINITION BUILDERS
// ===========================================================================

function buildServiceDay(timeIntervals) {
  if (!timeIntervals.length) return null;
  const first = timeIntervals[0];
  return {
    day: formatDay(first.day),
    startTime: first.startTime ?? null,
    endTime: first.endTime ?? null,
  };
}

function buildRoute(details, inexactTimetable, firstLiveRide) {
  const route = details.route || {};
  const loopSec = firstLiveRide?.loopOptions?.roundTripTimeSec;
  return {
    name: route.name ?? null,
    shortName: route.shortName ?? null,
    color: route.color ?? null,
    type: route.routeType ?? null,
    loopMinutes: loopSec ? Math.round(loopSec / 60) : null,
    serviceDay: buildServiceDay(asArray(inexactTimetable.timeIntervals)),
    direction: inexactTimetable.direction ?? null,
    directionName: inexactTimetable.directionName ?? null,
    regionId: route.regionId ?? null,
    effectiveThrough: details.effectiveThrough ?? null,
    headwayRangeSec: inexactTimetable.headwayRangeSec ?? null,
  };
}

function buildStop(stop, index) {
  const out = {
    order: index + 1,
    name: stop.name ?? null,
    location: loc(stop.location),
    gtfsId: stop.gtfsId ?? null,
    sharedStopId: stop.sharedStopId ?? null,
    stopId: stop.stopId ?? null,
    geofence: stop.geofence ?? null,
  };
  if (stop.ttsStopName && stop.ttsStopName !== stop.name) {
    out.ttsStopName = stop.ttsStopName;
  }
  return out;
}

function buildStops(stops) {
  return asArray(stops).map(buildStop);
}

function buildGeometry(navigations) {
  const byId = {};
  for (const nav of asArray(navigations)) {
    if (!nav?.navigationId) continue;
    byId[nav.navigationId] = {
      navigationId: nav.navigationId,
      legs: asArray(nav.legs).map((leg) => ({
        startStopId: leg.startPoint?.NavViaStop?.stopId ?? null,
        endStopId: leg.endPoint?.NavViaStop?.stopId ?? null,
        transitNominalSec: leg.transitNominalSec ?? null,
        transitInTrafficSec: leg.transitInTrafficSec ?? null,
        steps: asArray(leg.steps).map((step) => ({
          stepStart: step.stepStart ?? null,
          stepEnd: step.stepEnd ?? null,
          polyline: step.polyline ?? null,
          durationSec: step.durationSec ?? null,
          distanceMeters: step.distanceMeters ?? null,
          roadProximity: step.roadProximity ?? null,
          street: extractStreet(step.instructionsHtml),
          instructionsHtml: step.instructionsHtml ?? '',
        })),
      })),
    };
  }
  return byId;
}

function pickDefaultNavigationId(nonliveRides, geometryById) {
  const counts = new Map();
  for (const r of asArray(nonliveRides)) {
    const id = r.effectiveNavigationId;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best = null;
  let bestN = -1;
  for (const [k, n] of counts) {
    if (n > bestN) { best = k; bestN = n; }
  }
  if (best) return best;
  const keys = Object.keys(geometryById);
  return keys.length ? keys[0] : null;
}

function pickCanonicalNavigationId(nonliveRides) {
  for (const r of asArray(nonliveRides)) {
    if (r.navigationId) return r.navigationId;
  }
  return null;
}


// ===========================================================================
// STREET SEGMENTS (derived from geometry)
// ===========================================================================

/**
 * Decode a step polyline into an array of { lat, lng }.
 *
 * Handles both formats:
 *   - Google-encoded string (what TripShot returns): "_zivF|kieMDS"
 *   - Array of { lat, lng } (already decoded)
 *
 * Returns [] if the input is null or the decoder is unavailable.
 */
function decodePolyline(p) {
  if (!p) return [];
  if (Array.isArray(p)) {
    return p.filter(
      (v) => v && typeof v.lat === 'number' && typeof v.lng === 'number',
    );
  }
  if (typeof p === 'string' && polylineDecoder) {
    try {
      return polylineDecoder.decode(p).map(([lat, lng]) => ({ lat, lng }));
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Walk the default navigation's legs → steps and merge consecutive steps
 * that share the same street name into a single segment. Sums duration
 * and distance; `entry` = first vertex of the first merged step's decoded
 * polyline, `exit` = last vertex of the last merged step's decoded
 * polyline.
 *
 * Steps whose street could not be parsed are kept as standalone segments
 * with `street: null` so the ordered geometry is preserved — they are
 * never merged into anything.
 *
 * The output is a compact, client-friendly layer: typically 15–40
 * segments per route, each ~100 bytes. The full per-step geometry stays
 * in `geometry` for clients that need it.
 *
 * @param {object} geometry  Output of buildGeometry() — needs
 *                           `defaultNavigationId` and `navigations`.
 * @returns {Array<{street, entry, exit, durationSec, distanceMeters}>}
 */
function buildStreetsFromNavigation(geometry) {
  const navId = geometry?.defaultNavigationId;
  const nav = navId ? geometry?.navigations?.[navId] : null;
  if (!nav) return [];

  const segments = [];
  let current = null;

  const firstVertex = (p) => {
    const d = decodePolyline(p);
    return d.length ? d[0] : null;
  };
  const lastVertex = (p) => {
    const d = decodePolyline(p);
    return d.length ? d[d.length - 1] : null;
  };

  const flush = () => {
    if (current) {
      segments.push(current);
      current = null;
    }
  };

  for (const leg of nav.legs ?? []) {
    for (const step of leg.steps ?? []) {
      const street = step.street ?? null;

      // Never merge null-street steps. Flush what we were accumulating
      // and emit this step as its own segment so the driving order is
      // preserved.
      if (!street) {
        flush();
        segments.push({
          street: null,
          entry: firstVertex(step.polyline),
          exit: lastVertex(step.polyline),
          durationSec: step.durationSec ?? 0,
          distanceMeters: step.distanceMeters ?? 0,
        });
        continue;
      }

      if (current && current.street === street) {
        // Same street as the previous step: extend the current segment.
        current.exit = lastVertex(step.polyline) ?? current.exit;
        current.durationSec += step.durationSec ?? 0;
        current.distanceMeters += step.distanceMeters ?? 0;
      } else {
        // Different street (or first segment): start a new one.
        flush();
        current = {
          street,
          entry: firstVertex(step.polyline),
          exit: lastVertex(step.polyline),
          durationSec: step.durationSec ?? 0,
          distanceMeters: step.distanceMeters ?? 0,
        };
      }
    }
  }

  flush();
  return segments;
}


// ===========================================================================
// CAPTURE → ROUTE DEFINITION
// ===========================================================================

function emptyRouteDefinition(error) {
  return {
    error: error ?? null,
    route: null,
    stops: [],
    streets: [],
    geometry: {
      canonicalNavigationId: null,
      defaultNavigationId: null,
      navigations: {},
    },
  };
}

function analyzeRouteCapture(captured, error) {
  const routeResp = findByUrl(captured, ROUTE_DETAILS_RE);

  const details = bodyOf(routeResp)?.InternalRouteDetails;
  if (!details) return emptyRouteDefinition(error);

  const inexactTimetable = asArray(details.inexactTimetables)[0] || {};
  const rawStops = asArray(inexactTimetable.stops);
  const liveRides = asArray(inexactTimetable.liveRides);
  const nonliveRides = asArray(inexactTimetable.nonliveRides);
  const navigations = asArray(inexactTimetable.navigations);

  const firstLiveRide = liveRides[0]?.ride || null;

  const geometryById = buildGeometry(navigations);
  const defaultNavigationId = pickDefaultNavigationId(nonliveRides, geometryById);
  const canonicalNavigationId = pickCanonicalNavigationId(nonliveRides);

  const route = buildRoute(details, inexactTimetable, firstLiveRide);
  const stops = buildStops(rawStops);

  const geometry = {
    canonicalNavigationId,
    defaultNavigationId,
    navigations: geometryById,
  };

  const streets = buildStreetsFromNavigation(geometry);

  return {
    error: error ?? null,
    route,
    stops,
    streets,
    geometry,
  };
}


// ===========================================================================
// AGGREGATE
// ===========================================================================

function buildRoutesFile(routesMap) {
  const routeNames = Object.keys(routesMap);

  const timedOutRoutes = routeNames.filter((n) => routesMap[n]?.timedOut);

  // Strip capture metadata (timedOut) into a top-level field; keep the
  // route definition object itself clean.
  const routes = {};
  for (const [name, r] of Object.entries(routesMap)) {
    const { timedOut, ...definition } = r;
    routes[name] = definition;
  }

  // Use the first non-null serviceDay as the file-level serviceDate.
  let serviceDate = null;
  for (const def of Object.values(routes)) {
    const d = def?.route?.serviceDay?.day;
    if (d) { serviceDate = d; break; }
  }

  return {
    asOf: new Date().toISOString(),
    capturedAt: new Date().toISOString(),
    serviceDate,
    routeCount: routeNames.length,
    timedOutRoutes,
    routes,
  };
}


// ===========================================================================
// OUTPUT
// ===========================================================================

function writeRoutesFile(obj, savePath) {
  const outPath = savePath
    ? path.resolve(savePath)
    : path.resolve(CONFIG.defaultSavePath);
  fs.writeFileSync(outPath, JSON.stringify(obj, null, 2));
  process.stderr.write(`Wrote routes → ${outPath}\n`);
  return outPath;
}


// ===========================================================================
// ENTRY POINT
// ===========================================================================

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const allUrls = getAllRutgersTripShotUrls();
  const allNames = Object.keys(allUrls);

  if (args.list) {
    process.stdout.write(allNames.join('\n') + '\n');
    return;
  }

  if (!allNames.length) {
    process.stderr.write(
      'No routes found. Check that links.txt sits next to configURL.js.\n',
    );
    process.exitCode = 1;
    return;
  }

  const blockResources = !args.noBlock;
  const timeoutMs = args.timeout || CONFIG.responseTimeoutMs;

  let routeList;
  if (args.route) {
    const resolved = resolveRouteName(allUrls, args.route);
    if (!resolved) {
      process.stderr.write(`Unknown route: "${args.route}"\n`);
      process.stderr.write(`Available: ${allNames.join(', ')}\n`);
      process.exitCode = 1;
      return;
    }
    routeList = [{ name: resolved, url: allUrls[resolved] }];
  } else {
    routeList = allNames.map((n) => ({ name: n, url: allUrls[n] }));
  }

  const rawPerRoute = await captureAllRoutes({
    routeList,
    headed: args.headed,
    concurrency: args.concurrency || CONFIG.concurrency,
    timeoutMs,
    blockResources,
  });

  // Attach capture metadata (timedOut) onto each route definition.
  const definitions = {};
  for (const [name, raw] of Object.entries(rawPerRoute)) {
    const def = analyzeRouteCapture(raw.captured, raw.error);
    def.timedOut = raw.timedOut;
    definitions[name] = def;
  }

  // Single-route mode: emit the flat route definition.
  if (args.route) {
    const { timedOut, ...single } = definitions[routeList[0].name];
    if (timedOut) single.captureTimedOut = true;
    writeRoutesFile(single, args.savePath);
    return;
  }

  const routesFile = buildRoutesFile(definitions);
  process.stderr.write(`\nCaptured ${routesFile.routeCount} routes.\n`);
  if (routesFile.timedOutRoutes.length) {
    process.stderr.write(
      `Routes with capture timeouts: ${routesFile.timedOutRoutes.join(', ')}\n`,
    );
  }

  writeRoutesFile(routesFile, args.savePath);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exitCode = 1;
  });
}


// ===========================================================================
// EXPORTS
// ===========================================================================

module.exports = {
  // Capture toolkit (used by rutgers-server-full.js)
  captureAllRoutes,
  attachCapture,
  installRouteAborts,
  isInterestingResponse,
  ROUTE_DETAILS_RE,

  // Utilities
  asArray,
  shorten,
  findByUrl,
  bodyOf,
  loc,
  stateName,
  formatDay,
  extractStreet,
  runWithConcurrency,
  resolveRouteName,

  // Route builders
  buildServiceDay,
  buildRoute,
  buildStop,
  buildStops,
  buildGeometry,
  buildStreetsFromNavigation,
  decodePolyline,
  pickDefaultNavigationId,
  pickCanonicalNavigationId,

  // Route analysis
  analyzeRouteCapture,
  buildRoutesFile,

  // Output
  writeRoutesFile,

  // Config
  CONFIG,
};