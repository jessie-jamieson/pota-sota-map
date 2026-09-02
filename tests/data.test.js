#!/usr/bin/env node
/* =====================================================================
 * tests/data.test.js — offline unit tests for the data-access modules
 *
 *   node tests/data.test.js        # exits non-zero if anything fails
 *
 * Covers src/10-geocode.js, src/20-pota.js, src/30-sota.js, src/50-spots.js.
 * No test framework and no network: PSM.fetchJSON / PSM.fetchText are replaced
 * with a small URL router that serves tests/fixtures/ (see build_fixtures.py
 * for how those were generated).  Unrouted URLs reject with a 404 PSM.FetchError
 * and `setFailing([...])` makes chosen URL substrings reject with 503, which is
 * how the fallback cascades are exercised.
 *
 * Node has no indexedDB, so PSM.cache transparently falls back to its in-memory
 * map — asserted below, and cleared between scenarios so each cascade really
 * hits the router.
 * ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');

/* ------------------------------------------------------------------ */
/* assertion harness                                                   */
/* ------------------------------------------------------------------ */
let passed = 0;
const failures = [];
function ok(cond, msg, extra) {
  if (cond) { passed++; console.log('  ok   ' + msg); }
  else {
    failures.push(msg);
    console.log('  FAIL ' + msg + (extra !== undefined ? '\n         ' + extra : ''));
  }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}
function near(actual, expected, tol, msg) {
  ok(typeof actual === 'number' && Math.abs(actual - expected) <= tol, msg,
    'expected ~' + expected + ' (±' + tol + '), got ' + JSON.stringify(actual));
}
function section(title) { console.log('\n== ' + title + ' =='); }
async function throws(fn, test, msg) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  ok(err && test(err), msg, err ? 'error was: ' + err.message : 'no error thrown');
  return err;
}

/* ------------------------------------------------------------------ */
/* load the modules (browser-style globals)                            */
/* ------------------------------------------------------------------ */
global.window = globalThis;          // modules use `typeof window !== 'undefined' ? window : globalThis`
function loadModule(rel) {
  const p = path.join(ROOT, rel);
  vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: p });
}
loadModule('src/00-util.js');
loadModule('src/10-geocode.js');
loadModule('src/20-pota.js');
loadModule('src/30-sota.js');
loadModule('src/50-spots.js');

const PSM = global.PSM;

// Keep PSM's own chatter out of the test output, but remember it for assertions.
const psmLogs = [];
PSM.onLog(function (e) { psmLogs.push(e.msg); });
['log', 'warn', 'error'].forEach(function (level) {
  const orig = console[level].bind(console);
  console[level] = function () {
    if (arguments[0] === '[PSM]') return;
    orig.apply(null, arguments);
  };
});
function loggedSince(mark, needle) {
  return psmLogs.slice(mark).some(function (m) { return m.indexOf(needle) >= 0; });
}

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */
const fixCache = new Map();
function fixture(name) {
  if (!fixCache.has(name)) fixCache.set(name, JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8')));
  return fixCache.get(name);
}
function fixtureExists(name) { return fs.existsSync(path.join(FIX, name)); }
const clone = function (v) { return v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)); };

const NY_PARKS = fixture('pota_location_parks_US-NY.json');

// The W2/GC region served by the router = the fixture + one retired summit right
// next to the search centre, so the validity filter has something to exclude.
const RETIRED = {
  summitCode: 'W2/GC-999', name: 'Retired Knob', shortCode: 'GC-999',
  altM: 700, altFt: 2296, longitude: -74.40, latitude: 42.00,
  points: 6, bonusPoints: 0,
  validFrom: '2010-05-01T00:00:00', validTo: '2015-12-31T00:00:00',
  activationCount: 2, activationDate: '2014-06-01T00:00:00', activationCall: 'W2OLD',
  locator: 'FN22aa'
};
const GC_REGION = (function () {
  const r = clone(fixture('sota_region_W2_GC.json'));
  r.summits = r.summits.concat([clone(RETIRED)]);
  return r;
})();

/* --- summitslist.csv, built from the region fixture (banner + header) --- */
function csvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function isoToDDMMYYYY(v) {
  if (!v) return '';
  const b = String(v).slice(0, 10).split('-');
  return b.length === 3 ? b[2] + '/' + b[1] + '/' + b[0] : '';
}
const SOTA_CSV = (function () {
  const banner = 'SOTA Summits List (Date=31/08/2026)';
  const header = 'SummitCode,AssociationName,RegionName,SummitName,AltM,AltFt,GridRef1,GridRef2,Longitude,' +
    'Latitude,Points,BonusPoints,ValidFrom,ValidTo,ActivationCount,ActivationDate,ActivationCall';
  const rows = GC_REGION.summits.map(function (s) {
    return [s.summitCode, GC_REGION.associationName, GC_REGION.regionName, s.name, s.altM, s.altFt,
      s.longitude, s.latitude, s.longitude, s.latitude, s.points, s.bonusPoints,
      isoToDDMMYYYY(s.validFrom), isoToDDMMYYYY(s.validTo), s.activationCount,
      isoToDDMMYYYY(s.activationDate), s.activationCall || ''].map(csvField).join(',');
  });
  return [banner, header].concat(rows).join('\n') + '\n';
})();

/* ------------------------------------------------------------------ */
/* network router                                                      */
/* ------------------------------------------------------------------ */
const requests = [];
let failing = [];
function setFailing(list) { failing = list || []; }
function requestsMatching(needle) { return requests.filter(function (u) { return u.indexOf(needle) >= 0; }); }
function resetNet() { requests.length = 0; setFailing([]); }

const json = function (body) { return { body: body }; };
const text = function (body) { return { body: body, text: true }; };

function buildLookup(search) {
  const q = String(search || '').toLowerCase();
  if (!q) return [];
  return NY_PARKS.filter(function (p) { return p.name.toLowerCase().indexOf(q) >= 0; })
    .slice(0, 10)
    .map(function (p, i) {
      return { type: 'park', id: 900000 + i, display: p.reference + '  ' + p.name, value: p.reference };
    });
}

/** @returns {{body:any, text?:boolean}|null} — null means "no such route" (404). */
function route(url) {
  const u = new URL(url);
  const host = u.hostname;
  const parts = u.pathname.split('/').filter(Boolean);

  if (host === 'api.pota.app') {
    if (parts[0] === 'location' && parts[1] === 'parks' && parts.length === 3) {
      return parts[2] === 'US-NY' ? json(fixture('pota_location_parks_US-NY.json')) : null;
    }
    if (parts[0] === 'park' && parts[1] === 'grid' && parts.length === 3) {
      const f = 'pota_park_grid_' + parts[2] + '.json';
      return fixtureExists(f) ? json(fixture(f)) : null;
    }
    if (parts[0] === 'park' && parts[1] === 'stats' && parts.length === 3) return json(fixture('pota_park_stats_US-2069.json'));
    if (parts[0] === 'park' && parts[1] === 'activations' && parts.length === 3) return json(fixture('pota_park_activations_US-2069.json'));
    if (parts[0] === 'park' && parts[1] === 'leaderboard' && parts.length === 3) return json(fixture('pota_park_leaderboard_US-2069.json'));
    if (parts[0] === 'park' && parts.length === 2) {
      // The real API answers HTTP 200 with a body of `null` for unknown refs.
      return parts[1] === 'US-2069' ? json(fixture('pota_park_US-2069.json')) : json(null);
    }
    if (parts[0] === 'spot' && parts[1] === 'activator') return json(fixture('pota_spots.json'));
    if (parts[0] === 'lookup') return json(buildLookup(u.searchParams.get('search')));
    return null;
  }

  if (host === 'api2.sota.org.uk') {
    if (parts[0] !== 'api') return null;
    const p = parts.slice(1);
    if (p[0] === 'associations' && p.length === 1) return json(fixture('sota_associations.json'));
    if (p[0] === 'associations' && p.length === 2) {
      const f = 'sota_association_' + p[1] + '.json';
      return fixtureExists(f) ? json(fixture(f)) : null;
    }
    if (p[0] === 'regions' && p.length === 3) {
      if (p[1] === 'W2' && p[2] === 'GC') return json(GC_REGION);
      const f = 'sota_region_' + p[1] + '_' + p[2] + '.json';
      return fixtureExists(f) ? json(fixture(f)) : null;
    }
    if (p[0] === 'summits' && p.length === 3) {
      if (p[1] === 'W2' && p[2] === 'GC-001') return json(fixture('sota_summit_W2_GC-001.json'));
      return null;
    }
    if (p[0] === 'spots' && p.length === 3 && p[2] === 'all') return json(fixture('sota_spots.json'));
    return null;
  }

  if (host === 'storage.sota.org.uk' && u.pathname === '/summitslist.csv') return text(SOTA_CSV);

  if (host === 'photon.komoot.io') {
    if (u.pathname === '/api/' || u.pathname === '/api') return json(fixture('photon_search.json'));
    if (u.pathname === '/reverse') return json(fixture('photon_reverse.json'));
    return null;
  }

  if (host === 'nominatim.openstreetmap.org') {
    if (u.pathname === '/search') return json(fixture('nominatim_search.json'));
    if (u.pathname === '/reverse') return json(fixture('nominatim_reverse.json'));
    return null;
  }

  return null;
}

function serve(url, wantText) {
  requests.push(url);
  for (let i = 0; i < failing.length; i++) {
    if (url.indexOf(failing[i]) >= 0) {
      return Promise.reject(new PSM.FetchError('HTTP 503 for ' + url, 503, url));
    }
  }
  const r = route(url);
  if (!r) return Promise.reject(new PSM.FetchError('HTTP 404 for ' + url, 404, url));
  if (wantText) return Promise.resolve(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
  return Promise.resolve(r.text ? r.body : clone(r.body));
}

PSM.fetchJSON = function (url) { return serve(url, false); };
PSM.fetchText = function (url) { return serve(url, true); };

/* ------------------------------------------------------------------ */
/* shared expectations                                                 */
/* ------------------------------------------------------------------ */
const POTA_CENTER = { lat: 41.24, lon: -74.10 };
const POTA_RADIUS = 40;
const SOTA_CENTER = { lat: 42.0, lon: -74.4 };
const SOTA_RADIUS = 30;

function isSorted(list, key) {
  for (let i = 1; i < list.length; i++) if (list[i][key] < list[i - 1][key]) return false;
  return true;
}
function allWithin(list, center, radiusKm) {
  return list.every(function (x) {
    const d = PSM.haversineKm(center.lat, center.lon, x.lat, x.lon);
    return d <= radiusKm + 1e-9 && Math.abs(d - x.distKm) < 1e-6;
  });
}
function uniqueBy(list, key) {
  const seen = {};
  return list.every(function (x) {
    if (seen[x[key]]) return false;
    seen[x[key]] = true;
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* the tests                                                           */
/* ------------------------------------------------------------------ */
async function main() {
  /* ================================================================ */
  section('environment / PSM.cache fallback');
  eq(typeof global.indexedDB, 'undefined', 'Node has no indexedDB (PSM.cache uses its memory map)');
  await PSM.cache.set('unit:probe', { a: 1 });
  const probe = await PSM.cache.getFresh('unit:probe', 60000);
  ok(probe && probe.a === 1, 'PSM.cache round-trips through memory');
  eq(await PSM.cache.getFresh('unit:probe', -1), null, 'PSM.cache honours maxAge (stale -> null)');
  await PSM.cache.clear();
  eq(await PSM.cache.get('unit:probe'), null, 'PSM.cache.clear() empties the memory map');
  ok(typeof PSM.geocode === 'object' && typeof PSM.pota === 'object' &&
     typeof PSM.sota === 'object' && typeof PSM.spots === 'object', 'all four modules attached to PSM');

  /* ================================================================ */
  section('PSM.memo — shared in-flight requests');
  await PSM.cache.clear();
  {
    // Two searches can want the same URL at once; the second must not inherit the first's
    // AbortSignal.  (A radius nudge aborts the running search, and every /location/parks or
    // /api/regions call the new search shares with it used to fail with it.)
    let calls = 0;
    const producer = function (signal) {
      return function () {
        calls++;
        const n = calls;
        return new Promise(function (res, rej) {
          const t = setTimeout(function () { res('value-' + n); }, 30);
          signal.onabort = function () { clearTimeout(t); rej(new PSM.FetchError('timeout/abort for x', 0, 'x')); };
        });
      };
    };
    const a = { aborted: false, onabort: null, abort: function () { this.aborted = true; if (this.onabort) this.onabort(); } };
    const b = { aborted: false, onabort: null };
    const pFirst = PSM.memo('unit:race', 60000, producer(a));
    const pSecond = PSM.memo('unit:race', 60000, producer(b));
    pFirst.catch(function () { /* expected below */ });
    await PSM.sleep(5);
    a.abort();
    let firstErr = null;
    try { await pFirst; } catch (e) { firstErr = e; }
    ok(firstErr && PSM.isAbortError(firstErr), 'the caller that aborted still sees its own abort',
      firstErr && firstErr.message);
    let secondVal = null, secondErr = null;
    try { secondVal = await pSecond; } catch (e) { secondErr = e; }
    ok(secondVal === 'value-2' && !secondErr,
      'a second caller re-runs the producer instead of inheriting the abort',
      JSON.stringify({ secondVal: secondVal, err: secondErr && secondErr.message, calls: calls }));
    eq(await PSM.cache.getFresh('unit:race', 60000), 'value-2', 'the recovered value is what gets cached');
  }
  await PSM.cache.clear();

  /* ================================================================ */
  section('geocode.classify');
  const cLatLon = PSM.geocode.classify('41.2,-74.1');
  eq(cLatLon.kind, 'latlon', 'classify("41.2,-74.1") -> latlon');
  ok(cLatLon.value && Math.abs(cLatLon.value.lat - 41.2) < 1e-9 && Math.abs(cLatLon.value.lon + 74.1) < 1e-9,
    'classify latlon value carries {lat,lon}', JSON.stringify(cLatLon.value));
  const cGrid = PSM.geocode.classify('FN21ve');
  eq(cGrid.kind, 'grid', 'classify("FN21ve") -> grid');
  eq(cGrid.value, 'FN21ve', 'grid value is canonically cased');
  const cPota = PSM.geocode.classify('us-2069');
  eq(cPota.kind, 'pota', 'classify("us-2069") -> pota');
  eq(cPota.value, 'US-2069', 'POTA ref normalised');
  const cSota = PSM.geocode.classify('w2/gc-001');
  eq(cSota.kind, 'sota', 'classify("w2/gc-001") -> sota');
  eq(cSota.value, 'W2/GC-001', 'SOTA ref normalised');
  const cText = PSM.geocode.classify('Harriman State Park');
  eq(cText.kind, 'text', 'classify("Harriman State Park") -> text');
  eq(PSM.geocode.classify('k-2069').value, 'US-2069', 'legacy "K-####" classifies as US-####');

  /* ================================================================ */
  section('geocode.forward / reverse');
  resetNet();
  await PSM.cache.clear();
  PSM.geocode.nominatimMinIntervalMs = 60;    // keep the suite quick (default is 1100)

  const fwd = await PSM.geocode.forward('Harriman State Park');
  eq(fwd.source, 'photon', 'forward() prefers Photon');
  ok(requestsMatching('photon.komoot.io/api/').length === 1, 'forward() called the Photon search endpoint');
  ok(requestsMatching('q=Harriman%20State%20Park').length === 1, 'forward() URL-encodes the query',
    requests.join('\n'));
  near(fwd.lat, 41.1753, 1e-6, 'forward() latitude');
  near(fwd.lon, -74.1783, 1e-6, 'forward() longitude');
  eq(fwd.label, 'Harriman State Park, Rockland County, New York, United States', 'forward() builds a Photon label');

  const fwdNear = await PSM.geocode.forward('Harriman State Park', { near: { lat: 41.2, lon: -74.1 } });
  ok(requestsMatching('lat=41.2&lon=-74.1').length === 1, 'forward({near}) biases Photon with lat/lon');
  eq(fwdNear.source, 'photon', 'forward({near}) still uses Photon');

  resetNet();
  setFailing(['photon.komoot.io']);
  const fwdNom = await PSM.geocode.forward('Harriman State Park');
  eq(fwdNom.source, 'nominatim', 'forward() falls back to Nominatim when Photon fails');
  eq(fwdNom.label, 'Harriman State Park, Rockland County, New York, United States',
    'Nominatim label is display_name');
  near(fwdNom.lat, 41.1753, 1e-6, 'Nominatim latitude parsed from its string');
  ok(requestsMatching('format=jsonv2').length === 1, 'Nominatim search uses format=jsonv2&addressdetails=1');

  // Throttle: consecutive Nominatim calls are spaced by nominatimMinIntervalMs.
  const t0 = Date.now();
  await PSM.geocode.forward('Harriman State Park');
  await PSM.geocode.forward('Harriman State Park');
  ok(Date.now() - t0 >= 60, 'Nominatim calls are throttled (module-level gate)', 'elapsed ' + (Date.now() - t0) + ' ms');

  setFailing(['photon.komoot.io', 'nominatim.openstreetmap.org']);
  await throws(function () { return PSM.geocode.forward('Nowhere at all'); },
    function (e) { return /^No results for "Nowhere at all"/.test(e.message) && /service failed/.test(e.message); },
    'forward() with both services down throws "No results for …" mentioning the failure');

  resetNet();
  await PSM.cache.clear();
  const rev = await PSM.geocode.reverse(41.175, -74.18);
  eq(rev.source, 'photon', 'reverse() prefers Photon');
  ok(rev.label.indexOf('Seven Lakes Drive') >= 0, 'reverse() label contains the road', rev.label);
  eq(rev.label, 'Seven Lakes Drive, Sloatsburg, NY 10974', 'reverse() label is a one-line address');
  eq(rev.parts.city, 'Sloatsburg', 'reverse() parts.city');
  eq(rev.parts.state, 'New York', 'reverse() parts.state');
  eq(rev.parts.postcode, '10974', 'reverse() parts.postcode');
  const before = requests.length;
  const rev2 = await PSM.geocode.reverse(41.17501, -74.18002);
  eq(rev2.label, rev.label, 'reverse() is cached at 4 decimals');
  eq(requests.length, before, 'the cached reverse geocode issued no request');
  ok((await PSM.cache.get('rev:41.1750,-74.1800')) !== null, 'reverse cache key is "rev:<lat4>,<lon4>"');

  await PSM.cache.clear();
  setFailing(['photon.komoot.io']);
  const revNom = await PSM.geocode.reverse(41.175, -74.18);
  eq(revNom.source, 'nominatim', 'reverse() falls back to Nominatim');
  ok(revNom.label.indexOf('Seven Lakes Drive') >= 0, 'Nominatim reverse label contains the road', revNom.label);
  eq(revNom.parts.city, 'Sloatsburg', 'Nominatim reverse maps town -> city');
  resetNet();

  /* ================================================================ */
  section('pota.toPark / displayName / parkUrl');
  const pList = PSM.pota.toPark(NY_PARKS.find(function (p) { return p.reference === 'US-2069'; }));
  ok(pList.ref === 'US-2069' && pList.name === 'Harriman State Park' && pList.lat === 41.1753 &&
     pList.lon === -74.1783 && pList.grid === 'FN21ve' && pList.loc === 'US-NY' &&
     pList.attempts === 12 && pList.activations === 12 && pList.qsos === 300,
    'toPark(/location/parks row)', JSON.stringify(pList));
  const pGrid = PSM.pota.toPark(fixture('pota_park_grid_FN21.json').find(function (p) { return p.reference === 'US-2069'; }));
  ok(pGrid.ref === 'US-2069' && pGrid.attempts === null && pGrid.grid === null, 'toPark(/park/grid row)', JSON.stringify(pGrid));
  const pDetail = PSM.pota.toPark(fixture('pota_park_US-2069.json'));
  ok(pDetail.ref === 'US-2069' && pDetail.name === 'Harriman State Park' && pDetail.grid === 'FN21ve' &&
     pDetail.active === 1, 'toPark(/park/{ref} detail) appends parktypeDesc', JSON.stringify(pDetail));
  const pCsv = PSM.pota.toPark(['US-2069', 'Harriman State Park', '1', '291', 'US-NY', '41.1753', '-74.1783', 'FN21ve'],
    ['reference', 'name', 'active', 'entityId', 'locationDesc', 'latitude', 'longitude', 'grid']);
  ok(pCsv.ref === 'US-2069' && pCsv.lat === 41.1753 && pCsv.active === 1 && pCsv.loc === 'US-NY',
    'toPark(all_parks_ext.csv row + header)', JSON.stringify(pCsv));
  const pSnap = PSM.pota.toPark(['US-2069', 'Harriman State Park', 41.1753, -74.1783, 'FN21ve', 'US-NY', 1],
    PSM.pota.SNAPSHOT_COLUMNS);
  ok(pSnap.ref === 'US-2069' && pSnap.lon === -74.1783 && pSnap.grid === 'FN21ve', 'toPark(snapshot row + columns)',
    JSON.stringify(pSnap));
  const pLookup = PSM.pota.toPark({ type: 'park', id: 2069, display: 'US-2069  Harriman State Park', value: 'US-2069' });
  ok(pLookup.ref === 'US-2069' && pLookup.name === 'Harriman State Park',
    'toPark(/lookup row) strips the reference out of `display`', JSON.stringify(pLookup));
  eq(PSM.pota.toPark({ name: 'no ref' }), null, 'toPark() rejects rows without a reference');
  eq(PSM.pota.toPark({ reference: 'k-2069', latitude: 1, longitude: 2 }).ref, 'US-2069', 'toPark normalises K- refs');
  eq(PSM.pota.displayName(fixture('pota_park_US-2069.json')), 'Harriman State Park', 'displayName(detail)');
  eq(PSM.pota.displayName({ name: 'Harriman State Park', parktypeDesc: 'State Park' }), 'Harriman State Park',
    'displayName does not double the park type');
  eq(PSM.pota.parkUrl('k-2069'), 'https://pota.app/#/park/US-2069', 'parkUrl()');
  eq(PSM.pota.BASE, 'https://api.pota.app', 'PSM.pota.BASE exported');

  /* ================================================================ */
  section('pota.loadNear — state lists');
  await PSM.cache.clear();
  resetNet();
  const progress = [];
  const stateRes = await PSM.pota.loadNear(POTA_CENTER, POTA_RADIUS, {
    onProgress: function (msg, frac) { progress.push([msg, frac]); }
  });
  eq(stateRes.source, 'state', 'source is "state"');
  ok(stateRes.parks.length > 20, 'found parks near Harriman', stateRes.parks.length + ' parks');
  const harriman = stateRes.parks.find(function (p) { return p.ref === 'US-2069'; });
  ok(!!harriman, 'US-2069 Harriman State Park is in the results');
  eq(harriman.name, 'Harriman State Park', 'list name is the full park name');
  ok(harriman.distKm < 10, 'US-2069 distKm < 10 km', String(harriman.distKm));
  ok(harriman.attempts === 12 && harriman.activations === 12 && harriman.qsos === 300,
    'state list carries attempts/activations/qsos', JSON.stringify(harriman));
  ok(isSorted(stateRes.parks, 'distKm'), 'parks sorted by distKm');
  ok(allWithin(stateRes.parks, POTA_CENTER, POTA_RADIUS), 'every park is inside the radius with distKm set');
  ok(uniqueBy(stateRes.parks, 'ref'), 'parks de-duplicated by ref');
  ok(stateRes.warnings.some(function (w) { return w.indexOf('US-NJ') >= 0; }),
    'a missing state list becomes a warning', JSON.stringify(stateRes.warnings));
  ok(progress.some(function (p) { return /Loading POTA parks \(US-NY\)/.test(p[0]) && p[1] >= 0 && p[1] <= 1; }),
    'onProgress reports the state being loaded', JSON.stringify(progress.slice(0, 3)));
  eq(requestsMatching('/location/parks/US-NY').length, 1, 'the state list is fetched once');

  // second call: served from PSM.memo's cache
  const cachedRes = await PSM.pota.loadNear(POTA_CENTER, POTA_RADIUS, {});
  eq(requestsMatching('/location/parks/US-NY').length, 1, 'a repeat search reuses the 24 h cache');
  eq(cachedRes.parks.length, stateRes.parks.length, 'cached search returns the same parks');

  /* --- abort --------------------------------------------------- */
  await PSM.cache.clear();
  const ctrl = { aborted: true };
  await throws(function () { return PSM.pota.loadNear(POTA_CENTER, POTA_RADIUS, { signal: ctrl }); },
    function (e) { return e.name === 'AbortError'; }, 'loadNear() honours an already-aborted signal');

  /* ================================================================ */
  section('pota.loadNear — /park/grid fallback');
  await PSM.cache.clear();
  resetNet();
  const logMark = psmLogs.length;
  setFailing(['api.pota.app/location']);
  const gridRes = await PSM.pota.loadNear(POTA_CENTER, POTA_RADIUS, {});
  eq(gridRes.source, 'grid', 'source is "grid" when the state lists fail');
  ok(loggedSince(logMark, 'falling back to /park/grid'), 'the fallback is logged');
  ok(requestsMatching('/park/grid/FN21').length === 1, 'FN21 grid cell requested', requests.join('\n'));
  const gridHarriman = gridRes.parks.find(function (p) { return p.ref === 'US-2069'; });
  ok(!!gridHarriman, 'US-2069 found through the grid endpoint');
  ok(gridHarriman.distKm < 10, 'grid result carries distKm', String(gridHarriman && gridHarriman.distKm));
  eq(gridHarriman.attempts, null, 'grid rows have no stats and enrichment could not reach the state list');
  ok(isSorted(gridRes.parks, 'distKm'), 'grid parks sorted by distKm');
  ok(allWithin(gridRes.parks, POTA_CENTER, POTA_RADIUS), 'grid parks are inside the radius');
  ok(uniqueBy(gridRes.parks, 'ref'), 'grid parks de-duplicated by ref');
  ok(gridRes.warnings.length > 0, 'grid fallback reports warnings', JSON.stringify(gridRes.warnings.slice(0, 3)));
  setFailing([]);

  // Nothing reachable at all: still resolves, with warnings rather than an exception.
  await PSM.cache.clear();
  const emptyRes = await PSM.pota.loadNear({ lat: 0, lon: 0 }, 10, {});
  ok(Array.isArray(emptyRes.parks) && emptyRes.parks.length === 0 && emptyRes.source === 'grid' &&
     emptyRes.warnings.length > 0, 'loadNear() over open ocean returns an empty list, not an error',
    JSON.stringify(emptyRes.warnings.slice(0, 2)));

  /* ================================================================ */
  section('pota.loadNear — snapshot + stats enrichment');
  await PSM.cache.clear();
  resetNet();
  global.PSM_SNAPSHOT = {
    generated: '2026-08-31T14:00:00Z',
    pota: {
      columns: ['ref', 'name', 'lat', 'lon', 'grid', 'loc', 'active'],
      rows: NY_PARKS.map(function (p) {
        return [p.reference, p.name, p.latitude, p.longitude, p.grid, p.locationDesc, 1];
      })
    }
  };
  const snapRes = await PSM.pota.loadNear(POTA_CENTER, POTA_RADIUS, {});
  eq(snapRes.source, 'snapshot', 'source is "snapshot" when window.PSM_SNAPSHOT.pota exists');
  const snapHarriman = snapRes.parks.find(function (p) { return p.ref === 'US-2069'; });
  ok(!!snapHarriman, 'US-2069 found in the snapshot');
  ok(snapHarriman.attempts === 12 && snapHarriman.activations === 12 && snapHarriman.qsos === 300,
    'snapshot parks are enriched with state-list stats', JSON.stringify(snapHarriman));
  eq(requestsMatching('/location/parks/US-NY').length, 1, 'enrichment fetched exactly the covering state list');
  ok(isSorted(snapRes.parks, 'distKm'), 'snapshot parks sorted by distKm');
  ok(allWithin(snapRes.parks, POTA_CENTER, POTA_RADIUS), 'snapshot parks are inside the radius');
  eq(snapRes.parks.length, stateRes.parks.length, 'snapshot and state list agree on the park count');

  // A snapshot that does not cover the search area must not blind the API cascade.
  await PSM.cache.clear();
  resetNet();
  const outside = await PSM.pota.loadNear({ lat: 0, lon: 0 }, 10, {});
  eq(outside.source, 'grid', 'a snapshot with no parks in the area falls through to the API');

  // searchAll() uses the snapshot when there is one
  const snapSearch = await PSM.pota.searchAll('harriman');
  ok(snapSearch.length >= 1 && snapSearch[0].ref === 'US-2069', 'searchAll() finds Harriman in the snapshot',
    JSON.stringify(snapSearch.slice(0, 3)));
  global.PSM_SNAPSHOT = null;

  /* ================================================================ */
  section('pota detail endpoints');
  await PSM.cache.clear();
  resetNet();
  const detail = await PSM.pota.getPark('k-2069');
  eq(detail.reference, 'US-2069', 'getPark("k-2069") normalises to US-2069');
  eq(PSM.pota.displayName(detail), 'Harriman State Park', 'displayName(getPark(…)) -> "Harriman State Park"');
  await PSM.pota.getPark('US-2069');
  eq(requestsMatching('/park/US-2069').length, 1, 'getPark caches for 24 h');
  eq(await PSM.pota.getPark('US-9999'), null, 'getPark() returns null for an unknown ref (API sends 200 null)');
  eq(await PSM.cache.get('pota:park:US-9999'), null, 'null park results are not cached');

  const stats = await PSM.pota.getStats('US-2069');
  ok(stats && stats.attempts === 212 && stats.activations === 198 && stats.contacts === 6120, 'getStats()',
    JSON.stringify(stats));
  const acts = await PSM.pota.getActivations('US-2069', 10);
  ok(Array.isArray(acts) && acts.length === 2 && acts[0].activeCallsign === 'WK2S', 'getActivations()',
    JSON.stringify(acts && acts[0]));
  ok(requestsMatching('count=10').length === 1, 'getActivations passes ?count=N');
  const leader = await PSM.pota.getLeaderboard('US-2069', 5);
  ok(leader && leader.activations[0].callsign === 'WK2S', 'getLeaderboard()', JSON.stringify(leader && leader.activations));
  ok(requestsMatching('/park/leaderboard/US-2069?count=5').length === 1, 'getLeaderboard passes ?count=5');
  const hits = await PSM.pota.lookup('harriman');
  ok(Array.isArray(hits) && hits.length === 1 && hits[0].value === 'US-2069', 'lookup()', JSON.stringify(hits));
  const searched = await PSM.pota.searchAll('harriman');
  ok(searched.length === 1 && searched[0].ref === 'US-2069' && searched[0].name === 'Harriman State Park',
    'searchAll() without a snapshot goes through lookup() + getPark()', JSON.stringify(searched));
  setFailing(['api.pota.app']);
  await PSM.cache.clear();
  eq((await PSM.pota.lookup('harriman')).length, 0, 'lookup() swallows API failures');
  eq(await PSM.pota.getStats('US-2069'), null, 'getStats() swallows API failures');
  setFailing([]);

  /* ================================================================ */
  section('sota.toSummit / isValid');
  const sApi = PSM.sota.toSummit(GC_REGION.summits[0], null, { assocName: 'USA - NJ / NY', regionName: 'Greater Catskills' });
  ok(sApi.code === 'W2/GC-001' && sApi.assoc === 'W2' && sApi.region === 'GC' && sApi.name === 'Slide Mountain' &&
     sApi.points === 10 && sApi.bonus === 3 && sApi.locator === 'FN21tx',
    'toSummit(API region row) derives assoc/region from the code', JSON.stringify(sApi));
  eq(sApi.validFrom, '2010-05-01', 'toSummit parses "2010-05-01T00:00:00" -> ISO date');
  eq(sApi.validTo, '2099-12-31', 'toSummit parses the 2099 sentinel');
  eq(sApi.assocName, 'USA - NJ / NY', 'toSummit takes assocName from the caller hint');
  const sDetail = PSM.sota.toSummit(fixture('sota_summit_W2_GC-001.json'));
  ok(sDetail.code === 'W2/GC-001' && sDetail.altM === 1172 && sDetail.altFt === 3845 &&
     sDetail.assocName === 'USA - NJ / NY' && sDetail.regionName === 'Greater Catskills',
    'toSummit(API detail)', JSON.stringify(sDetail));
  const CSV_HEADER = ('SummitCode,AssociationName,RegionName,SummitName,AltM,AltFt,GridRef1,GridRef2,Longitude,' +
    'Latitude,Points,BonusPoints,ValidFrom,ValidTo,ActivationCount,ActivationDate,ActivationCall').split(',');
  const sCsv = PSM.sota.toSummit(
    ['3B8/MU-001', 'Mauritius', 'Mauritius', 'Piton de la Petite Rivière Noire', '828', '2716',
      '57.40771', '-20.40882', '57.40771', '-20.40882', '10', '0', '01/08/2026', '31/12/2099', '1', '29/08/2026', 'FR1JB'],
    CSV_HEADER);
  ok(sCsv.code === '3B8/MU-001' && sCsv.assoc === '3B8' && sCsv.region === 'MU' && sCsv.altM === 828 &&
     sCsv.lat === -20.40882 && sCsv.lon === 57.40771, 'toSummit(CSV row + header)', JSON.stringify(sCsv));
  eq(sCsv.validFrom, '2026-08-01', 'toSummit parses DD/MM/YYYY "01/08/2026" -> "2026-08-01"');
  eq(sCsv.validTo, '2099-12-31', 'toSummit parses DD/MM/YYYY "31/12/2099"');
  eq(sCsv.actDate, '2026-08-29', 'toSummit parses the CSV activation date');
  eq(sCsv.actCall, 'FR1JB', 'toSummit reads ActivationCall');
  eq(PSM.sota.toSummit({ summitCode: 'W7I/SI-001', activationCallsign: 'WB7ABP', latitude: 1, longitude: 2 }).actCall,
    'WB7ABP', 'toSummit accepts the alternate activationCallsign spelling');
  eq(PSM.sota.toSummit({ SummitCode: 'W2/GC-001', AltM: '1172', Latitude: '1', Longitude: '2' }).altM, 1172,
    'toSummit is case-insensitive about field names');
  eq(PSM.sota.toSummit({ summitCode: 'GC-001', latitude: 1, longitude: 2 }, null, { assoc: 'W2' }).code, 'W2/GC-001',
    'toSummit prefixes a bare summit code with the association');
  eq(PSM.sota.toSummit({ summitCode: 'W2/GC-001', validTo: 'no idea', latitude: 1, longitude: 2 }).validTo, null,
    'toSummit turns an unparseable date into null (never a lexicographic landmine)');
  eq(PSM.sota.toSummit(null), null, 'toSummit(null) -> null');
  const sSnap = PSM.sota.toSummit(['W2/GC-001', 'Slide Mountain', 41.9991, -74.3862, 1172, 3845, 10, 3,
    '2010-05-01', '2099-12-31', 0, null, null, 'USA - NJ / NY', 'Greater Catskills'], PSM.sota.COMPACT_COLUMNS);
  ok(sSnap.code === 'W2/GC-001' && sSnap.altFt === 3845 && sSnap.regionName === 'Greater Catskills',
    'toSummit(snapshot row + columns)', JSON.stringify(sSnap));

  ok(PSM.sota.isValid({ validFrom: '2010-05-01', validTo: '2099-12-31' }, '2026-08-31'), 'isValid() current summit');
  ok(!PSM.sota.isValid({ validFrom: '2010-05-01', validTo: '2015-12-31' }, '2026-08-31'), 'isValid() retired summit');
  ok(!PSM.sota.isValid({ validFrom: '2027-01-01', validTo: '2099-12-31' }, '2026-08-31'), 'isValid() not yet valid');
  ok(PSM.sota.isValid({ validFrom: null, validTo: null }, '2026-08-31'), 'isValid() tolerates missing dates');
  eq(PSM.sota.summitUrls('w2/gc-001').sotlas, 'https://sotl.as/summits/W2/GC-001', 'summitUrls().sotlas');
  eq(PSM.sota.summitUrls('W2/GC-001').sotadata, 'https://www.sotadata.org.uk/en/summit/W2/GC-001', 'summitUrls().sotadata');

  /* ================================================================ */
  section('sota.loadNear — API cascade');
  await PSM.cache.clear();
  resetNet();
  const sotaProgress = [];
  const apiRes = await PSM.sota.loadNear(SOTA_CENTER, SOTA_RADIUS, {
    onProgress: function (msg, frac) { sotaProgress.push([msg, frac]); }
  });
  eq(apiRes.source, 'api', 'source is "api"');
  ok(apiRes.summits.length > 20, 'summits found near the Catskills', apiRes.summits.length + ' summits');
  eq(apiRes.summits[0].code, 'W2/GC-001', 'nearest summit is W2/GC-001 Slide Mountain');
  ok(apiRes.summits.every(function (s) { return s.assoc === 'W2' && s.region === 'GC'; }), 'all summits are W2/GC');
  ok(isSorted(apiRes.summits, 'distKm'), 'summits sorted by distKm');
  ok(allWithin(apiRes.summits, SOTA_CENTER, SOTA_RADIUS), 'every summit is inside the radius with distKm set');
  ok(!apiRes.summits.some(function (s) { return s.code === 'W2/GC-999'; }),
    'the retired summit (validTo 2015-12-31) is excluded');
  ok(apiRes.summits[0].assocName === 'USA - NJ / NY' && apiRes.summits[0].regionName === 'Greater Catskills',
    'association/region names are attached from the region response');
  ok(sotaProgress.some(function (p) { return /W2\/GC/.test(p[0]); }), 'onProgress reports each region');
  eq(requestsMatching('/api/associations').length, 3, 'associations + the two intersecting association details');
  ok(requestsMatching('/api/associations/W6').length === 0, 'associations outside the bbox are skipped');

  const retiredRes = await PSM.sota.loadNear(SOTA_CENTER, SOTA_RADIUS, { includeRetired: true });
  ok(retiredRes.summits.some(function (s) { return s.code === 'W2/GC-999'; }),
    'includeRetired:true keeps the retired summit');

  // One failing region must not sink the whole search (and must not trigger the CSV).
  await PSM.cache.clear();
  resetNet();
  setFailing(['/api/regions/W2/GC']);
  const partial = await PSM.sota.loadNear(SOTA_CENTER, SOTA_RADIUS, {});
  eq(partial.source, 'api', 'a failing region keeps the API source');
  ok(partial.warnings.some(function (w) { return w.indexOf('W2/GC') >= 0; }), 'the failing region is a warning',
    JSON.stringify(partial.warnings));
  eq(requestsMatching('summitslist.csv').length, 0, 'a region failure does not trigger the 20 MB CSV');
  setFailing([]);

  /* --- every association failing -> CSV -------------------------- */
  section('sota.loadNear — CSV fallback');
  await PSM.cache.clear();
  resetNet();
  setFailing(['api2.sota.org.uk/api/associations']);
  const csvRes = await PSM.sota.loadNear(SOTA_CENTER, SOTA_RADIUS, {});
  eq(csvRes.source, 'csv', 'source is "csv" when the association list is unreachable');
  ok(requestsMatching('storage.sota.org.uk/summitslist.csv').length === 1, 'the bulk CSV was downloaded once');
  eq(csvRes.summits.length, apiRes.summits.length, 'CSV and API paths agree on the summit count');
  eq(csvRes.summits[0].code, 'W2/GC-001', 'CSV path finds Slide Mountain first');
  eq(csvRes.summits[0].assocName, 'USA - NJ / NY', 'CSV carries the association name');
  eq(csvRes.summits[0].validFrom, '2010-05-01', 'CSV dates parsed to ISO');
  ok(!csvRes.summits.some(function (s) { return s.code === 'W2/GC-999'; }), 'CSV path also drops the retired summit');
  ok(isSorted(csvRes.summits, 'distKm'), 'CSV summits sorted by distKm');
  ok(allWithin(csvRes.summits, SOTA_CENTER, SOTA_RADIUS), 'CSV summits are inside the radius');
  const cachedCsv = await PSM.cache.getFresh('sota:csv', 60000);
  ok(Array.isArray(cachedCsv) && Array.isArray(cachedCsv[0]) && cachedCsv[0].length === PSM.sota.COMPACT_COLUMNS.length,
    'the CSV is cached as compact rows', JSON.stringify(cachedCsv && cachedCsv[0]));
  setFailing([]);

  /* --- snapshot -------------------------------------------------- */
  section('sota.loadNear — snapshot');
  await PSM.cache.clear();
  resetNet();
  global.PSM_SNAPSHOT = {
    sota: {
      columns: PSM.sota.COMPACT_COLUMNS,
      rows: GC_REGION.summits.map(function (s) {
        return [s.summitCode, s.name, s.latitude, s.longitude, s.altM, s.altFt, s.points, s.bonusPoints,
          String(s.validFrom).slice(0, 10), String(s.validTo).slice(0, 10), s.activationCount,
          s.activationDate ? String(s.activationDate).slice(0, 10) : null, s.activationCall,
          'USA - NJ / NY', 'Greater Catskills'];
      })
    }
  };
  const sotaSnapRes = await PSM.sota.loadNear(SOTA_CENTER, SOTA_RADIUS, {});
  eq(sotaSnapRes.source, 'snapshot', 'source is "snapshot" when window.PSM_SNAPSHOT.sota exists');
  eq(sotaSnapRes.summits.length, apiRes.summits.length, 'snapshot and API paths agree on the summit count');
  eq(requests.length, 0, 'the snapshot path makes no network calls');
  global.PSM_SNAPSHOT = null;

  /* ================================================================ */
  section('sota.getSummit');
  await PSM.cache.clear();
  resetNet();
  const summit = await PSM.sota.getSummit('w2/gc-001');
  eq(summit.summitCode, 'W2/GC-001', 'getSummit("w2/gc-001") normalises the code');
  eq(summit.regionName, 'Greater Catskills', 'getSummit returns the full detail object');
  await PSM.sota.getSummit('W2/GC-001');
  eq(requestsMatching('/api/summits/W2/GC-001').length, 1, 'getSummit caches for 24 h');
  eq(await PSM.sota.getSummit('W2/ZZ-999'), null, 'getSummit returns null on 404');

  /* ================================================================ */
  section('spots');
  await PSM.cache.clear();
  resetNet();
  const spots = await PSM.spots.fetchAll();
  eq(spots.pota.length, 1, 'one POTA spot');
  const ps = spots.pota[0];
  ok(ps.program === 'pota' && ps.ref === 'US-2069' && ps.freqKHz === 14285 && ps.mode === 'SSB' &&
     ps.activator === 'WK2S' && ps.spotter === 'N2XYZ' && ps.name === 'Harriman State Park' &&
     ps.lat === 41.1753 && ps.lon === -74.1783 && ps.loc === 'US-NY',
    'POTA spot normalised (freqKHz 14285)', JSON.stringify(ps));
  eq(ps.timeISO, '2026-08-31T14:00:00Z', 'POTA spotTime becomes an ISO instant');
  eq(spots.sota.length, 1, 'one SOTA spot');
  const ss = spots.sota[0];
  ok(ss.program === 'sota' && ss.ref === 'W2/GC-001' && ss.freqKHz === 14062 && ss.mode === 'CW' &&
     ss.activator === 'W2XYZ' && ss.spotter === 'N2SPOT' && ss.name === 'Slide Mountain' &&
     ss.lat === null && ss.lon === null,
    'SOTA spot normalised (bare summitCode + MHz -> kHz 14062)', JSON.stringify(ss));
  ok(typeof spots.fetchedAt === 'string' && !isNaN(new Date(spots.fetchedAt)), 'fetchAll() stamps fetchedAt');
  eq(PSM.spots._khzFromMhz('7.032'), 7032, 'MHz -> kHz avoids float dust');
  eq(PSM.spots._khzFromKhz('10119.9'), 10119.9, 'kHz strings keep their decimal');

  const beforeSpots = requests.length;
  await PSM.spots.fetchAll();
  eq(requests.length, beforeSpots, 'spot feeds are cached for 60 s');

  await PSM.cache.clear();
  setFailing(['api.pota.app', 'api2.sota.org.uk']);
  const deadFeeds = await PSM.spots.fetchAll();
  ok(Array.isArray(deadFeeds.pota) && deadFeeds.pota.length === 0 && deadFeeds.sota.length === 0,
    'fetchAll() never rejects — dead feeds yield []');
  eq(deadFeeds.warnings.length, 2, 'both failures are reported as warnings', JSON.stringify(deadFeeds.warnings));
  setFailing([]);

  await PSM.cache.clear();
  let ticks = 0;
  let lastUpdate = null;
  await PSM.spots.start(600000, function (r) { ticks++; lastUpdate = r; });
  ok(ticks === 1 && lastUpdate && lastUpdate.pota.length === 1, 'start() polls immediately', 'ticks=' + ticks);
  ok(PSM.spots.isRunning(), 'start() schedules the next poll');
  PSM.spots.stop();
  ok(!PSM.spots.isRunning(), 'stop() clears the interval');

  // Unticking "Live spots" while a poll is in flight must not deliver that poll afterwards,
  // or the layer the user just switched off comes straight back.
  await PSM.cache.clear();
  let lateTicks = 0;
  const pending = PSM.spots.start(600000, function () { lateTicks++; });
  PSM.spots.stop();
  await pending;
  await PSM.sleep(20);
  eq(lateTicks, 0, 'a poll that lands after stop() does not call onUpdate');

  /* ================================================================ */
  section('geocode.resolve');
  await PSM.cache.clear();
  resetNet();
  const rPota = await PSM.geocode.resolve('US-2069');
  ok(rPota.source === 'pota' && rPota.ref === 'US-2069' && rPota.label === 'Harriman State Park' &&
     Math.abs(rPota.lat - 41.1753) < 1e-6 && Math.abs(rPota.lon + 74.1783) < 1e-6,
    'resolve("US-2069") -> centre with ref', JSON.stringify(rPota));
  const rSota = await PSM.geocode.resolve('W2/GC-001');
  ok(rSota.source === 'sota' && rSota.code === 'W2/GC-001' && rSota.label === 'Slide Mountain' &&
     Math.abs(rSota.lat - 41.9991) < 1e-6 && Math.abs(rSota.lon + 74.3862) < 1e-6,
    'resolve("W2/GC-001") -> centre with code', JSON.stringify(rSota));
  const rLatLon = await PSM.geocode.resolve('41.2, -74.1');
  ok(rLatLon.source === 'latlon' && Math.abs(rLatLon.lat - 41.2) < 1e-9, 'resolve("41.2, -74.1")', JSON.stringify(rLatLon));
  const rGrid = await PSM.geocode.resolve('FN21ve');
  ok(rGrid.source === 'grid' && Math.abs(rGrid.lat - 41.1875) < 0.03 && Math.abs(rGrid.lon + 74.208) < 0.05,
    'resolve("FN21ve") -> grid square centre', JSON.stringify(rGrid));
  const rText = await PSM.geocode.resolve('Harriman State Park');
  ok(rText.source === 'geocode' && rText.via === 'photon' && Math.abs(rText.lat - 41.1753) < 1e-6,
    'resolve(free text) -> forward geocode', JSON.stringify(rText));
  await throws(function () { return PSM.geocode.resolve('US-9999'); },
    function (e) { return /Unknown POTA reference/.test(e.message); }, 'resolve() throws for an unknown POTA ref');
  await throws(function () { return PSM.geocode.resolve('W2/ZZ-999'); },
    function (e) { return /Unknown SOTA reference/.test(e.message); }, 'resolve() throws for an unknown SOTA ref');

  /* ================================================================ */
  PSM.geocode.nominatimMinIntervalMs = 1100;
  console.log('\n' + (failures.length ? 'FAILED' : 'PASSED') + ': ' + passed + ' assertions passed, ' +
    failures.length + ' failed');
  if (failures.length) {
    failures.forEach(function (f) { console.log('  - ' + f); });
    process.exit(1);
  }
}

main().then(function () {
  process.exit(failures.length ? 1 : 0);
}, function (e) {
  console.error('\nUNEXPECTED ERROR:', e && e.stack || e);
  process.exit(2);
});
