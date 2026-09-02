'use strict';
/**
 * tests/mock-network.js
 *
 * Registers Playwright network routes on a BrowserContext so the POTA/SOTA map app can run fully
 * offline: every external host it talks to (CDN libraries, map tiles, the POTA/SOTA APIs, the SOTA
 * summits CSV, geocoders, Overpass) is answered from local files under tests/fixtures/ and
 * dev/vendor/, or synthesized on the fly from those fixtures.
 *
 * Usage:
 *   const { installMocks } = require('./mock-network');
 *   const mocks = await installMocks(context, { fail: ['api.pota.app/location'] });
 *   ... run the page ...
 *   console.log(mocks.requests, mocks.tileCount, mocks.overpassQueries);
 *
 * See tests/README-tests.md for the full list of routed URLs and options.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const VENDOR_DIR = path.join(__dirname, '..', 'dev', 'vendor');

// ---------------------------------------------------------------------------
// A tiny valid 256x256 grayscale PNG, built by hand (signature + IHDR + IDAT + IEND) so the harness
// has no dependency beyond core Node "zlib". Verified against a real PNG decoder while developing
// this file (256x256, single flat grey channel, ~560 bytes after deflate).
// ---------------------------------------------------------------------------
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makeGreyPng(size = 256, grey = 224) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method
  const rowBytes = size + 1; // 1 filter-type byte + `size` grey bytes
  const raw = Buffer.alloc(rowBytes * size, grey);
  for (let y = 0; y < size; y++) raw[y * rowBytes] = 0; // filter type "None" per row
  const idat = zlib.deflateSync(raw);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// CDN library files -> local vendor copies
// ---------------------------------------------------------------------------
const CDN_FILES = [
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css', file: 'leaflet-1.9.4/dist/leaflet.css', type: 'text/css' },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js', file: 'leaflet-1.9.4/dist/leaflet.js', type: 'application/javascript' },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js.map', file: 'leaflet-1.9.4/dist/leaflet.js.map', type: 'application/json' },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png', file: 'leaflet-1.9.4/dist/images/marker-icon.png', type: 'image/png' },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png', file: 'leaflet-1.9.4/dist/images/marker-icon-2x.png', type: 'image/png' },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png', file: 'leaflet-1.9.4/dist/images/marker-shadow.png', type: 'image/png' },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/layers.png', file: 'leaflet-1.9.4/dist/images/layers.png', type: 'image/png' },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/layers-2x.png', file: 'leaflet-1.9.4/dist/images/layers-2x.png', type: 'image/png' },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.css', file: 'leaflet.markercluster-1.5.3/dist/MarkerCluster.css', type: 'text/css' },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.Default.css', file: 'leaflet.markercluster-1.5.3/dist/MarkerCluster.Default.css', type: 'text/css' },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/leaflet.markercluster.js', file: 'leaflet.markercluster-1.5.3/dist/leaflet.markercluster.js', type: 'application/javascript' },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/leaflet.markercluster.js.map', file: 'leaflet.markercluster-1.5.3/dist/leaflet.markercluster.js.map', type: 'application/json' },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/Turf.js/7.4.0/turf.min.js', file: 'turf-turf-7.4.0/turf.min.js', type: 'application/javascript' },
  { url: 'https://cdn.jsdelivr.net/npm/osmtogeojson@3.0.0-beta.5/osmtogeojson.js', file: 'osmtogeojson-3.0.0-beta.5/osmtogeojson.js', type: 'application/javascript' },
];
const CDN_MAP = new Map(CDN_FILES.map((e) => [e.url, e]));

function isTileHost(hostname) {
  return (
    hostname === 'tile.openstreetmap.org' ||
    hostname.endsWith('.tile.opentopomap.org') ||
    hostname === 'basemap.nationalmap.gov' ||
    hostname === 'server.arcgisonline.com'
  );
}

// ---------------------------------------------------------------------------
// POTA API (https://api.pota.app/...)
// ---------------------------------------------------------------------------
function synthId(ref, counter) {
  const m = /(\d+)\s*$/.exec(ref || '');
  return m ? parseInt(m[1], 10) : counter.next();
}

function synthesizeParkDetail(ref, ny) {
  const row = ny.find((p) => p.reference === ref);
  if (!row) return null;
  // Per the harness spec: name/lat/lon/grid come from the NY list row; parktypeDesc/locationDesc/
  // locationName are hard-set the way every row in this NY fixture actually is ("State Park" is a
  // reasonable stand-in type for any US-#### ref not otherwise fixture-backed).
  return {
    parkId: null,
    reference: row.reference,
    name: row.name,
    latitude: row.latitude,
    longitude: row.longitude,
    grid4: row.grid ? row.grid.slice(0, 4) : null,
    grid6: row.grid || null,
    parktypeId: null,
    active: null,
    parkComments: null,
    accessibility: null,
    sensitivity: null,
    accessMethods: null,
    activationMethods: null,
    agencies: null,
    agencyURLs: null,
    parkURLs: null,
    website: null,
    createdByAdmin: null,
    parktypeDesc: 'State Park',
    locationDesc: row.locationDesc || 'US-NY',
    locationName: 'New York',
    entityId: null,
    entityName: null,
    referencePrefix: (row.reference || '').split('-')[0] || null,
    entityDeleted: 0,
    firstActivator: null,
    firstActivationDate: null,
  };
}

function buildLookupResults(search, ny, counter) {
  if (!search) return [];
  const q = search.toLowerCase();
  const matches = ny.filter((p) => p.name.toLowerCase().includes(q));
  matches.sort((a, b) => a.name.localeCompare(b.name));
  return matches.slice(0, 50).map((p) => ({
    type: 'park',
    id: synthId(p.reference, counter),
    display: `${p.reference}  ${p.name}`,
    value: p.reference,
  }));
}

/** @returns {{status:number, body:any}} */
function handlePota(pathname, searchParams, fx) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'location' && parts[1] === 'parks' && parts.length === 3) {
    const state = parts[2];
    if (state === 'US-NY') return { status: 200, body: fx.loadJSON('pota_location_parks_US-NY.json') };
    return { status: 200, body: [] };
  }
  if (parts[0] === 'park' && parts[1] === 'grid' && parts.length === 3) {
    const fname = `pota_park_grid_${parts[2]}.json`;
    if (fx.exists(fname)) return { status: 200, body: fx.loadJSON(fname) };
    return { status: 200, body: [] };
  }
  if (parts[0] === 'park' && parts[1] === 'stats' && parts.length === 3) {
    return { status: 200, body: fx.loadJSON('pota_park_stats_US-2069.json') };
  }
  if (parts[0] === 'park' && parts[1] === 'activations' && parts.length === 3) {
    return { status: 200, body: fx.loadJSON('pota_park_activations_US-2069.json') };
  }
  if (parts[0] === 'park' && parts[1] === 'leaderboard' && parts.length === 3) {
    return { status: 200, body: fx.loadJSON('pota_park_leaderboard_US-2069.json') };
  }
  if (parts[0] === 'park' && parts.length === 2) {
    const ref = parts[1];
    if (ref === 'US-2069') return { status: 200, body: fx.loadJSON('pota_park_US-2069.json') };
    const ny = fx.loadJSON('pota_location_parks_US-NY.json');
    return { status: 200, body: synthesizeParkDetail(ref, ny) };
  }
  if (parts[0] === 'spot' && parts[1] === 'activator') {
    return { status: 200, body: fx.loadJSON('pota_spots.json') };
  }
  if (parts[0] === 'lookup') {
    const search = searchParams.get('search') || '';
    const ny = fx.loadJSON('pota_location_parks_US-NY.json');
    return { status: 200, body: buildLookupResults(search, ny, fx.counter) };
  }
  // Real api.pota.app returns 403 for unmatched routes (see ARCHITECTURE.md).
  return { status: 403, body: { error: 'unmatched pota route (mocked)' } };
}

// ---------------------------------------------------------------------------
// SOTA API (https://api2.sota.org.uk/api/...)
// ---------------------------------------------------------------------------
const SOTA_ASSOCIATIONS = ['W1', 'W2', 'W3'];
const SOTA_W2_REGIONS = ['GC', 'EH', 'GA', 'WE', 'NJ'];

function synthesizeSummitDetail(assoc, regionAndNum, fx) {
  if (assoc !== 'W2') return null;
  const regionCode = (regionAndNum || '').split('-')[0];
  if (!SOTA_W2_REGIONS.includes(regionCode)) return null;
  const regionFile = `sota_region_W2_${regionCode}.json`;
  if (!fx.exists(regionFile)) return null;
  const region = fx.loadJSON(regionFile);
  const code = `${assoc}/${regionAndNum}`;
  const s = (region.summits || []).find((x) => x.summitCode === code);
  if (!s) return null;
  return Object.assign({}, s, {
    associationName: region.associationName,
    regionName: region.regionName,
    valid: true,
  });
}

/** @returns {{status:number, body:any}} */
function handleSota(pathname, fx) {
  const all = pathname.split('/').filter(Boolean);
  if (all[0] !== 'api') return { status: 404, body: { error: 'not found (mocked)' } };
  const p = all.slice(1);
  if (p[0] === 'associations' && p.length === 1) {
    return { status: 200, body: fx.loadJSON('sota_associations.json') };
  }
  if (p[0] === 'associations' && p.length === 2) {
    const code = p[1];
    if (SOTA_ASSOCIATIONS.includes(code)) return { status: 200, body: fx.loadJSON(`sota_association_${code}.json`) };
    return { status: 404, body: { error: 'unknown association (mocked)' } };
  }
  if (p[0] === 'regions' && p.length === 3) {
    const assoc = p[1];
    const region = p[2];
    if (assoc === 'W2' && SOTA_W2_REGIONS.includes(region)) {
      return { status: 200, body: fx.loadJSON(`sota_region_W2_${region}.json`) };
    }
    return { status: 404, body: { error: 'unknown region (mocked)' } };
  }
  if (p[0] === 'summits' && p.length === 3) {
    const assoc = p[1];
    const regionAndNum = p[2];
    if (assoc === 'W2' && regionAndNum === 'GC-001') {
      return { status: 200, body: fx.loadJSON('sota_summit_W2_GC-001.json') };
    }
    const synth = synthesizeSummitDetail(assoc, regionAndNum, fx);
    if (synth) return { status: 200, body: synth };
    return { status: 404, body: { error: 'unknown summit (mocked)' } };
  }
  if (p[0] === 'spots' && p.length === 3 && p[2] === 'all') {
    return { status: 200, body: fx.loadJSON('sota_spots.json') };
  }
  if (p[0] === 'alerts' && p.length === 1) {
    return { status: 200, body: [] };
  }
  return { status: 404, body: { error: 'unmatched sota route (mocked)' } };
}

// ---------------------------------------------------------------------------
// SOTA summits CSV, synthesized from the W2/GC region fixture.
// ---------------------------------------------------------------------------
function todayDDMMYYYY() {
  const d = new Date();
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

function isoToDDMMYYYY(iso) {
  if (!iso) return '';
  const datePart = String(iso).slice(0, 10); // "YYYY-MM-DD"
  const bits = datePart.split('-');
  if (bits.length !== 3) return '';
  return `${bits[2]}/${bits[1]}/${bits[0]}`;
}

function csvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildSotaCsv(fx) {
  const region = fx.loadJSON('sota_region_W2_GC.json');
  const header =
    'SummitCode,AssociationName,RegionName,SummitName,AltM,AltFt,GridRef1,GridRef2,Longitude,Latitude,' +
    'Points,BonusPoints,ValidFrom,ValidTo,ActivationCount,ActivationDate,ActivationCall';
  const banner = `SOTA Summits List (Date=${todayDDMMYYYY()})`;
  const rows = (region.summits || []).map((s) =>
    [
      s.summitCode,
      region.associationName,
      region.regionName,
      s.name,
      s.altM,
      s.altFt,
      s.gridRef1,
      s.gridRef2,
      s.longitude,
      s.latitude,
      s.points,
      s.bonusPoints,
      isoToDDMMYYYY(s.validFrom),
      isoToDDMMYYYY(s.validTo),
      s.activationCount,
      isoToDDMMYYYY(s.activationDate),
      s.activationCall || '',
    ]
      .map(csvField)
      .join(',')
  );
  return [banner, header].concat(rows).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// installMocks
// ---------------------------------------------------------------------------
async function installMocks(context, options) {
  options = options || {};
  const requests = [];
  const overpassQueries = [];
  let tileCount = 0;
  const greyTile = makeGreyPng(256, 224);
  const jsonCache = new Map();
  let idCounter = 900000;
  const counter = { next: () => ++idCounter };

  function loadJSON(name) {
    if (!jsonCache.has(name)) {
      jsonCache.set(name, JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8')));
    }
    return jsonCache.get(name);
  }
  function fxExists(name) {
    return fs.existsSync(path.join(FIXTURES_DIR, name));
  }
  const fx = { loadJSON, exists: fxExists, counter };

  const CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': '*',
  };

  async function respond(route, status, body, contentType, extraHeaders) {
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : String(body));
    await route.fulfill({
      status,
      headers: Object.assign({ 'content-type': contentType || 'application/octet-stream' }, CORS_HEADERS, extraHeaders || {}),
      body: buf,
    });
  }
  async function respondJSON(route, status, value) {
    await respond(route, status, JSON.stringify(value), 'application/json');
  }

  await context.route('**/*', async (route) => {
    const request = route.request();
    const method = request.method();
    const rawUrl = request.url();
    let u;
    try {
      u = new URL(rawUrl);
    } catch (e) {
      requests.push({ method, url: rawUrl, status: 404 });
      console.warn('[mock-network] unparseable URL -> 404:', rawUrl);
      await respond(route, 404, 'not found', 'text/plain');
      return;
    }
    const cleanUrl = u.origin + u.pathname;
    const postData = request.postData() || null;

    // 1. Optional snapshot.js override, served at .../data/snapshot.js regardless of scheme/origin.
    if ((options.snapshotJs != null || options.snapshotPath) && u.pathname.endsWith('/data/snapshot.js')) {
      const body = options.snapshotJs != null ? options.snapshotJs : fs.readFileSync(options.snapshotPath, 'utf8');
      requests.push({ method, url: rawUrl, status: 200 });
      await respond(route, 200, body, 'application/javascript');
      return;
    }

    // 2. Local passthrough: never touch the app's own origin (the test static server, or file://).
    if (u.protocol === 'file:' || (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'))) {
      await route.continue();
      return;
    }

    // 3. Simulated failures, checked against the full URL.
    if (Array.isArray(options.fail) && options.fail.some((sub) => rawUrl.includes(sub))) {
      requests.push({ method, url: rawUrl, status: 503, postData });
      await respond(route, 503, 'Service Unavailable (mocked failure)', 'text/plain');
      return;
    }

    // 4. CORS preflight safety net (none of the mocked calls should need this, but just in case).
    if (method === 'OPTIONS') {
      requests.push({ method, url: rawUrl, status: 204 });
      await respond(route, 204, '', 'text/plain');
      return;
    }

    // 5. CDN vendor files.
    const cdnEntry = CDN_MAP.get(cleanUrl);
    if (cdnEntry) {
      const filePath = path.join(VENDOR_DIR, cdnEntry.file);
      if (fs.existsSync(filePath)) {
        requests.push({ method, url: rawUrl, status: 200 });
        await respond(route, 200, fs.readFileSync(filePath), cdnEntry.type);
      } else {
        requests.push({ method, url: rawUrl, status: 404 });
        console.warn('[mock-network] vendor file missing on disk:', filePath);
        await respond(route, 404, 'vendor file missing (mocked)', 'text/plain');
      }
      return;
    }

    // 6. Map tile servers.
    if (isTileHost(u.hostname)) {
      tileCount++;
      requests.push({ method, url: rawUrl, status: 200 });
      await respond(route, 200, greyTile, 'image/png');
      return;
    }

    // 7. POTA API.
    if (u.hostname === 'api.pota.app') {
      const result = handlePota(u.pathname, u.searchParams, fx);
      requests.push({ method, url: rawUrl, status: result.status, postData });
      await respondJSON(route, result.status, result.body);
      return;
    }

    // 8. SOTA API.
    if (u.hostname === 'api2.sota.org.uk') {
      const result = handleSota(u.pathname, fx);
      requests.push({ method, url: rawUrl, status: result.status, postData });
      await respondJSON(route, result.status, result.body);
      return;
    }

    // 9. SOTA summits CSV (and its redirect-target host).
    if ((u.hostname === 'storage.sota.org.uk' || u.hostname === 'www.sotadata.org.uk') && u.pathname === '/summitslist.csv') {
      if (options.blockSotaCsv) {
        requests.push({ method, url: rawUrl, status: 403 });
        await respond(route, 403, 'Forbidden (mocked)', 'text/plain');
        return;
      }
      requests.push({ method, url: rawUrl, status: 200 });
      await respond(route, 200, buildSotaCsv(fx), 'text/csv');
      return;
    }

    // 10. Geocoders.
    if (u.hostname === 'photon.komoot.io') {
      if (u.pathname === '/api/') {
        requests.push({ method, url: rawUrl, status: 200 });
        await respondJSON(route, 200, loadJSON('photon_search.json'));
        return;
      }
      if (u.pathname === '/reverse') {
        requests.push({ method, url: rawUrl, status: 200 });
        await respondJSON(route, 200, loadJSON('photon_reverse.json'));
        return;
      }
    }
    if (u.hostname === 'nominatim.openstreetmap.org') {
      if (u.pathname === '/search') {
        requests.push({ method, url: rawUrl, status: 200 });
        await respondJSON(route, 200, loadJSON('nominatim_search.json'));
        return;
      }
      if (u.pathname === '/reverse') {
        requests.push({ method, url: rawUrl, status: 200 });
        await respondJSON(route, 200, loadJSON('nominatim_reverse.json'));
        return;
      }
    }

    // 11. Overpass.
    if ((u.hostname === 'overpass-api.de' || u.hostname === 'overpass.kumi.systems') && u.pathname === '/api/interpreter') {
      if (postData) overpassQueries.push(postData);
      const overpassFixture = path.join(FIXTURES_DIR, 'overpass_harriman.json');
      requests.push({ method, url: rawUrl, status: 200, postData });
      if (fs.existsSync(overpassFixture)) {
        await respond(route, 200, fs.readFileSync(overpassFixture), 'application/json');
      } else {
        console.warn('[mock-network] tests/fixtures/overpass_harriman.json not found yet — serving {version:0.6,elements:[]}');
        await respondJSON(route, 200, { version: 0.6, elements: [] });
      }
      return;
    }

    // 12. Anything else external is unmocked.
    console.warn('[mock-network] unmocked URL -> 404:', method, rawUrl);
    requests.push({ method, url: rawUrl, status: 404, postData });
    await respond(route, 404, 'not found (unmocked by tests/mock-network.js)', 'text/plain');
  });

  return {
    requests,
    overpassQueries,
    get tileCount() {
      return tileCount;
    },
  };
}

module.exports = { installMocks, makeGreyPng };
