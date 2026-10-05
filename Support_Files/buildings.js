// bus_support/buildings.js
'use strict';

/**
 * Rutgers buildings scraper.
 *
 * Two-step fetch:
 *   1. GET https://maps.rutgers.edu/api/syncId
 *        -> { "syncId": "1790853006813 (Oct 1, 2026, 7:10 AM EDT)" }
 *   2. GET https://storage.googleapis.com/rutgers-campus-map-prod-public-sync/
 *          <encoded-syncId>/buildings-parking-layer.json
 *        -> GeoJSON FeatureCollection of buildings + parking lots
 *
 * We do not use Playwright here. The two URLs are stable and public,
 * so a plain `fetch` is faster, lighter, and has no Chromium dependency.
 *
 * This module is importable. It does not run anything on require().
 * CLI entry lives at the bottom behind `require.main === module`.
 *
 * Public API:
 *   capturePlaces(opts) -> {
 *     sourceSyncId: string,
 *     generatedAt:  string (ISO),
 *     count:        number,
 *     places:       Place[]
 *   }
 *
 *   Place = {
 *     id:         string,         // stable, from source ("3000", "4146")
 *     name:       string,
 *     lat:        number,
 *     lng:        number,
 *     categories: string[],       // ["academic"], ["housing","academic"], ...
 *     labelRank:  number          // 0-5; see handoff §labelRank
 *   }
 */

const DEFAULT_SYNC_URL =
  'https://maps.rutgers.edu/api/syncId';

const STORAGE_BASE =
  'https://storage.googleapis.com/rutgers-campus-map-prod-public-sync';

// The bus app only serves the New Brunswick / Piscataway campuses.
// Everything outside this box is dropped before it ever reaches Redis.
// If you add a Newark or Camden route later, widen this — or better,
// make it a config parameter rather than a hardcoded constant.
const NB_BBOX = Object.freeze({
  minLat: 40.47,
  maxLat: 40.53,
  minLng: -74.48,
  maxLng: -74.40,
});

// Categories that should never appear as destinations in the journey
// planner. These are real Rutgers "buildings" in the source data, but
// nobody wants to be routed to "Hardenbergh Generator".
//
// Note: 'parking' is intentionally NOT in this list. Parking features
// have category === 'parking' (not 'building'), and the very first
// filter in isDestinationBuilding() already drops them. Including it
// here would be dead code.
const EXCLUDED_CATEGORIES = new Set([
  'utilities',
  'storage',
  'supt-stor',
]);

// The source should have hundreds of buildings inside NB_BBOX. If the
// upstream response is truncated, empty, or the shape changes, we will
// see far fewer. Refusing to publish a suspiciously small list protects
// clients from silently losing every place for a full day.
const MIN_EXPECTED_PLACES = 50;

// The sync id is formatted like "1790853006813 (Oct 1, 2026, 7:10 AM EDT)".
// We accept word chars, whitespace, and the punctuation already present.
// Anything else means the format has changed and we should refuse to
// build the URL rather than guess.
const SYNC_ID_PATTERN = /^[\w\d\s\-().:,]+$/;

function inNewBrunswickBBox(lat, lng) {
  if (lat == null || lng == null) return false;
  return (
    lat >= NB_BBOX.minLat &&
    lat <= NB_BBOX.maxLat &&
    lng >= NB_BBOX.minLng &&
    lng <= NB_BBOX.maxLng
  );
}

function normalizeCategories(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => String(c).toLowerCase());
}

function isDestinationBuilding(feature) {
  const p = feature && feature.properties;
  if (!p) return false;
  if (p.category !== 'building') return false;
  if (!p.name || p.lat == null || p.lng == null) return false;
  if (!inNewBrunswickBBox(p.lat, p.lng)) return false;

  const cats = normalizeCategories(p.categories);
  if (cats.some((c) => EXCLUDED_CATEGORIES.has(c))) return false;
  return true;
}

function shapePlace(feature) {
  const p = feature.properties;
  return {
    id: String(p.id),
    name: String(p.name).trim(),
    lat: p.lat,
    lng: p.lng,
    // Store normalized (lowercase) categories so filters and downstream
    // consumers see a consistent casing regardless of source drift.
    categories: normalizeCategories(p.categories),
    labelRank: typeof p.labelRank === 'number' ? p.labelRank : 0,
  };
}

// The browser encoded the sync id as "spaces -> %20" only. Parens,
// commas and colons were left alone. Match that exactly, because the
// GCS bucket key was written by the Rutgers Maps frontend.
//
// Any other reserved character would break the URL and go unnoticed;
// we therefore validate against SYNC_ID_PATTERN before reaching here.
function encodeSyncIdPathSegment(syncId) {
  return syncId.replace(/ /g, '%20');
}

async function fetchJson(url, { timeoutMs = 30000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the current sync id and the buildings layer that matches it.
 * Returns the cleaned, filtered, deduped, sorted list of places.
 *
 * Throws on:
 *   - network failure, non-2xx, malformed JSON
 *   - unexpected /api/syncId shape or format
 *   - a suspiciously small result set (< MIN_EXPECTED_PLACES)
 *
 * The caller (places.js) is responsible for catching and deciding
 * what to do.
 */
async function capturePlaces(opts = {}) {
  const {
    syncUrl = DEFAULT_SYNC_URL,
    storageBase = STORAGE_BASE,
    timeoutMs = 30000,
    fetchImpl = fetch,
    logger = console,
  } = opts;

  // Step 1 — current sync id
  const syncBody = await fetchJson(syncUrl, { timeoutMs, fetchImpl });
  const syncId =
    typeof syncBody === 'string' ? syncBody : syncBody && syncBody.syncId;
  if (!syncId || typeof syncId !== 'string') {
    throw new Error(
      `Unexpected /api/syncId response: ${JSON.stringify(syncBody)}`,
    );
  }
  if (!SYNC_ID_PATTERN.test(syncId)) {
    throw new Error(
      `Unexpected syncId format (refusing to build URL): ${JSON.stringify(syncId)}`,
    );
  }

  // Step 2 — the layer for that sync id
  const layerUrl =
    `${storageBase}/${encodeSyncIdPathSegment(syncId)}` +
    `/buildings-parking-layer.json`;
  if (logger && logger.log) logger.log(`[buildings] fetching ${layerUrl}`);

  const layer = await fetchJson(layerUrl, { timeoutMs, fetchImpl });
  const features = Array.isArray(layer && layer.features) ? layer.features : [];

  const kept = features
    .filter(isDestinationBuilding)
    .map(shapePlace);

  // Dedupe by id (defensive — the source should already be unique).
  const byId = new Map();
  for (const p of kept) byId.set(p.id, p);

  // Sort by name so the output is deterministic regardless of feature
  // order in the source. This is what makes the content hash stable.
  const places = Array.from(byId.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  // Refuse to publish a suspiciously small result. An empty or truncated
  // upstream response should fail the capture, not silently overwrite
  // yesterday's good data with nothing.
  if (places.length < MIN_EXPECTED_PLACES) {
    throw new Error(
      `Suspiciously few places (${places.length}); refusing to publish. ` +
      `Expected at least ${MIN_EXPECTED_PLACES}.`,
    );
  }

  return {
    sourceSyncId: syncId,
    generatedAt: new Date().toISOString(),
    count: places.length,
    places,
  };
}

module.exports = {
  capturePlaces,
  isDestinationBuilding,
  shapePlace,
  inNewBrunswickBBox,
  normalizeCategories,
  encodeSyncIdPathSegment,
  NB_BBOX,
  EXCLUDED_CATEGORIES,
  MIN_EXPECTED_PLACES,
  SYNC_ID_PATTERN,
  DEFAULT_SYNC_URL,
  STORAGE_BASE,
};

// ---------------------------------------------------------------------------
// CLI entry — only runs when this file is executed directly.
//
//   node bus_support/buildings.js            # print summary + 5 samples
//   node bus_support/buildings.js --dump     # also write places.json
// ---------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    try {
      const result = await capturePlaces();
      console.log(
        JSON.stringify(
          {
            sourceSyncId: result.sourceSyncId,
            generatedAt: result.generatedAt,
            count: result.count,
            sample: result.places.slice(0, 5),
          },
          null,
          2,
        ),
      );
      if (process.argv.includes('--dump')) {
        require('fs').writeFileSync(
          'places.json',
          JSON.stringify(result, null, 2),
        );
        console.log(`\nWrote ${result.count} places to places.json`);
      }
    } catch (err) {
      console.error('capturePlaces failed:', err);
      process.exit(1);
    }
  })();
}