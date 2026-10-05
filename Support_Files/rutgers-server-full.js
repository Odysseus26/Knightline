#!/usr/bin/env node
/**
 * rutgers-server-full.js
 *
 * Captures the LIVE / time-sensitive Rutgers TripShot data for every route
 * in links.txt and writes rutgers-summary.json:
 *
 *   - Live buses: position, speed, bearing, next stop, ETAs to every stop
 *   - Riders:     estimated count, capacity, percent full
 *   - Alerts:     active rider notices (deduped across routes)
 *   - Schedule:   activeRoutes, nextScheduledStart
 *   - Timetable:  full ride list with stop-level scheduled times
 *
 * The STATIC route definition (identity, stops, geometry/polylines) lives
 * in complete-routes.js → routes.json.
 *
 * The Playwright capture toolkit is required from complete-routes.js so
 * both files share one implementation of page-opening, response-capturing,
 * and request-blocking.
 *
 * Usage:
 *   node rutgers-server-full.js                     # all routes
 *   node rutgers-server-full.js --route "A Route"   # one route
 *   node rutgers-server-full.js --list              # list route names
 *   node rutgers-server-full.js --save custom.json
 *   node rutgers-server-full.js --compress          # also write Brotli .bin
 *   node rutgers-server-full.js --concurrency 6
 *   node rutgers-server-full.js --timeout 20000
 *   node rutgers-server-full.js --no-block
 *   node rutgers-server-full.js --headed
 *   node rutgers-server-full.js --help
 *
 * Requires: playwright (npm i playwright)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { buildStopIndex, enrichBusWithEtas } = require('./bus-etas');
const { compress: compressSummary, decompress: decompressSummary } = require('./bus-compress');
const {
  getAllRutgersTripShotUrls,
  getAllRutgersTripShotUrlList,
} = require('./configURL');

// Shared capture toolkit + route-derived helpers.
const {
  captureAllRoutes,
  findByUrl,
  bodyOf,
  asArray,
  stateName,
  loc,
  resolveRouteName,
  ROUTE_DETAILS_RE,
  buildGeometry,
  buildRoute,
  pickDefaultNavigationId,
  CONFIG: ROUTES_CONFIG,
} = require('./complete-routes');


// ===========================================================================
// CONFIGURATION
// ===========================================================================

const CONFIG = {
  defaultSavePath: 'rutgers-summary.json',
  defaultCompressPath: 'bus-compressed.bin',
  responseTimeoutMs: ROUTES_CONFIG.responseTimeoutMs,
  settleMs: ROUTES_CONFIG.settleMs,
  concurrency: 9,
  dataQualityNote:
    'Rider counts may reflect APC-derived rolling totals rather than current onboard passengers.',
};


// ===========================================================================
// CLI
// ===========================================================================

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
      if (next && !next.startsWith('-')) { out.savePath = next; i++; }
    } else if (a === '--compress' || a === '-c') {
      out.compress = true;
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) { out.compressPath = next; i++; }
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
Rutgers Server Full — live bus capture + rider-facing summary

Usage:
  node rutgers-server-full.js [options]

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
  -s, --save [file]       Write summary JSON to file
                          (default ${CONFIG.defaultSavePath})
  -c, --compress [file]   Also write a Brotli-compressed binary
                          (default ${CONFIG.defaultCompressPath})
      --headed            Run the browser with a visible UI
  -h, --help              Show this help text

Output: rutgers-summary.json — live buses, ETAs, alerts, schedule, timetable.
Static route definitions live in routes.json (see complete-routes.js).
`);
}


// ===========================================================================
// BUS BUILDERS
// ===========================================================================

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
    vehicleId: ride?.vehicleId ?? null,
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


// ===========================================================================
// STOP NAME INDEX
// ===========================================================================

function buildStopNameIndex(rawStops) {
  const map = new Map();
  for (const s of asArray(rawStops)) {
    if (s.stopId) map.set(s.stopId, s.name ?? null);
    if (s.sharedStopId) map.set(s.sharedStopId, s.name ?? null);
  }
  return map;
}


// ===========================================================================
// TIMETABLE
// ===========================================================================

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


// ===========================================================================
// SCHEDULE
// ===========================================================================

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


// ===========================================================================
// ALERTS
// ===========================================================================

function buildAlerts(noticesResp) {
  const n = bodyOf(noticesResp) || {};
  return asArray(n.riderNotices);
}


// ===========================================================================
// SUMMARY
// ===========================================================================

function buildSummary(route, stopNames, buses) {
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


// ===========================================================================
// ORCHESTRATION
// ===========================================================================

function extractServerSlices(captured) {
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

function analyzeServerCapture(captured, error) {
  const { noticesResp, routeResp } = extractServerSlices(captured);

  const details = bodyOf(routeResp)?.InternalRouteDetails;
  if (!details) return emptySummary(noticesResp, error);

  const inexactTimetable = asArray(details.inexactTimetables)[0] || {};
  const rawStops = asArray(inexactTimetable.stops);
  const liveRides = asArray(inexactTimetable.liveRides);
  const nonliveRides = asArray(inexactTimetable.nonliveRides);
  const navigations = asArray(inexactTimetable.navigations);

  const firstLiveRide = liveRides[0]?.ride || null;

  // geometryById is only used to compute the defaultNavigationId fallback.
  // The full geometry itself lives in routes.json, not here.
  const geometryById = buildGeometry(navigations);
  const defaultNavigationId = pickDefaultNavigationId(nonliveRides, geometryById);

  const route = buildRoute(details, inexactTimetable, firstLiveRide);
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

  // Route metadata only — stops + geometry belong in routes.json.
  const routeMeta = route
    ? {
        name: route.name,
        shortName: route.shortName,
        color: route.color,
        type: route.type,
        loopMinutes: route.loopMinutes,
        serviceDay: route.serviceDay,
        direction: route.direction,
        directionName: route.directionName,
        regionId: route.regionId,
        effectiveThrough: route.effectiveThrough,
        headwayRangeSec: route.headwayRangeSec,
      }
    : null;

  // Stop names for the human-readable routeSummary string.
  const stopNames = rawStops.map((s) => s.name).filter(Boolean);
  const summary = buildSummary(route, stopNames, buses);

  return {
    asOf: pickAsOf(buses),
    error: error ?? null,
    route: routeMeta,
    timetable,
    buses,
    alerts,
    schedule,
    summary,
  };
}


// ---------------------------------------------------------------------------
// Aggregate every per-route summary into a single self-describing payload.
// ---------------------------------------------------------------------------

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


// ===========================================================================
// OUTPUT
// ===========================================================================

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


// ===========================================================================
// ENTRY POINT
// ===========================================================================

// ===========================================================================
// PROGRAMMATIC ENTRY (used by CLI and by live.js)
// ===========================================================================

/**
 * Run the full capture pipeline and return the per-route map plus the
 * resolved route list. No file I/O, no console side-effects.
 *
 * @param {object}   [options]
 * @param {string}   [options.route]          single route name (else all)
 * @param {boolean}  [options.headed]         visible browser
 * @param {number}   [options.concurrency]    parallel route pages
 * @param {number}   [options.timeoutMs]      per-route response timeout
 * @param {boolean}  [options.blockResources] default true
 * @returns {Promise<{ perRoute: object, routeList: Array<{name:string,url:string}> }>}
 */
async function captureAndAggregate(options = {}) {
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
    concurrency: options.concurrency ?? CONFIG.concurrency,
    timeoutMs: options.timeoutMs ?? CONFIG.responseTimeoutMs,
    blockResources: options.blockResources !== false,
  });

  const perRoute = {};
  for (const [name, raw] of Object.entries(rawPerRoute)) {
    const summary = analyzeServerCapture(raw.captured, raw.error);
    if (raw.timedOut) summary.captureTimedOut = true;
    perRoute[name] = summary;
  }

  return { perRoute, routeList };
}



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

  let perRoute;
  let routeList;
  try {
    ({ perRoute, routeList } = await captureAndAggregate({
      route: args.route,
      headed: args.headed,
      concurrency: args.concurrency,
      timeoutMs: args.timeout,
      blockResources: !args.noBlock,
    }));
  } catch (err) {
    process.stderr.write(`Capture failed: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  // Single-route mode: emit the flat per-route summary.
  if (args.route) {
    const single = perRoute[routeList[0].name];
    writeSummaryFile(single, args.savePath);
    if (args.compress) writeCompressedFile(single, args.compressPath);
    return;
  }

  // Default: capture EVERY route, emit aggregated payload.
  const aggregate = buildAggregate(perRoute);
  process.stderr.write(
    `\nCaptured ${aggregate.routeCount} routes, ${aggregate.busCount} buses total.\n`,
  );
  if (aggregate.timedOutRoutes.length) {
    process.stderr.write(
      `Routes with capture timeouts: ${aggregate.timedOutRoutes.join(', ')}\n`,
    );
  }

  writeSummaryFile(aggregate, args.savePath);
  if (args.compress) writeCompressedFile(aggregate, args.compressPath);
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
  parseArgs,
  printHelp,

  // Bus builders
  buildBuses,
  buildBus,
  computeNextStop,
  pickRiderCount,

  // Timetable
  buildTimetable,
  normalizeStopStatus,

  // Schedule
  buildSchedule,

  // Alerts
  buildAlerts,

  // Summary
  buildSummary,

  // Orchestration
  analyzeServerCapture,
  extractServerSlices,
  captureAndAggregate,

  // Aggregation
  flattenBuses,
  dedupeAlerts,
  aggregateSchedule,
  buildAggregate,

  // Output
  writeSummaryFile,
  writeCompressedFile,

  // Config
  CONFIG,
};