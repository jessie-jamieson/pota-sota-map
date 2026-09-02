# Offline end-to-end test harness

Everything here runs with **zero real network access**. Every external host the app talks to
(CDN libraries, map tiles, the POTA/SOTA APIs, the SOTA CSV, geocoders, Overpass) is intercepted
by Playwright's `context.route()` and answered from local files under `tests/fixtures/` and
`dev/vendor/`.

## Files

| File | What it is |
|---|---|
| `tests/mock-network.js` | `installMocks(context, options)` — registers every network route on a Playwright `BrowserContext`. Reusable by any Playwright script, not just `e2e.js`. |
| `tests/e2e.js` | The test runner: starts a static file server, launches Chromium, runs each scenario in its own mocked context, prints PASS/FAIL/SKIP, exits non-zero on any FAIL. |
| `tests/standin.html` | A minimal page (same CDN tags as the real app, a real Leaflet map, a few `fetch()` calls) used **only** to prove the harness itself works before `pota-sota-map.html` exists. Only the `loads` scenario is expected to pass against it. |
| `tests/nfer.test.js` | A separate, self-contained Node unit test for `src/40-nfer.js` (no Playwright, no `mock-network.js`). Not part of this harness; documented here only because it lives in the same directory. |
| `tests/boundary.test.js` | Same idea for the single-park boundary lookup in `src/40-nfer.js` (`buildParkQuery` / `parkBoundary` / `boundaryFromAnalysis`), stubbing `PSM.fetchText` with the same Overpass fixture. |
| `tests/fixtures/*.json`, `*.csv`-shaped fixtures, `build_fixtures.py`, `build_overpass_fixture.py` | Fixture data + the scripts that generated it. Owned by other agents — see "Adding / changing fixtures" below. |

## Running

```bash
# from the project root; NODE_PATH is required unless playwright is already resolvable
export NODE_PATH=/home/claude/.npm-global/lib/node_modules

# run every scenario against pota-sota-map.html (the default --app)
node tests/e2e.js

# run one or more scenarios (comma-separated, or repeat --only)
node tests/e2e.js --only loads
node tests/e2e.js --only search-latlon,search-grid

# point at a different HTML file (path is resolved relative to your current directory)
node tests/e2e.js --app tests/standin.html --only loads

# show the browser instead of running headless (useful for debugging a failure)
node tests/e2e.js --headed --only park-detail

node tests/e2e.js --help
```

Exit code is non-zero iff at least one scenario **FAIL**ed. A scenario that **SKIP**ped (because
`--app` doesn't exist on disk yet) does not fail the run — this is expected until the other
agents finish `scripts/build.py` / `src/*.js` and `pota-sota-map.html` exists at the project root.

Screenshots land in `tests/out/<scenario>.png` (1280×860, except `mobile` which is 390×844),
overwritten on every run.

## What each scenario checks

`loads`, `search-address`, `search-latlon`, `search-grid`, `search-pota-ref`, `search-sota-ref`,
`park-detail`, `summit-detail`, `fallback-grid`, `nfer`, `park-boundary`, `spots`, `mylog`,
`file-url`, `mobile`, `snapshot`
— see the doc comment above each `scenario*` function in `tests/e2e.js` for the exact assertions;
the short version is in the task brief this harness was built from. A few notes on how the runner
behaves that aren't obvious from reading one scenario in isolation:

* Every scenario gets a **fresh `BrowserContext`** (fresh `localStorage`, fresh mocks) and its own
  `installMocks()` call, so scenarios cannot leak state into each other and can run in any order.
* `PSM.app.search(...)` / `openPark(...)` / `openSummit(...)` / `runNfer()` are invoked via
  `page.evaluate()` **without** awaiting their returned promise inside the page — the scenario
  then waits on a bounded, state-based condition (`psm-results` class, `state.nfer` appearing,
  etc., capped at 20 s) instead. This means a bug that leaves one of those promises unsettled
  produces a clean timeout failure here rather than hanging the whole suite.
* **Console/page error policy**: any `pageerror` (uncaught exception / unhandled rejection) always
  fails the scenario. A `console.error(...)` call also fails it, **except** messages that start
  with `[PSM]` (the app's own `PSM.log(msg, 'error')` → `console.error('[PSM]', msg)` channel per
  `src/00-util.js`) and anything mentioning `favicon`. The reasoning: `[PSM]`-prefixed messages
  are the app's intentional, user-visible status log — scenarios like `fallback-grid` and
  `snapshot` deliberately induce a handled failure and assert on `PSM.logEntries` instead of
  wanting that log line to fail the run. Any *other* console error (a real exception logged
  manually, a genuinely unmocked failed resource load, a CORS failure, etc.) still fails the
  scenario. **This filtering rule is an assumption about the app's logging convention** documented
  in `ARCHITECTURE.md`'s `00-util.js` contract (`PSM.log`) — if the real app logs handled
  fallbacks differently, revisit the filter in `runScenario()` in `tests/e2e.js`.
* The `snapshot` scenario needs `tests/fixtures/snapshot_sample.js` (`window.PSM_SNAPSHOT = {...}`
  shaped per `ARCHITECTURE.md`'s `build_snapshot.py` section). If that fixture doesn't exist yet
  (another agent generates it), `e2e.js` prints a note and synthesizes a tiny one in memory (one
  POTA park — Harriman — and one SOTA summit — Slide Mountain, read from
  `tests/fixtures/sota_summit_W2_GC-001.json` if present) via `mock-network.js`'s
  `options.snapshotJs`. Once the real fixture lands, it's picked up automatically — no code change
  needed.
* `nfer`'s "expect `zones.features.length ≥ 1`" check is conditional on
  `tests/fixtures/overpass_harriman.json` actually containing `elements` (it does, as of this
  writing — 111 of them). If that fixture is ever swapped for the `{version:0.6,elements:[]}`
  placeholder, the scenario relaxes to only checking the Overpass POST body itself.

## What's mocked (`tests/mock-network.js`)

`installMocks(context, options)` returns `{ requests, overpassQueries, tileCount }` and installs
one `context.route('**/*', ...)` handler that answers:

| Source | Destination |
|---|---|
| `https://cdnjs.cloudflare.com/.../leaflet/1.9.4/*`, `.../leaflet.markercluster/1.5.3/*`, `.../Turf.js/7.4.0/turf.min.js`, `https://cdn.jsdelivr.net/npm/osmtogeojson@3.0.0-beta.5/osmtogeojson.js` | `dev/vendor/**` (correct `content-type` per file) |
| `tile.openstreetmap.org`, `*.tile.opentopomap.org`, `basemap.nationalmap.gov`, `server.arcgisonline.com` (any path) | a generated 256×256 flat-grey PNG; counted in `tileCount` |
| `api.pota.app/location/parks/US-NY` | `pota_location_parks_US-NY.json` |
| `api.pota.app/location/parks/<other>` | `[]` |
| `api.pota.app/park/grid/<CELL>` | `pota_park_grid_<CELL>.json` if it exists, else `[]` |
| `api.pota.app/park/US-2069` | `pota_park_US-2069.json` (the one real, fully-populated capture) |
| `api.pota.app/park/<other ref>` | synthesized from the matching `pota_location_parks_US-NY.json` row (name/lat/lon/grid) with `parktypeDesc:"State Park"`, `locationDesc:"US-NY"`, `locationName:"New York"`; `null` (HTTP 200) if the ref isn't in that list |
| `api.pota.app/park/stats\|activations\|leaderboard/<any ref>` | the `US-2069` fixture, regardless of ref |
| `api.pota.app/spot/activator` | `pota_spots.json` |
| `api.pota.app/lookup?search=<text>` | NY list filtered by case-insensitive name substring → `[{type:"park",id,display,value}]` |
| any other `api.pota.app` route | HTTP 403 (matches the real API's documented behavior for unmatched routes) |
| `api2.sota.org.uk/api/associations` | `sota_associations.json` |
| `.../api/associations/{W1,W2,W3}` | the matching fixture; other codes → 404 |
| `.../api/regions/W2/{GC,EH,GA,WE,NJ}` | the matching fixture (`GC` has real summits, the rest are empty); other regions → 404 |
| `.../api/summits/W2/GC-001` | `sota_summit_W2_GC-001.json` |
| `.../api/summits/<assoc>/<region-NNN>` | synthesized from that region's summit list if found, else 404 |
| `.../api/spots/<hours>/all` | `sota_spots.json` |
| `.../api/alerts` | `[]` |
| any other `api2.sota.org.uk` route | 404 |
| `storage.sota.org.uk/summitslist.csv`, `www.sotadata.org.uk/summitslist.csv` | a CSV synthesized from `sota_region_W2_GC.json` (banner + header line + one row per summit, matching the real column order in `ARCHITECTURE.md`); 403 if `options.blockSotaCsv` |
| `photon.komoot.io/api/` | `photon_search.json` |
| `photon.komoot.io/reverse` | `photon_reverse.json` |
| `nominatim.openstreetmap.org/search` | `nominatim_search.json` |
| `nominatim.openstreetmap.org/reverse` | `nominatim_reverse.json` |
| `POST overpass-api.de/api/interpreter`, `POST overpass.kumi.systems/api/interpreter` | `overpass_harriman.json` if present, else `{"version":0.6,"elements":[]}` (with a console warning); the raw POST body is recorded in `mocks.overpassQueries` |
| `.../data/snapshot.js` (any origin) | served only if `options.snapshotJs` or `options.snapshotPath` is set — see below |
| anything else external | HTTP 404 + `console.warn('[mock-network] unmocked URL -> 404: ...')` on the Node side (not the page's console, so it won't fail an `e2e.js` scenario by itself) |
| `file://` and `http://127.0.0.1`/`http://localhost` requests | passed through untouched (`route.continue()`) — this is how the app's own HTML/CSS/JS actually loads |

All mocked responses include permissive CORS headers (`access-control-allow-origin: *`, etc.),
since Chromium enforces CORS on `fetch()` even against an intercepted/mocked response.

**Options** (second argument to `installMocks`):

* `options.fail` — array of substrings; any request URL containing one of them gets HTTP 503
  instead of its normal mocked response. Checked before every other route, so it works against
  any host (e.g. `fail: ['api.pota.app/location']` to force the grid fallback,
  `fail: ['api.pota.app', 'api2.sota.org.uk']` to force the snapshot-only path).
* `options.delayMs` — adds this many ms of latency before every mocked (non-passthrough) response.
* `options.blockSotaCsv` — serve 403 for the SOTA summits CSV instead of a real CSV.
* `options.snapshotJs` (a JS source string) or `options.snapshotPath` (a file path) — if either is
  set, any request whose path ends in `/data/snapshot.js` is answered with that content
  (`application/javascript`), regardless of origin/scheme. Used by the `snapshot` scenario.

**Return value**: `mocks.requests` is an array of `{method, url, status, postData?}` in request
order (every mocked or passed-through-but-intercepted request is logged; local `file://`/
`127.0.0.1` passthroughs are not, since those never reach the mock handler's response logic).
`mocks.overpassQueries` is an array of the raw Overpass POST bodies (`"data=<urlencoded query>"`
— decode with `decodeURIComponent`). `mocks.tileCount` is a live count of tile requests.

## Adding / changing fixtures

Fixtures live in `tests/fixtures/` and are **owned by other agents** (`build_fixtures.py` /
`build_overpass_fixture.py` regenerate most of them) — don't hand-edit the ones you didn't create;
regenerate via those scripts instead, or ask for a new one. If you need a new URL shape mocked:

1. Add the fixture JSON/CSV to `tests/fixtures/` (or point at an existing one).
2. Add a branch to the relevant `handlePota` / `handleSota` / route block in
   `tests/mock-network.js` — keep following the existing pattern: parse the path into `parts`,
   match on shape, return `{status, body}` (or call `fx.loadJSON(name)` / `fx.exists(name)`).
2. If it's a brand-new host, add a new `if (u.hostname === '...')` block before the final
   catch-all in `installMocks()`.
3. Re-run `node tests/e2e.js --only <affected scenario>` (or add a new scenario in `e2e.js` if
   you're testing genuinely new app behavior — follow the existing `scenario*` functions as a
   template: call `waitForAppReady(page)` first, drive the UI or call `PSM.app.*` via
   `fireAndForget()`, wait on a bounded condition, then assert with plain `throw new Error(...)`).

## Current status

As of this writing, `pota-sota-map.html` exists (built via `python3 scripts/build.py`) and the full
suite passes cleanly against it:

```
$ NODE_PATH=/home/claude/.npm-global/lib/node_modules node tests/e2e.js
PASS  loads                  530ms
PASS  search-address        2480ms
PASS  search-latlon          705ms
PASS  search-grid            559ms
PASS  search-pota-ref        702ms
PASS  search-sota-ref        734ms
PASS  park-detail            670ms
PASS  summit-detail          733ms
PASS  fallback-grid         3006ms
PASS  nfer                  2718ms
PASS  spots                  513ms
PASS  file-url               632ms
PASS  mobile                 857ms
PASS  snapshot              2914ms

PASSED: 14 passed, 0 failed, 0 skipped  (17753ms total)
```

Verified stable across repeated runs. If `pota-sota-map.html` is rebuilt (`python3 scripts/build.py`)
after `src/*.js` changes, just re-run `node tests/e2e.js` — no other setup needed.

**One finding worth flagging**: while building the `nfer` scenario against the real app, an
apparent flaky failure (`state.nfer` ending up `null`/missing) turned out to be a race in the
*scenario*, not the app: the `#radius-range` slider's own `input`/`change` listener correctly
triggers a debounced re-search (real, intended UX), and calling `PSM.app.search()` +
`PSM.app.runNfer()` immediately afterward could let that debounced re-search land *after*
`runNfer()` writes `state.nfer`, silently resetting it (a plain `search()` clears `state.nfer` at
the start of any new search cycle — reasonable behavior, since a new search invalidates the old
n-fer analysis). Confirmed via a standalone repro (`page.on('console')` timestamps across several
runs) that touching the slider before any search has ever run doesn't itself trigger a search, so
`scenarioNfer` in `tests/e2e.js` now settles 1.5 s after setting the radius, before calling
`search()` — verified race-free across repeated runs. Documented here in case another scenario
that combines the radius slider with `PSM.app.search()`/`runNfer()`/`openPark()` etc. hits the same
thing.

## Proof run (harness self-test, before `pota-sota-map.html` existed)

```
$ NODE_PATH=/home/claude/.npm-global/lib/node_modules node tests/e2e.js --app tests/standin.html --only loads
[e2e] app under test: /home/claude/pota-sota-map/tests/standin.html
[e2e] static server: http://127.0.0.1:PORT/  (serving /home/claude/pota-sota-map)
PASS  loads                 1251ms

PASSED: 1 passed, 0 failed, 0 skipped  (1251ms total)
screenshots: /home/claude/pota-sota-map/tests/out
```

`tests/out/loads.png` shows grey mock tiles filling the map, a real Leaflet marker (proving
`marker-icon.png` was mocked), a working layers control (proving `layers.png` was mocked), and a
status line reading "libs OK / fetches OK" (Leaflet/markercluster/turf/osmtogeojson all loaded as
globals from the mocked CDN, and the page's own `fetch()` calls against the mocked POTA, SOTA,
Photon and Overpass endpoints all returned 2xx).

Once `pota-sota-map.html` exists, `node tests/e2e.js` (no `--app`) runs the full suite against it.
Until then every scenario reports `SKIP ... app file not found: .../pota-sota-map.html` and the
run still exits 0 — that's expected, not a failure.
