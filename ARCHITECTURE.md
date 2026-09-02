# POTA + SOTA Near-Me Map — Architecture & Module Contracts

Single-file browser app (Leaflet, plain ES2019 JS, no build framework) that shows Parks on the Air (POTA)
parks and Summits on the Air (SOTA) summits near an address / lat,lon / Maidenhead grid / POTA or SOTA
reference, with full detail panels, and detects places where several references can be activated
from one spot ("n-fers").

Deliverable: `pota-sota-map.html` (built by `scripts/build.py` from `src/`). Works when opened from
disk (`file://`) or hosted statically (GitHub Pages, `python -m http.server`). Optional `data/snapshot.js`
(built by `scripts/build_snapshot.py`) makes park/summit loading instant and independent of the APIs.

## Runtime facts that shape the design (verified 2026-08-31, see research notes)

* **POTA API** `https://api.pota.app` (undocumented, used from browsers by third-party sites, so CORS is
  believed open):
  * `GET /park/{ref}` → full detail object (fields: parkId, reference, name, latitude, longitude, grid4,
    grid6, parktypeId, active, parkComments, accessibility, sensitivity, accessMethods (CSV string),
    activationMethods (CSV string), agencies, agencyURLs, parkURLs, website, parktypeDesc, locationDesc
    (may be `"US-NJ,US-NY"`), locationName, entityId, entityName, referencePrefix, entityDeleted,
    firstActivator, firstActivationDate). Unknown ref → HTTP 200 with body `null`.
    NOTE: detail `name` is the bare name ("Harriman"); the list endpoints give the full name
    ("Harriman State Park"). Display = list name, or `name + " " + parktypeDesc`.
  * `GET /location/parks/{US-XX}` → array `{reference, name, latitude, longitude, grid, locationDesc,
    attempts, activations, qsos}` — every park in a state/province. ~100 KB for NY.
  * `GET /park/grid/{GRID4}` → array `{reference, name, latitude, longitude}` for a 2°×1° Maidenhead cell.
  * `GET /park/stats/{ref}` → `{reference, attempts, activations, contacts}`.
  * `GET /park/activations/{ref}?count=N|all` → `[{activeCallsign, qso_date "YYYYMMDD", totalQSOs, qsosCW,
    qsosDATA, qsosPHONE, locationDesc}]`.
  * `GET /park/leaderboard/{ref}?count=5` → `{activations:[{callsign,count}], activator_qsos:[...],
    hunter_qsos:[...]}`.
  * `GET /spot/activator` → live spots `{spotId, activator, frequency (kHz string), mode, reference,
    parkName, spotTime, spotter, comments, source, invalid, name, locationDesc, grid4, grid6, latitude,
    longitude, count, expire}`.
  * `GET /lookup?search=text` → `[{type:"park", id, display, value}]`.
  * Bulk CSV `https://pota.app/all_parks_ext.csv` (reference,name,active,entityId,locationDesc,latitude,
    longitude,grid) — CORS unknown → only used by the server-side snapshot script.
  * Unmatched routes return HTTP 403; matched-but-empty returns 200 `null`.
* **SOTA API** `https://api2.sota.org.uk` (CORS believed open — potamap.us calls it from the browser):
  * `GET /api/associations` → `[{associationCode, associationName, minLat, maxLat, minLong, maxLong, ...}]`
  * `GET /api/associations/{CODE}` → `{..., regions:[{regionCode, regionName, ...}]}`
  * `GET /api/regions/{ASSOC}/{REGION}` → `{..., summits:[{summitCode, name, altM, altFt, latitude,
    longitude, locator, points, bonusPoints?, validFrom, validTo, activationCount, activationDate,
    activationCall, ...}]}` (several fields may be null here)
  * `GET /api/summits/{ASSOC}/{REGION-NNN}` → full summit `{summitCode, name, shortCode, altM, altFt,
    latitude, longitude, locator, points, bonusPoints, validFrom, validTo, activationCount, activationDate,
    activationCall, associationName, regionName, valid, ...}`
  * `GET /api/spots/{hours}/all`, `GET /api/alerts`
  * No "near" endpoint. Bulk CSV `https://storage.sota.org.uk/summitslist.csv` (redirect target of
    `https://www.sotadata.org.uk/summitslist.csv`): line 1 is `SOTA Summits List (Date=DD/MM/YYYY)`, line 2
    is the header `SummitCode,AssociationName,RegionName,SummitName,AltM,AltFt,GridRef1,GridRef2,Longitude,
    Latitude,Points,BonusPoints,ValidFrom,ValidTo,ActivationCount,ActivationDate,ActivationCall`; dates are
    `DD/MM/YYYY`; `ValidTo=31/12/2099` means "no expiry"; ~150k rows (~20 MB).
  * Activation zone = within 25 m vertical of the summit (SOTA General Rules 3.5). A summit is active when
    `validFrom <= today <= validTo`.
* **Geocoding**: Photon `https://photon.komoot.io/api/?q=&limit=&lat=&lon=` and
  `https://photon.komoot.io/reverse?lat=&lon=` (GeoJSON, CORS open). Fallback Nominatim
  `https://nominatim.openstreetmap.org/search?q=&format=jsonv2&limit=5` and
  `/reverse?lat=&lon=&format=jsonv2` (max 1 req/s, never on keystrokes, show attribution).
* **Boundaries**: OSM via Overpass (`https://overpass-api.de/api/interpreter`, mirror
  `https://overpass.kumi.systems/api/interpreter`, CORS open, POST form `data=<query>`). OSM features may
  carry `communication:amateur_radio:pota=<REF>` (POTA-blessed tag, Jan 2026) — a direct feature↔park link.
  Otherwise match `boundary=protected_area|national_park`, `leisure=nature_reserve|park`, hiking route
  relations (`route=hiking`, `network=nwn|iwn`) by point-in-polygon + name similarity.
* **Basemaps**: OSM `https://tile.openstreetmap.org/{z}/{x}/{y}.png` (max 19), OpenTopoMap
  `https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png` (max 17), USGS Topo
  `https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}` (US, max 16
  reliable), Esri World Imagery
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`.
* **Libraries (CDN)**: Leaflet 1.9.4, Leaflet.markercluster 1.5.3, Turf.js 7.4.0 (global `turf`) from
  cdnjs; osmtogeojson 3.0.0-beta.5 (global `osmtogeojson`) from jsdelivr. Local copies for offline tests
  live in `dev/vendor/` (note: `turf.min.js` sits in a `"type":"module"` package dir — in Node load it
  with `new Function('module','exports',src)` or copy it elsewhere).

## Source layout

```
src/
  index.html          page shell + CSS + <script> includes (build inlines everything)
  app.css
  00-util.js          PSM namespace: geometry, Maidenhead, parsing, fetch, cache, formatting, state tables
  10-geocode.js       PSM.geocode: forward/reverse, input classification
  20-pota.js          PSM.pota: park loading cascade + detail endpoints
  30-sota.js          PSM.sota: summit loading cascade + detail endpoints
  40-nfer.js          PSM.nfer: Overpass boundaries + overlap analysis (pure data; no DOM/Leaflet)
  50-spots.js         PSM.spots: live POTA/SOTA spots
  55-mylog.js         PSM.mylog: the operator's own activation / hunter log (pure data; no DOM)
  60-map.js           PSM.mapui: Leaflet map, layers, markers, popups
  70-panel.js         PSM.panel: sidebar lists + detail panels (DOM)
  90-app.js           wiring, state, URL hash, geolocation, search flow
scripts/build.py          -> pota-sota-map.html (inlines src/*)
scripts/build_snapshot.py -> data/snapshot.js (optional; POTA+SOTA bulk CSV → compact JS)
tests/                    Playwright e2e with mocked network + fixtures
dev/vendor/               local copies of CDN libs for offline testing
```

All modules attach to the single global `window.PSM` (created in `00-util.js`). Modules must not
depend on load order beyond `00-util.js` being first; `90-app.js` is last.

## Shared data shapes

```js
// Park (list-level; from snapshot / state list / grid / CSV)
{ ref:"US-2069", name:"Harriman State Park", lat:41.1753, lon:-74.1783, grid:"FN21ve"|null,
  loc:"US-NY"|"US-NJ,US-NY"|null, active:1|0|null, attempts:null|n, activations:null|n, qsos:null|n,
  distKm:number /* set by app */ }

// Summit (list-level)
{ code:"W2/GC-001", name:"Slide Mountain", lat, lon, altM, altFt, points, bonus, validFrom:"YYYY-MM-DD",
  validTo:"YYYY-MM-DD", actCount:null|n, actDate:null|"YYYY-MM-DD", actCall:null|str, locator:null|str,
  assoc:"W2", region:"GC", assocName:null|str, regionName:null|str, distKm:number }

// Search center
{ lat, lon, label:"…", source:"geocode"|"latlon"|"grid"|"pota"|"sota"|"geolocation" }
```

## `00-util.js` — `PSM` core API (implemented by the orchestrator)

```js
PSM.haversineKm(lat1, lon1, lat2, lon2) -> km
PSM.bboxAround(lat, lon, radiusKm) -> {south, west, north, east}
PSM.bboxesIntersect(a, b) -> bool            // both {south,west,north,east}
PSM.gridToLatLon("FN21ve") -> {lat, lon}      // centre of the square; 4/6/8 chars
PSM.latLonToGrid(lat, lon, len=6) -> "FN21ve"
PSM.grid4CellsForBbox(bbox) -> ["FN21","FN31",...]
PSM.parseLatLon(text) -> {lat, lon} | null   // "41.2, -74.1", "41.2 -74.1", "41.2N 74.1W", "41°12'N 74°06'W"
PSM.isGrid(text), PSM.isPotaRef(text), PSM.isSotaRef(text)
PSM.fetchJSON(url, {timeoutMs=20000, retries=1, method, body, headers}) -> Promise<any>  // throws PSM.FetchError {status}
PSM.fetchText(url, opts) -> Promise<string>
PSM.cache.get(key) -> Promise<{value, ts}|null>          // IndexedDB, falls back to memory
PSM.cache.set(key, value) -> Promise<void>
PSM.cache.getFresh(key, maxAgeMs) -> Promise<value|null>
PSM.cache.clear() -> Promise<void>
PSM.memo(key, maxAgeMs, producerFn) -> Promise<value>    // cache-through helper
PSM.fmt.dist(km, units)  // "3.2 mi" | "5.1 km"   units = "mi"|"km"
PSM.fmt.elev(m, units)   // "1,234 ft" | "376 m"
PSM.fmt.date(str)        // tolerant: YYYYMMDD, YYYY-MM-DD, DD/MM/YYYY, ISO -> "2026-08-31"
PSM.fmt.num(n)
PSM.esc(str)             // HTML escape
PSM.normalizeName(str)   // lower-case, strip punctuation/stop-words for fuzzy matching
PSM.nameSimilarity(a, b) -> 0..1 (token Jaccard on normalized names)
PSM.parseCSV(text) -> string[][]   // RFC4180-ish, handles quotes
PSM.US_STATES  // { "US-NY": {name:"New York", bbox:{south,west,north,east}}, ... } bbox padded ~0.5°
PSM.stateCodeForName("New York") -> "US-NY" | null
PSM.log(msg, level="info")  // appends to status log (UI subscribes via PSM.onLog)
PSM.settings  // {units:"mi"|"km", radiusKm, ...} persisted to localStorage
PSM.pLimit(n) -> limiter(fn) for bounded concurrency
```

## `10-geocode.js` — `PSM.geocode`

```js
PSM.geocode.classify(text) -> {kind:"latlon"|"grid"|"pota"|"sota"|"text", value}
PSM.geocode.forward(text, {near:{lat,lon}}) -> Promise<{lat, lon, label, source:"photon"|"nominatim", raw}>  // throws Error("No results for …")
PSM.geocode.reverse(lat, lon) -> Promise<{label, parts:{house, road, city, county, state, postcode, country}, source}>
        // Photon reverse → Nominatim reverse fallback; cached 30 d under key "rev:<lat4>,<lon4>"; label is a one-line address
PSM.geocode.resolve(text, {near}) -> Promise<Center>
        // latlon/grid → direct; pota ref → PSM.pota.getPark(ref) → {lat,lon,label:name,source:"pota",ref};
        // sota ref → PSM.sota.getSummit(code) → {lat,lon,label:name,source:"sota",code}; text → forward()
```
Photon: `https://photon.komoot.io/api/?q=<q>&limit=5&lang=en[&lat=&lon=]`; label = name + city/state/country parts.
Nominatim: `https://nominatim.openstreetmap.org/search?q=<q>&format=jsonv2&limit=5&addressdetails=1`
(throttled ≥ 1.1 s between calls, module-level), reverse `…/reverse?lat=&lon=&format=jsonv2&zoom=17&addressdetails=1`.

## `20-pota.js` — `PSM.pota`

```js
PSM.pota.loadNear(center, radiusKm, {onProgress, signal}) -> Promise<{parks:[Park], source:"snapshot"|"state"|"grid", sources:[..], warnings:[..]}>
   // cascade: window.PSM_SNAPSHOT.pota (if present) → /location/parks/{US-XX} for PSM.locationsForBbox(bbox) (cache 24 h,
   // concurrency 3) → /park/grid/{cell} for PSM.grid4CellsForBbox(bbox) (cache 24 h). Always returns parks with distKm set,
   // filtered to ≤ radiusKm, sorted by distKm, de-duplicated by ref. When the base came from the snapshot or grid, still try
   // the state lists to fill attempts/activations/qsos (best effort, never fatal).
PSM.pota.getPark(ref) -> Promise<detail|null>                 // GET /park/{ref}, cache 24 h; null for unknown refs
PSM.pota.getStats(ref) -> Promise<{attempts,activations,contacts}|null>   // cache 6 h
PSM.pota.getActivations(ref, count=10) -> Promise<[...]>     // cache 6 h
PSM.pota.getLeaderboard(ref, count=5) -> Promise<{activations,activator_qsos,hunter_qsos}|null>   // cache 24 h
PSM.pota.lookup(text) -> Promise<[{type,id,display,value}]>  // GET /lookup?search=, cache 24 h
PSM.pota.searchAll(name) -> Promise<[Park]>                  // snapshot name search when available, else lookup() +
                                                             // getPark() for the top 5 hits (used by n-fer trail matching)
PSM.pota.parkUrl(ref) -> "https://pota.app/#/park/US-2069"
PSM.pota.displayName(detail) -> "Harriman State Park"        // name + parktypeDesc unless name already ends with it
PSM.pota.toPark(rowFromAnySource) -> Park                    // normaliser used by all paths
```

## `30-sota.js` — `PSM.sota`

```js
PSM.sota.loadNear(center, radiusKm, {onProgress, signal, includeRetired:false}) -> Promise<{summits:[Summit], source:"snapshot"|"api"|"csv", warnings}>
   // cascade: window.PSM_SNAPSHOT.sota → GET /api/associations (cache 7 d) → keep associations whose
   // {minLat,maxLat,minLong,maxLong} intersects the search bbox → GET /api/associations/{CODE} (cache 7 d) → regions →
   // GET /api/regions/{A}/{R} (cache 7 d, concurrency 3, progress per region) → filter by distance/validity.
   // If the API path yields an error for every association, fall back to the CSV (cache the parsed compact rows 7 d).
PSM.sota.getSummit(code) -> Promise<detail|null>             // GET /api/summits/{ASSOC}/{REGION-NNN}, cache 24 h
PSM.sota.summitUrls(code) -> {sotlas:"https://sotl.as/summits/W2/GC-001", sotadata:"https://www.sotadata.org.uk/en/summit/W2/GC-001"}
PSM.sota.toSummit(rowFromAnySource) -> Summit                // normaliser (API region row, API detail, CSV row, snapshot row)
PSM.sota.isValid(summit, dateISO=today) -> bool
```

## `50-spots.js` — `PSM.spots`

```js
PSM.spots.fetchAll() -> Promise<{pota:[Spot], sota:[Spot], fetchedAt}>   // POTA GET /spot/activator; SOTA GET /api/spots/1/all; each cached 60 s
Spot = {program:"pota"|"sota", ref, name, activator, freqKHz:number|null, mode, timeISO, spotter, comments, lat, lon, loc}
       // SOTA spots have no coordinates: lat/lon null; summitCode may arrive without the association prefix → prepend associationCode
PSM.spots.start(intervalMs, onUpdate) / PSM.spots.stop()                  // polling helper
```

## `55-mylog.js` — `PSM.mylog`

Pure data (no DOM, no Leaflet): which POTA parks and SOTA summits *this* user has activated,
attempted, or hunted. Persisted to `localStorage` under `psm.mylog.v1` (an in-memory copy keeps
private-mode browsers working for the session); loaded once at script-load time from whatever is
already stored.

```js
Entry = { activated:bool, activations:n /* valid days */, attempts:n /* distinct UTC days with
          any QSOs */, qsos:n, first:"YYYY-MM-DD"|null, last:"YYYY-MM-DD"|null,
          hunted:{qsos:n, last:"YYYY-MM-DD"|null}|null, source:"manual"|"refs"|"json"|"sota-csv"|
          "pota-csv"|"adif", note:"" }

PSM.mylog.get(kind, id) -> Entry|null                    // kind: "pota"|"sota"; id is normalised internally
PSM.mylog.isActivated(kind, id) -> bool
PSM.mylog.isAttempted(kind, id) -> bool                  // attempts > 0 and not activated
PSM.mylog.isHunted(kind, id) -> bool
PSM.mylog.mark(kind, id, {date, note}) -> Entry          // manual mark; keeps any imported counters, only the flag/date/note change
PSM.mylog.unmark(kind, id) -> bool                       // drops the entry if nothing was ever imported for it, else just clears the flag
PSM.mylog.all() -> {version, updated, pota:{ref:Entry}, sota:{code:Entry}}
PSM.mylog.exportJSON() -> string                         // JSON.stringify(all(), null, 2)
PSM.mylog.clear()
PSM.mylog.stats() -> {pota, sota, total, attempted:{pota,sota}, hunted:{pota,sota}}
PSM.mylog.onChange(fn) -> unsubscribe()                  // fn(reason, stats()); reason: "mark"|"unmark"|"import"|"clear"
PSM.mylog.importText(text, {filename}) -> {
  format: "adif"|"pota-csv"|"sota-csv"|"json"|"refs"|null,
  added:{pota,sota}, updated:{pota,sota},   // per reference, counted once per import regardless of how many QSOs it carried;
                                             // a delta that is hunted-only (no activation/attempt/QSO count of its own) still
                                             // counts here — it is new information about a reference, same as an activation
  hunted:{pota,sota}, qsos:n, warnings:[str]
}
PSM.mylog.describeImport(result) -> string                // "Imported ADIF: 4 parks (4 new), 2 summits (2 new), 3 hunted, 23 QSOs"
PSM.mylog.summaryText() -> string                          // "14 parks · 3 summits marked · 5 hunted" | "Nothing marked yet — …"
PSM.mylog.describeEntry(kind, id) -> string                // "You: activated 3× (first …, last …) · 41 QSOs · hunted 5 QSOs" | ""
PSM.mylog.detect(text, filename) -> format|null            // exported for tests
PSM.mylog.parseADIF(text) -> [{date, myPota:[ref], mySota:ref|null, pota:[ref], sota:ref|null, call}]  // exported for tests
PSM.mylog.POTA_MIN_QSOS  // 10 — QSOs at one POTA ref on one UTC date to count as a valid activation
PSM.mylog.SOTA_MIN_QSOS  // 4  — QSOs at one SOTA summit on one UTC date to count as a valid activation
```

Import formats, auto-detected from the text (and filename extension for ADIF): **ADIF** (`.adi`/
`.adif`, or text containing `<EOR>`/`<EOH>`; tags case-insensitive, a typed length like
`<QSO_DATE:8:D>` is tolerated; `MY_POTA_REF`/`POTA_REF` are comma/space lists with an optional
`@US-XX` location suffix per item; `MY_SIG`/`SIG` = `"POTA"` + `MY_SIG_INFO`/`SIG_INFO`, or
`"SOTA"` + the same, is equivalent to the dedicated ref field; `K-####` normalises to `US-####`);
**POTA park-list CSV** (header row anywhere in the first 10 lines with both `reference` and
`my_activations` columns; also reads `my_attempts`, `my_qsos`/`my_activator_qsos`,
`my_hunted_qsos`/`my_hunter_qsos`); **SOTA CSV** (lines starting `V2,` — `MySummit` (column 3) is
an activation, date (column 4) is `DD/MM/YY` or `DD/MM/YYYY`; a non-blank `OtherSummit` (column 9)
is hunted); **our own JSON export** (merges); a **plain list of references** (any token matching a
POTA or SOTA reference marks it activated, source `"refs"`).

Merge rules — within one import, per-reference QSOs are aggregated by UTC day first (so multiple
QSO records on the same day combine before the validity threshold is checked); across imports
(including a re-import of the same file), every counter takes the **maximum**, `first` takes the
**earliest**, `last` takes the **latest**, and `activated` is **true if either side says so** — a
later, poorer import can never un-activate or shrink a reference. Source provenance follows a
fixed precedence, `manual < refs < json < sota-csv < pota-csv < adif`, so a richer import is
recorded as the source even if a poorer one arrives later. `mark()`/`unmark()` never touch
imported counters — only the activated flag (and, for `mark()`, `first`/`last`/`note`).

## `40-nfer.js` — `PSM.nfer` contract (built by an agent)

Pure-data module: no DOM, no Leaflet. Uses `turf` and `osmtogeojson` globals, `PSM.fetchText/fetchJSON`,
`PSM.cache`, `PSM.haversineKm`, `PSM.nameSimilarity`, `PSM.normalizeName`, `PSM.log`.

```js
PSM.nfer.analyze({
  center: {lat, lon}, radiusKm, bbox: {south,west,north,east},   // analysis area (app caps radius ≤ 40 km)
  parks:   [Park],            // POTA parks in the area (list-level shape above)
  summits: [Summit],          // SOTA summits in the area
  allParksLookup: async (name) => [Park]   // optional: search the full POTA list (snapshot or /lookup API)
                                           // for trails/parks whose reference point lies outside the area
  onProgress: (msg, fraction) => void,
  signal: AbortSignal (optional)
}) -> Promise<{
  boundaries: FeatureCollection,   // one Feature per matched OSM feature: properties {osmId, osmType, name,
                                   //   refs:["US-2069"], matchKind:"tag"|"point"|"name"|"trail", confidence:0..1,
                                   //   kind:"area"|"trail", tags:{...}}
  zones: FeatureCollection,        // overlap polygons: properties {refs:[...], names:[...], count, kind:
                                   //   "park-park"|"trail-park"|"park-park-trail", areaHa, confidence,
                                   //   summits:["W2/GC-001"] (summits inside the zone, if any)}
  summitCombos: [{ code, name, lat, lon, refs:[...], names:[...], inside:true|false, distM, confidence }],
  unmatchedParks: ["US-1234", ...],   // parks in area with no boundary found
  unmatchedFeatures: [{osmId, name, tags}],  // named protected areas with no POTA match (info only)
  stats: {osmFeatures, matched, zones, combos, elapsedMs, errors:[...],
          source:"cache"|"none"|<the host that answered, e.g. "overpass-api.de"|"overpass.kumi.systems">}
}>
PSM.nfer.buildOverpassQuery(bbox) -> string   // exported for tests
PSM.nfer.matchFeaturesToParks(features, parks, opts) -> [...]   // exported for tests

// --- one park's boundary (drawn while its detail panel is open) ---
PSM.nfer.buildParkQuery(park) -> string       // exported for tests
   // [out:json][timeout:30]; union of (a) the reference tag looked up GLOBALLY — exact
   // `nwr["communication:amateur_radio:pota"="US-2069"]` plus the multi-value form
   // `nwr[...~"(^|;)US-2069(;|$)"]` — and (b) `(around:15000,lat,lon)` sweeps of
   // way/relation boundary=protected_area|national_park, way/relation leisure=nature_reserve,
   // relation leisure=park, way leisure=park;  ends `out tags geom;`
PSM.nfer.parkBoundary(park, {signal}) -> Promise<{
     fc,                       // FeatureCollection: EVERY polygon/line matched to this ref
                               //   (multi-unit parks), properties as in `boundaries` above
     matchKind, confidence,    // the best match of the set ("tag" 1.0 > "trail" > "point" > "name")
     name,                     // the OSM name of that best match
     source                    // "cache" | the host that answered
   } | null>                   // null: nothing matched, or the park has no coordinates
   // One request per park, memoised under `overpass:park:<REF>` for 7 days (an abort never
   // caches anything). Matching is matchFeaturesToParks(features, [park], {}) filtered to this
   // ref, so a detail-panel boundary and an analysis boundary always agree. Geometry is
   // simplified for display (turf.simplify, tol 0.00008) only when the set exceeds ~8000 vertices.
PSM.nfer.boundaryFromAnalysis(ref, nferResult) -> same shape (source:"analysis") | null
   // Synchronous, network-free shortcut over a finished analyze() result; the app tries it first.
```
Rules of thumb: dedupe overlap zones by ref-set; drop slivers < 0.2 ha (shared borders); trails are
buffered 20 m before intersection; summit "inside" uses point-in-polygon, "near" = within 150 m of an
edge; simplify large polygons (tolerance ≈ 0.00005°) before intersections; cache Overpass responses
24 h keyed by rounded bbox; try mirrors on 429/504/network error; never throw on partial failure —
return what you have plus `stats.errors`.

## `scripts/build_snapshot.py` — `data/snapshot.js` (built by an agent)

```
python3 scripts/build_snapshot.py [--programs US VE] [--sota-assoc-prefix W VE] [--out data/snapshot.js]
```
Downloads `https://pota.app/all_parks_ext.csv` and `https://storage.sota.org.uk/summitslist.csv`, filters,
writes:
```js
window.PSM_SNAPSHOT = {
  generated: "2026-08-31T14:00:00Z",
  pota: { columns: ["ref","name","lat","lon","grid","loc","active"], rows: [[...], ...] },
  sota: { columns: ["code","name","lat","lon","altM","altFt","points","bonus","validFrom","validTo",
                    "actCount","actDate","actCall","assocName","regionName"], rows: [[...], ...] }
};
```
Dates ISO `YYYY-MM-DD`; retired summits (validTo < today) excluded unless `--include-retired`; numbers as
numbers; rows sorted by ref/code. The app loads it with
`<script src="data/snapshot.js" onerror="…"></script>` (works from `file://` too).

## UI contract (element ids + test hooks) — for tests

```
#search-input   text input (address / lat,lon / grid / POTA or SOTA ref)      #search-btn   button
#locate-btn     "use my location"                                              #radius-range input[type=range] (value in current units)
#radius-value   span showing "25 mi"                                           #units-toggle button toggling mi/km
#toggle-pota #toggle-sota #toggle-spots #toggle-boundaries   checkboxes (layers)
#filter-pota-unactivated checkbox   #filter-sota-points <select>   #filter-mine <select value="all|new|mine">
   filters apply to both #list-parks/#list-summits and the park/summit marker layers (state.filters)
#nfer-btn       "Find multi-activation spots" (runs PSM.nfer.analyze on current results)
#tab-parks #tab-summits #tab-multi     tab buttons (inside the sticky .tabbar);   #list-parks #list-summits #list-multi   lists
   list rows: <div class="item" data-kind="park|summit|zone" data-id="US-2069|W2/GC-001|zone-3">
   long lists are paged 300 rows at a time; the next page comes from
   <button class="show-more" data-list="parks|summits|multi"> (never a .item, so row assertions stay clean)
#to-search      "back to the search box" button in the tab bar (phone bottom sheet only)
#detail         detail panel container; #detail-close closes it; #detail-body holds content
#boundary-line  (park detail only, inside the "Park information" section) one line about the park's
   OSM boundary: "Boundary: looking up OpenStreetMap…" → "Boundary: shown on map · matched by
   <tag|location + name|name|trail name> (<nn>% confidence) · © OpenStreetMap" (+ #boundary-zoom-btn
   "Zoom to boundary" → PSM.app.zoomToParkBoundary()) | "Boundary: not mapped on OpenStreetMap yet —
   showing the reference point only" | "Boundary: lookup failed (Overpass unreachable)".
   The shape itself is drawn by PSM.mapui.showParkBoundary and cleared when the detail closes,
   when another item opens, or when a new search starts. Summits never look one up.
#status         one-line status text (data sources / progress / errors);  #log-toggle shows #log (log entries)
#basemap-select <select> of basemaps;   #map  the Leaflet container
#mylog-section  <details> "My activations" (closed by default, sidebar, after Filters);
   #mylog-summary one-line summary text; #mylog-file file input; #mylog-paste textarea;
   #mylog-import-btn #mylog-export-btn #mylog-clear-btn buttons (Clear confirms via window.confirm)
   list rows: badges .badge-mine "✓ activated" / .badge-attempted "attempted" / .badge-hunted "hunted"
      (mutually exclusive, in that priority order, from PSM.mylog.isActivated/isAttempted/isHunted)
   park/summit detail panels: #mylog-toggle-btn ("Mark as activated"/"Unmark activated", aria-pressed)
      in the action row; #mylog-detail-line ([hidden] when there is no entry) below it, text from
      PSM.mylog.describeEntry(kind, id)
   map markers (60-map.js): classes psm-park-mine/psm-summit-mine (activated by you, teal #00897b,
      wins over the "never activated by anyone" hollow style) and psm-attempted (dashed teal ring);
      legend row "activated by you"
window.PSM.app  = { state: {center, radiusKm, parks, summits, nfer, spots}, search(text) -> Promise,
                    searchAt({lat, lon, label}) -> Promise, openPark(ref) -> Promise, openSummit(code) -> Promise,
                    runNfer() -> Promise, zoomToParkBoundary() -> bool, ready: Promise (resolves after first render) }
PSM.mapui.showParkBoundary(ref, fc, {focus:false}) -> n     // the open park's OSM boundary, in its own
   // single-purpose layer (one park at a time; calling it again replaces the previous). Solid outline in
   // the POTA green family (weight 3 / lines 4, #1b5e20 on #2e7d32 at 0.14 fill), class
   // `psm-selected-boundary` so dark mode can lift the stroke, `interactive:false` so clicks reach the
   // markers underneath. Independent of the n-fer `#toggle-boundaries` layer, which never hides it.
PSM.mapui.clearParkBoundary() / PSM.mapui.parkBoundaryBounds() -> LatLngBounds|null
PSM.mapui.parkBoundaryRef() -> "US-2069"|null / PSM.mapui.zoomToParkBoundary() -> bool
PSM.panel.clearBoundary()   // abort any in-flight lookup + clear the layer (called on close/switch/search)
document.body gets class "psm-ready" after init and "psm-results" after a search completes.
```

## App behaviours (for reference)

* Start: geolocation (if permitted) else last search (localStorage) else empty map of the USA.
* Input classification order: lat/lon → Maidenhead → POTA ref → SOTA ref → geocode (Photon → Nominatim).
* Radius 1–100 mi (default 25 mi); units toggle mi/km; results sorted by distance.
* POTA cascade: snapshot → `/location/parks/{state}` for states whose bbox intersects the search circle
  (cache 24 h) → `/park/grid/{cell}` for intersecting cells (cache 24 h). Snapshot data is enriched with
  state-list stats when reachable.
* SOTA cascade: snapshot → associations bbox → regions → region summits (cache 7 d) → CSV (cache 7 d).
* Detail panel (park): every field from `/park/{ref}` + stats + last activations + leaderboard + approx.
  address (reverse geocode, cached) + links (POTA page, directions, OSM) + copy button + the park's OSM
  boundary highlighted on the map (`PSM.nfer.boundaryFromAnalysis` first, else one cached
  `PSM.nfer.parkBoundary` request; non-blocking, aborted when the panel closes or another item opens,
  never auto-zoomed).
* Detail panel (summit): every field from `/api/summits/{code}` + approx. address + links (sotl.as,
  sotadata, directions).
* n-fer analysis is on-demand ("Find multi-activation spots" button) because Overpass is slow; results
  are drawn as polygons/lines and listed in a "Multi" tab. Summit+park combos get a special marker.
* Live spots (POTA + SOTA, polled every 60 s while enabled) drawn as pulsing markers.
* URL hash keeps `#lat,lon,radiusKm` so a search can be bookmarked/shared.
