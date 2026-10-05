// bus-etas.js
//
// Computes per-stop ETAs for a live bus, using the stop status array the
// TripShot route endpoint already provides. No extra network calls.
//
// The server provides ETAs for the next ~1.5 loops per bus. For anything
// beyond that horizon, we extrapolate using the ride's nominal loop time.
//
// Public API:
//   buildStopIndex(stops)                             → Map<stopId, stop>
//   etaForStop(busEntry, stopId, stopIndex, loopSec)  → ETA | null
//   enrichBusWithEtas(busEntry, stops, stopIndex)     → { [stopName]: ETA }
//
// `busEntry` is a raw live-ride entry from `liveRides[]` (has .vehicle,
// .vehicleStatus, .ride). `stops` is the raw stops array from the route
// payload (must include stopId and name).

'use strict';

// ===========================================================================
// PRIVATE HELPERS
// ===========================================================================

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function stateName(state) {
  if (!state || typeof state !== 'object') return null;
  const keys = Object.keys(state);
  return keys.length ? keys[0] : null;
}

// ===========================================================================
// PUBLIC API
// ===========================================================================

/**
 * Build a lookup from any stop identifier to the stop object.
 *
 * A stop may be referenced by both `stopId` and `sharedStopId` in different
 * parts of the payload, so both keys point to the same object.
 *
 * @param {Array} stops  Raw stops array from the route payload.
 * @returns {Map<string, object>}
 */
function buildStopIndex(stops) {
  const map = new Map();
  for (const s of asArray(stops)) {
    if (!s) continue;
    if (s.stopId) map.set(s.stopId, s);
    if (s.sharedStopId) map.set(s.sharedStopId, s);
  }
  return map;
}

/**
 * Return the next arrival of `busEntry` at `stopId`.
 *
 * Walk the ride's stopStatus[] in order and return the first entry whose
 * state is Awaiting (en route) or Present (at the stop). That first match
 * is by definition the next visit.
 *
 * If the server's horizon doesn't include the requested stop, fall back to
 * a one-loop extrapolation using `loopSec`. The result's `source` field
 * distinguishes the two cases.
 *
 * @param {object} busEntry       Raw live-ride entry (has .ride).
 * @param {string} stopId         The target stop's stopId.
 * @param {Map}    stopIndex      Result of buildStopIndex().
 * @param {number} [loopSec]      Optional nominal round-trip seconds.
 * @returns {object|null}
 */
function etaForStop(busEntry, stopId, stopIndex, loopSec = null) {
  const ride = busEntry?.ride;
  const statuses = asArray(ride?.stopStatus);
  const stop = stopIndex?.get(stopId) ?? { stopId, name: null };

  // 1) Server-provided next visit.
  for (const entry of statuses) {
    const state = stateName(entry);
    if (state !== 'Awaiting' && state !== 'Present') continue;

    const visit = entry[state];
    if (visit?.stopId !== stopId) continue;

    const etaISO = visit.expectedArrivalTime ?? visit.arrivalTime ?? null;
    if (!etaISO) continue;

    return {
      name: stop.name,
      etaISO,
      state,
      source: 'server',
    };
  }

  // 2) Extrapolate one loop beyond the last Awaiting entry.
  if (!loopSec) return null;

  const lastAwaiting = [...statuses]
    .reverse()
    .find((e) => stateName(e) === 'Awaiting');
  if (!lastAwaiting) return null;

  const lastVisit = lastAwaiting.Awaiting;
  const lastEtaMs = new Date(
    lastVisit.expectedArrivalTime ?? lastVisit.arrivalTime,
  ).getTime();
  if (Number.isNaN(lastEtaMs)) return null;

  return {
    name: stop.name,
    etaISO: new Date(lastEtaMs + loopSec * 1000).toISOString(),
    state: 'Projected',
    source: 'extrapolated',
  };
}

/**
 * Build a { [stopName]: ETA } map for one bus across every stop on the route.
 *
 * Keying by name (rather than stopId) makes the output human-readable. On
 * the LX loop, all stop names are unique, so there are no collisions.
 *
 * @param {object} busEntry   Raw live-ride entry (has .ride).
 * @param {Array}  stops      Raw stops array.
 * @param {Map}    stopIndex  Result of buildStopIndex().
 * @returns {object}
 */
function enrichBusWithEtas(busEntry, stops, stopIndex) {
  const loopSec = busEntry?.ride?.loopOptions?.roundTripTimeSec ?? null;
  const etas = {};

  for (const s of asArray(stops)) {
    const key = s.stopId ?? s.sharedStopId;
    if (!key) continue;

    const eta = etaForStop(busEntry, key, stopIndex, loopSec);
    if (!eta) continue;

    etas[s.name ?? key] = {
      etaISO: eta.etaISO,
      state: eta.state,
      source: eta.source,
    };
  }

  return etas;
}

// ===========================================================================
// EXPORTS
// ===========================================================================

module.exports = {
  buildStopIndex,
  etaForStop,
  enrichBusWithEtas,
};