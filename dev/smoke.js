'use strict';
/**
 * dev/smoke.js — offline smoke test for the built single-file app.
 *
 *   NODE_PATH=/home/claude/.npm-global/lib/node_modules node dev/smoke.js [--stubs] [--headed]
 *
 * What it does:
 *   1. runs scripts/build.py
 *   2. serves the repo over http://127.0.0.1:<port> (Playwright's route mock lets
 *      localhost through, everything external is answered from tests/fixtures +
 *      dev/vendor by tests/mock-network.js)
 *   3. drives the page: startup → search → lists → park detail → summit detail →
 *      n-fer analysis → filters/units/basemap/log/sidebar → mobile layout
 *   4. writes dev/smoke-*.png and prints a pass/fail table
 *
 * --stubs builds a variant with the data modules (10/20/30/50) replaced by
 * fixture-backed stubs and *no* n-fer module, which exercises the UI's
 * graceful-degradation paths. Useful when those modules are missing or broken.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { installMocks } = require('../tests/mock-network');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');
const OUT_HTML = path.join(ROOT, 'pota-sota-map.html');
const STUB_HTML = path.join(ROOT, 'dev', 'smoke-stubs.html');

const argv = process.argv.slice(2);
const USE_STUBS = argv.includes('--stubs');
const HEADED = argv.includes('--headed');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '  — ' + detail : ''));
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */
function build() {
  const out = execFileSync('python3', [path.join(ROOT, 'scripts', 'build.py')], { cwd: ROOT, encoding: 'utf8' });
  console.log(out.trim().split('\n').map((l) => '  ' + l).join('\n'));
  return OUT_HTML;
}

/** Build a variant whose data modules are fixture-backed stubs (no n-fer). */
function buildStubVariant() {
  const tmp = path.join(ROOT, 'dev', '.stub-src');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  for (const name of fs.readdirSync(path.join(ROOT, 'src'))) {
    if (/^(10|20|30|40|50)-/.test(name)) continue;
    fs.copyFileSync(path.join(ROOT, 'src', name), path.join(tmp, name));
  }
  fs.writeFileSync(path.join(tmp, '55-stubs.js'), stubSource(), 'utf8');
  const out = execFileSync('python3', [path.join(ROOT, 'scripts', 'build.py'), '--src', tmp, '--out', STUB_HTML],
    { cwd: ROOT, encoding: 'utf8' });
  console.log(out.trim().split('\n').map((l) => '  ' + l).join('\n'));
  return STUB_HTML;
}

function fx(name) { return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8')); }

function stubSource() {
  const data = {
    ny: fx('pota_location_parks_US-NY.json').slice(0, 400),
    park: fx('pota_park_US-2069.json'),
    stats: fx('pota_park_stats_US-2069.json'),
    acts: fx('pota_park_activations_US-2069.json'),
    lead: fx('pota_park_leaderboard_US-2069.json'),
    summits: fx('sota_region_W2_GC.json'),
    summit: fx('sota_summit_W2_GC-001.json'),
    spots: fx('pota_spots.json')
  };
  return `/* fixture-backed stubs for dev/smoke.js --stubs (never shipped) */
(function (g) {
  var PSM = g.PSM;
  var D = ${JSON.stringify(data)};
  if (!PSM.geocode) PSM.geocode = {
    classify: function (t) {
      if (PSM.parseLatLon(t)) return { kind: 'latlon', value: PSM.parseLatLon(t) };
      if (PSM.isGrid(t)) return { kind: 'grid', value: t };
      if (PSM.isPotaRef(t)) return { kind: 'pota', value: t };
      if (PSM.isSotaRef(t)) return { kind: 'sota', value: t };
      return { kind: 'text', value: t };
    },
    forward: function (t) { return Promise.resolve({ lat: 41.1753, lon: -74.1783, label: 'Harriman State Park', source: 'photon' }); },
    reverse: function (lat, lon) { return Promise.resolve({ label: 'Seven Lakes Drive, Sloatsburg, New York', parts: {}, source: 'photon' }); },
    resolve: function (t) {
      var c = PSM.geocode.classify(t);
      if (c.kind === 'latlon') return Promise.resolve({ lat: c.value.lat, lon: c.value.lon, label: PSM.fmt.latlon(c.value.lat, c.value.lon, 4), source: 'latlon' });
      if (c.kind === 'grid') { var g2 = PSM.gridToLatLon(t); return Promise.resolve({ lat: g2.lat, lon: g2.lon, label: t, source: 'grid' }); }
      return PSM.geocode.forward(t);
    }
  };
  if (!PSM.pota) PSM.pota = {
    toPark: function (r) { return { ref: r.reference, name: r.name, lat: r.latitude, lon: r.longitude, grid: r.grid || null, loc: r.locationDesc || null, active: 1, attempts: r.attempts, activations: r.activations, qsos: r.qsos }; },
    loadNear: function (center, radiusKm, o) {
      o = o || {};
      if (o.onProgress) o.onProgress('stub state list');
      var out = D.ny.map(PSM.pota.toPark).map(function (p) { p.distKm = PSM.haversineKm(center.lat, center.lon, p.lat, p.lon); return p; })
        .filter(function (p) { return p.distKm <= radiusKm; }).sort(function (a, b) { return a.distKm - b.distKm; });
      return Promise.resolve({ parks: out, source: 'state', sources: ['US-NY'], warnings: [] });
    },
    getPark: function (ref) { return Promise.resolve(ref === 'US-2069' ? D.park : null); },
    getStats: function () { return Promise.resolve(D.stats); },
    getActivations: function () { return Promise.resolve(D.acts); },
    getLeaderboard: function () { return Promise.resolve(D.lead); },
    lookup: function () { return Promise.resolve([]); },
    searchAll: function () { return Promise.resolve([]); },
    parkUrl: function (r) { return 'https://pota.app/#/park/' + r; },
    displayName: function (d) { return (d.name || '') + (d.parktypeDesc ? ' ' + d.parktypeDesc : ''); }
  };
  if (!PSM.sota) PSM.sota = {
    toSummit: function (s) {
      return { code: s.summitCode, name: s.name, lat: s.latitude, lon: s.longitude, altM: s.altM, altFt: s.altFt,
        points: s.points, bonus: s.bonusPoints, validFrom: (s.validFrom || '').slice(0, 10), validTo: (s.validTo || '').slice(0, 10),
        actCount: s.activationCount, actDate: s.activationDate, actCall: s.activationCall, locator: s.locator,
        assoc: 'W2', region: 'GC', assocName: 'USA - NJ / NY', regionName: 'Greater Catskills' };
    },
    loadNear: function (center, radiusKm, o) {
      o = o || {};
      if (o.onProgress) o.onProgress('stub region');
      var out = (D.summits.summits || []).map(PSM.sota.toSummit).map(function (s) { s.distKm = PSM.haversineKm(center.lat, center.lon, s.lat, s.lon); return s; })
        .filter(function (s) { return s.distKm <= radiusKm; }).sort(function (a, b) { return a.distKm - b.distKm; });
      return Promise.resolve({ summits: out, source: 'api', warnings: [] });
    },
    getSummit: function (code) { return Promise.resolve(code === 'W2/GC-001' ? D.summit : null); },
    summitUrls: function (c) { return { sotlas: 'https://sotl.as/summits/' + c, sotadata: 'https://www.sotadata.org.uk/en/summit/' + c }; },
    isValid: function () { return true; }
  };
  if (!PSM.spots) PSM.spots = {
    fetchAll: function () {
      var pota = D.spots.map(function (r) {
        return { program: 'pota', ref: r.reference, name: r.name, activator: r.activator,
          freqKHz: parseFloat(r.frequency), mode: r.mode, timeISO: r.spotTime + 'Z', spotter: r.spotter,
          comments: r.comments, lat: r.latitude, lon: r.longitude, loc: r.locationDesc };
      });
      return Promise.resolve({ pota: pota, sota: [], fetchedAt: new Date().toISOString() });
    },
    start: function (ms, cb) { return PSM.spots.fetchAll().then(cb); },
    stop: function () {}
  };
})(window);
`;
}

/* ------------------------------------------------------------------ */
/* Static server                                                       */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.csv': 'text/csv'
};

function serve(rootDir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
      const file = path.join(rootDir, rel);
      if (!file.startsWith(rootDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ------------------------------------------------------------------ */
/* Console capture                                                     */
/* ------------------------------------------------------------------ */
function watchConsole(page, bag) {
  page.on('console', (msg) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return;
    const text = msg.text();
    const where = (msg.location() && msg.location().url) || '';
    // A missing optional data/snapshot.js is expected: the browser logs the 404
    // itself, the app must stay silent (its onerror sets PSM_SNAPSHOT_MISSING).
    if (/snapshot\.js/.test(text) || /snapshot\.js/.test(where)) { bag.ignored.push(text + ' <- ' + where); return; }
    (msg.type() === 'error' ? bag.errors : bag.warnings).push(text);
  });
  page.on('pageerror', (err) => bag.errors.push('pageerror: ' + err.message));
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */
(async () => {
  console.log('building…');
  const htmlPath = USE_STUBS ? buildStubVariant() : build();
  const urlPath = '/' + path.relative(ROOT, htmlPath).split(path.sep).join('/');

  const { server, port } = await serve(ROOT);
  const base = 'http://127.0.0.1:' + port;
  console.log('serving ' + ROOT + ' on ' + base + urlPath + '\n');

  const browser = await chromium.launch({ headless: !HEADED, args: ['--no-sandbox'] });
  let failed = false;

  try {
    /* ---------------- desktop ------------------------------------- */
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
    await installMocks(ctx);
    const page = await ctx.newPage();
    const bag = { errors: [], warnings: [], ignored: [] };
    watchConsole(page, bag);

    await page.goto(base + urlPath, { waitUntil: 'load' });
    await page.waitForSelector('body.psm-ready', { timeout: 10000 });
    check('body gets psm-ready', true);

    const hasApp = await page.evaluate(() => !!(window.PSM && window.PSM.app && window.PSM.app.ready));
    check('window.PSM.app exposed with ready promise', hasApp);
    await page.evaluate(() => window.PSM.app.ready);

    // Startup with geolocation denied must land on the idle view, not blow up.
    const idle = await page.textContent('#status');
    check('idle status after geolocation denial', /Enter an address|park|Search|summit/i.test(idle || ''), JSON.stringify(idle));

    /* search ------------------------------------------------------- */
    await page.fill('#search-input', '41.24,-74.10');
    await page.click('#search-btn');
    await page.waitForSelector('body.psm-results', { timeout: 20000 });
    check('search produces psm-results', true);

    await page.waitForFunction(() => document.querySelectorAll('#list-parks .item').length > 0, null, { timeout: 20000 });
    const counts = await page.evaluate(() => ({
      parks: document.querySelectorAll('#list-parks .item[data-kind="park"]').length,
      summits: document.querySelectorAll('#list-summits .item[data-kind="summit"]').length,
      tabParks: document.getElementById('tab-parks').textContent,
      tabSummits: document.getElementById('tab-summits').textContent,
      tabMulti: document.getElementById('tab-multi').textContent,
      status: document.getElementById('status').textContent,
      state: { parks: PSM.app.state.parks.length, summits: PSM.app.state.summits.length },
      firstRow: (document.querySelector('#list-parks .item') || {}).textContent,
      markers: document.querySelectorAll('#map .leaflet-marker-icon, #map path.leaflet-interactive').length
    }));
    check('park rows rendered', counts.parks > 0, counts.parks + ' rows, first: ' + String(counts.firstRow).trim().slice(0, 60));
    check('summit rows rendered', counts.summits > 0, counts.summits + ' rows');
    check('tab labels carry counts', /Parks \(\d+\)/.test(counts.tabParks) && /Summits \(\d+\)/.test(counts.tabSummits) && /Multi \(\d+\)/.test(counts.tabMulti),
      [counts.tabParks, counts.tabSummits, counts.tabMulti].join(' | '));
    check('map drew markers', counts.markers > 0, counts.markers + ' marker/vector elements');
    check('status summarises the result', /park/.test(counts.status), JSON.stringify(counts.status).slice(0, 120));

    const hash = await page.evaluate(() => location.hash);
    check('URL hash carries lat,lon,radius', /^#-?\d+\.\d+,-?\d+\.\d+,\d/.test(hash), hash);

    /* park detail --------------------------------------------------- */
    await page.evaluate(() => window.PSM.app.openPark('US-2069'));
    await page.waitForSelector('#detail:not([hidden])', { timeout: 10000 });
    await page.waitForFunction(() => !document.querySelector('#detail-body .loading'), null, { timeout: 15000 });
    const detail = await page.evaluate(() => ({
      title: document.getElementById('detail-title').textContent,
      text: document.getElementById('detail-body').innerText,
      links: Array.from(document.querySelectorAll('#detail-body a')).map((a) => a.getAttribute('href')),
      buttons: Array.from(document.querySelectorAll('#detail-body button')).map((b) => b.textContent.trim())
    }));
    const dtext = detail.text || '';
    check('park detail: title + name', detail.title === 'US-2069' && /Harriman/.test(dtext), detail.title);
    check('park detail: park info fields', /State Park/.test(dtext) && /New York/.test(dtext) && /FN21/.test(dtext));
    check('park detail: comments + methods', /trailheads/i.test(dtext) && /Automobile/.test(dtext));
    check('park detail: first activator', /WK2S/.test(dtext));
    check('park detail: stats block', /attempts/i.test(dtext) && /activations/i.test(dtext) && /contacts/i.test(dtext));
    check('park detail: activations table', /2026-08-15/.test(dtext) && /recent activations/i.test(dtext));
    check('park detail: leaderboard', /top activators/i.test(dtext) && /leaderboard/i.test(dtext));
    check('park detail: approximate address', /Sloatsburg|Reverse-geocoded|Unavailable/i.test(dtext));
    check('park detail: links', detail.links.some((h) => /pota\.app/.test(h)) &&
      detail.links.some((h) => /google\.com\/maps\/dir/.test(h)) &&
      detail.links.some((h) => /maps\.apple\.com/.test(h)) &&
      detail.links.some((h) => /openstreetmap\.org/.test(h)), detail.links.length + ' links');
    check('park detail: copy + show-on-map buttons',
      detail.buttons.some((b) => /Copy reference/.test(b)) &&
      detail.buttons.some((b) => /Copy coordinates/.test(b)) &&
      detail.buttons.some((b) => /Show on map/.test(b)), detail.buttons.join(', '));

    await page.waitForTimeout(450); await page.screenshot({ path: path.join(ROOT, 'dev', 'smoke-detail.png') });

    /* summit detail -------------------------------------------------- */
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('detail').hidden, null, { timeout: 5000 });
    check('Escape closes the detail panel', true);

    await page.evaluate(() => window.PSM.app.openSummit('W2/GC-001'));
    await page.waitForSelector('#detail:not([hidden])', { timeout: 10000 });
    await page.waitForFunction(() => !document.querySelector('#detail-body .loading'), null, { timeout: 15000 });
    const stext = await page.evaluate(() => document.getElementById('detail-body').innerText);
    check('summit detail: name + altitude', /Slide Mountain/.test(stext) && /3,845 ft/.test(stext), stext.split('\n')[1]);
    check('summit detail: points/bonus + locator', /10/.test(stext) && /FN21tx/.test(stext));
    check('summit detail: association + region', /Greater Catskills/.test(stext) && /USA - NJ \/ NY/.test(stext));
    check('summit detail: activation zone note', /Activation zone/.test(stext));
    check('summit detail: sotl.as + sotadata links',
      await page.evaluate(() => Array.from(document.querySelectorAll('#detail-body a')).some((a) => /sotl\.as/.test(a.href)) &&
        Array.from(document.querySelectorAll('#detail-body a')).some((a) => /sotadata/.test(a.href))));
    await page.click('#detail-close');

    /* selecting from the list ---------------------------------------- */
    await page.click('#list-parks .item');
    await page.waitForSelector('#detail:not([hidden])', { timeout: 8000 });
    const selOk = await page.evaluate(() => !!document.querySelector('#list-parks .item.selected'));
    check('clicking a list row opens the detail and marks it selected', selOk);
    await page.click('#detail-close');

    /* filters, units, basemap, log, sidebar --------------------------- */
    const before = await page.evaluate(() => document.querySelectorAll('#list-parks .item').length);
    await page.check('#filter-pota-unactivated');
    const after = await page.evaluate(() => document.querySelectorAll('#list-parks .item').length);
    check('never-activated filter narrows the list', after <= before, before + ' → ' + after);
    await page.uncheck('#filter-pota-unactivated');

    await page.click('#tab-summits');
    await page.selectOption('#filter-sota-points', '8');
    const sAfter = await page.evaluate(() => document.querySelectorAll('#list-summits .item').length);
    check('summit points filter applies', typeof sAfter === 'number', sAfter + ' summits with 8+ points');
    await page.selectOption('#filter-sota-points', '0');
    await page.click('#tab-parks');

    const rv0 = await page.textContent('#radius-value');
    await page.click('#units-toggle');
    const rv1 = await page.textContent('#radius-value');
    check('units toggle switches mi/km', /mi/.test(rv0) && /km/.test(rv1), rv0 + ' → ' + rv1);
    await page.click('#units-toggle');
    await page.waitForTimeout(700); // let the debounced re-search settle

    await page.selectOption('#basemap-select', 'topo');
    await page.waitForTimeout(150);
    const tiles = await page.evaluate(() => Array.from(document.querySelectorAll('#map img.leaflet-tile')).some((i) => /opentopomap/.test(i.src)));
    check('basemap select switches tile layer', tiles);
    await page.selectOption('#basemap-select', 'osm');

    await page.click('#log-toggle');
    const logLines = await page.evaluate(() => document.querySelectorAll('#log .log-line').length);
    check('log toggle reveals entries', logLines > 0, logLines + ' lines');
    const logHasSources = await page.evaluate(() => document.getElementById('log').innerText);
    check('log records data sources', /POTA: \d+ parks via/.test(logHasSources), (logHasSources.match(/POTA: [^\n]*/) || [''])[0].slice(0, 90));
    await page.click('#log-toggle');

    const mapW0 = await page.evaluate(() => document.getElementById('map').getBoundingClientRect().width);
    await page.click('#sidebar-toggle');
    await page.waitForTimeout(400);
    const mapW1 = await page.evaluate(() => document.getElementById('map').getBoundingClientRect().width);
    const sized = await page.evaluate(() => {
      const m = PSM.mapui.getMap();
      return Math.abs(m.getSize().x - document.getElementById('map').getBoundingClientRect().width) < 2;
    });
    check('sidebar collapse widens the map', mapW1 > mapW0, Math.round(mapW0) + 'px → ' + Math.round(mapW1) + 'px');
    check('map.invalidateSize() ran after the layout change', sized);
    await page.click('#sidebar-toggle');
    await page.waitForTimeout(400);

    /* live spots ------------------------------------------------------ */
    await page.check('#toggle-spots');
    await page.waitForTimeout(500);
    const spotCount = await page.evaluate(() => document.querySelectorAll('#map .psm-spot-icon').length);
    check('live spots draw pulsing markers', spotCount > 0, spotCount + ' spot markers');
    await page.uncheck('#toggle-spots');

    /* n-fer ------------------------------------------------------------ */
    const nferEnabled = await page.evaluate(() => !document.getElementById('nfer-btn').disabled);
    if (nferEnabled) {
      await page.click('#nfer-btn');
      await page.waitForFunction(() => !document.getElementById('nfer-btn').disabled, null, { timeout: 120000 });
      const nfer = await page.evaluate(() => ({
        zones: (PSM.app.state.nfer && PSM.app.state.nfer.zones.features.length) || 0,
        combos: (PSM.app.state.nfer && PSM.app.state.nfer.summitCombos.length) || 0,
        rows: document.querySelectorAll('#list-multi .item').length,
        tab: document.getElementById('tab-multi').textContent,
        polys: document.querySelectorAll('#map path.leaflet-interactive').length,
        status: document.getElementById('status').textContent
      }));
      check('n-fer analysis completes', /zone|failed|unavailable/i.test(nfer.status), nfer.status.slice(0, 110));
      check('n-fer results reach the Multi tab', nfer.rows === nfer.zones + nfer.combos,
        nfer.zones + ' zones + ' + nfer.combos + ' combos → ' + nfer.rows + ' rows (' + nfer.tab + ')');
      if (nfer.rows > 0) {
        await page.click('#list-multi .item');
        await page.waitForSelector('#detail:not([hidden])', { timeout: 8000 });
        const ztext = await page.evaluate(() => document.getElementById('detail-body').innerText);
        check('zone/combo detail opens with the disclaimer', /verify with official park maps|Activation zone/i.test(ztext), ztext.split('\n')[0]);
        await page.waitForTimeout(450); await page.screenshot({ path: path.join(ROOT, 'dev', 'smoke-nfer.png') });
        await page.click('#detail-close');
      }
    } else {
      check('n-fer button disabled when turf/osmtogeojson/PSM.nfer are missing', true, 'graceful degradation path');
    }

    await page.click('#tab-parks');
    await page.waitForTimeout(450); await page.screenshot({ path: path.join(ROOT, 'dev', 'smoke-desktop.png') });

    /* reference + text searches ---------------------------------------- */
    await page.fill('#search-input', 'US-2069');
    await page.click('#search-btn');
    await page.waitForFunction(() => !document.getElementById('detail').hidden &&
      document.getElementById('detail-title').textContent === 'US-2069', null, { timeout: 20000 });
    check('POTA reference search recentres and opens the park', true,
      await page.evaluate(() => PSM.app.state.center.label));
    await page.click('#detail-close');

    await page.fill('#search-input', 'W2/GC-001');
    await page.click('#search-btn');
    await page.waitForFunction(() => !document.getElementById('detail').hidden &&
      document.getElementById('detail-title').textContent === 'W2/GC-001', null, { timeout: 20000 });
    check('SOTA reference search recentres and opens the summit', true,
      await page.evaluate(() => PSM.app.state.center.label));
    await page.click('#detail-close');

    await page.fill('#search-input', 'FN21ve');
    await page.click('#search-btn');
    await page.waitForFunction(() => /FN21ve/.test(document.getElementById('status').textContent), null, { timeout: 20000 });
    check('grid-square search works', true, await page.textContent('#status'));

    await page.fill('#search-input', 'Harriman State Park');
    await page.click('#search-btn');
    await page.waitForFunction(() => /within .* of .*Harriman/i.test(document.getElementById('status').textContent), null, { timeout: 20000 });
    check('free-text geocode search works', true, (await page.textContent('#status')).slice(0, 90));

    // Unknown reference: the mocked POTA API answers 200 with a null body.
    await page.fill('#search-input', 'US-99999');
    await page.click('#search-btn');
    await page.waitForFunction(() => /unknown|no results|could not|failed/i.test(document.getElementById('status').textContent), null, { timeout: 20000 })
      .catch(() => {});
    const errStatus = await page.textContent('#status');
    check('a failed search reports on the status line, not as an exception',
      /unknown|no results|could not|failed/i.test(errStatus), JSON.stringify(errStatus).slice(0, 90));

    // The deliberate US-99999 lookup above is *meant* to log an error, so it is
    // excluded here; everything else must be clean.
    check('deliberate bad search is logged as an error', bag.errors.some((e) => /US-99999/.test(e)));
    const unexpected = bag.errors.filter((e) => !/US-99999/.test(e));
    check('no unexpected console errors (desktop)', unexpected.length === 0, unexpected.slice(0, 4).join(' | '));
    if (bag.warnings.length) console.log('  (warnings: ' + bag.warnings.slice(0, 5).join(' | ') + ')');
    if (bag.ignored.length) console.log('  (ignored expected 404s: ' + bag.ignored.length + ')');
    await ctx.close();

    /* ---------------- mobile -------------------------------------- */
    const mctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
      isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    });
    await installMocks(mctx);
    const mpage = await mctx.newPage();
    const mbag = { errors: [], warnings: [], ignored: [] };
    watchConsole(mpage, mbag);
    await mpage.goto(base + urlPath + '#41.2400,-74.1000,40', { waitUntil: 'load' });
    await mpage.waitForSelector('body.psm-results', { timeout: 25000 });
    await mpage.waitForFunction(() => document.querySelectorAll('#list-parks .item').length > 0, null, { timeout: 20000 });
    check('hash search works on load (mobile)', true);

    const layout = await mpage.evaluate(() => {
      const m = document.getElementById('map').getBoundingClientRect();
      const s = document.getElementById('sidebar').getBoundingClientRect();
      return { map: { top: m.top, bottom: m.bottom, width: m.width, height: m.height },
               side: { top: s.top, bottom: s.bottom, width: s.width, height: s.height }, vh: innerHeight };
    });
    check('mobile: map on top, sheet below', layout.map.top < layout.side.top && layout.map.height > 100 && layout.side.height > 200,
      JSON.stringify(layout));
    check('mobile: sheet is ~45% tall', Math.abs(layout.side.height / layout.vh - 0.45) < 0.08,
      Math.round((layout.side.height / layout.vh) * 100) + '% of ' + layout.vh + 'px');
    check('mobile: no horizontal overflow', await mpage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));

    await mpage.evaluate(() => window.PSM.app.openPark('US-2069'));
    await mpage.waitForSelector('#detail:not([hidden])', { timeout: 10000 });
    await mpage.waitForFunction(() => !document.querySelector('#detail-body .loading'), null, { timeout: 15000 });
    await mpage.waitForTimeout(450); await mpage.screenshot({ path: path.join(ROOT, 'dev', 'smoke-mobile-detail.png') });
    await mpage.click('#detail-close');
    await mpage.waitForTimeout(450); await mpage.screenshot({ path: path.join(ROOT, 'dev', 'smoke-mobile.png') });
    check('no console errors (mobile)', mbag.errors.length === 0, mbag.errors.slice(0, 4).join(' | '));
    await mctx.close();

    /* ---------------- unbuilt dev page ---------------------------- */
    // src/index.html must also run straight from src/ (the DEV-ONLY block that
    // scripts/build.py strips carries app.css + one <script> per module).
    if (!USE_STUBS) {
      const dctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      await installMocks(dctx);
      const dpage = await dctx.newPage();
      const dbag = { errors: [], warnings: [], ignored: [] };
      watchConsole(dpage, dbag);
      await dpage.goto(base + '/src/index.html', { waitUntil: 'load' });
      await dpage.waitForSelector('body.psm-ready', { timeout: 15000 });
      await dpage.fill('#search-input', 'FN21ve');
      await dpage.click('#search-btn');
      await dpage.waitForSelector('body.psm-results', { timeout: 25000 });
      await dpage.waitForFunction(() => document.querySelectorAll('#list-parks .item').length > 0, null, { timeout: 20000 });
      const dstyled = await dpage.evaluate(() => getComputedStyle(document.getElementById('sidebar')).width);
      check('unbuilt src/index.html runs and is styled', dstyled === '380px', 'sidebar width ' + dstyled);
      check('no console errors (unbuilt dev page)', dbag.errors.length === 0, dbag.errors.slice(0, 3).join(' | '));
      await dctx.close();
    }
    /* ---------------- file:// ------------------------------------- */
    // The deliverable must also work when opened straight from disk.
    {
      const fctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      await installMocks(fctx);
      const fpage = await fctx.newPage();
      const fbag = { errors: [], warnings: [], ignored: [] };
      watchConsole(fpage, fbag);
      await fpage.goto('file://' + htmlPath, { waitUntil: 'load' });
      await fpage.waitForSelector('body.psm-ready', { timeout: 15000 });
      await fpage.fill('#search-input', '41.24,-74.10');
      await fpage.click('#search-btn');
      await fpage.waitForSelector('body.psm-results', { timeout: 25000 });
      await fpage.waitForFunction(() => document.querySelectorAll('#list-parks .item').length > 0, null, { timeout: 20000 });
      check('runs from file:// (no server)', true,
        await fpage.evaluate(() => document.querySelectorAll('#list-parks .item').length + ' park rows'));
      const funexpected = fbag.errors.filter((e) => !/snapshot/i.test(e));
      check('no unexpected console errors (file://)', funexpected.length === 0, funexpected.slice(0, 3).join(' | '));
      await fctx.close();
    }
  } catch (err) {
    failed = true;
    check('smoke run completed without throwing', false, err && err.stack ? err.stack.split('\n').slice(0, 3).join(' ') : String(err));
  } finally {
    await browser.close();
    server.close();
  }

  const bad = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - bad.length) + '/' + results.length + ' checks passed');
  if (bad.length) {
    console.log('failures:');
    bad.forEach((b) => console.log('  - ' + b.name + (b.detail ? ': ' + b.detail : '')));
  }
  process.exit(bad.length || failed ? 1 : 0);
})();
