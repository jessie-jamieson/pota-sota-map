# POTA + SOTA Near Me

A single-file, no-backend web map that shows every **Parks on the Air** park and **Summits on the Air**
summit near an address, a lat/lon, a Maidenhead grid square, or a POTA/SOTA reference — with the full
record for each one (reference, name, type, state, grid, coordinates, access and activation methods,
agencies, website, comments, activation stats, leaderboard, an approximate street address, and
directions links) — and a **multi-activation finder** that looks for spots where several references
overlap ("2-fers", "3-fers", summit-in-park combos).

```
pota-sota-map.html      ← the whole app; open it in a browser, or host it anywhere static
data/snapshot.js        ← optional: pre-baked park/summit data (see "Snapshot" below)
```

## Quick start

1. Open `pota-sota-map.html` in Chrome, Firefox, Safari or Edge (double-click works; no server needed).
2. Allow location access, or type something in the search box:
   * an address or place — `Harriman State Park, NY`
   * coordinates — `41.24, -74.10`, `41°12'30"N 74°06'W`, `N41.2 W74.1`
   * a grid square — `FN21ve`
   * a POTA reference — `US-2069` (legacy `K-2069` also works)
   * a SOTA reference — `W2/GC-001`
3. Drag the radius slider (1–100 mi; switch to km with the units button). Results are sorted by distance.
4. Click any park or summit (list or map) for the full detail panel. **Show on map**, **Copy reference**,
   **Copy coordinates**, and the "Open in" links (POTA/SOTA pages, Google/Apple directions, OSM) are
   at the top of the panel. Click a park and its OpenStreetMap boundary is highlighted on the map for
   as long as the panel is open — the *Boundary* line under "Park information" says how the shape was
   matched and how confident that match is, with a **Zoom to boundary** button next to it. Parks OSM
   has not mapped (or has not linked to their POTA reference) simply show the reference point.
5. Press **Find multi-activation spots** to analyse OpenStreetMap park boundaries within the search
   radius (capped at 25 mi / 40 km). Overlap zones appear on the map in purple and in the **Multi** tab.
6. Tick **Live spots** to overlay activators currently on the air (POTA and SOTA spots, refreshed
   every 60 s).

The URL hash keeps `#lat,lon,radiusKm`, so a search can be bookmarked or shared
(e.g. `pota-sota-map.html#41.24000,-74.10000,40.2`). Units, radius, basemap and layer choices are
remembered in the browser.

### Hosting it (recommended for phone use)

Any static host works: GitHub Pages, Netlify, an S3 bucket, or `python3 -m http.server` in the folder.
Hosting gives you HTTPS, which is required for browser geolocation on most phones (Chrome/Safari refuse
`getCurrentPosition` on plain `http://` non-localhost pages; `file://` is fine on desktop).

## What the app talks to

Everything runs in the browser; there is no server of ours in the loop.

| Purpose | Service | Notes |
|---|---|---|
| POTA parks | `api.pota.app` | per-state lists (`/location/parks/US-NY`), grid-cell lists (`/park/grid/FN21`), park detail, stats, activations, leaderboard, spots, lookup |
| SOTA summits | `api2.sota.org.uk` | associations → regions → summits; summit detail; spots. Falls back to the bulk `summitslist.csv` |
| Geocoding | Photon (komoot) → Nominatim (OSM) | Nominatim is throttled to 1 request/second as their policy requires |
| Boundaries | Overpass API (`overpass-api.de`, mirror `overpass.kumi.systems`) | one query per analysis (cached 24 h); one small query per park whose detail panel you open (cached 7 days) |
| Basemaps | OpenStreetMap, OpenTopoMap, USGS Topo, Esri World Imagery | switch with the Basemap menu |

Responses are cached in IndexedDB (state lists 24 h, summit regions 7 days, park details 24 h,
reverse-geocoded addresses 30 days, Overpass 24 h), so repeat searches are fast and polite.

**Loading cascade.** POTA: bundled snapshot → state lists → grid cells. SOTA: bundled snapshot →
association/region API → bulk CSV. The status line and the **Log** button (bottom-left) always say
which source was used and why a fallback happened. Both POTA and SOTA APIs are undocumented and have
no published terms; the app keeps concurrency low (3 requests at a time), caches aggressively, and
never polls faster than once a minute.

### Snapshot (optional, recommended)

`scripts/build_snapshot.py` downloads the official bulk files (`all_parks_ext.csv` from POTA and
`summitslist.csv` from SOTA), filters them, and writes `data/snapshot.js`. If that file sits next to
`pota-sota-map.html`, searches are instant, work without API access (only tiles need the network), and
stats are filled in from the live API when it is reachable.

```bash
python3 scripts/build_snapshot.py                        # active US parks + every W* SOTA association
python3 scripts/build_snapshot.py --programs US VE --sota-assoc-prefix W VE   # add Canada
python3 scripts/build_snapshot.py --bbox 40.4 -79.9 45.1 -71.7                 # just a region
python3 scripts/build_snapshot.py --offline               # rebuild from the cached download
```

Python 3.9+, standard library only. Re-run it every few weeks; the header comment in the file shows
when it was generated. Options: `--include-inactive-parks`, `--include-retired`, `--format json`,
`--pota-csv/--sota-csv` (local files), `--out`.

## Multi-activation ("n-fer") finder — how it works and what to trust

POTA rules allow logging several parks from one spot only where their boundaries actually overlap,
and POTA publishes no boundary data. The finder therefore builds its own picture from OpenStreetMap:

1. One Overpass query fetches, for the analysis area, every `boundary=protected_area`,
   `boundary=national_park`, `leisure=nature_reserve`, larger `leisure=park` feature, long-distance
   hiking route (`route=hiking` with `network=nwn|iwn`) and anything tagged with the POTA-endorsed
   `communication:amateur_radio:pota=<reference>` tag.
2. OSM features are matched to POTA parks: by that tag (confidence 100 %); by the park's reference
   point lying inside the polygon with a matching name (85 %); by name similarity within 3 km (60 %);
   trails by name, e.g. OSM "Appalachian Trail" ↔ POTA "Appalachian National Scenic Trail" (75 %).
3. Matched polygons are intersected pairwise (Turf.js). Overlaps under 0.2 ha are discarded as shared
   borders. Trails are buffered 20 m and intersected with the parks they cross.
4. SOTA summits are tested against every matched polygon: **inside** or within 150 m of an edge
   (worth checking, since a SOTA activation zone extends 25 m vertically below the summit).

The **single-park boundary** drawn under a detail panel uses exactly the same matching, so the two
always agree — and it carries the same caveats: an OSM shape may be out of date, drawn differently
from the official map, or simply missing. It is one small Overpass query per park (the reference tag
looked up worldwide, plus protected areas within 15 km of the reference point), cached for 7 days,
and skipped entirely when the multi-activation analysis has already matched that park.

Every zone lists its references, the confidence of the weakest match, and the area. Treat results as
**candidates**: OSM boundaries can be out of date or drawn differently from the official map, and OSM
tagging of POTA references is still being filled in by volunteers (unmatched parks are listed in the
log). Verify against the official park map before you activate, and remember POTA requires a
separate log per park.

## Marking your activations

The sidebar's **My activations** section (collapsed by default, just above the *Find
multi-activation spots* button) tracks which POTA parks and SOTA summits *you* have activated —
and, secondarily, hunted — so the map and the lists can show your own progress instead of just the
community totals.

There are three ways to mark something:

1. **Toggle it by hand.** Open a park's or summit's detail panel and click **Mark as activated** /
   **Unmark activated**. The detail panel also shows a one-line summary of what it knows about
   your history with that reference.
2. **Import a log file.** Choose a file with **Import log**, or paste text into the box and press
   **Import**. The format is auto-detected:
   * **ADIF** (`.adi`/`.adif`, or any text containing `<EOR>` records) — reads `MY_POTA_REF` /
     `MY_SIG`+`MY_SIG_INFO` / `MY_SOTA_REF` for your own activations, and `POTA_REF` /
     `SIG`+`SIG_INFO` / `SOTA_REF` for hunted contacts. Legacy `K-####` park references are
     normalised to `US-####`.
   * **POTA park-list CSV** (the "Park List" export from pota.app, with a `my_activations` column
     and optionally `my_hunted_qsos`).
   * **SOTA CSV** (the V2 activator/chaser log export from SOTAdata) — a row with `MySummit`
     filled in is one of your activations; a blank `MySummit` with `OtherSummit` set is a hunted
     (chaser) contact.
   * **Our own JSON export** (see below) — for moving your log between browsers or devices.
   * **A plain list of references** — paste something like `US-2069, W2/GC-001, K-4556` and every
     recognised reference is marked activated.
3. **Re-import.** Importing again never deletes anything: matching counters are merged by taking
   the maximum of each, the earliest first-activation date and the latest last-activation date —
   so it is safe to import overlapping logs, or the same file twice.

**Validity thresholds.** An import only counts a day as an activation once it clears the same bar
the programs themselves use: **10 QSOs** at one POTA reference on one UTC date, or **4 QSOs** at
one SOTA summit on one UTC date. Fewer QSOs than that on a given day still shows as *attempted*,
not *activated* — handy for remembering a trip that fell just short.

**Storage.** Your marks live only in this browser's `localStorage` (key `psm.mylog.v1`) — nothing
is ever sent anywhere. That means a different browser, a different device, or a private window
starts empty. Use **Export JSON** to save (and, where available, copy to the clipboard) a
`my-activations.json` file, and **Import log** on another device to bring it across — re-importing
your own export merges just like any other import, so it is also a safe way to back it up. **Clear**
(after a confirmation prompt) empties the log in this browser for good.

Once something is marked, the **Mine** filter (next to the other list filters) narrows both the
map and the lists to only what you have activated, or only what you have not, and list rows
carry a small badge (✓ activated / attempted / hunted) at a glance.

## Development

```
src/                 readable modules (00-util … 90-app) + index.html + app.css
scripts/build.py     inlines src/ into pota-sota-map.html          → python3 scripts/build.py
scripts/build_snapshot.py                                            → data/snapshot.js
tests/data.test.js   unit tests for geocode/pota/sota/spots (Node)   → node tests/data.test.js
tests/nfer.test.js   unit tests for the overlap engine               → node tests/nfer.test.js
tests/boundary.test.js  unit tests for the single-park boundary     → node tests/boundary.test.js
tests/snapshot.test.sh                                               → bash tests/snapshot.test.sh
tests/e2e.js         Playwright browser scenarios with a fully mocked network → node tests/e2e.js
ARCHITECTURE.md      module contracts, data shapes, API facts, UI hooks
```

`src/index.html` also runs unbuilt (it references the individual files), which is handy while editing.
The e2e suite needs `playwright` (`npm i -g playwright && npx playwright install chromium`); it serves
the built file, intercepts every external host (CDNs, tiles, POTA, SOTA, geocoders, Overpass) and
replays fixtures from `tests/fixtures/`, so it runs offline and never touches the real services. See
`tests/README-tests.md`.

Libraries (loaded from cdnjs/jsdelivr at runtime): Leaflet 1.9.4, Leaflet.markercluster 1.5.3,
Turf.js 7.4.0, osmtogeojson 3.0.0-beta.5. Without network access to the CDNs the page still loads and
explains what is missing.

## Known limitations

* **CORS is unverified for `api2.sota.org.uk` and `storage.sota.org.uk`.** Every sign says both work
  from browsers (potamap.us calls the SOTA API from client JS), but this was built in a sandbox with
  no outbound network. If a browser blocks them you will see "SOTA: 0 summits" and a log line saying
  each source failed; the fix is the snapshot above.
* Non-US searches use POTA's grid-cell endpoint, which carries no activation statistics until you
  open a park's detail panel.
* The multi-activation finder is only as good as OpenStreetMap coverage in your area; large city
  bounding boxes can take 30–60 s on Overpass and are capped at 40 km.
* Live SOTA spots are drawn only for summits that are in the current results (the SOTA spot feed has
  no coordinates).
* Photon/Nominatim/OSM tiles are community services: this app is fine for personal use; do not wire
  it to anything that hammers them.

## Credits and attribution

Map data © OpenStreetMap contributors (ODbL). Park data © Parks on the Air®. Summit data © Summits on
the Air (SOTA). Geocoding by Photon (komoot) and Nominatim. Topographic tiles by OpenTopoMap
(CC-BY-SA) and USGS; imagery by Esri. Not affiliated with POTA or SOTA.
