#!/usr/bin/env node
/**
 * rutgers-lx-full.js
 *
 * Captures Rutgers TripShot JSON traffic with Playwright across ALL route
 * URLs provided by configURL.js (which builds them for the *current* day
 * from links.txt), and prints a single aggregated, rider-facing summary.
 *
 * Default behavior: capture every route in links.txt and emit one object
 * that contains every bus on every route, plus the per-route summaries.
 *
 * Output shape (default / --all):
 *   {
 *     asOf, capturedAt, routeCount, busCount,
 *     routes: { "<Route Name>": <per-route summary>, ... },
 *     buses:  [ { route, routeShortName, ...bus }, ... ],
 *     alerts: [ ...deduped rider alerts... ],
 *     schedule: { activeRoutes: [...], nextScheduledStart, perRoute: {...} }
 *   }
 *
 * With --route <name> the output is the original flat per-route summary.
 *
 * Speed improvements (v2):
 *   - Wait for the actual route-details response instead of sleeping 12s.
 *   - Abort Google Maps telemetry / viewport RPCs and heavy UI resources
 *     (images, fonts, media). The Maps bootstrap script is left alone so
 *     the TripShot app does not throw on `google` being undefined.
 *   - The route geometry (polylines, legs, steps) comes from TripShot's
 *     own /v3/p/shared/route/... JSON — not from Google — so blocking
 *     Maps traffic does not affect it.
 *
 * Per-route summary content (unchanged from before):
 *   - When the route runs
 *   - Where the stops are
 *   - Where each bus is and when it reaches its next stop
 *   - Per-bus ETA to every stop on the loop
 *   - How full each bus is
 *   - Any active rider alerts
 *   - Route geometry per navigation variant        (Tier 1)
 *   - Full timetable with stop-level schedule      (Tier 1)
 *   - Stable stop UUIDs                            (Tier 2)
 *   - Per-bus and per-ride navigation IDs          (Tier 2)
 *   - Route direction / directionName              (Tier 2)
 *   - Stop geofences                               (Tier 3)
 *
 * Usage:
 *   node rutgers-lx-full.js                       # ALL routes (default)
 *   node rutgers-lx-full.js --route "A Route"     # one route by name
 *   node rutgers-lx-full.js --list                # list route names
 *   node rutgers-lx-full.js --concurrency 6       # parallel page limit
 *   node rutgers-lx-full.js --timeout 20000       # route-response wait (ms)
 *   node rutgers-lx-full.js --no-block            # disable resource blocking
 *   node rutgers-lx-full.js --save                # write JSON
 *   node rutgers-lx-full.js --save foo.json       # custom path
 *   node rutgers-lx-full.js --compress            # also write Brotli .bin
 *   node rutgers-lx-full.js --headed              # visible browser
 *   node rutgers-lx-full.js --help
 *
 * Requires: playwright (npm i playwright)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const { buildStopIndex, enrichBusWithEtas } = require('./bus-etas');
const { compress: compressSummary, decompress: decompressSummary } = require('./bus-compress');
const {
  getRutgersTripShotUrl,
  getAllRutgersTripShotUrls,
  getAllRutgersTripShotUrlList,
} = require('./configURL');


const CONFIG = {
  defaultSavePath: 'rutgers-summary.json',
  defaultCompressPath: 'bus-compressed.bin',

  // How long to wait for the route-details response (v3/p/shared/route/...)
  responseTimeoutMs: 20_000,
  settleMs: 800,

  // Concurrency cap. WARNING: CAN OVERLOAD IF SET TOO HIGH --> Upper-Bound: 9
  concurrency: 4,

  dataQualityNote:
    'Rider counts may reflect APC-derived rolling totals rather than current onboard passengers.',
};


function parseArgs(argv) {
  const out = {
    save: false,
    savePath: null,
    compress: false,
    compressPath: null,
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
      if (next && !next.startsWith('-')) {
        out.savePath = next;
        i++;
      }
    } else if (a === '--compress' || a === '-c') {
      out.compress = true;
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        out.compressPath = next;
        i++;
      }
    } else if (a === '--route' || a === '-r') {
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        out.route = next;
        i++;
      }
    } else if (a === '--concurrency') {
      const next = argv[i + 1];
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) {
        out.concurrency = Math.floor(n);
        i++;
      }
    } else if (a === '--timeout') {
      const next = argv[i + 1];
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) {
        out.timeout = Math.floor(n);
        i++;
      }
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
Rutgers TripShot — all-routes capture + aggregated rider summary

Usage:
  node rutgers-lx-full.js [options]

Route selection:
  -r, --route <name>      Capture ONLY one named route from links.txt
                          (e.g. "A Route", "LX Route", "Campus Connect").
                          Output is the flat per-route summary.
  -l, --list              Print available route names and exit.
                          (Default: capture EVERY route in links.txt.)

Tuning:
      --concurrency <n>   Parallel route pages (default ${CONFIG.concurrency}).
      --timeout <ms>      Route-response wait timeout
                          (default ${CONFIG.responseTimeoutMs}).
      --no-block          Disable request blocking (Maps + heavy UI).
                          Useful for A/B testing whether blocking ever
                          affects a route.

Options:
  -s, --save [file]       Write the summary JSON to file
                          (default: ${CONFIG.defaultSavePath})
  -c, --compress [file]   Also write a Brotli-compressed binary
                          (default: ${CONFIG.defaultCompressPath})
      --headed            Run the browser with a visible UI
  -h, --help              Show this help text
`);
}

function resolveRouteName(allUrls, query) {
  if (!query) return null;
  if (Object.prototype.hasOwnProperty.call(allUrls, query)) return query;
  const lower = query.toLowerCase();
  for (const name of Object.keys(allUrls)) {
    if (name.toLowerCase() === lower) return name;
  }
  return null;
}



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

const ROUTE_DETAILS_RE = /\/v3\/p\/shared\/route\//;


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

    // Ignore Image, font, and Media data
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


async function captureResponses({ url, headed = false, timeoutMs, blockResources = true } = {}) {
  const targetUrl = url || getRutgersTripShotUrl();
  const timeout = timeoutMs || CONFIG.responseTimeoutMs;

  const browser = await chromium.launch({ headless: !headed });
  const page = await browser.newPage();
  if (blockResources) await installRouteAborts(page);
  const cap = attachCapture(page);

  process.stderr.write(`Opening ${shorten(targetUrl)}\n`);

  const routeRespPromise = page.waitForResponse(
    (r) => ROUTE_DETAILS_RE.test(r.url()) && r.status() === 200,
    { timeout },
  );

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

  try {
    await routeRespPromise;
  } catch {
    process.stderr.write(`Route response timed out after ${timeout}ms\n`);
  }

  // Let trailing JSON (riderNotices, live updates) land.
  await page.waitForTimeout(CONFIG.settleMs);

  const captured = await cap.drain();
  await browser.close();

  process.stderr.write(`Captured ${captured.length} JSON responses.\n`);
  return captured;
}


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

    try {

      const routeRespPromise = page.waitForResponse(
        (r) => ROUTE_DETAILS_RE.test(r.url()) && r.status() === 200,
        { timeout },
      );

      await page.goto(item.url, { waitUntil: 'domcontentloaded' });

      let timedOut = false;
      try {
        await routeRespPromise;
      } catch {
        timedOut = true;
        process.stderr.write(
          `=== [${item.name}] Route response timed out after ${timeout}ms\n`,
        );
      }

      await page.waitForTimeout(CONFIG.settleMs);

      const captured = await cap.drain();
      process.stderr.write(
        `=== [${item.name}] Captured ${captured.length} JSON responses${timedOut ? ' (timed out)' : ''}.\n`,
      );
      return { name: item.name, captured, timedOut };
    } catch (err) {
      process.stderr.write(`=== [${item.name}] FAILED: ${err.message}\n`);
      return { name: item.name, captured: [], error: err.message };
    } finally {
      await page.close().catch(() => {});
    }
  });

  await browser.close();

  const perRoute = {};
  for (const r of results) {
    const summary = analyzeCapture(r.captured, r.error);
    if (r.timedOut) summary.captureTimedOut = true;
    perRoute[r.name] = summary;
  }
  return perRoute;
}


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
    //Tier System
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

function buildStopNameIndex(rawStops) {
  const map = new Map();
  for (const s of asArray(rawStops)) {
    if (s.stopId) map.set(s.stopId, s.name ?? null);
    if (s.sharedStopId) map.set(s.sharedStopId, s.name ?? null);
  }
  return map;
}


function computeNextStop(ride, stopNameById) {
  for (const entry of asArray(ride?.stopStatus)) {
    const key = stateName(entry);
    if (key !== 'Awaiting' && key !== 'Present') continue;

    const visit = entry[key] || {};
    return {
      name: stopNameById.get(visit.stopId) ?? null,
      etaISO: visit.expectedArrivalTime ?? visit.arrivalTime ?? null,
      state: key,
    };
  }
  return null;
}

function pickRiderCount(ride) {
  if (typeof ride?.apcRiderCount === 'number') return ride.apcRiderCount;
  if (typeof ride?.userRiderCount === 'number') return ride.userRiderCount;
  return 0;
}

function buildBus(entry, route, stopNameById, defaultNavigationId) {
  const { vehicle, vehicleStatus, ride } = entry;
  const capacity = vehicle?.capacity ?? null;
  const estimated = pickRiderCount(ride);
  const percentFull =
    capacity && capacity > 0
      ? Math.min(100, Math.round((estimated / capacity) * 100))
      : null;

  const navId =
    ride?.effectiveNavigationId ??
    ride?.navigationId ??
    ride?.userNavigationId ??
    null;

  return {
    name: vehicle?.name ?? null,
    color: route?.color ?? null,
    location: loc(vehicleStatus?.location),
    speed: vehicleStatus?.speed ?? null,
    bearing: vehicleStatus?.bearing ?? null,
    updatedAt: vehicleStatus?.when ?? null,
    nextStop: computeNextStop(ride, stopNameById),
    riders: {
      estimated,
      capacity,
      percentFull,
    },
    bikes: ride?.bikeCount ?? 0,
    wheelchairCapacity: vehicle?.wheelchairCapacity ?? null,
    navigationId: navId,
    detourSuspected:
      navId != null &&
      defaultNavigationId != null &&
      navId !== defaultNavigationId,
  };
}

function buildBuses(
  liveRides,
  route,
  stopNameById,
  rawStops,
  stopIndex,
  defaultNavigationId,
) {
  return asArray(liveRides).map((entry) => {
    const bus = buildBus(entry, route, stopNameById, defaultNavigationId);
    bus.etas = enrichBusWithEtas(entry, rawStops, stopIndex);
    return bus;
  });
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
    if (n > bestN) {
      best = k;
      bestN = n;
    }
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



function normalizeStopStatus(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const [state, body] = Object.entries(entry)[0] || [];
  if (!state || !body) return null;
  return {
    state,
    stopId: body.stopId ?? null,
    viaIdx: body.viaIdx ?? null,
    scheduledAt: body.scheduledAt ?? null,
    scheduledDepartureTime: body.scheduledDepartureTime ?? null,
    arrivalTime: body.arrivalTime ?? null,
    departureTime: body.departureTime ?? null,
    expectedArrivalTime: body.expectedArrivalTime ?? null,
    timepoint: body.timepoint ?? false,
    visitType: body.visitType ?? null,
    byRequest: body.byRequest ?? null,
  };
}

function buildTimetable(inexactTimetable) {
  const t = inexactTimetable || {};
  return {
    direction: t.direction ?? null,
    directionName: t.directionName ?? null,
    headwayRangeSec: t.headwayRangeSec ?? null,
    timeIntervals: asArray(t.timeIntervals).map((ti) => ({
      day: ti.day,
      startTime: ti.startTime,
      endTime: ti.endTime,
    })),
    rides: asArray(t.nonliveRides).map((r) => ({
      rideId: r.rideId ?? null,
      routeServiceId: r.routeServiceId ?? null,
      vehicleId: r.vehicleId ?? null,
      vehicleName: r.vehicleName ?? null,
      direction: r.direction ?? null,
      navigationId: r.navigationId ?? null,
      userNavigationId: r.userNavigationId ?? null,
      effectiveNavigationId: r.effectiveNavigationId ?? null,
      scheduledStart: r.scheduledStart ?? null,
      scheduledEnd: r.scheduledEnd ?? null,
      loopOptions: r.loopOptions
        ? {
            startTime: r.loopOptions.startTime ?? null,
            endTime: r.loopOptions.endTime ?? null,
            exactTimes: r.loopOptions.exactTimes ?? null,
            roundTripTimeSec: r.loopOptions.roundTripTimeSec ?? null,
            headwayDefinedTripSpan:
              r.loopOptions.headwayDefinedTripSpan ?? null,
          }
        : null,
      state: stateName(r.state),
      stopStatus: asArray(r.stopStatus)
        .map(normalizeStopStatus)
        .filter(Boolean),
    })),
  };
}


function buildSchedule(nonliveRides, liveRides) {
  const futureStarts = asArray(nonliveRides)
    .filter((r) => r.state?.Scheduled)
    .map((r) => r.scheduledStart)
    .filter(Boolean)
    .sort();

  return {
    routeActiveNow: asArray(liveRides).length > 0,
    nextScheduledStart: futureStarts[0] ?? null,
  };
}


function buildAlerts(noticesResp) {
  const n = bodyOf(noticesResp) || {};
  return asArray(n.riderNotices);
}


function buildSummary(route, stops, buses) {
  const stopNames = stops.map((s) => s.name).filter(Boolean);
  const routeName = route?.name || 'Route';
  const shortName = route?.shortName || routeName;
  const count = buses.length;

  const headline = count
    ? `${routeName} — ${count} bus${count === 1 ? '' : 'es'} live`
    : `${routeName} — no buses currently live`;

  const routeSummary = stopNames.length
    ? `The ${shortName} loops between ${stopNames.join(', ')}.`
    : 'No stops available.';

  return {
    headline,
    routeSummary,
    note: CONFIG.dataQualityNote,
  };
}

function extractCaptureSlices(captured) {
  return {
    noticesResp: findByUrl(captured, /\/u\/riderNotices/),
    routeResp: findByUrl(captured, ROUTE_DETAILS_RE),
  };
}

function emptySummary(noticesResp, error) {
  return {
    asOf: new Date().toISOString(),
    error: error ?? null,
    route: null,
    stops: [],
    geometry: {
      canonicalNavigationId: null,
      defaultNavigationId: null,
      navigations: {},
    },
    timetable: {
      direction: null,
      directionName: null,
      headwayRangeSec: null,
      timeIntervals: [],
      rides: [],
    },
    buses: [],
    alerts: buildAlerts(noticesResp),
    schedule: { routeActiveNow: false, nextScheduledStart: null },
    summary: {
      headline: 'No route data captured.',
      routeSummary: '',
      note: CONFIG.dataQualityNote,
    },
  };
}

function pickAsOf(buses) {
  const stamps = buses.map((b) => b.updatedAt).filter(Boolean).sort();
  return stamps.length ? stamps[stamps.length - 1] : new Date().toISOString();
}

function analyzeCapture(captured, error) {
  const { noticesResp, routeResp } = extractCaptureSlices(captured);

  const details = bodyOf(routeResp)?.InternalRouteDetails;
  if (!details) return emptySummary(noticesResp, error);

  const inexactTimetable = asArray(details.inexactTimetables)[0] || {};
  const rawStops = asArray(inexactTimetable.stops);
  const liveRides = asArray(inexactTimetable.liveRides);
  const nonliveRides = asArray(inexactTimetable.nonliveRides);
  const navigations = asArray(inexactTimetable.navigations);

  const firstLiveRide = liveRides[0]?.ride || null;

  const geometryById = buildGeometry(navigations);
  const defaultNavigationId = pickDefaultNavigationId(
    nonliveRides,
    geometryById,
  );
  const canonicalNavigationId = pickCanonicalNavigationId(nonliveRides);

  const route = buildRoute(details, inexactTimetable, firstLiveRide);
  const stops = buildStops(rawStops);
  const stopNameById = buildStopNameIndex(rawStops);
  const stopIndex = buildStopIndex(rawStops);
  const buses = buildBuses(
    liveRides,
    route,
    stopNameById,
    rawStops,
    stopIndex,
    defaultNavigationId,
  );

  const timetable = buildTimetable(inexactTimetable);

  const alerts = buildAlerts(noticesResp);
  const schedule = buildSchedule(nonliveRides, liveRides);
  const summary = buildSummary(route, stops, buses);

  return {
    asOf: pickAsOf(buses),
    error: error ?? null,
    route,
    stops,
    geometry: {
      canonicalNavigationId,
      defaultNavigationId,
      navigations: geometryById,
    },
    timetable,
    buses,
    alerts,
    schedule,
    summary,
  };
}


function flattenBuses(routesMap) {
  const out = [];
  for (const [routeName, perRoute] of Object.entries(routesMap)) {
    const shortName = perRoute?.route?.shortName ?? routeName;
    const color = perRoute?.route?.color ?? null;
    for (const bus of asArray(perRoute?.buses)) {
      out.push({
        route: routeName,
        routeShortName: shortName,
        routeColor: color,
        ...bus,
      });
    }
  }
  return out;
}

function dedupeAlerts(routesMap) {
  const seen = new Set();
  const out = [];
  for (const perRoute of Object.values(routesMap)) {
    for (const alert of asArray(perRoute?.alerts)) {
      const key =
        alert?.noticeId ??
        alert?.id ??
        (typeof alert === 'string' ? alert : JSON.stringify(alert));
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(alert);
    }
  }
  return out;
}

function aggregateSchedule(routesMap) {
  const activeRoutes = [];
  const perRoute = {};
  let nextOverall = null;

  for (const [name, perRouteSummary] of Object.entries(routesMap)) {
    const sched = perRouteSummary?.schedule || {};
    perRoute[name] = {
      routeActiveNow: !!sched.routeActiveNow,
      nextScheduledStart: sched.nextScheduledStart ?? null,
    };
    if (sched.routeActiveNow) activeRoutes.push(name);
    if (sched.nextScheduledStart) {
      if (!nextOverall || sched.nextScheduledStart < nextOverall) {
        nextOverall = sched.nextScheduledStart;
      }
    }
  }

  return {
    activeRoutes,
    nextScheduledStart: nextOverall,
    perRoute,
  };
}

function buildAggregate(routesMap) {
  const buses = flattenBuses(routesMap);
  const routeNames = Object.keys(routesMap);

  const timedOutRoutes = routeNames.filter(
    (n) => routesMap[n]?.captureTimedOut,
  );

  return {
    asOf: new Date().toISOString(),
    capturedAt: new Date().toISOString(),
    routeCount: routeNames.length,
    busCount: buses.length,
    timedOutRoutes,
    routes: routesMap,
    buses,
    alerts: dedupeAlerts(routesMap),
    schedule: aggregateSchedule(routesMap),
  };
}


function printSummary(summary) {
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

function writeSummaryFile(summary, savePath) {
  const outPath = savePath
    ? path.resolve(savePath)
    : path.resolve(CONFIG.defaultSavePath);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  process.stderr.write(`Wrote summary → ${outPath}\n`);
  return outPath;
}

function writeCompressedFile(summary, compressPath) {
  const outPath = compressPath
    ? path.resolve(compressPath)
    : path.resolve(CONFIG.defaultCompressPath);

  const compressed = compressSummary(summary);
  fs.writeFileSync(outPath, compressed);

  try {
    const restored = decompressSummary(compressed);
    if (JSON.stringify(restored) !== JSON.stringify(summary)) {
      process.stderr.write(
        'WARNING: decompressed output does not match the original summary.\n',
      );
    }
  } catch (err) {
    process.stderr.write(
      `WARNING: failed to verify decompression: ${err.message}\n`,
    );
  }

  process.stderr.write(
    `Wrote compressed → ${outPath} (${compressed.length} bytes)\n`,
  );
  return outPath;
}


async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  // Every route name → current-day URL, built from links.txt.
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

  if (args.route) {
    const resolved = resolveRouteName(allUrls, args.route);
    if (!resolved) {
      process.stderr.write(`Unknown route: "${args.route}"\n`);
      process.stderr.write(`Available: ${allNames.join(', ')}\n`);
      process.exitCode = 1;
      return;
    }

    const perRoute = await captureAllRoutes({
      routeList: [{ name: resolved, url: allUrls[resolved] }],
      headed: args.headed,
      concurrency: 1,
      timeoutMs,
      blockResources,
    });

    const output = perRoute[resolved];
    //printSummary(output); <-- Optional print out by execution
    if (args.save) writeSummaryFile(output, args.savePath);
    if (args.compress) writeCompressedFile(output, args.compressPath);
    return;
  }

  const routeList = allNames.map((n) => ({ name: n, url: allUrls[n] }));
  const perRoute = await captureAllRoutes({
    routeList,
    headed: args.headed,
    concurrency: args.concurrency || CONFIG.concurrency,
    timeoutMs,
    blockResources,
  });

  const aggregate = buildAggregate(perRoute);
  process.stderr.write(
    `\nCaptured ${aggregate.routeCount} routes, ${aggregate.busCount} buses total.\n`,
  );
  if (aggregate.timedOutRoutes.length) {
    process.stderr.write(
      `Routes with capture timeouts: ${aggregate.timedOutRoutes.join(', ')}\n`,
    );
  }

  //printSummary(aggregate); <-- Optional print out by execution
  if (args.save) writeSummaryFile(aggregate, args.savePath);
  if (args.compress) writeCompressedFile(aggregate, args.compressPath);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exitCode = 1;
});


module.exports = {
  // Config / routes
  getAllRutgersTripShotUrlList,

  // CLI
  parseArgs,
  printHelp,
  resolveRouteName,

  // Capture
  captureResponses,
  captureAllRoutes,
  attachCapture,
  installRouteAborts,
  isInterestingResponse,

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

  // Route
  buildRoute,
  buildServiceDay,

  // Stops
  buildStops,
  buildStop,
  buildStopNameIndex,

  // Buses
  buildBuses,
  buildBus,
  computeNextStop,
  pickRiderCount,

  // Geometry (Tier 1 + Tier 2)
  buildGeometry,
  pickDefaultNavigationId,
  pickCanonicalNavigationId,

  // Timetable (Tier 1 + Tier 2)
  buildTimetable,
  normalizeStopStatus,

  // Schedule
  buildSchedule,

  // Alerts
  buildAlerts,

  // Summary
  buildSummary,

  // Orchestration
  analyzeCapture,
  extractCaptureSlices,

  // Aggregation
  flattenBuses,
  dedupeAlerts,
  aggregateSchedule,
  buildAggregate,

  // Output
  printSummary,
  writeSummaryFile,
  writeCompressedFile,
};