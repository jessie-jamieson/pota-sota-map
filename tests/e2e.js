#!/usr/bin/env node
'use strict';
/* =============================================================================================
 * tests/e2e.js — offline Playwright end-to-end harness for pota-sota-map.html
 *
 *   node tests/e2e.js                              # run every scenario against pota-sota-map.html
 *   node tests/e2e.js --only loads,search-latlon    # run just these scenarios (comma list)
 *   node tests/e2e.js --app tests/standin.html --only loads   # smoke-test the harness itself
 *   node tests/e2e.js --headed                      # show the browser while it runs
 *
 * No test framework: plain Node, prints "PASS/FAIL/SKIP <scenario>" per scenario, and exits
 * non-zero if any scenario FAILs (SKIPs do not fail the run — see README-tests.md).
 *
 * Every scenario gets its own BrowserContext with tests/mock-network.js installed, so every
 * external host the app talks to (CDN libs, map tiles, POTA/SOTA APIs, geocoders, Overpass, the
 * SOTA CSV) is answered from local fixtures/vendor files — this suite makes zero real network
 * calls. See tests/README-tests.md for the full list of what is mocked and how to add fixtures.
 * ============================================================================================= */

const fs = require('fs');
const path = require('path');
const http = require('http');

const { installMocks } = require('./mock-network');

let playwright;
try {
  playwright = require('playwright');
} catch (e) {
  // Fall back to the known global install location documented for this sandbox.
  playwright = require('/home/claude/.npm-global/lib/node_modules/playwright');
}
const { chromium } = playwright;

const ROOT = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const OUT_DIR = path.join(__dirname, 'out');

const DEFAULT_TIMEOUT_MS = 20000; // "Bounded waits ... 20 s" for every wait in this file unless noted
const READY_TIMEOUT_MS = 10000; // scenario "loads" wants psm-ready within 10 s
const SPOTS_NETWORK_TIMEOUT_MS = 5000; // scenario "spots" wants the spot requests within 5 s

/* ------------------------------------------------------------------------------------------- */
/* small helpers                                                                                 */
/* ------------------------------------------------------------------------------------------- */

class SkipError extends Error {}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll a synchronous Node-side predicate (e.g. checking mocks.requests) until it is true. */
async function waitForNode(predicate, timeoutMs, intervalMs) {
  intervalMs = intervalMs || 100;
  const start = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - start >= timeoutMs) return predicate();
    await sleep(intervalMs);
  }
}

function assertApprox(actual, expected, eps, label) {
  if (typeof actual !== 'number' || !isFinite(actual)) {
    throw new Error(label + ' is not a finite number: ' + JSON.stringify(actual));
  }
  if (Math.abs(actual - expected) > eps) {
    throw new Error(label + ' expected ≈ ' + expected + ' (±' + eps + ') but got ' + actual);
  }
}

function assertIncludesAll(text, needles, where) {
  const missing = needles.filter((s) => !text.includes(s));
  if (missing.length) {
    throw new Error(where + ' missing: ' + JSON.stringify(missing) + '\n  text was: ' + text.slice(0, 500));
  }
}

/** Wait for window.PSM.app to exist and for its `ready` promise to settle, itself time-boxed
 *  from inside the page (so a bug that never resolves `ready` cannot hang this script). */
async function waitForAppReady(page, timeoutMs) {
  timeoutMs = timeoutMs || READY_TIMEOUT_MS;
  await page.waitForFunction(
    () => !!(window.PSM && window.PSM.app && typeof window.PSM.app.search === 'function'),
    null,
    { timeout: timeoutMs }
  );
  await page.evaluate((ms) => {
    return Promise.race([
      Promise.resolve(window.PSM.app.ready).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, ms)),
    ]);
  }, timeoutMs);
}

/** Fire PSM.app.search()/openPark()/etc. WITHOUT awaiting its promise inside the page — the
 *  scenario separately waits on a bounded, state-based condition afterward. This keeps every
 *  wait in this file bounded even if the app's promise never settles. */
async function fireAndForget(page, methodPath, ...args) {
  await page.evaluate(
    ({ methodPath, args }) => {
      const parts = methodPath.split('.');
      let obj = window;
      for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
      const fn = obj[parts[parts.length - 1]];
      const p = fn.apply(obj, args);
      if (p && typeof p.catch === 'function') p.catch(() => {}); // avoid an unhandled-rejection page error
    },
    { methodPath, args }
  );
}

async function waitForResults(page, timeoutMs) {
  await page.waitForFunction(() => document.body.classList.contains('psm-results'), null, {
    timeout: timeoutMs || DEFAULT_TIMEOUT_MS,
  });
}

async function getState(page) {
  return page.evaluate(() => window.PSM.app.state);
}

async function getLogMessages(page) {
  return page.evaluate(() => (window.PSM.logEntries || []).map((e) => e.msg));
}

async function setRadiusMi(page, mi) {
  await page.evaluate((v) => {
    const el = document.getElementById('radius-range');
    if (!el) throw new Error('#radius-range not found in the page');
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, mi);
}

/** mocks.overpassQueries entries are the raw POST body ("data=<urlencoded query>"); decode it. */
function decodeOverpassBody(raw) {
  if (!raw) return '';
  const m = /^data=([\s\S]*)$/.exec(raw);
  const enc = m ? m[1] : raw;
  try {
    return decodeURIComponent(enc.replace(/\+/g, ' '));
  } catch (e) {
    return enc;
  }
}

function readJSON(absPath) {
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

/* ------------------------------------------------------------------------------------------- */
/* fallback "snapshot" fixture — used only if tests/fixtures/snapshot_sample.js does not exist   */
/* yet (it is being generated by another agent concurrently; see tests/README-tests.md).         */
/* ------------------------------------------------------------------------------------------- */
function buildFallbackSnapshotJs() {
  let summit = { lat: 41.9991, lon: -74.3862, altM: 1172, altFt: 3845, points: 10, bonus: 3 };
  try {
    const s = readJSON(path.join(FIXTURES_DIR, 'sota_summit_W2_GC-001.json'));
    summit = {
      lat: s.latitude, lon: s.longitude, altM: s.altM, altFt: s.altFt,
      points: s.points, bonus: s.bonusPoints,
    };
  } catch (e) { /* fixture not there either -> use the hardcoded fallback above */ }
  const snapshot = {
    generated: new Date().toISOString(),
    pota: {
      columns: ['ref', 'name', 'lat', 'lon', 'grid', 'loc', 'active'],
      rows: [['US-2069', 'Harriman State Park', 41.1753, -74.1783, 'FN21ve', 'US-NY', 1]],
    },
    sota: {
      columns: ['code', 'name', 'lat', 'lon', 'altM', 'altFt', 'points', 'bonus', 'validFrom', 'validTo',
                'actCount', 'actDate', 'actCall', 'assocName', 'regionName'],
      rows: [[
        'W2/GC-001', 'Slide Mountain', summit.lat, summit.lon, summit.altM, summit.altFt,
        summit.points, summit.bonus, '2010-05-01', '2099-12-31', 0, null, null,
        'USA - NJ / NY', 'Greater Catskills',
      ]],
    },
  };
  return 'window.PSM_SNAPSHOT = ' + JSON.stringify(snapshot) + ';\n';
}

/* ------------------------------------------------------------------------------------------- */
/* scenarios                                                                                     */
/* ------------------------------------------------------------------------------------------- */

async function scenarioLoads({ page, mocks }) {
  await page.waitForFunction(() => !!window.PSM, null, { timeout: READY_TIMEOUT_MS });
  await page.waitForFunction(() => document.body.classList.contains('psm-ready'), null, {
    timeout: READY_TIMEOUT_MS,
  });
  const gotTiles = await waitForNode(() => mocks.tileCount > 0, READY_TIMEOUT_MS);
  if (!gotTiles) throw new Error('expected tiles to have been requested (mocks.tileCount > 0), got ' + mocks.tileCount);
}

async function scenarioSearchAddress({ page }) {
  await waitForAppReady(page);
  await setRadiusMi(page, 100);
  await page.fill('#search-input', 'Harriman State Park');
  await page.click('#search-btn');
  await waitForResults(page);

  const state = await getState(page);
  if (!(state.parks && state.parks.length > 0)) {
    throw new Error('expected state.parks.length > 0, got ' + JSON.stringify(state.parks && state.parks.length));
  }
  if (!(state.summits && state.summits.length > 0)) {
    throw new Error(
      'expected state.summits.length > 0 (W2/GC summits are ~80 km north, within the 100 mi radius), got ' +
        JSON.stringify(state.summits && state.summits.length)
    );
  }

  const rows = await page.$$eval('#list-parks .item', (els) => els.map((el) => el.getAttribute('data-id')));
  if (rows.length === 0) throw new Error('#list-parks has no .item rows');
  if (!/^US-\d+$/.test(rows[0] || '')) throw new Error('first #list-parks row data-id is not a US-#### ref: ' + rows[0]);

  const distByRef = new Map(state.parks.map((p) => [p.ref, p.distKm]));
  let lastD = -Infinity;
  for (const id of rows) {
    const d = distByRef.get(id);
    if (typeof d !== 'number') throw new Error('#list-parks row data-id "' + id + '" not found in state.parks');
    if (d < lastD - 1e-6) {
      throw new Error('#list-parks rows are not sorted by distKm ascending (hit ' + id + ' d=' + d + ' after d=' + lastD + ')');
    }
    lastD = d;
  }
}

async function scenarioSearchLatLon({ page }) {
  await waitForAppReady(page);
  await fireAndForget(page, 'PSM.app.search', '41.24, -74.10');
  await waitForResults(page);
  const state = await getState(page);
  assertApprox(state.center && state.center.lat, 41.24, 0.0005, 'state.center.lat');
  assertApprox(state.center && state.center.lon, -74.1, 0.0005, 'state.center.lon');
  const radiusKm = state.radiusKm;
  if (typeof radiusKm !== 'number') throw new Error('state.radiusKm is not a number: ' + JSON.stringify(radiusKm));
  const bad = (state.parks || []).filter((p) => typeof p.distKm !== 'number' || p.distKm > radiusKm + 1e-6);
  if (bad.length) {
    throw new Error(bad.length + ' park(s) exceed radiusKm=' + radiusKm + ', e.g. ' + JSON.stringify(bad[0]));
  }
}

async function scenarioSearchGrid({ page }) {
  await waitForAppReady(page);
  await fireAndForget(page, 'PSM.app.search', 'FN21ve');
  await waitForResults(page);
  const state = await getState(page);
  assertApprox(state.center && state.center.lat, 41.1875, 0.01, 'state.center.lat');
  assertApprox(state.center && state.center.lon, -74.2083, 0.01, 'state.center.lon');
}

async function scenarioSearchPotaRef({ page }) {
  await waitForAppReady(page);
  await fireAndForget(page, 'PSM.app.search', 'US-2069');
  await waitForResults(page);
  const state = await getState(page);
  assertApprox(state.center && state.center.lat, 41.1753, 0.001, 'state.center.lat');
  assertApprox(state.center && state.center.lon, -74.1783, 0.001, 'state.center.lon');

  await page.waitForSelector('#detail', { state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
  const text = await page.locator('#detail').innerText();
  assertIncludesAll(text, ['US-2069', 'Harriman'], '#detail');
}

async function scenarioSearchSotaRef({ page }) {
  await waitForAppReady(page);
  await fireAndForget(page, 'PSM.app.search', 'W2/GC-001');
  await waitForResults(page);
  const state = await getState(page);
  assertApprox(state.center && state.center.lat, 41.9991, 0.001, 'state.center.lat');
  assertApprox(state.center && state.center.lon, -74.3862, 0.001, 'state.center.lon');

  await page.waitForSelector('#detail', { state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
  const text = await page.locator('#detail').innerText();
  assertIncludesAll(text, ['W2/GC-001'], '#detail');
}

async function scenarioParkDetail({ page }) {
  await waitForAppReady(page);
  await fireAndForget(page, 'PSM.app.search', '41.1753, -74.1783');
  await waitForResults(page);
  await fireAndForget(page, 'PSM.app.openPark', 'US-2069');
  await page.waitForSelector('#detail-body', { state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
  // Stats and the reverse-geocoded address arrive from separate (mocked) requests and fill
  // their sections independently; wait for both so the strict checks below are fair.
  await page.waitForFunction(
    () => {
      const el = document.querySelector('#detail-body');
      if (!el) return false;
      const t = el.innerText;
      return t.includes('212') && t.includes('198') &&
        (t.includes('Seven Lakes Drive') || t.includes('Sloatsburg') || t.includes('Unavailable'));
    },
    null,
    { timeout: DEFAULT_TIMEOUT_MS }
  );

  const text = await page.locator('#detail-body').innerText();
  const hrefs = await page.$$eval('#detail-body a', (as) => as.map((a) => a.href));
  assertIncludesAll(
    text,
    ['US-2069', 'State Park', 'New York', 'FN21ve', 'WK2S', 'Automobile', '212', '198'],
    '#detail-body'
  );
  if (!(text.includes('Seven Lakes Drive') || text.includes('Sloatsburg'))) {
    throw new Error('#detail-body missing the approx. address (expected "Seven Lakes Drive" or "Sloatsburg"); text=' + text.slice(0, 400));
  }
  if (!hrefs.some((h) => h.includes('parks.ny.gov/parks/145'))) {
    throw new Error('#detail-body missing a link to https://parks.ny.gov/parks/145; hrefs=' + JSON.stringify(hrefs));
  }
  if (!hrefs.some((h) => h.includes('google.com/maps'))) {
    throw new Error('#detail-body missing a google.com/maps directions link; hrefs=' + JSON.stringify(hrefs));
  }
}

async function scenarioSummitDetail({ page }) {
  await waitForAppReady(page);
  await fireAndForget(page, 'PSM.app.search', '41.9991, -74.3862');
  await waitForResults(page);
  await fireAndForget(page, 'PSM.app.openSummit', 'W2/GC-001');
  await page.waitForSelector('#detail-body', { state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('#detail-body');
      return !!el && el.innerText.includes('Slide Mountain');
    },
    null,
    { timeout: DEFAULT_TIMEOUT_MS }
  );

  const text = await page.locator('#detail-body').innerText();
  const hrefs = await page.$$eval('#detail-body a', (as) => as.map((a) => a.href));
  assertIncludesAll(text, ['Slide Mountain', '10', 'Greater Catskills'], '#detail-body');
  if (!hrefs.some((h) => h.includes('sotl.as'))) {
    throw new Error('#detail-body missing a sotl.as link; hrefs=' + JSON.stringify(hrefs));
  }
  if (!hrefs.some((h) => h.includes('sotadata.org.uk'))) {
    throw new Error('#detail-body missing a sotadata.org.uk link; hrefs=' + JSON.stringify(hrefs));
  }
}

async function scenarioFallbackGrid({ page, mocks }) {
  await waitForAppReady(page);
  await fireAndForget(page, 'PSM.app.search', '41.24, -74.10');
  await waitForResults(page);

  const state = await getState(page);
  if (!(state.parks && state.parks.length > 0)) {
    throw new Error('expected parks to still load via the /park/grid/ fallback, got ' + JSON.stringify(state.parks && state.parks.length));
  }
  const sawLocationFail = mocks.requests.some((r) => /api\.pota\.app\/location\//.test(r.url) && r.status === 503);
  if (!sawLocationFail) {
    throw new Error(
      'expected a mocked 503 to /location/parks/*; requests to api.pota.app were: ' +
        JSON.stringify(mocks.requests.filter((r) => /api\.pota\.app/.test(r.url)).slice(0, 10))
    );
  }
  const sawGrid = mocks.requests.some((r) => /api\.pota\.app\/park\/grid\//.test(r.url) && r.status === 200);
  if (!sawGrid) throw new Error('expected successful /park/grid/{cell} requests as the fallback path');

  const logs = await getLogMessages(page);
  if (!logs.some((m) => /grid|fallback/i.test(m))) {
    throw new Error('PSM.logEntries does not mention "grid" or "fallback"; last entries: ' + JSON.stringify(logs.slice(-15)));
  }
}

async function scenarioNfer({ page, mocks }) {
  await waitForAppReady(page);
  await setRadiusMi(page, 15);
  // The radius slider's own 'input'/'change' listener debounces a real re-search (correct app
  // behavior — confirmed empirically: touching #radius-range before any search has happened
  // never itself triggers a search, since there's no existing search context to re-run yet).
  // Settling here, before the first search, means that debounce has nothing pending by the time
  // we call search()+runNfer() below, so it can't race in later and silently reset the one-shot
  // state.nfer result a plain search() clears at the start of *any* new search cycle.
  await page.waitForTimeout(1500);
  await fireAndForget(page, 'PSM.app.search', '41.24, -74.10');
  await waitForResults(page);

  await fireAndForget(page, 'PSM.app.runNfer');
  await page.waitForFunction(() => !!(window.PSM.app.state && window.PSM.app.state.nfer), null, {
    timeout: DEFAULT_TIMEOUT_MS,
  });

  const decodedBodies = mocks.overpassQueries.map(decodeOverpassBody);
  if (!decodedBodies.some((b) => b.includes('communication:amateur_radio:pota'))) {
    throw new Error(
      'expected an Overpass POST body containing "communication:amateur_radio:pota"; bodies were: ' +
        JSON.stringify(decodedBodies.map((b) => b.slice(0, 200)))
    );
  }

  let hasOverpassElements = false;
  try {
    const fx = readJSON(path.join(FIXTURES_DIR, 'overpass_harriman.json'));
    hasOverpassElements = Array.isArray(fx.elements) && fx.elements.length > 0;
  } catch (e) { /* fixture missing -> mock-network.js already fell back to {elements:[]}; leave false */ }

  if (hasOverpassElements) {
    const nfer = await page.evaluate(() => window.PSM.app.state.nfer);
    const zoneCount = nfer && nfer.zones && Array.isArray(nfer.zones.features) ? nfer.zones.features.length : -1;
    if (zoneCount < 1) {
      throw new Error('overpass_harriman.json has elements, so expected state.nfer.zones.features.length >= 1, got ' + zoneCount);
    }
    const rowCount = await page.$$eval('#list-multi .item', (els) => els.length);
    if (rowCount < 1) throw new Error('#list-multi has no .item rows despite zones.features.length=' + zoneCount);
  }
}

/**
 * park-boundary: opening a park's detail panel fetches that one park's OSM boundary and
 * highlights it until the detail closes. Checks the Overpass request the app sends (one POST
 * naming the reference), the #boundary-line wording, the drawn .psm-selected-boundary path,
 * #boundary-zoom-btn, the teardown on #detail-close, and a second park matched by point/name
 * rather than by the POTA tag.
 */
async function scenarioParkBoundary({ page, mocks }) {
  await waitForAppReady(page);
  await setRadiusMi(page, 25);
  // Same reason as scenarioNfer: let the radius slider's debounce fire before the real search,
  // so it cannot re-run search() later and clear the detail panel mid-scenario.
  await page.waitForTimeout(1500);
  await fireAndForget(page, 'PSM.app.search', '41.24, -74.10');
  await waitForResults(page);

  await fireAndForget(page, 'PSM.app.openPark', 'US-2069');
  await page.waitForSelector('#boundary-line', { state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
  await page.waitForFunction(
    () => {
      const el = document.getElementById('boundary-line');
      return !!el && el.innerText.includes('shown on map');
    },
    null,
    { timeout: DEFAULT_TIMEOUT_MS }
  );

  const line = await page.locator('#boundary-line').innerText();
  assertIncludesAll(line, ['Boundary:', 'shown on map', 'matched by tag', '100%', 'OpenStreetMap'], '#boundary-line');

  // The app must have asked Overpass for THIS park (one small query, not the area sweep).
  const bodies = mocks.overpassQueries.map(decodeOverpassBody);
  const parkQuery = bodies.find((b) => b.includes('US-2069') && b.includes('communication:amateur_radio:pota'));
  if (!parkQuery) {
    throw new Error(
      'expected an Overpass POST body naming US-2069 and the POTA tag; bodies were: ' +
        JSON.stringify(bodies.map((b) => b.slice(0, 200)))
    );
  }
  if (!/\(around:\d+,41\.\d+,-74\.\d+\)/.test(parkQuery)) {
    throw new Error('the park boundary query has no around: clause: ' + parkQuery.slice(0, 300));
  }

  const drawn = await page.evaluate(() => ({
    bounds: window.PSM.mapui.parkBoundaryBounds() ? true : false,
    paths: document.querySelectorAll('#map .psm-selected-boundary').length,
    ref: window.PSM.mapui.parkBoundaryRef ? window.PSM.mapui.parkBoundaryRef() : null,
  }));
  if (!drawn.bounds) throw new Error('PSM.mapui.parkBoundaryBounds() is null after the boundary rendered');
  if (drawn.paths < 1) throw new Error('no .psm-selected-boundary path in the map pane');
  if (drawn.ref !== 'US-2069') throw new Error('the drawn boundary is not US-2069: ' + JSON.stringify(drawn.ref));

  // Bring #boundary-line into view so the screenshot shows both halves of the feature:
  // the highlighted polygon on the map and the line that explains it.
  try {
    await page.locator('#boundary-line').scrollIntoViewIfNeeded({ timeout: 2000 });
  } catch (e) { /* cosmetic only */ }
  await page.screenshot({ path: path.join(OUT_DIR, 'park-boundary.png') });

  // "Zoom to boundary" fits the map to it.
  await page.click('#boundary-zoom-btn');
  await page.waitForFunction(
    () => {
      const m = window.PSM.mapui.getMap();
      const b = window.PSM.mapui.parkBoundaryBounds();
      return !!m && !!b && m.getBounds().contains(b);
    },
    null,
    { timeout: DEFAULT_TIMEOUT_MS }
  );

  // Closing the detail takes the highlight away again.
  await page.click('#detail-close');
  await page.waitForFunction(() => window.PSM.mapui.parkBoundaryBounds() === null, null, {
    timeout: DEFAULT_TIMEOUT_MS,
  });
  const leftOver = await page.$$eval('#map .psm-selected-boundary', (els) => els.length);
  if (leftOver !== 0) throw new Error('#detail-close left ' + leftOver + ' boundary path(s) on the map');

  // A second park, this one matched by its location + name (no POTA tag in the fixture).
  await fireAndForget(page, 'PSM.app.openPark', 'US-2144');
  await page.waitForFunction(
    () => {
      const el = document.getElementById('boundary-line');
      return !!el && el.innerText.includes('shown on map');
    },
    null,
    { timeout: DEFAULT_TIMEOUT_MS }
  );
  const line2 = await page.locator('#boundary-line').innerText();
  if (/matched by tag/.test(line2)) {
    throw new Error('US-2144 has no POTA tag in the fixture, so it must not report a tag match: ' + line2);
  }
  assertIncludesAll(line2, ['shown on map', 'confidence'], '#boundary-line (US-2144)');
  const ref2 = await page.evaluate(() => window.PSM.mapui.parkBoundaryRef());
  if (ref2 !== 'US-2144') throw new Error('the boundary did not switch to US-2144: ' + JSON.stringify(ref2));
}

async function scenarioSpots({ page, mocks }) {
  await waitForAppReady(page);
  await page.check('#toggle-spots');

  const sawRequests = await waitForNode(
    () =>
      mocks.requests.some((r) => /\/spot\/activator/.test(r.url)) &&
      mocks.requests.some((r) => /\/api\/spots\//.test(r.url)),
    SPOTS_NETWORK_TIMEOUT_MS
  );
  if (!sawRequests) {
    throw new Error(
      'expected requests to /spot/activator and /api/spots/ within ' +
        SPOTS_NETWORK_TIMEOUT_MS +
        'ms; spot-ish requests seen: ' +
        JSON.stringify(mocks.requests.filter((r) => /spot/i.test(r.url)).slice(0, 10))
    );
  }

  await page.waitForFunction(
    () => {
      const s = window.PSM.app.state && window.PSM.app.state.spots;
      if (!s) return false;
      if (Array.isArray(s)) return s.length > 0;
      const pota = Array.isArray(s.pota) ? s.pota.length : 0;
      const sota = Array.isArray(s.sota) ? s.sota.length : 0;
      return pota + sota > 0;
    },
    null,
    { timeout: DEFAULT_TIMEOUT_MS }
  );
}

/** Builds one ADIF QSO record; `refTag` is the already-formatted MY_POTA_REF/POTA_REF field. */
function adifQsoRecord(refTag, date, call, band, mode) {
  return (
    '<QSO_DATE:8>' + date + '<CALL:' + call.length + '>' + call + refTag +
    '<BAND:' + band.length + '>' + band + '<MODE:' + mode.length + '>' + mode + '<EOR>\n'
  );
}

async function scenarioMylog({ page }) {
  await waitForAppReady(page);
  await setRadiusMi(page, 40);
  await fireAndForget(page, 'PSM.app.search', '41.24, -74.10');
  await waitForResults(page);

  // (i) PSM.mylog.mark('pota','US-2069') -> its #list-parks row gains a badge-mine.
  await page.evaluate(() => window.PSM.mylog.mark('pota', 'US-2069'));
  await page.waitForFunction(
    () => {
      const row = document.querySelector('#list-parks .item[data-id="US-2069"]');
      return !!row && !!row.querySelector('.badge-mine');
    },
    null,
    { timeout: DEFAULT_TIMEOUT_MS }
  );

  // (ii) PSM.app.openPark('US-2069') -> the toggle button reads pressed, the detail line says so.
  await fireAndForget(page, 'PSM.app.openPark', 'US-2069');
  await page.waitForSelector('#mylog-toggle-btn[aria-pressed="true"]', { timeout: DEFAULT_TIMEOUT_MS });
  const detailLine1 = await page.locator('#mylog-detail-line').innerText();
  if (!/activated/i.test(detailLine1)) {
    throw new Error('#mylog-detail-line does not mention "activated" after marking US-2069: ' + JSON.stringify(detailLine1));
  }

  // (iii) paste a small ADIF (12 QSOs at US-2010 via MY_POTA_REF -> a valid activation, plus 3
  // hunted QSOs at US-4556 via POTA_REF) and import it. "My activations" is a closed-by-default
  // <details>, so open it before touching the controls inside it -- but first close the still-open
  // detail panel from step (ii), which overlays the whole sidebar and would intercept the click.
  await page.evaluate(() => window.PSM.app.close());
  await page.waitForSelector('#detail', { state: 'hidden', timeout: DEFAULT_TIMEOUT_MS });
  await page.click('#mylog-section summary');
  const mylogAdif =
    Array(12).fill(0).map(() => adifQsoRecord('<MY_POTA_REF:7>US-2010', '20260615', 'W1TST', '20m', 'CW')).join('') +
    Array(3).fill(0).map(() => adifQsoRecord('<POTA_REF:7>US-4556', '20260616', 'K2ABC', '40m', 'SSB')).join('');
  await page.fill('#mylog-paste', mylogAdif);
  await page.click('#mylog-import-btn');
  await page.waitForFunction(
    () => /2 park/.test((document.getElementById('mylog-summary') || {}).textContent || ''),
    null,
    { timeout: DEFAULT_TIMEOUT_MS }
  );
  await page.waitForFunction(
    () => {
      const row = document.querySelector('#list-parks .item[data-id="US-2010"]');
      return !!row && !!row.querySelector('.badge-mine');
    },
    null,
    { timeout: DEFAULT_TIMEOUT_MS }
  );

  await page.screenshot({ path: path.join(OUT_DIR, 'mylog.png') });

  // (iv) #filter-mine: "new" hides both marked rows; "mine" shows only them; "all" restores.
  await page.selectOption('#filter-mine', 'new');
  await page.waitForFunction(() => !document.querySelector('#list-parks .badge-mine'), null, { timeout: DEFAULT_TIMEOUT_MS });
  const mineFilterState = await page.evaluate(() => window.PSM.app.state.filters.mine);
  if (mineFilterState !== 'new') {
    throw new Error('PSM.app.state.filters.mine expected "new", got ' + JSON.stringify(mineFilterState));
  }

  await page.selectOption('#filter-mine', 'mine');
  await page.waitForFunction(
    () => {
      const rows = document.querySelectorAll('#list-parks .item');
      return rows.length === 2 && Array.from(rows).every((r) => r.querySelector('.badge-mine'));
    },
    null,
    { timeout: DEFAULT_TIMEOUT_MS }
  );

  await page.selectOption('#filter-mine', 'all');
  await page.waitForFunction(
    () => document.querySelectorAll('#list-parks .badge-mine').length === 2,
    null,
    { timeout: DEFAULT_TIMEOUT_MS }
  );

  // (v) reload in the same context: marks persist via localStorage, and the URL hash the earlier
  // search wrote (searchAt -> updateHash) drives the same search again on startup, so US-2069
  // shows up badged again without us re-issuing the search ourselves.
  await page.reload({ waitUntil: 'load' });
  await waitForAppReady(page);
  await waitForResults(page);
  await page.waitForFunction(
    () => {
      const row = document.querySelector('#list-parks .item[data-id="US-2069"]');
      return !!row && !!row.querySelector('.badge-mine');
    },
    null,
    { timeout: DEFAULT_TIMEOUT_MS }
  );

  // (vi) PSM.mylog.exportJSON() contains US-2069.
  const exported = await page.evaluate(() => window.PSM.mylog.exportJSON());
  if (!exported.includes('US-2069')) {
    throw new Error('PSM.mylog.exportJSON() does not contain "US-2069": ' + exported.slice(0, 300));
  }

  // (vii) unmark via the toggle button click -> the badge disappears.
  await fireAndForget(page, 'PSM.app.openPark', 'US-2069');
  await page.waitForSelector('#mylog-toggle-btn[aria-pressed="true"]', { timeout: DEFAULT_TIMEOUT_MS });
  await page.click('#mylog-toggle-btn');
  await page.waitForSelector('#mylog-toggle-btn[aria-pressed="false"]', { timeout: DEFAULT_TIMEOUT_MS });
  await page.waitForFunction(
    () => {
      const row = document.querySelector('#list-parks .item[data-id="US-2069"]');
      return !!row && !row.querySelector('.badge-mine');
    },
    null,
    { timeout: DEFAULT_TIMEOUT_MS }
  );
}

async function scenarioFileUrl({ page }) {
  await page.waitForFunction(() => !!window.PSM, null, { timeout: READY_TIMEOUT_MS });
  await page.waitForFunction(() => document.body.classList.contains('psm-ready'), null, {
    timeout: READY_TIMEOUT_MS,
  });
  await fireAndForget(page, 'PSM.app.search', '41.24, -74.10');
  await waitForResults(page);
  const state = await getState(page);
  if (!(state.parks && state.parks.length > 0)) {
    throw new Error('search over file:// did not return any parks; state.parks=' + JSON.stringify(state.parks));
  }
}

async function scenarioMobile({ page }) {
  await page.waitForFunction(() => !!window.PSM, null, { timeout: READY_TIMEOUT_MS });
  await page.waitForFunction(() => document.body.classList.contains('psm-ready'), null, {
    timeout: READY_TIMEOUT_MS,
  });

  const toggle = page.locator('#sidebar-toggle');
  await toggle.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS });

  const snapshot = () =>
    page.evaluate(() => {
      const searchEl = document.getElementById('search-input');
      const panel = searchEl ? searchEl.closest('div,aside,section,nav') : null;
      const panelRect = panel ? panel.getBoundingClientRect() : null;
      const mapEl = document.getElementById('map');
      const mapRect = mapEl ? mapEl.getBoundingClientRect() : null;
      return {
        bodyClass: document.body.className,
        htmlClass: document.documentElement.className,
        panelRect: panelRect ? [panelRect.width, panelRect.height, panelRect.x, panelRect.y] : null,
        mapRect: mapRect ? [mapRect.width, mapRect.height] : null,
      };
    });

  const before = await snapshot();
  await toggle.click();
  await page.waitForTimeout(400); // let any CSS transition settle before the screenshot/recheck
  const after = await snapshot();

  if (JSON.stringify(before) === JSON.stringify(after)) {
    throw new Error(
      '#sidebar-toggle click produced no observable change (body/html class, the search panel\'s ' +
        'bounding rect, and #map\'s bounding rect were all identical): ' + JSON.stringify(before)
    );
  }
}

async function scenarioSnapshot({ page, mocks }) {
  await waitForAppReady(page);
  await setRadiusMi(page, 100);
  await fireAndForget(page, 'PSM.app.search', '41.1753, -74.1783');
  await waitForResults(page);

  const state = await getState(page);
  const nParks = state.parks ? state.parks.length : 0;
  const nSummits = state.summits ? state.summits.length : 0;
  if (nParks === 0 && nSummits === 0) {
    throw new Error('expected parks and/or summits to load from the snapshot even though every POTA/SOTA API call fails; got 0 parks, 0 summits');
  }

  const badPota = mocks.requests.filter((r) => /api\.pota\.app/.test(r.url) && r.status !== 503);
  const badSota = mocks.requests.filter((r) => /api2\.sota\.org\.uk/.test(r.url) && r.status !== 503);
  if (badPota.length || badSota.length) {
    throw new Error('a POTA/SOTA API request was not answered with the mocked 503: ' + JSON.stringify(badPota.concat(badSota).slice(0, 5)));
  }

  const logs = await getLogMessages(page);
  if (!logs.some((m) => /snapshot/i.test(m))) {
    throw new Error('PSM.logEntries does not mention "snapshot"; last entries: ' + JSON.stringify(logs.slice(-15)));
  }
}

/* ------------------------------------------------------------------------------------------- */
/* scenario table                                                                                 */
/* ------------------------------------------------------------------------------------------- */

const SCENARIOS = [
  { name: 'loads', run: scenarioLoads },
  { name: 'search-address', run: scenarioSearchAddress },
  { name: 'search-latlon', run: scenarioSearchLatLon },
  { name: 'search-grid', run: scenarioSearchGrid },
  { name: 'search-pota-ref', run: scenarioSearchPotaRef },
  { name: 'search-sota-ref', run: scenarioSearchSotaRef },
  { name: 'park-detail', run: scenarioParkDetail },
  { name: 'summit-detail', run: scenarioSummitDetail },
  { name: 'fallback-grid', run: scenarioFallbackGrid, mockOptions: { fail: ['api.pota.app/location'] } },
  { name: 'nfer', run: scenarioNfer },
  // The screenshot is taken inside the scenario, right after the first boundary renders —
  // the harness's end-of-run one would show the second park instead.
  { name: 'park-boundary', run: scenarioParkBoundary, screenshot: false },
  { name: 'spots', run: scenarioSpots },
  // Screenshot is taken inside the scenario itself (after step iii, mid-run) rather than by the
  // harness's default end-of-run screenshot, which would instead capture the final (unmarked) state.
  { name: 'mylog', run: scenarioMylog, screenshot: false },
  { name: 'file-url', run: scenarioFileUrl, useFileUrl: true },
  { name: 'mobile', run: scenarioMobile, viewport: { width: 390, height: 844 } },
  {
    name: 'snapshot',
    run: scenarioSnapshot,
    mockOptions: (env) => Object.assign({ fail: ['api.pota.app', 'api2.sota.org.uk'] }, env.snapshotMockExtra),
  },
];

/* ------------------------------------------------------------------------------------------- */
/* static file server (serves the project root so the app can be opened at http://127.0.0.1:PORT) */
/* ------------------------------------------------------------------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.map': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.csv': 'text/csv', '.txt': 'text/plain; charset=utf-8',
};

function startStaticServer(rootDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, 'http://127.0.0.1');
        let p = decodeURIComponent(u.pathname);
        if (p === '/') p = '/index.html';
        const filePath = path.normalize(path.join(rootDir, p));
        if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) {
          res.writeHead(403);
          res.end('forbidden');
          return;
        }
        fs.stat(filePath, (err, stat) => {
          if (err || !stat.isFile()) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('not found: ' + p);
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
          fs.createReadStream(filePath).pipe(res);
        });
      } catch (e) {
        res.writeHead(400);
        res.end('bad request');
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/* ------------------------------------------------------------------------------------------- */
/* driver                                                                                         */
/* ------------------------------------------------------------------------------------------- */

function parseArgs(argv) {
  const opts = { only: [], app: 'pota-sota-map.html', headed: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') opts.only.push(argv[++i]);
    else if (a === '--app') opts.app = argv[++i];
    else if (a === '--headed') opts.headed = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else console.error('[e2e] ignoring unknown argument: ' + a);
  }
  opts.only = opts.only
    .flatMap((s) => String(s).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  return opts;
}

function printHelp() {
  console.log(
    [
      'Usage: node tests/e2e.js [--only <scenario>[,<scenario>...]] [--app <path>] [--headed]',
      '',
      'Scenarios: ' + SCENARIOS.map((s) => s.name).join(', '),
      '',
      '  --only <names>   run just these scenarios (comma-separated, or repeat --only)',
      '  --app <path>     HTML file to test, relative to the current directory',
      '                   (default: pota-sota-map.html at the project root)',
      '  --headed         launch Chromium with a visible window instead of headless',
      '',
      'See tests/README-tests.md for details.',
    ].join('\n')
  );
}

async function runScenario(sc, env) {
  const t0 = Date.now();
  if (!env.appExists) {
    return { name: sc.name, status: 'SKIP', message: 'app file not found: ' + env.appAbsPath, ms: Date.now() - t0 };
  }

  let context = null;
  let page = null;
  const consoleErrors = [];
  const pageErrors = [];

  try {
    const viewport = sc.viewport || { width: 1280, height: 860 };
    context = await env.browser.newContext({ viewport });

    const mockOptsRaw = typeof sc.mockOptions === 'function' ? sc.mockOptions(env) : sc.mockOptions || {};
    const mocks = await installMocks(context, mockOptsRaw);
    const injectedFailSubstrings = Array.isArray(mockOptsRaw.fail) ? mockOptsRaw.fail : [];

    page = await context.newPage();
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(DEFAULT_TIMEOUT_MS);
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      // Chromium's own "Failed to load resource: ..." messages (the case a plain favicon.ico 404
      // produces — this static server serves none) never put the URL in msg.text(); it only shows
      // up in msg.location().url. Check both so the URL-based carve-outs below actually work.
      let locUrl = '';
      try {
        locUrl = (msg.location() && msg.location().url) || '';
      } catch (e) { /* ignore */ }
      if (/favicon/i.test(text) || /favicon/i.test(locUrl)) return;
      // data/snapshot.js is an OPTIONAL, onerror-handled resource by design (ARCHITECTURE.md) —
      // the browser still logs a resource-load-error to console for its 404/ERR_FILE_NOT_FOUND
      // even though the app's own onerror handler deals with it gracefully. Not a real failure.
      if (/\/data\/snapshot\.js(\?|$)/.test(locUrl)) return;
      // This scenario's own options.fail deliberately makes some URL respond with a 503 (to
      // exercise a fallback path) — Chromium logs a resource-load-error for that too, on a mocked
      // response the app is *expected* to receive and handle. Not a real failure either.
      if (injectedFailSubstrings.length && injectedFailSubstrings.some((s) => locUrl.includes(s) || text.includes(s))) return;
      // The app's own status-log channel (PSM.log(msg,'error') -> console.error('[PSM]', msg)) is
      // intentional, user-visible logging for a handled condition, not a crash — scenarios that
      // care about it assert on PSM.logEntries directly instead of failing the whole run here.
      if (/^\[PSM\]/.test(text)) return;
      consoleErrors.push(locUrl ? text + '  (' + locUrl + ')' : text);
    });
    page.on('pageerror', (err) => {
      pageErrors.push((err && err.stack) || String(err));
    });

    const url = sc.useFileUrl ? env.fileAppUrl : env.httpAppUrl;
    await page.goto(url, { timeout: DEFAULT_TIMEOUT_MS, waitUntil: 'load' });

    let runError = null;
    try {
      await sc.run({ page, context, mocks, browser: env.browser, outDir: OUT_DIR, port: env.port, ROOT });
    } catch (e) {
      runError = e;
    }

    if (sc.screenshot !== false && !page.isClosed()) {
      try {
        await page.screenshot({ path: path.join(OUT_DIR, sc.name + '.png') });
      } catch (e) {
        /* best effort — do not let a screenshot failure mask the real result */
      }
    }

    if (runError instanceof SkipError) {
      return { name: sc.name, status: 'SKIP', message: runError.message, ms: Date.now() - t0 };
    }

    const problems = [];
    if (runError) problems.push('assertion: ' + ((runError && runError.message) || String(runError)));
    if (pageErrors.length) problems.push('page error(s): ' + pageErrors.slice(0, 3).join(' | '));
    if (consoleErrors.length) problems.push('console error(s): ' + consoleErrors.slice(0, 3).join(' | '));

    if (problems.length) {
      return { name: sc.name, status: 'FAIL', message: problems.join('; '), ms: Date.now() - t0 };
    }
    return { name: sc.name, status: 'PASS', ms: Date.now() - t0 };
  } catch (e) {
    return { name: sc.name, status: 'FAIL', message: (e && e.stack) || String(e), ms: Date.now() - t0 };
  } finally {
    try {
      if (page) await page.close();
    } catch (e) { /* ignore */ }
    try {
      if (context) await context.close();
    } catch (e) { /* ignore */ }
  }
}

function printResult(r) {
  const ms = String(r.ms).padStart(6) + 'ms';
  if (r.status === 'PASS') {
    console.log('PASS  ' + r.name.padEnd(20) + ms);
  } else if (r.status === 'SKIP') {
    console.log('SKIP  ' + r.name.padEnd(20) + ms + '  ' + r.message);
  } else {
    console.log('FAIL  ' + r.name.padEnd(20) + ms);
    console.log('      ' + String(r.message).split('\n').join('\n      '));
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const appAbsPath = path.resolve(process.cwd(), opts.app);
  const appExists = fs.existsSync(appAbsPath) && fs.statSync(appAbsPath).isFile();

  fs.mkdirSync(OUT_DIR, { recursive: true });

  let scenarios = SCENARIOS;
  if (opts.only.length) {
    const names = new Set(opts.only);
    const unknown = opts.only.filter((n) => !SCENARIOS.some((s) => s.name === n));
    if (unknown.length) {
      console.error('[e2e] unknown scenario name(s): ' + unknown.join(', ') + ' -- known: ' + SCENARIOS.map((s) => s.name).join(', '));
    }
    scenarios = SCENARIOS.filter((s) => names.has(s.name));
    if (scenarios.length === 0) {
      console.error('[e2e] no scenarios matched --only ' + opts.only.join(','));
      process.exit(1);
    }
  }

  let snapshotMockExtra;
  const snapshotFixturePath = path.join(FIXTURES_DIR, 'snapshot_sample.js');
  if (fs.existsSync(snapshotFixturePath)) {
    snapshotMockExtra = { snapshotPath: snapshotFixturePath };
  } else {
    console.log(
      '[e2e] tests/fixtures/snapshot_sample.js not found yet (another agent is generating it) -- ' +
        'the "snapshot" scenario will use a small synthesized snapshot (Harriman State Park + ' +
        'Slide Mountain) instead.'
    );
    snapshotMockExtra = { snapshotJs: buildFallbackSnapshotJs() };
  }

  console.log('[e2e] app under test: ' + appAbsPath + (appExists ? '' : '  (NOT FOUND -- scenarios will be skipped)'));

  const server = await startStaticServer(ROOT);
  const port = server.address().port;
  const relApp = path.relative(ROOT, appAbsPath).split(path.sep).join('/');
  const httpAppUrl = 'http://127.0.0.1:' + port + '/' + relApp;
  const fileAppUrl = 'file://' + appAbsPath;
  console.log('[e2e] static server: http://127.0.0.1:' + port + '/  (serving ' + ROOT + ')');

  let browser = null;
  const results = [];
  try {
    browser = await chromium.launch({ headless: !opts.headed, args: ['--no-sandbox'] });

    const env = { browser, appExists, appAbsPath, httpAppUrl, fileAppUrl, port, snapshotMockExtra };

    for (const sc of scenarios) {
      const r = await runScenario(sc, env);
      results.push(r);
      printResult(r);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  const totalMs = results.reduce((a, r) => a + r.ms, 0);
  console.log('');
  console.log(
    (failed ? 'FAILED' : 'PASSED') +
      ': ' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped  (' + totalMs + 'ms total)'
  );
  console.log('screenshots: ' + OUT_DIR);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('\n[e2e] UNEXPECTED ERROR:', (e && e.stack) || e);
  process.exit(1);
});
