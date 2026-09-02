#!/usr/bin/env node
/* =====================================================================
 * tests/nfer.test.js — offline unit test for src/40-nfer.js (PSM.nfer)
 *
 *   node tests/nfer.test.js         # exits non-zero on the first failure
 *
 * No test framework, no network.  Vendor libs come from dev/vendor/,
 * the Overpass response from tests/fixtures/overpass_harriman.json
 * (regenerate with `python3 tests/fixtures/build_overpass_fixture.py`).
 * ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');

/* ------------------------------------------------------------------ */
/* tiny assertion harness                                              */
/* ------------------------------------------------------------------ */
let passed = 0;
const failures = [];
function ok(cond, msg, extra) {
  if (cond) { passed++; console.log('  ok   ' + msg); }
  else {
    failures.push(msg);
    console.log('  FAIL ' + msg + (extra ? '\n         ' + extra : ''));
  }
}
function section(title) { console.log('\n== ' + title + ' =='); }

/* ------------------------------------------------------------------ */
/* load vendor globals + the modules under test                        */
/* ------------------------------------------------------------------ */
// turf.min.js lives in a package dir marked "type":"module", so a plain
// require() fails — evaluate it as CommonJS by hand instead.
(function loadTurf() {
  const src = fs.readFileSync(path.join(ROOT, 'dev/vendor/turf-turf-7.4.0/turf.min.js'), 'utf8');
  const m = { exports: {} };
  new Function('module', 'exports', src)(m, m.exports);
  global.turf = m.exports;
})();
global.osmtogeojson = require(path.join(ROOT, 'dev/vendor/osmtogeojson-3.0.0-beta.5/osmtogeojson.js'));

function loadModule(rel) {
  const p = path.join(ROOT, rel);
  vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: p });
}
loadModule('src/00-util.js');
loadModule('src/40-nfer.js');

const PSM = global.PSM;
const turf = global.turf;
const nfer = PSM.nfer;

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */
const BBOX = { south: 41.10, west: -74.40, north: 41.45, east: -73.85 };
const CENTER = { lat: 41.28, lon: -74.10 };

const overpassPath = path.join(FIX, 'overpass_harriman.json');
if (!fs.existsSync(overpassPath)) {
  console.error('missing ' + overpassPath + '\nRun: python3 tests/fixtures/build_overpass_fixture.py');
  process.exit(2);
}
const OVERPASS_TEXT = fs.readFileSync(overpassPath, 'utf8');

// POTA parks -> Park shape {ref, name, lat, lon}
const potaAll = JSON.parse(fs.readFileSync(path.join(FIX, 'pota_location_parks_US-NY.json'), 'utf8'))
  .map((p) => ({ ref: p.reference, name: p.name, lat: p.latitude, lon: p.longitude,
                 grid: p.grid || null, loc: p.locationDesc || null }));
const parks = potaAll.filter((p) =>
  p.lat >= BBOX.south && p.lat <= BBOX.north && p.lon >= BBOX.west && p.lon <= BBOX.east);

// SOTA summits -> Summit shape (Catskills region; north of the bbox)
const sotaRegion = JSON.parse(fs.readFileSync(path.join(FIX, 'sota_region_W2_GC.json'), 'utf8'));
const summitsReal = (sotaRegion.summits || []).map((s) => ({
  code: s.summitCode, name: s.name, lat: s.latitude, lon: s.longitude,
  altM: s.altM, altFt: s.altFt, points: s.points, assoc: 'W2', region: 'GC'
}));

/* ------------------------------------------------------------------ */
/* network stub                                                        */
/* ------------------------------------------------------------------ */
let fetchLog = [];
let failPrimaryWith = null;      // set to an Error to force a mirror fallback
let primaryRespondsWith = null;  // set to a string the primary returns instead
PSM.fetchText = async function (url, opts) {
  fetchLog.push({ url: url, method: (opts || {}).method, body: (opts || {}).body,
                  headers: (opts || {}).headers });
  if (/overpass-api\.de/.test(url)) {
    if (failPrimaryWith) throw failPrimaryWith;
    if (primaryRespondsWith) return primaryRespondsWith;
  }
  return OVERPASS_TEXT;
};
PSM.fetchJSON = async function (url, opts) { return JSON.parse(await PSM.fetchText(url, opts)); };

/* full-POTA-list lookup stub (trails + refs outside the search area) */
const APPALACHIAN = { ref: 'US-4556', name: 'Appalachian National Scenic Trail', lat: 40.7, lon: -75.9 };
let lookupCalls = [];
async function allParksLookup(q) {
  lookupCalls.push(q);
  const s = String(q || '');
  if (/^[A-Z0-9]{1,4}-\d{3,6}$/i.test(s)) {                       // by reference
    if (s.toUpperCase() === 'US-4556') return [APPALACHIAN];
    if (s.toUpperCase() === 'US-9999') {
      return [{ ref: 'US-9999', name: 'Harriman-Bear Mountain overlap test', lat: 41.30, lon: -74.03 }];
    }
    const hit = potaAll.find((p) => p.ref.toUpperCase() === s.toUpperCase());
    return hit ? [hit] : [];
  }
  if (PSM.nameSimilarity(s, APPALACHIAN.name) >= 0.5) return [APPALACHIAN];   // by name
  return [];
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
function outlineLines(poly) {
  const ln = turf.polygonToLine(poly);
  const out = [];
  const push = (f) => {
    if (f.geometry.type === 'LineString') out.push(f);
    else f.geometry.coordinates.forEach((c) => out.push(turf.lineString(c)));
  };
  if (ln.type === 'FeatureCollection') ln.features.forEach(push); else push(ln);
  return out;
}
function distToOutlineM(lon, lat, poly) {
  const pt = turf.point([lon, lat]);
  return outlineLines(poly).reduce(
    (best, l) => Math.min(best, turf.pointToLineDistance(pt, l, { units: 'meters' })), Infinity);
}
const tagsOf = (f) => (f.properties && f.properties.tags) || f.properties || {};

/* ------------------------------------------------------------------ */
(async function main() {
  /* ---------------------------------------------------------------- */
  section('buildOverpassQuery');
  const q = nfer.buildOverpassQuery(BBOX);
  ok(q.indexOf('[out:json][timeout:90];') === 0, 'starts with [out:json][timeout:90];');
  ok(/nwr\["communication:amateur_radio:pota"\]/.test(q), 'queries the POTA tag with nwr');
  ok(/way\["boundary"="protected_area"\]/.test(q) && /relation\["boundary"="protected_area"\]/.test(q),
     'way + relation boundary=protected_area');
  ok(/way\["boundary"="national_park"\]/.test(q) && /relation\["boundary"="national_park"\]/.test(q),
     'way + relation boundary=national_park');
  ok(/way\["leisure"="nature_reserve"\]/.test(q) && /relation\["leisure"="nature_reserve"\]/.test(q),
     'way + relation leisure=nature_reserve');
  ok(/relation\["leisure"="park"\]/.test(q), 'relation leisure=park');
  ok(/way\["leisure"="park"\]\["name"~"State Park\|State Forest\|National\|County Park\|Reservation\|Preserve\|Wildlife\|Recreation Area",i\]/.test(q),
     'leisure=park ways restricted by name regex');
  ok(/relation\["route"="hiking"\]\["network"~"\^\(nwn\|iwn\)\$"\]/.test(q), 'hiking route relations (nwn|iwn)');
  ok(!/landuse/.test(q), 'landuse=forest deliberately excluded');
  ok(q.indexOf('(41.100000,-74.400000,41.450000,-73.850000)') > -1, 'bbox is south,west,north,east');
  ok(/\bout tags geom;\s*$/.test(q.trim()), 'ends with "out tags geom;"');

  /* ---------------------------------------------------------------- */
  section('fetchBoundaries');
  await PSM.cache.clear();
  fetchLog = [];
  const fc = await nfer.fetchBoundaries(BBOX, {});
  const polys = fc.features.filter((f) => /Polygon$/.test(f.geometry.type));
  const trails = fc.features.filter((f) => /LineString$/.test(f.geometry.type));
  ok(fc.type === 'FeatureCollection', 'returns a FeatureCollection');
  ok(polys.length >= 10, 'at least 10 polygon features (got ' + polys.length + ')');
  ok(trails.length >= 1, 'at least 1 trail/line feature (got ' + trails.length + ')');
  ok(!fc.features.some((f) => /Point$/.test(f.geometry.type)), 'point features dropped');
  ok(!fc.features.some((f) => tagsOf(f).boundary === 'administrative'),
     'administrative boundary polygons dropped');
  ok(JSON.parse(OVERPASS_TEXT).elements.some(
       (e) => (e.tags || {}).boundary === 'administrative'),
     'the fixture really does contain an administrative relation');
  ok(fc.source === 'overpass-api.de', 'source is the primary endpoint (' + fc.source + ')');
  ok(fetchLog.length === 1 && fetchLog[0].method === 'POST', 'POSTed once');
  ok(/^data=/.test(fetchLog[0].body) && decodeURIComponent(fetchLog[0].body.slice(5)) === q,
     'body is data=<urlencoded query>');
  ok((fetchLog[0].headers || {})['Content-Type'] === 'application/x-www-form-urlencoded',
     'form-urlencoded content type (no CORS preflight)');

  // second call for the same bbox must be served from the 24 h cache
  fetchLog = [];
  const fc2 = await nfer.fetchBoundaries(BBOX, {});
  ok(fetchLog.length === 0 && fc2.source === 'cache', 'second call hits the cache (source=' + fc2.source + ')');

  // cache key = bbox rounded outwards to 3 decimals
  ok(nfer._bboxCacheKey(BBOX) === '41.100,-74.400,41.450,-73.850',
     'cache key rounds the bbox to 3 decimals (' + nfer._bboxCacheKey(BBOX) + ')');
  // rounding is outwards, so a slightly tighter bbox lands on the same key
  ok(nfer._bboxCacheKey({ south: 41.1004, west: -74.3996, north: 41.4496, east: -73.8504 }) ===
     nfer._bboxCacheKey(BBOX), 'sub-100 m bbox jitter shares one cache key');

  // 429 on the primary endpoint must fall through to the mirror
  const err429 = new PSM.FetchError('HTTP 429', 429, 'https://overpass-api.de/api/interpreter');
  failPrimaryWith = err429;
  fetchLog = [];
  const fcMirror = await nfer.fetchBoundaries(
    { south: 41.11, west: -74.41, north: 41.46, east: -73.86 }, {});   // different cache key
  failPrimaryWith = null;
  ok(fcMirror.source === 'overpass.kumi.systems',
     'falls through to the mirror on 429 (' + fcMirror.source + ')');
  ok(fetchLog.length === 2 && /kumi/.test(fetchLog[1].url), 'mirror URL used for the retry');

  // Overpass runtime errors arrive as HTTP 200 + "remark" + no elements
  primaryRespondsWith = JSON.stringify({ version: 0.6, generator: 'Overpass API',
    remark: 'runtime error: Query timed out in "query" at line 3', elements: [] });
  const fcRemark = await nfer.fetchBoundaries(
    { south: 41.12, west: -74.42, north: 41.47, east: -73.87 }, {});
  primaryRespondsWith = null;
  ok(fcRemark.source === 'overpass.kumi.systems' && fcRemark.features.length >= 10,
     'an Overpass "remark" runtime error falls through to the mirror ('
     + fcRemark.source + ', ' + fcRemark.features.length + ' features)');

  /* ---------------------------------------------------------------- */
  section('matchFeaturesToParks');
  const matches = await nfer.matchFeaturesToParks(fc.features, parks, { allParksLookup: allParksLookup });
  const byRef = (ref) => matches.filter((m) => m.refs.indexOf(ref) > -1);

  const harriman = byRef('US-2069');
  ok(harriman.length >= 1, 'Harriman State Park matched (' + harriman.length + ' feature(s))');
  ok(harriman.some((m) => m.matchKind === 'tag' && m.confidence === 1),
     'Harriman matched by TAG with confidence 1.0');
  ok(harriman.some((m) => /Harriman/.test(m.name || '')), 'Harriman match carries the OSM name');

  const bear = byRef('US-2010');
  ok(bear.some((m) => m.matchKind === 'tag' && m.confidence === 1),
     'Bear Mountain matched by TAG to US-2010');

  const sterling = byRef('US-2144');
  ok(sterling.length >= 1, 'Sterling Forest matched (' + sterling.length + ' feature(s))');
  ok(sterling.some((m) => m.matchKind === 'point' || m.matchKind === 'name'),
     'Sterling Forest matched by POINT/NAME (' + sterling.map((m) => m.matchKind).join(',') + ')');

  // the umbrella distractor must not be matched to anything
  const umbrellaFeature = fc.features.find(
    (f) => (tagsOf(f).name || '') === 'Palisades Interstate Park Commission');
  ok(!!umbrellaFeature, 'umbrella distractor present in the fixture');
  const umbrellaId = umbrellaFeature.id;
  const umbrellaMatch = matches.find((m) => m.osmId === String(umbrellaId));
  ok(!umbrellaMatch, 'umbrella polygon is NOT matched to any park'
     + (umbrellaMatch ? ' (got ' + umbrellaMatch.refs.join(',') + ')' : ''));
  // sanity: it really does contain several park points
  const insideUmbrella = parks.filter((p) => turf.booleanPointInPolygon([p.lon, p.lat], umbrellaFeature));
  ok(insideUmbrella.length >= 3,
     'umbrella really contains several park points (' + insideUmbrella.length + ')');
  ['US-2069', 'US-2010', 'US-2144'].forEach((ref) => {
    ok(!matches.some((m) => m.osmId === String(umbrellaId) && m.refs.indexOf(ref) > -1),
       'umbrella not attached to ' + ref);
  });

  // the Appalachian Trail line must be matched as a trail
  const at = matches.find((m) => m.kind === 'trail');
  ok(!!at, 'a trail feature was matched');
  ok(at && at.matchKind === 'trail' && at.confidence === 0.75, 'trail match kind/confidence');
  ok(at && at.refs.indexOf('US-4556') > -1,
     'Appalachian Trail matched to US-4556 via allParksLookup (' + (at ? at.refs.join(',') : '-') + ')');
  ok(lookupCalls.some((c) => /Appalachian/.test(c)), 'allParksLookup was consulted by name');

  // A tag holding several refs: they come back sorted, and names[i] must still
  // describe refs[i] (a name/ref mix-up would show wrong park names in the UI).
  const twoRefFeature = {
    type: 'Feature', id: 'way/999001',
    properties: { type: 'way', id: 999001,
      tags: { name: 'Two Ref Test', 'communication:amateur_radio:pota': 'US-9999;k-2069' } },
    geometry: { type: 'Polygon', coordinates: [[[-74.20, 41.20], [-74.20, 41.21],
      [-74.19, 41.21], [-74.19, 41.20], [-74.20, 41.20]]] }
  };
  const twoRef = (await nfer.matchFeaturesToParks([twoRefFeature], parks,
    { allParksLookup: allParksLookup }))[0];
  ok(twoRef && twoRef.refs.join(',') === 'US-2069,US-9999',
     'multi-ref tag split, K-prefix normalised, refs sorted'
     + (twoRef ? ' (' + twoRef.refs.join(',') + ')' : ''));
  ok(twoRef && twoRef.names[0] === 'Harriman State Park' &&
     twoRef.names[1] === 'Harriman-Bear Mountain overlap test',
     'names stay aligned with refs' + (twoRef ? ' (' + JSON.stringify(twoRef.names) + ')' : ''));

  /* ---------------------------------------------------------------- */
  section('analyze');
  // Synthetic summits: two inside the Harriman polygon, one ~100 m outside.
  const harrimanFeature = fc.features.find(
    (f) => tagsOf(f)['communication:amateur_radio:pota'] === 'US-2069');
  ok(!!harrimanFeature, 'Harriman polygon carries the POTA tag in the fixture');
  // Only *matched* polygons matter here: the near summit must sit outside every
  // polygon that carries POTA refs (the unmatched umbrella covers everything).
  const matchedPolys = matches.filter((m) => m.kind === 'area').map((m) => m.feature);
  const insideAnyPoly = (lon, lat) =>
    matchedPolys.some((f) => { try { return turf.booleanPointInPolygon([lon, lat], f); } catch (e) { return false; } });

  const hb = turf.bbox(harrimanFeature);
  const insidePts = [];
  for (let i = 1; i < 40 && insidePts.length < 2; i++) {
    for (let j = 1; j < 40 && insidePts.length < 2; j++) {
      const lon = hb[0] + (hb[2] - hb[0]) * i / 40;
      const lat = hb[1] + (hb[3] - hb[1]) * j / 40;
      if (!turf.booleanPointInPolygon([lon, lat], harrimanFeature)) continue;
      if (distToOutlineM(lon, lat, harrimanFeature) < 300) continue;      // safely interior
      if (insidePts.some((p) => turf.distance(turf.point(p), turf.point([lon, lat]),
                                              { units: 'kilometers' }) < 2)) continue;
      insidePts.push([lon, lat]);
    }
  }
  ok(insidePts.length === 2, 'found two interior points inside Harriman');

  // a point ~100 m beyond the Harriman boundary, outside every fixture polygon
  let nearPt = null;
  const outline = outlineLines(harrimanFeature);
  outer:
  for (const line of outline) {
    for (const c of line.geometry.coordinates) {
      for (let brg = 0; brg < 360; brg += 15) {
        const dest = turf.destination(turf.point(c), 0.1, brg, { units: 'kilometers' });
        const [lon, lat] = dest.geometry.coordinates;
        if (insideAnyPoly(lon, lat)) continue;
        const d = distToOutlineM(lon, lat, harrimanFeature);
        if (d > 60 && d < 140) { nearPt = [lon, lat, d]; break outer; }
      }
    }
  }
  ok(!!nearPt, 'found a point ~100 m outside Harriman' + (nearPt ? ' (' + nearPt[2].toFixed(0) + ' m)' : ''));

  // …and one inside the US-9999 x US-2069 overlap, so zone.summits is exercised
  const overlapFeature = fc.features.find(
    (f) => tagsOf(f)['communication:amateur_radio:pota'] === 'US-9999');
  let zonePt = null;
  try {
    const inter = turf.intersect(turf.featureCollection([overlapFeature, harrimanFeature]));
    const c = inter && turf.pointOnFeature(inter).geometry.coordinates;
    if (c && turf.booleanPointInPolygon(c, overlapFeature) &&
        turf.booleanPointInPolygon(c, harrimanFeature)) zonePt = c;
  } catch (e) { /* reported by the assertion below */ }
  ok(!!zonePt, 'found a point inside the US-9999 x US-2069 overlap');

  const summits = summitsReal.concat([
    { code: 'W2/TT-001', name: 'Test Summit Inside A', lat: insidePts[0][1], lon: insidePts[0][0], altM: 400, points: 1, assoc: 'W2', region: 'TT' },
    { code: 'W2/TT-002', name: 'Test Summit Inside B', lat: insidePts[1][1], lon: insidePts[1][0], altM: 420, points: 1, assoc: 'W2', region: 'TT' },
    { code: 'W2/TT-003', name: 'Test Summit Near', lat: nearPt[1], lon: nearPt[0], altM: 380, points: 1, assoc: 'W2', region: 'TT' },
    { code: 'W2/TT-004', name: 'Test Summit In Zone', lat: zonePt[1], lon: zonePt[0], altM: 410, points: 1, assoc: 'W2', region: 'TT' }
  ]);

  const progress = [];
  await PSM.cache.clear();               // exercise the full fetch->analyse path
  const res = await nfer.analyze({
    center: CENTER, radiusKm: 25, bbox: BBOX,
    parks: parks, summits: summits,
    allParksLookup: allParksLookup,
    onProgress: (msg, frac) => progress.push([msg, frac])
  });

  ok(res && res.boundaries && res.boundaries.type === 'FeatureCollection', 'boundaries is a FeatureCollection');
  ok(res.zones && res.zones.type === 'FeatureCollection', 'zones is a FeatureCollection');
  ok(Array.isArray(res.summitCombos), 'summitCombos is an array');
  ok(Array.isArray(res.unmatchedParks), 'unmatchedParks is an array');
  ok(Array.isArray(res.unmatchedFeatures), 'unmatchedFeatures is an array');
  ok(progress.length >= 4, 'onProgress called at each phase (' + progress.length + ' times)');
  ok(res.stats.elapsedMs < 15000, 'analysis finished in ' + res.stats.elapsedMs + ' ms (< 15000)');
  ok(res.stats.errors.length === 0,
     'no partial-failure errors', JSON.stringify(res.stats.errors.slice(0, 5)));
  ok(res.stats.source === 'overpass-api.de', 'stats.source = ' + res.stats.source);

  const zones = res.zones.features.map((z) => z.properties);
  const trailZones = zones.filter((z) => z.refs.indexOf('US-4556') > -1);
  ok(trailZones.length >= 1, 'at least one zone contains the trail US-4556');
  const trailParkZone = trailZones.find(
    (z) => z.refs.indexOf('US-2069') > -1 || z.refs.indexOf('US-2010') > -1);
  ok(!!trailParkZone, 'a trail zone also contains US-2069 and/or US-2010'
     + (trailParkZone ? ' -> ' + trailParkZone.refs.join('+') : ''));
  ok(trailParkZone && /trail/.test(trailParkZone.kind),
     'that zone has a trail kind (' + (trailParkZone ? trailParkZone.kind : '-') + ')');

  const overlapZone = zones.find(
    (z) => z.refs.indexOf('US-9999') > -1 && z.refs.indexOf('US-2069') > -1);
  ok(!!overlapZone, 'park-park zone with US-9999 + US-2069'
     + (overlapZone ? ' (' + overlapZone.areaHa + ' ha, kind=' + overlapZone.kind + ')' : ''));
  ok(overlapZone && overlapZone.summits.indexOf('W2/TT-004') > -1,
     'that zone lists the summit standing in it'
     + (overlapZone ? ' (' + JSON.stringify(overlapZone.summits) + ')' : ''));
  ok(zones.every((z) => /^zone-\d+$/.test(z.id) && Array.isArray(z.summits) &&
        Array.isArray(z.centroid) && z.centroid.length === 2 &&
        typeof z.areaHa === 'number' && z.confidence > 0 && z.confidence <= 1 &&
        ['park-park', 'trail-park', 'park-park-trail'].indexOf(z.kind) > -1),
     'zone properties carry the full contract shape');

  zones.forEach((z) => {
    if (z.areaHa < 0.2) failures.push('zone ' + z.id + ' below the 0.2 ha sliver threshold');
  });
  ok(zones.every((z) => z.areaHa >= 0.2), 'no zone below 0.2 ha');
  ok(zones.every((z) => z.count === z.refs.length && z.count >= 2), 'every zone has >= 2 refs and a matching count');
  ok(new Set(zones.map((z) => z.refs.join('|'))).size === zones.length ||
     zones.length !== new Set(zones.map((z) => z.id)).size === false, 'zone ids are unique');
  const sorted = zones.every((z, i) => i === 0 ||
    zones[i - 1].count > z.count || (zones[i - 1].count === z.count && zones[i - 1].areaHa >= z.areaHa));
  ok(sorted, 'zones sorted by count desc then area desc');

  const combo = (code) => res.summitCombos.find((c) => c.code === code);
  const cA = combo('W2/TT-001'), cB = combo('W2/TT-002'), cN = combo('W2/TT-003');
  ok(cA && cA.inside === true && cA.refs.indexOf('US-2069') > -1,
     'synthetic summit A inside Harriman (US-2069)');
  ok(cB && cB.inside === true && cB.refs.indexOf('US-2069') > -1,
     'synthetic summit B inside Harriman (US-2069)');
  ok(cA && cA.distM === 0 && cB && cB.distM === 0, 'inside summits report distM 0');
  ok(cN && cN.inside === false && cN.distM > 0 && cN.distM <= 150,
     'near summit outside, 0 < distM <= 150 (distM=' + (cN ? cN.distM : '-') + ')');
  ok(cN && cN.refs.indexOf('US-2069') > -1, 'near summit still linked to US-2069');
  const cZ = combo('W2/TT-004');
  ok(cZ && cZ.inside === true && cZ.refs.indexOf('US-2069') > -1 && cZ.refs.indexOf('US-9999') > -1,
     'summit in the overlap zone reports both refs' + (cZ ? ' (' + cZ.refs.join('+') + ')' : ''));
  // Real W2/GC summits inside the bbox legitimately produce combos; summits
  // well outside the analysis area must never appear.
  const outsideBbox = summitsReal.filter((s) =>
    s.lat < BBOX.south || s.lat > BBOX.north || s.lon < BBOX.west || s.lon > BBOX.east);
  ok(outsideBbox.length > 50, 'the SOTA fixture has plenty of out-of-area summits (' + outsideBbox.length + ')');
  ok(!res.summitCombos.some((c) => outsideBbox.some((s) => s.code === c.code)),
     'summits outside the analysis bbox produce no combos');
  ok(res.summitCombos.some((c) => c.code === 'W2/GC-077' && c.refs.indexOf('US-2010') > -1),
     'real summit W2/GC-077 (Bear Mountain) pairs with US-2010');

  const unmatchedNames = res.unmatchedFeatures.map((u) => u.name);
  ok(unmatchedNames.indexOf('Palisades Interstate Park Commission') > -1,
     'umbrella polygon listed in unmatchedFeatures');
  ok(res.unmatchedFeatures.length <= 200, 'unmatchedFeatures capped at 200');
  ok(res.unmatchedFeatures.every((u) => u.name && u.osmId), 'unmatchedFeatures entries have osmId + name');

  const boundaryProps = res.boundaries.features.map((f) => f.properties);
  ok(boundaryProps.length === res.stats.matched, 'boundaries count == stats.matched');
  ok(boundaryProps.every((p) => p.osmId && p.osmType && Array.isArray(p.refs) &&
        p.matchKind && typeof p.confidence === 'number' &&
        (p.kind === 'area' || p.kind === 'trail') && p.tags),
     'boundary properties carry the full contract shape');

  /* ---------------------------------------------------------------- */
  section('robustness');
  let aborted = false;
  try {
    await nfer.analyze({ bbox: BBOX, parks: parks, summits: summits, signal: { aborted: true } });
  } catch (e) { aborted = (e && e.name === 'AbortError'); }
  ok(aborted, 'analyze throws an AbortError when signal.aborted');

  // Total Overpass failure must degrade, not throw.
  const savedFetch = PSM.fetchText;
  PSM.fetchText = async () => { throw new PSM.FetchError('network error', 0, 'x'); };
  await PSM.cache.clear();
  const dead = await nfer.analyze({ bbox: { south: 40, west: -75, north: 40.2, east: -74.8 },
                                    parks: parks, summits: summits });
  PSM.fetchText = savedFetch;
  ok(dead.stats.osmFeatures === 0 && dead.boundaries.features.length === 0,
     'a dead Overpass yields an empty but valid result');
  ok(dead.stats.errors.length >= 2, 'both endpoint failures recorded in stats.errors');
  ok(dead.unmatchedParks.length === parks.length, 'every park reported unmatched when nothing was fetched');

  /* ---------------------------------------------------------------- */
  section('summary');
  console.log('  OSM features    : ' + res.stats.osmFeatures);
  console.log('  matched         : ' + res.stats.matched +
    '  (tag=' + boundaryProps.filter((p) => p.matchKind === 'tag').length +
    ' point=' + boundaryProps.filter((p) => p.matchKind === 'point').length +
    ' name=' + boundaryProps.filter((p) => p.matchKind === 'name').length +
    ' trail=' + boundaryProps.filter((p) => p.matchKind === 'trail').length + ')');
  console.log('  unmatched parks : ' + res.unmatchedParks.length + ' [' +
    res.unmatchedParks.slice(0, 8).join(', ') + (res.unmatchedParks.length > 8 ? ', …' : '') + ']');
  console.log('  unmatched feats : ' + res.unmatchedFeatures.length);
  console.log('  source          : ' + res.stats.source + '   elapsed ' + res.stats.elapsedMs + ' ms');
  console.log('  zones           : ' + zones.length);
  zones.slice(0, 12).forEach((z) => {
    console.log('    ' + z.id.padEnd(8) + z.kind.padEnd(17) +
      String(z.areaHa).padStart(9) + ' ha  conf ' + z.confidence.toFixed(2) + '  ' +
      z.refs.join(' + ') + (z.summits.length ? '   summits: ' + z.summits.join(',') : ''));
  });
  if (zones.length > 12) console.log('    … ' + (zones.length - 12) + ' more');
  console.log('  summit combos   : ' + res.summitCombos.length);
  res.summitCombos.slice(0, 10).forEach((c) => {
    console.log('    ' + c.code.padEnd(11) + (c.inside ? 'inside ' : 'near   ') +
      String(c.distM).padStart(4) + ' m  ' + c.refs.join(' + ') + '   ' + (c.name || ''));
  });

  /* ---------------------------------------------------------------- */
  console.log('\n' + (failures.length ? 'FAILED' : 'PASSED') +
    ': ' + passed + ' assertions passed, ' + failures.length + ' failed');
  if (failures.length) {
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
})().catch((e) => {
  console.error('\nUNEXPECTED ERROR:', e && e.stack || e);
  process.exit(1);
});
