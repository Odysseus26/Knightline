# Knightline

A backend service that scrapes Rutgers' TripShot bus platform and Rutgers
Campus Maps, normalizes the data into a Redis-backed store, and serves it
over a stateless HTTP API.

Unofficial project. Not affiliated with Rutgers University or TripShot.

---

## What it does

Rutgers operates ~17 intercampus bus routes. The official TripShot web app
shows live positions and ETAs, but there is no public API. This service
fills that gap:

1. **Scrapes** TripShot with headless Chromium (Playwright) for route
   definitions and live bus positions.
2. **Fetches** Rutgers Campus Maps for building geometry and metadata.
3. **Normalizes** everything into three tiers — static routes, live buses,
   and places — and stores them in Redis.
4. **Serves** the data via a read-only Fastify API.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  UPSTREAM                                                       │
│   • Rutgers TripShot    (HTML + XHR JSON)                       │
│   • Rutgers Campus Maps (sync-id + GeoJSON on GCS)              │
└─────────────────────────────────────────────────────────────────┘
                    │                          │
        ┌───────────┴──────────┐               │
        │                      │               │
        ▼                      ▼               ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ routes.js        │  │ live.js          │  │ places.js        │
│ 30 min cadence   │  │ 30 sec cadence   │  │ 24 hr cadence    │
│ hash-gated       │  │ overwrites       │  │ skip-the-day     │
│ 10-min rotation  │  │ 10-min rotation  │  │ no rotation      │
└────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
         │                     │                     │
         └───────────┬─────────┴─────────────────────┘
                     ▼
         ┌────────────────────────────┐
         │  Redis                     │
         │  bus:static:*              │  immutable route blobs + index
         │  bus:live:current / old    │  rotating live snapshots
         │  bus:places:*              │  daily building blob
         └──────────────┬─────────────┘
                        │
                        ▼
         ┌────────────────────────────┐
         │  Fastify API               │
         │  reads Redis only          │
         │  GET-only, stateless       │
         └────────────────────────────┘
```

**Cardinal rules:**

- The API never writes to Redis.
- `routes.js`, `live.js`, and `places.js` are the only writers, each owning
  a distinct namespace.
- Content-addressed blobs are immutable; pointers flip after writes.
- On any producer failure, the previous good data is left in place.

---

## Repository layout

```
Bus API/
├── API/                    Fastify HTTP server
│   ├── src/
│   │   ├── server.js
│   │   ├── config.js, keys.js, redis.js, errors.js, http.js
│   │   └── routes/
│   │       ├── index.js, health.js, meta.js
│   │       ├── static.js, live.js, places.js
│   │       ├── bootstrap.js
│   │       ├── reverse-index.js, discovery.js, summary.js
│   └── package.json
│
├── Redis/                  Producers — write to Redis
│   ├── routes.js           static route definitions (30 min)
│   ├── live.js             live bus positions + ETAs (30 sec)
│   └── places.js           Rutgers buildings (24 hr)
│
└── Support_Files/          Scrapers, config, and helpers
    ├── complete-routes.js       TripShot route scraper (Playwright)
    ├── rutgers-server-full.js   TripShot live scraper (Playwright)
    ├── rutgers-bus-full.js      Legacy combined scraper
    ├── buildings.js             Campus Maps scraper (plain fetch)
    ├── bus-etas.js              ETA precomputation
    ├── bus-compress.js          Compression helpers
    ├── configURL.js             Builds the { routeName: url } map
    └── links.txt                One TripShot route URL per line
```

---

## The three tiers

### Static tier — route definitions

- **Producer:** `Redis/routes.js`, every 30 minutes.
- **Content:** route metadata, stop list, street segments, geometry.
- **Volatility:** days to weeks.
- **Storage:** `bus:static:<hash>` (immutable), `bus:index:<hash>` (reverse
  index: which routes serve each stop / street).
- **Client behavior:** fetch once per version hash, cache forever.

### Live tier — bus positions

- **Producer:** `Redis/live.js`, every 30 seconds.
- **Content:** per-bus position, speed, bearing, next stop, ETAs, rider
  counts, plus alerts and schedule.
- **Volatility:** seconds.
- **Storage:** `bus:live:current` (TTL 120s), `bus:live:old` (TTL 900s),
  rotated on 10-minute bucket boundaries.
- **Client behavior:** poll every 30 seconds while foregrounded.

### Places tier — Rutgers buildings

- **Producer:** `Redis/places.js`, once per 24-hour bucket.
- **Content:** destination buildings inside the New Brunswick / Piscataway
  bounding box, with categories and a 0–5 prominence rank.
- **Volatility:** days to weeks.
- **Storage:** `bus:places:<hash>` (immutable), `bus:places:current`
  (pointer).
- **Failure mode:** a failed capture skips the rest of the day; the previous
  blob is left untouched.

---

## Prerequisites

- **Node.js 20+** — the producers use `fetch`, top-level `await`, and
  Node 20's unhandled-rejection behavior.
- **Redis 6+** — the producers use `SET ... NX EX` and Lua for lock
  release.
- **Chromium** — installed automatically by Playwright on first run
  (`npx playwright install chromium`).

---

## Setup

### 1. Install dependencies

Each of the three components has its own `package.json` (API) or shared
dependencies. Install in each folder:

```bash
cd API && npm install
cd ../Redis && npm install
cd ../Support_Files && npm install
```

Install Playwright's Chromium once:

```bash
npx playwright install chromium
```

### 2. Configure environment

Copy `.env.example` to `.env` in each folder that has one, or export
variables directly.

**`Redis/routes.js`:**

| Variable | Default | Purpose |
|---|---|---|
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection |
| `ROUTES_INTERVAL_MS` | `1800000` (30 min) | Tick cadence |
| `ROUTES_ROTATION_MS` | `600000` (10 min) | Rotation bucket size |
| `ROUTES_BLOB_TTL_SEC` | — | TTL for previous blobs |

**`Redis/live.js`:**

| Variable | Default | Purpose |
|---|---|---|
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection |
| `LIVE_INTERVAL_MS` | `30000` (30 sec) | Tick cadence |
| `LIVE_ROTATION_MS` | `600000` (10 min) | Rotation bucket size |
| `LIVE_OLD_TTL_SEC` | `900` | TTL of previous snapshot |

**`Redis/places.js`:**

| Variable | Default | Purpose |
|---|---|---|
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection |
| `PLACES_TICK_MS` | `3600000` (1 hr) | Wake-up cadence |
| `PLACES_ROTATION_MS` | `86400000` (24 hr) | Daily bucket size |
| `PLACES_BLOB_TTL_SEC` | `2592000` (30 d) | TTL of previous blob |
| `PLACES_LOCK_TTL_SEC` | `120` | Lock TTL |

**`API/`:**

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Listen host |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection |
| `LOG_LEVEL` | `info` | Fastify log level |
| `CORS_ORIGIN` | `*` | CORS allow-origin |
| `REDIS_TIMEOUT_MS` | `2000` | Per-request Redis timeout |

---

## Running

Six terminals, or run producers under a process manager:

```bash
# 1. Redis
redis-server

# 2. Static route producer
cd Redis && node routes.js

# 3. Live bus producer
cd Redis && node live.js

# 4. Places producer
cd Redis && node places.js

# 5. HTTP API
cd API && npm run dev

# 6. Verify
redis-cli exists bus:static:current bus:live:current bus:places:current
# expect: (integer) 3

curl -s localhost:3000/v1/health | jq '.ok'
```

The producers can also be run as one-shot jobs (they process a single tick
and exit if you pass `--once` — check each file for the exact flag) or
wrapped by `systemd`, `pm2`, or a Docker Compose stack.

---

## API reference

All endpoints are read-only. Full details in `API/src/routes/`.

### Health and meta

- `GET /v1/health`
- `GET /v1/health/live`, `GET /v1/health/static`
- `GET /v1/meta/live`, `GET /v1/meta/static`

### Static routes

- `GET /v1/static` — current version pointer
- `GET /v1/static/latest` — full routes blob at current version
- `GET /v1/static/:hash` — routes blob at a specific version (immutable)
- `GET /v1/static/:hash/index` — reverse index (stop → routes)
- `GET /v1/routes` — route summaries
- `GET /v1/routes/active` — routes with at least one live bus
- `GET /v1/routes/:name` — full definition for one route
- `GET /v1/routes/:name/streets` — street segments only
- `GET /v1/stops`, `GET /v1/stops/:stopId`, `GET /v1/stops/:stopId/routes`
- `GET /v1/streets`, `GET /v1/streets/:name`

### Live buses

- `GET /v1/live` — full snapshot: buses, alerts, schedule
- `GET /v1/live/buses` — buses only
- `GET /v1/live/buses/:name` — one bus
- `GET /v1/live/alerts`, `GET /v1/live/schedule`

All `/v1/live/*` accept `?window=current|old`. When the current snapshot
is missing, the API falls back to `old` and decorates the response with
`fellBack: true`.

### Places

- `GET /v1/places` — pointer + summary
- `GET /v1/places/latest` — blob at current version
- `GET /v1/places/:hash` — blob at a specific version (immutable)
- `GET /v1/places/:hash/items/:id` — one place
- `GET /v1/places/meta` — raw meta record (for ops)

### Bootstrap

- `GET /v1/bootstrap?have=<hash>` — combined static + live in one request

---

## Redis key layout

```
# Static tier
bus:static:current              pointer to current routes hash
bus:static:old                  pointer to previous window's hash
bus:static:<hash>               immutable routes blob
bus:index:<hash>                immutable index blob
bus:static:meta                 freshness / error state
bus:static:lock                 single-flight lock

# Live tier
bus:live:current                fresh snapshot (TTL 120s)
bus:live:old                    previous window (TTL 900s)
bus:live:meta                   freshness / error state
bus:live:lock                   single-flight lock

# Places tier
bus:places:current              pointer to current places hash
bus:places:<hash>               immutable places blob
bus:places:meta                 freshness / error state
bus:places:lock                 single-flight lock
```

Blobs are content-addressed: `<hash>` is the first 12 hex chars of a
SHA-256 over the canonical JSON. Same content → same hash → no writes.
Old blobs are kept until their TTL expires so clients that cached an old
hash can still read it.

---

## Design notes

**Content addressing.** Static and places blobs are immutable and keyed
by content hash. Pointer flips are atomic — the blob is written before the
pointer is updated.

**Two-slot rotation.** Static and live tiers keep a `current` and an `old`
slot. On a bucket boundary, `current` moves to `old` and the fresh payload
becomes `current`. Clients that ask for `current` get an automatic
fallback to `old` if `current` is briefly missing.

**Single-flight locks.** Every producer acquires `SET ... NX EX` before
capturing. A tick that can't get the lock skips. Lock release uses Lua
compare-and-delete so a slow tick can't release a lock it no longer owns.

**Availability over observability.** A failed producer tick leaves the
previous good data in place. Only the meta record reflects the failure.

**Skip-the-day for places.** A failed places capture skips the rest of the
24-hour bucket — building data changes at most daily, and a retry storm
against a flaky upstream is worse than a lost day.

**ETA precomputation.** ETAs are computed once per live tick by
`Support_Files/bus-etas.js` and written into `bus:live:current`. The API
never computes them. Note: `bus.etas` is keyed by **stop name**, not
`stopKey` — this is documented in the code and noted as a known limitation.

**Nameless buses.** TripShot occasionally emits live rides with a null
`vehicle.name` — buses being pre-positioned. Filtered in `live.js` before
writing to Redis. Counted as `droppedNameless` in meta.

---

## Debugging

**Producer crashes with `triggerUncaughtException`**
Unhandled promise rejection. Every `waitForResponse` in the Playwright
scrapers must have `.then().catch()` attached at creation, not just
`await`. See `complete-routes.js` for the pattern.

**Empty `name` field on a bus in the API response**
The producer filter has regressed:

```bash
redis-cli --raw get bus:live:current | jq '[.buses[] | select((.name // "") == "")] | length'
# expect: 0
```

If it returns > 0, restart `live.js`.

**API returns 503 on `/v1/live`**
Check `redis-cli exists bus:live:current bus:live:old`. If both are 0,
the producer isn't running.

**API returns 503 on `/v1/places`**
Check `redis-cli exists bus:places:current`. If 0, `places.js` has either
never run or failed on every bucket since startup. Check
`redis-cli --raw get bus:places:meta | jq`.

**`/v1/routes/stale` returns 404**
Route registration order — `reverse-index.js` must register before
`discovery.js` so the static path resolves before `:name`.

**Producers write to `undefined` keys**
`redis-cli keys 'undefined*'`. A key constant is missing from a
`CONFIG_KEYS` block.

---

## Contributing

Issues and PRs welcome. The codebase is deliberately small and the
contracts are documented in comments at the top of each file. A few
things to know:

- The scrapers are the fragile part. TripShot changes its HTML and JSON
  shape without warning; if a scrape starts failing, the response shape
  is the first thing to check.
- The API never writes to Redis. If you need new data, add it in a
  producer.
- The content hash is the cache key on the client. Changing the shape of
  a blob without bumping the relevant `schemaVersion` (for places) will
  collide with older blobs of the same content.

---

## Disclaimer

This project is unofficial and not affiliated with Rutgers University,
TripShot, or Google. It scrapes publicly accessible data from the Rutgers
TripShot web app and Rutgers Campus Maps. If you are one of the maintainers
of those systems and would prefer this project not scrape your endpoints,
open an issue and it will be taken down.
