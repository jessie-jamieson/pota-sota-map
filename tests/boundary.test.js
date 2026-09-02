#!/usr/bin/env node
/* =====================================================================
 * tests/boundary.test.js — offline unit test for the single-park boundary
 * lookup added to src/40-nfer.js (PSM.nfer.buildParkQuery / parkBoundary /
 * boundaryFromAnalysis).
 *
 *   node tests/boundary.test.js      # exits non-zero on the first failure
 *
 * Same loader pattern as tests/nfer.test.js: no test framework, no network.
 * Vendor libs come from dev/vendor/, the Overpass response from
 * tests/fixtures/overpass_harriman.json.
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
const nfer = PSM.nfer;

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */
const overpassPath = path.join(FIX, 'overpass_harriman.json');
if (!fs.existsSync(overpassPath)) {
  console.error('missing ' + overpassPath + '\nRun: python3 tests/fixtures/build_overpass_fixture.py');
  process.exit(2);
}
const OVERPASS_TEXT = fs.readFileSync(overpassPath, 'utf8');

const HARRIMAN = { ref: 'US-2069', name: 'Harriman State Park', lat: 41.1753, lon: -74.1783 };
const STERLING = { ref: 'US-2144', name: 'Sterling Forest State Park', lat: 41.1986, lon: -74.2553 };
const NOWHERE = { ref: 'US-0000', name: 'Zzyzx Imaginary Park', lat: 41.2, lon: -74.1 };

/* ------------------------------------------------------------------ */
/* network stub                                                        */
/* ------------------------------------------------------------------ */
let fetchLog = [];
let nextResponse = null;   // set to a string to answer with something else once
PSM.fetchText = async function (url, opts) {
  fetchLog.push({ url: url, method: (opts || {}).method, body: (opts || {}).body,
                  headers: (opts || {}).headers, timeoutMs: (opts || {}).timeoutMs });
  if (nextResponse != null) { const r = nextResponse; nextResponse = null; return r; }
  return OVERPASS_TEXT;
};
PSM.fetchJSON = async function (url, opts) { return JSON.parse(await PSM.fetchText(url, opts)); };

const decodeBody = (b) => decodeURIComponent(String(b || '').replace(/^data=/, '').replace(/\+/g, ' '));

/* ------------------------------------------------------------------ */
(async function main() {
  /* ---------------------------------------------------------------- */
  section('buildParkQuery');
  const q = nfer.buildParkQuery(HARRIMAN);
  ok(q.indexOf('[out:json][timeout:30];') === 0, 'starts with [out:json][timeout:30];');
  ok(q.indexOf('nwr["communication:amateur_radio:pota"="US-2069"];') > -1,
     'exact-tag arm for the reference');
  ok(q.indexOf('nwr["communication:amateur_radio:pota"~"(^|;)US-2069(;|$)"];') > -1,
     'multi-value regex arm for the reference');
  ok((q.match(/\(around:15000,41\.175300,-74\.178300\)/g) || []).length === 6,
     'six around:15000 clauses at the park point (' +
     (q.match(/\(around:15000,/g) || []).length + ')');
  ok(/way\["boundary"~"\^\(protected_area\|national_park\)\$"\]\(around:15000,/.test(q) &&
     /relation\["boundary"~"\^\(protected_area\|national_park\)\$"\]\(around:15000,/.test(q),
     'way + relation boundary=protected_area|national_park around the point');
  ok(/way\["leisure"="nature_reserve"\]\(around:15000,/.test(q) &&
     /relation\["leisure"="nature_reserve"\]\(around:15000,/.test(q),
     'way + relation leisure=nature_reserve around the point');
  ok(/relation\["leisure"="park"\]\(around:15000,/.test(q) &&
     /way\["leisure"="park"\]\(around:15000,/.test(q),
     'relation + way leisure=park around the point');
  ok(!/\(4[01]\.\d+,-7\d\.\d+,4[01]\./.test(q), 'no bbox filter — the tag arm is global');
  ok(/\bout tags geom;\s*$/.test(q.trim()), 'ends with "out tags geom;"');
  // A reference is normalised the same way the matcher normalises OSM tag values.
  ok(nfer.buildParkQuery({ ref: 'k-2069', lat: 41.1753, lon: -74.1783 })
       .indexOf('"communication:amateur_radio:pota"="US-2069"') > -1,
     'legacy K-#### references are normalised into the query');

  /* ---------------------------------------------------------------- */
  section('parkBoundary — Harriman (tagged)');
  await PSM.cache.clear();
  fetchLog = [];
  const har = await nfer.parkBoundary(HARRIMAN);
  ok(!!har, 'returned a result for US-2069');
  ok(har && har.fc && har.fc.type === 'FeatureCollection', 'fc is a FeatureCollection');
  ok(har && har.fc.features.length >= 1,
     'at least one feature (' + (har ? har.fc.features.length : 0) + ')');
  ok(har && har.matchKind === 'tag', 'matchKind is "tag" (' + (har ? har.matchKind : '-') + ')');
  ok(har && har.confidence === 1, 'confidence 1.0 (' + (har ? har.confidence : '-') + ')');
  ok(har && /Harriman/.test(har.name || ''), 'carries the OSM name (' + (har ? har.name : '-') + ')');
  ok(har && har.source === 'overpass-api.de', 'source is the primary endpoint (' + (har ? har.source : '-') + ')');
  ok(har && har.fc.features.every((f) => (f.properties.refs || []).indexOf('US-2069') > -1),
     'every returned feature belongs to US-2069');
  ok(har && har.fc.features.every((f) => /Polygon|LineString/.test((f.geometry || {}).type || '')),
     'every returned feature has drawable geometry');
  ok(har && har.fc.features.some((f) => f.properties.matchKind === 'tag'),
     'the tagged relation is among them');
  ok(har && har.fc.features.every((f) => f.properties.osmId && f.properties.kind &&
       typeof f.properties.confidence === 'number'),
     'feature properties carry osmId / kind / confidence for the map layer');
  // Bear Mountain (US-2010) and the US-9999 test polygon ride along in the same
  // Overpass response — neither may leak into this park's boundary.
  ok(har && !har.fc.features.some((f) => (f.properties.refs || []).some((r) => r !== 'US-2069')),
     'no other park’s polygons leak in');
  // …and neither does the umbrella distractor that contains the park point.
  ok(har && !har.fc.features.some((f) => /Palisades Interstate Park Commission/.test(f.properties.name || '')),
     'the umbrella distractor is not claimed as Harriman');

  ok(fetchLog.length === 1 && fetchLog[0].method === 'POST', 'POSTed exactly once');
  ok(/overpass-api\.de/.test(fetchLog[0].url), 'primary endpoint used');
  ok(decodeBody(fetchLog[0].body) === q, 'body is data=<urlencoded buildParkQuery()>');
  ok((fetchLog[0].headers || {})['Content-Type'] === 'application/x-www-form-urlencoded',
     'form-urlencoded content type (no CORS preflight)');

  // A second open of the same park is served from the 7-day cache.
  fetchLog = [];
  const har2 = await nfer.parkBoundary(HARRIMAN);
  ok(fetchLog.length === 0, 'second lookup makes no request');
  ok(har2 && har2.source === 'cache', 'second lookup reports source="cache" (' + (har2 ? har2.source : '-') + ')');
  ok(har2 && har2.fc.features.length === har.fc.features.length, 'cached result has the same features');

  /* ---------------------------------------------------------------- */
  section('parkBoundary — Sterling Forest (untagged) and misses');
  const ster = await nfer.parkBoundary(STERLING);
  ok(!!ster, 'returned a result for US-2144 (no POTA tag in OSM)');
  ok(ster && (ster.matchKind === 'point' || ster.matchKind === 'name'),
     'matched by point/name (' + (ster ? ster.matchKind : '-') + ')');
  ok(ster && ster.confidence > 0 && ster.confidence < 1,
     'confidence below 1 for a non-tag match (' + (ster ? ster.confidence : '-') + ')');
  ok(ster && ster.fc.features.every((f) => (f.properties.refs || []).indexOf('US-2144') > -1),
     'every Sterling Forest feature belongs to US-2144');

  const miss = await nfer.parkBoundary(NOWHERE);
  ok(miss === null, 'a park that matches nothing returns null (' + JSON.stringify(miss) + ')');

  const noCoords = await nfer.parkBoundary({ ref: 'US-2069', name: 'Harriman State Park' });
  ok(noCoords === null, 'a park with no coordinates returns null without a request');

  ok((await nfer.parkBoundary(null)) === null, 'no park at all returns null');

  /* ---------------------------------------------------------------- */
  section('parkBoundary — robustness');
  await PSM.cache.clear();
  const savedFetch = PSM.fetchText;
  PSM.fetchText = async () => { throw new PSM.FetchError('network error', 0, 'x'); };
  let threw = null;
  try { await nfer.parkBoundary(HARRIMAN); } catch (e) { threw = e; }
  PSM.fetchText = savedFetch;
  ok(!!threw, 'a dead Overpass rejects (the panel shows "lookup failed")');
  ok(threw && Array.isArray(threw.overpassErrors) && threw.overpassErrors.length === 2,
     'both endpoint failures are carried on the error');

  // An abort must not be cached as "no boundary": the next open re-runs.
  await PSM.cache.clear();
  let aborted = null;
  try { await nfer.parkBoundary(HARRIMAN, { signal: { aborted: true } }); } catch (e) { aborted = e; }
  ok(aborted && aborted.name === 'AbortError', 'an already-aborted signal throws an AbortError');
  fetchLog = [];
  const afterAbort = await nfer.parkBoundary(HARRIMAN);
  ok(fetchLog.length === 1 && afterAbort && afterAbort.matchKind === 'tag',
     'the abort did not poison the cache — the next lookup fetches and succeeds');

  /* ---------------------------------------------------------------- */
  section('boundaryFromAnalysis');
  const fakeNfer = {
    boundaries: {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-74.2, 41.2], [-74.2, 41.21], [-74.19, 41.21], [-74.19, 41.2], [-74.2, 41.2]]] },
          properties: { osmId: 'relation/1', name: 'Harriman State Park', refs: ['US-2069'], matchKind: 'tag', confidence: 1, kind: 'area' } },
        { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-74.3, 41.3], [-74.3, 41.31], [-74.29, 41.31], [-74.29, 41.3], [-74.3, 41.3]]] },
          properties: { osmId: 'way/2', name: 'Harriman State Park (north unit)', refs: ['US-2069'], matchKind: 'name', confidence: 0.6, kind: 'area' } },
        { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-74.0, 41.28], [-74.0, 41.29], [-73.99, 41.29], [-73.99, 41.28], [-74.0, 41.28]]] },
          properties: { osmId: 'relation/3', name: 'Bear Mountain State Park', refs: ['US-2010'], matchKind: 'tag', confidence: 1, kind: 'area' } }
      ]
    }
  };
  fetchLog = [];
  const fromAnalysis = nfer.boundaryFromAnalysis('US-2069', fakeNfer);
  ok(!!fromAnalysis, 'returns a result from an existing analysis');
  ok(fetchLog.length === 0, 'no fetch at all (it is a synchronous, network-free shortcut)');
  ok(fromAnalysis && fromAnalysis.fc.features.length === 2,
     'both US-2069 units come back (' + (fromAnalysis ? fromAnalysis.fc.features.length : 0) + ')');
  ok(fromAnalysis && !fromAnalysis.fc.features.some((f) => f.properties.refs.indexOf('US-2010') > -1),
     'Bear Mountain is not included');
  ok(fromAnalysis && fromAnalysis.matchKind === 'tag' && fromAnalysis.confidence === 1,
     'reports the best match of the set (' + (fromAnalysis ? fromAnalysis.matchKind + '/' + fromAnalysis.confidence : '-') + ')');
  ok(fromAnalysis && fromAnalysis.source === 'analysis', 'source is "analysis"');
  ok(nfer.boundaryFromAnalysis('k-2069', fakeNfer) !== null, 'legacy K-#### reference is normalised');
  ok(nfer.boundaryFromAnalysis('US-1111', fakeNfer) === null, 'a ref the analysis never saw returns null');
  ok(nfer.boundaryFromAnalysis('US-2069', null) === null, 'no analysis returns null');
  ok(nfer.boundaryFromAnalysis('US-2069', { boundaries: { type: 'FeatureCollection', features: [] } }) === null,
     'an empty analysis returns null');

  /* ---------------------------------------------------------------- */
  section('summary');
  console.log('  Harriman  : ' + har.fc.features.length + ' feature(s), ' + har.matchKind +
    ' ' + Math.round(har.confidence * 100) + '%  [' +
    har.fc.features.map((f) => f.properties.osmId + ':' + f.properties.matchKind).join(', ') + ']');
  console.log('  Sterling  : ' + ster.fc.features.length + ' feature(s), ' + ster.matchKind +
    ' ' + Math.round(ster.confidence * 100) + '%  [' +
    ster.fc.features.map((f) => f.properties.osmId + ':' + f.properties.matchKind).join(', ') + ']');
  console.log('  vertices  : Harriman ' + har.fc.features.reduce(
    (n, f) => n + nfer._countPositions(f.geometry), 0) + ' (simplify threshold ' +
    nfer.CONST.PARK_MAX_VERTICES + ')');

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
