/* =====================================================================
 * 00-util.js — shared core for the POTA + SOTA map (namespace: window.PSM)
 * Geometry, Maidenhead grids, input parsing, fetch with timeout/retry,
 * IndexedDB cache, formatting, fuzzy name matching, CSV, US location table,
 * logging, settings, concurrency limiter.
 * ===================================================================== */
(function (global) {
  'use strict';

  const PSM = global.PSM || (global.PSM = {});
  PSM.VERSION = '1.0.0';

  /* ------------------------------------------------------------------ */
  /* Geometry                                                            */
  /* ------------------------------------------------------------------ */
  const R_EARTH_KM = 6371.0088;
  const toRad = (d) => (d * Math.PI) / 180;

  PSM.haversineKm = function (lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  };

  PSM.bearingDeg = function (lat1, lon1, lat2, lon2) {
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
      Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  };

  PSM.compass = function (deg) {
    const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return pts[Math.round(deg / 22.5) % 16];
  };

  /** Bounding box (degrees) that contains a circle of radiusKm around a point. */
  PSM.bboxAround = function (lat, lon, radiusKm) {
    const dLat = radiusKm / 111.32;
    const south = Math.max(-90, lat - dLat);
    const north = Math.min(90, lat + dLat);
    // A degree of longitude is shortest on the parallel farthest from the equator that the
    // box touches — size dLon there, or the box would clip the circle near its top/bottom.
    const cos = Math.max(0.05, Math.min(Math.cos(toRad(south)), Math.cos(toRad(north))));
    const dLon = radiusKm / (111.32 * cos);
    return {
      south: south,
      north: north,
      west: Math.max(-180, lon - dLon),
      east: Math.min(180, lon + dLon)
    };
  };

  PSM.bboxesIntersect = function (a, b) {
    return !(a.east < b.west || a.west > b.east || a.north < b.south || a.south > b.north);
  };

  PSM.pointInBbox = function (lat, lon, b) {
    return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
  };

  /* ------------------------------------------------------------------ */
  /* Maidenhead grid locators                                            */
  /* ------------------------------------------------------------------ */
  const GRID_RE = /^[A-R]{2}[0-9]{2}(?:[A-X]{2}(?:[0-9]{2})?)?$/i;

  PSM.isGrid = (text) => GRID_RE.test(String(text || '').trim());

  /** Centre of a 4/6/8 character grid square. */
  PSM.gridToLatLon = function (grid) {
    const g = String(grid || '').trim().toUpperCase();
    if (!GRID_RE.test(g)) return null;
    let lon = (g.charCodeAt(0) - 65) * 20 - 180;
    let lat = (g.charCodeAt(1) - 65) * 10 - 90;
    let lonSize = 20, latSize = 10;
    lon += parseInt(g[2], 10) * 2;
    lat += parseInt(g[3], 10) * 1;
    lonSize = 2; latSize = 1;
    if (g.length >= 6) {
      lon += (g.charCodeAt(4) - 65) * (2 / 24);
      lat += (g.charCodeAt(5) - 65) * (1 / 24);
      lonSize = 2 / 24; latSize = 1 / 24;
    }
    if (g.length >= 8) {
      lon += parseInt(g[6], 10) * (2 / 240);
      lat += parseInt(g[7], 10) * (1 / 240);
      lonSize = 2 / 240; latSize = 1 / 240;
    }
    return { lat: lat + latSize / 2, lon: lon + lonSize / 2 };
  };

  PSM.latLonToGrid = function (lat, lon, len) {
    len = len || 6;
    let adjLon = lon + 180, adjLat = lat + 90;
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWX';
    let s = '';
    s += A[Math.floor(adjLon / 20)] + A[Math.floor(adjLat / 10)];
    adjLon %= 20; adjLat %= 10;
    s += Math.floor(adjLon / 2) + '' + Math.floor(adjLat / 1);
    if (len >= 6) {
      adjLon %= 2; adjLat %= 1;
      s += A[Math.floor(adjLon / (2 / 24))].toLowerCase() + A[Math.floor(adjLat / (1 / 24))].toLowerCase();
    }
    if (len >= 8) {
      adjLon %= (2 / 24); adjLat %= (1 / 24);
      s += Math.floor(adjLon / (2 / 240)) + '' + Math.floor(adjLat / (1 / 240));
    }
    return s;
  };

  /** All 4-character grid cells (2° lon × 1° lat) intersecting a bbox. */
  PSM.grid4CellsForBbox = function (b) {
    const cells = [];
    const lonStart = Math.floor((b.west + 180) / 2) * 2 - 180;
    const latStart = Math.floor(b.south + 90) - 90;
    for (let lon = lonStart; lon <= b.east && lon < 180; lon += 2) {
      for (let lat = latStart; lat <= b.north && lat < 90; lat += 1) {
        cells.push(PSM.latLonToGrid(lat + 0.5, lon + 1, 4));
      }
    }
    return cells;
  };

  /* ------------------------------------------------------------------ */
  /* Input parsing                                                       */
  /* ------------------------------------------------------------------ */
  // POTA programme prefixes are ISO-3166 alpha-2 codes (plus the legacy 1-letter "K-####").
  // Reference numbers are 4–5 digits today; 6 is allowed so the app does not stop recognising
  // references the day a programme rolls over 99999.
  const POTA_RE = /^([A-Z]{1,2})-(\d{4,6})$/i;
  const SOTA_RE = /^([A-Z0-9]{1,3})\/([A-Z]{2})-(\d{3})$/i;

  PSM.isPotaRef = (t) => POTA_RE.test(String(t || '').trim());
  PSM.isSotaRef = (t) => SOTA_RE.test(String(t || '').trim());

  /** Normalise a POTA reference ("k-1234" → "US-1234", "us-2069" → "US-2069"). */
  PSM.normalizePotaRef = function (t) {
    const m = POTA_RE.exec(String(t || '').trim());
    if (!m) return null;
    let prefix = m[1].toUpperCase();
    if (prefix === 'K') prefix = 'US'; // POTA renamed K-#### to US-#### in 2023
    return prefix + '-' + m[2];
  };

  PSM.normalizeSotaRef = function (t) {
    const m = SOTA_RE.exec(String(t || '').trim());
    if (!m) return null;
    return (m[1] + '/' + m[2] + '-' + m[3]).toUpperCase();
  };

  /**
   * Parse "41.2, -74.1" | "41.2 -74.1" | "41.2N 74.1W" | "41°12'30\"N 74°06'W" | "N41.2 W74.1".
   * Returns {lat, lon} or null.
   */
  PSM.parseLatLon = function (text) {
    let s = String(text || '').trim();
    if (!s) return null;
    // Decimal pair: "41.2,-74.1" / "41.2 -74.1" / "41.2, -74.1"
    let m = /^([+-]?\d{1,2}(?:\.\d+)?)\s*[, ]\s*([+-]?\d{1,3}(?:\.\d+)?)$/.exec(s);
    if (m) {
      const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
      return null;
    }
    // Hemisphere-suffixed / DMS forms.
    const part = String.raw`(?:([NSEW])\s*)?(\d{1,3}(?:\.\d+)?)\s*°?(?:[\s:]*(\d{1,2}(?:\.\d+)?)\s*['′]?)?(?:[\s:]*(\d{1,2}(?:\.\d+)?)\s*["″]?)?\s*([NSEW])?`;
    const re = new RegExp('^' + part + String.raw`[\s,]+` + part + '$', 'i');
    m = re.exec(s);
    if (!m) return null;
    const toDeg = (pre, d, mi, se, post) => {
      let v = parseFloat(d) + (mi ? parseFloat(mi) / 60 : 0) + (se ? parseFloat(se) / 3600 : 0);
      const h = (pre || post || '').toUpperCase();
      if (h === 'S' || h === 'W') v = -v;
      return { v, h };
    };
    const a = toDeg(m[1], m[2], m[3], m[4], m[5]);
    const b = toDeg(m[6], m[7], m[8], m[9], m[10]);
    if (!a.h && !b.h) return null; // plain numbers without hemisphere handled above
    let lat, lon;
    if (a.h === 'N' || a.h === 'S' || b.h === 'E' || b.h === 'W') { lat = a.v; lon = b.v; }
    else { lat = b.v; lon = a.v; }
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
    return null;
  };

  /* ------------------------------------------------------------------ */
  /* Fetch helpers                                                       */
  /* ------------------------------------------------------------------ */
  class FetchError extends Error {
    constructor(message, status, url) {
      super(message);
      this.name = 'FetchError';
      this.status = status || 0;
      this.url = url;
    }
  }
  PSM.FetchError = FetchError;

  PSM.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function doFetch(url, opts, asJson) {
    opts = opts || {};
    const timeoutMs = opts.timeoutMs || 20000;
    const retries = opts.retries == null ? 1 : opts.retries;
    const outer = opts.signal && typeof opts.signal.addEventListener === 'function' ? opts.signal : null;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (opts.signal && opts.signal.aborted) throw new FetchError('aborted', 0, url);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      // One search's AbortController is shared by dozens of requests, so the listener has to
      // come off again — otherwise every call leaves a live closure hanging off the signal.
      let onAbort = null;
      if (outer) {
        onAbort = function () { ctrl.abort(); };
        outer.addEventListener('abort', onAbort, { once: true });
      }
      const cleanup = function () {
        clearTimeout(timer);
        if (onAbort) { try { outer.removeEventListener('abort', onAbort); } catch (e) { /* ignore */ } onAbort = null; }
      };
      try {
        const res = await fetch(url, {
          method: opts.method || 'GET',
          headers: opts.headers || undefined,
          body: opts.body || undefined,
          signal: ctrl.signal,
          mode: 'cors',
          credentials: 'omit',
          cache: opts.cache || 'default'
        });
        cleanup();
        if (!res.ok) {
          const err = new FetchError('HTTP ' + res.status + ' for ' + url, res.status, url);
          // Retry only on transient statuses
          if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
            lastErr = err;
            await PSM.sleep(600 * (attempt + 1));
            continue;
          }
          throw err;
        }
        return asJson ? await res.json() : await res.text();
      } catch (e) {
        cleanup();
        if (e instanceof FetchError) throw e;
        lastErr = new FetchError((e && e.name === 'AbortError' ? 'timeout/abort' : (e && e.message) || 'network error') + ' for ' + url, 0, url);
        if (opts.signal && opts.signal.aborted) throw lastErr;
        if (attempt < retries) { await PSM.sleep(500 * (attempt + 1)); continue; }
        throw lastErr;
      }
    }
    throw lastErr;
  }

  PSM.fetchJSON = (url, opts) => doFetch(url, opts, true);
  PSM.fetchText = (url, opts) => doFetch(url, opts, false);

  /* ------------------------------------------------------------------ */
  /* Cache (IndexedDB with in-memory fallback)                          */
  /* ------------------------------------------------------------------ */
  const mem = new Map();
  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      try {
        if (!global.indexedDB) return resolve(null);
        const req = global.indexedDB.open('psm-cache', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    return dbPromise;
  }
  function idb(mode, fn) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      if (!db) return resolve(undefined);
      let tx;
      try { tx = db.transaction('kv', mode); } catch (e) { return resolve(undefined); }
      const store = tx.objectStore('kv');
      let req;
      try { req = fn(store); } catch (e) { return resolve(undefined); }
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    }));
  }

  PSM.cache = {
    async get(key) {
      if (mem.has(key)) return mem.get(key);
      const rec = await idb('readonly', (s) => s.get(key));
      if (rec && typeof rec === 'object') { mem.set(key, { value: rec.value, ts: rec.ts }); return { value: rec.value, ts: rec.ts }; }
      return null;
    },
    async set(key, value) {
      const rec = { key, value, ts: Date.now() };
      mem.set(key, { value, ts: rec.ts });
      await idb('readwrite', (s) => s.put(rec));
    },
    async getFresh(key, maxAgeMs) {
      const rec = await this.get(key);
      if (!rec) return null;
      if (maxAgeMs != null && Date.now() - rec.ts > maxAgeMs) return null;
      return rec.value;
    },
    async remove(key) {
      mem.delete(key);
      await idb('readwrite', (s) => s.delete(key));
    },
    async clear() {
      mem.clear();
      await idb('readwrite', (s) => s.clear());
    },
    async keys() {
      const ks = await idb('readonly', (s) => s.getAllKeys());
      return ks || Array.from(mem.keys());
    }
  };

  /** True for the errors doFetch/checkAbort raise when a request was cancelled. */
  function isAbortError(e) {
    if (!e) return false;
    if (e.name === 'AbortError') return true;
    return /\babort/i.test(String(e.message || ''));
  }
  PSM.isAbortError = isAbortError;

  /** Cache-through helper: returns cached value if fresh, else runs producer and stores. */
  const inflight = new Map();
  PSM.memo = async function (key, maxAgeMs, producer) {
    const cached = await PSM.cache.getFresh(key, maxAgeMs);
    if (cached !== null && cached !== undefined) return cached;
    const pending = inflight.get(key);
    if (pending) {
      try {
        return await pending;
      } catch (e) {
        // The in-flight request belongs to whoever asked first, and its AbortSignal does too.
        // If *that* caller cancelled (a new search superseding an old one, a timeout), the
        // failure is not ours: drop the dead entry and run the producer with our own signal.
        if (!isAbortError(e)) throw e;
        if (inflight.get(key) === pending) inflight.delete(key);
      }
    }
    // `Promise.resolve().then(producer)` keeps a producer that throws synchronously from
    // running the `finally` before `p` exists.
    const p = (async () => {
      try {
        const value = await Promise.resolve().then(producer);
        if (value !== undefined && value !== null) await PSM.cache.set(key, value);
        return value;
      } finally { if (inflight.get(key) === p) inflight.delete(key); }
    })();
    inflight.set(key, p);
    return p;
  };

  /* ------------------------------------------------------------------ */
  /* Formatting                                                          */
  /* ------------------------------------------------------------------ */
  const KM_PER_MI = 1.609344;
  PSM.KM_PER_MI = KM_PER_MI;
  PSM.fmt = {
    num(n) {
      if (n == null || n === '' || isNaN(n)) return '—';
      return Number(n).toLocaleString('en-US');
    },
    dist(km, units) {
      if (km == null || isNaN(km)) return '—';
      if ((units || PSM.settings.units) === 'mi') {
        const mi = km / KM_PER_MI;
        return (mi < 10 ? mi.toFixed(1) : Math.round(mi).toLocaleString('en-US')) + ' mi';
      }
      return (km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString('en-US')) + ' km';
    },
    elev(m, units) {
      if (m == null || isNaN(m)) return '—';
      if ((units || PSM.settings.units) === 'mi') return Math.round(m * 3.28084).toLocaleString('en-US') + ' ft';
      return Math.round(m).toLocaleString('en-US') + ' m';
    },
    /** Tolerant date → ISO "YYYY-MM-DD" (or the original string if unparseable). */
    date(str) {
      if (!str) return '—';
      const s = String(str).trim();
      let m;
      if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return `${m[1]}-${m[2]}-${m[3]}`;
      if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) return `${m[1]}-${m[2]}-${m[3]}`;
      if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; // DD/MM/YYYY (SOTA)
      const d = new Date(s);
      if (!isNaN(d)) return d.toISOString().slice(0, 10);
      return s;
    },
    latlon(lat, lon, digits) {
      digits = digits == null ? 5 : digits;
      return Number(lat).toFixed(digits) + ', ' + Number(lon).toFixed(digits);
    },
    freq(khz) {
      const f = parseFloat(khz);
      if (isNaN(f)) return String(khz || '—');
      return (f / 1000).toFixed(3) + ' MHz';
    },
    ago(iso) {
      const t = new Date(iso);
      if (isNaN(t)) return '';
      const s = Math.max(0, (Date.now() - t.getTime()) / 1000);
      if (s < 90) return Math.round(s) + 's ago';
      if (s < 5400) return Math.round(s / 60) + 'm ago';
      if (s < 172800) return Math.round(s / 3600) + 'h ago';
      return Math.round(s / 86400) + 'd ago';
    }
  };

  PSM.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  /** Turn a possibly scheme-less website value into a safe href (or null). */
  PSM.safeUrl = function (u) {
    if (!u) return null;
    let s = String(u).trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) {
      if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(s)) s = 'https://' + s; else return null;
    }
    try { const url = new URL(s); if (!/^https?:$/.test(url.protocol)) return null; return url.href; } catch (e) { return null; }
  };

  /* ------------------------------------------------------------------ */
  /* Fuzzy name matching                                                 */
  /* ------------------------------------------------------------------ */
  const STOP = new Set(('state park parks forest forests national wildlife management area areas preserve preserves ' +
    'historic historical site sites recreation recreational natural nature reserve reserves sanctuary refuge ' +
    'conservation wild scenic river rivers trail trails the of and at in on de la le county city town memorial ' +
    'monument seashore lakeshore marine estuarine research public land lands unit units wma wmas sp sf nf nwr ' +
    'ma wa game gamelands lands boat launch access fishing hunting').split(/\s+/));

  PSM.normalizeName = function (s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w && !STOP.has(w))
      .join(' ');
  };

  PSM.nameTokens = function (s) {
    const n = PSM.normalizeName(s);
    return n ? n.split(' ') : [];
  };

  /** Token Jaccard similarity (0..1) on normalized names; 1 if equal after normalization. */
  PSM.nameSimilarity = function (a, b) {
    const ta = new Set(PSM.nameTokens(a));
    const tb = new Set(PSM.nameTokens(b));
    if (!ta.size || !tb.size) return 0;
    let inter = 0;
    ta.forEach((w) => { if (tb.has(w)) inter++; });
    const union = ta.size + tb.size - inter;
    return union ? inter / union : 0;
  };

  /* ------------------------------------------------------------------ */
  /* CSV                                                                 */
  /* ------------------------------------------------------------------ */
  PSM.parseCSV = function (text) {
    const rows = [];
    let row = [], field = '', inQ = false;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQ) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false;
        } else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  };

  /* ------------------------------------------------------------------ */
  /* US locations (POTA locationDesc codes) with padded bounding boxes  */
  /* ------------------------------------------------------------------ */
  const PAD = 0.4;
  const raw = {
    'US-AL': ['Alabama', 30.2, -88.5, 35.0, -84.9],
    'US-AK': ['Alaska', 51.2, -180, 71.4, -129.9],
    'US-AZ': ['Arizona', 31.3, -114.8, 37.0, -109.0],
    'US-AR': ['Arkansas', 33.0, -94.6, 36.5, -89.6],
    'US-CA': ['California', 32.5, -124.5, 42.0, -114.1],
    'US-CO': ['Colorado', 37.0, -109.1, 41.0, -102.0],
    'US-CT': ['Connecticut', 40.98, -73.73, 42.05, -71.78],
    'US-DE': ['Delaware', 38.45, -75.79, 39.84, -75.05],
    'US-DC': ['District of Columbia', 38.79, -77.12, 38.995, -76.91],
    'US-FL': ['Florida', 24.4, -87.6, 31.0, -80.0],
    'US-GA': ['Georgia', 30.36, -85.6, 35.0, -80.8],
    'US-HI': ['Hawaii', 18.9, -160.3, 22.3, -154.8],
    'US-ID': ['Idaho', 42.0, -117.25, 49.0, -111.04],
    'US-IL': ['Illinois', 36.97, -91.5, 42.5, -87.5],
    'US-IN': ['Indiana', 37.77, -88.1, 41.76, -84.78],
    'US-IA': ['Iowa', 40.37, -96.64, 43.5, -90.14],
    'US-KS': ['Kansas', 36.99, -102.05, 40.0, -94.59],
    'US-KY': ['Kentucky', 36.5, -89.57, 39.15, -81.96],
    'US-LA': ['Louisiana', 28.9, -94.05, 33.02, -88.8],
    'US-ME': ['Maine', 43.06, -71.08, 47.46, -66.95],
    'US-MD': ['Maryland', 37.9, -79.49, 39.72, -75.05],
    'US-MA': ['Massachusetts', 41.24, -73.51, 42.89, -69.93],
    'US-MI': ['Michigan', 41.7, -90.42, 48.3, -82.12],
    'US-MN': ['Minnesota', 43.5, -97.24, 49.38, -89.49],
    'US-MS': ['Mississippi', 30.17, -91.65, 35.0, -88.1],
    'US-MO': ['Missouri', 35.99, -95.77, 40.61, -89.1],
    'US-MT': ['Montana', 44.36, -116.05, 49.0, -104.04],
    'US-NE': ['Nebraska', 39.99, -104.05, 43.0, -95.31],
    'US-NV': ['Nevada', 35.0, -120.0, 42.0, -114.04],
    'US-NH': ['New Hampshire', 42.7, -72.56, 45.3, -70.6],
    'US-NJ': ['New Jersey', 38.93, -75.56, 41.36, -73.89],
    'US-NM': ['New Mexico', 31.33, -109.05, 37.0, -103.0],
    'US-NY': ['New York', 40.5, -79.76, 45.02, -71.85],
    'US-NC': ['North Carolina', 33.84, -84.32, 36.59, -75.46],
    'US-ND': ['North Dakota', 45.93, -104.05, 49.0, -96.55],
    'US-OH': ['Ohio', 38.4, -84.82, 41.98, -80.52],
    'US-OK': ['Oklahoma', 33.62, -103.0, 37.0, -94.43],
    'US-OR': ['Oregon', 41.99, -124.57, 46.29, -116.46],
    'US-PA': ['Pennsylvania', 39.72, -80.52, 42.27, -74.69],
    'US-RI': ['Rhode Island', 41.15, -71.86, 42.02, -71.12],
    'US-SC': ['South Carolina', 32.03, -83.35, 35.22, -78.54],
    'US-SD': ['South Dakota', 42.48, -104.06, 45.95, -96.44],
    'US-TN': ['Tennessee', 34.98, -90.31, 36.68, -81.65],
    'US-TX': ['Texas', 25.84, -106.65, 36.5, -93.51],
    'US-UT': ['Utah', 36.99, -114.05, 42.0, -109.04],
    'US-VT': ['Vermont', 42.73, -73.44, 45.02, -71.46],
    'US-VA': ['Virginia', 36.54, -83.68, 39.47, -75.24],
    'US-WA': ['Washington', 45.54, -124.85, 49.0, -116.92],
    'US-WV': ['West Virginia', 37.2, -82.64, 40.64, -77.72],
    'US-WI': ['Wisconsin', 42.49, -92.89, 47.31, -86.25],
    'US-WY': ['Wyoming', 40.99, -111.06, 45.0, -104.05],
    'US-PR': ['Puerto Rico', 17.9, -67.95, 18.52, -65.22],
    'US-VI': ['U.S. Virgin Islands', 17.67, -65.1, 18.42, -64.55],
    'US-GU': ['Guam', 13.23, 144.6, 13.66, 145.0],
    'US-AS': ['American Samoa', -14.4, -171.1, -11.0, -168.1],
    'US-MP': ['Northern Mariana Islands', 14.1, 144.9, 20.6, 146.1]
  };
  PSM.LOCATIONS = {};
  Object.keys(raw).forEach((code) => {
    const [name, s, w, n, e] = raw[code];
    PSM.LOCATIONS[code] = { code, name, bbox: { south: s - PAD, west: w - PAD, north: n + PAD, east: e + PAD } };
  });
  PSM.US_STATES = PSM.LOCATIONS; // alias

  const NAME_TO_CODE = {};
  Object.keys(PSM.LOCATIONS).forEach((c) => { NAME_TO_CODE[PSM.LOCATIONS[c].name.toLowerCase()] = c; NAME_TO_CODE[c.slice(3).toLowerCase()] = c; });
  NAME_TO_CODE['washington, d.c.'] = 'US-DC'; NAME_TO_CODE['washington dc'] = 'US-DC';
  PSM.stateCodeForName = function (name) {
    if (!name) return null;
    const k = String(name).trim().toLowerCase();
    if (NAME_TO_CODE[k]) return NAME_TO_CODE[k];
    if (/^us-[a-z]{2}$/.test(k)) return k.toUpperCase();
    return null;
  };
  PSM.locationsForBbox = function (bbox) {
    return Object.values(PSM.LOCATIONS).filter((l) => PSM.bboxesIntersect(l.bbox, bbox)).map((l) => l.code);
  };
  PSM.locationName = function (code) {
    if (!code) return '';
    return String(code).split(',').map((c) => (PSM.LOCATIONS[c.trim()] || {}).name || c.trim()).join(', ');
  };

  /* ------------------------------------------------------------------ */
  /* Logging                                                             */
  /* ------------------------------------------------------------------ */
  const logListeners = [];
  PSM.logEntries = [];
  PSM.log = function (msg, level) {
    level = level || 'info';
    const entry = { ts: new Date(), msg: String(msg), level };
    PSM.logEntries.push(entry);
    if (PSM.logEntries.length > 400) PSM.logEntries.shift();
    if (level === 'error') console.error('[PSM]', msg); else if (level === 'warn') console.warn('[PSM]', msg); else console.log('[PSM]', msg);
    logListeners.forEach((fn) => { try { fn(entry); } catch (e) { /* ignore */ } });
  };
  PSM.onLog = (fn) => logListeners.push(fn);

  /* ------------------------------------------------------------------ */
  /* Settings (localStorage)                                             */
  /* ------------------------------------------------------------------ */
  const SETTINGS_KEY = 'psm.settings.v1';
  const defaults = { units: 'mi', radiusKm: 25 * KM_PER_MI, basemap: 'osm', showPota: true, showSota: true, showSpots: false, showBoundaries: true, lastSearch: null };
  let settings = Object.assign({}, defaults);
  try { const s = JSON.parse(global.localStorage && global.localStorage.getItem(SETTINGS_KEY)); if (s && typeof s === 'object') settings = Object.assign(settings, s); } catch (e) { /* ignore */ }
  PSM.settings = settings;
  PSM.saveSettings = function (patch) {
    Object.assign(settings, patch || {});
    try { global.localStorage && global.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  };

  /* ------------------------------------------------------------------ */
  /* Concurrency limiter                                                 */
  /* ------------------------------------------------------------------ */
  PSM.pLimit = function (n) {
    let active = 0; const queue = [];
    const next = () => { if (active >= n || !queue.length) return; active++; const { fn, resolve, reject } = queue.shift(); Promise.resolve().then(fn).then((v) => { active--; resolve(v); next(); }, (e) => { active--; reject(e); next(); }); };
    return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
  };

  PSM.uid = (() => { let i = 0; return (p) => (p || 'id') + '-' + (++i) + '-' + Math.random().toString(36).slice(2, 7); })();

  PSM.todayISO = () => new Date().toISOString().slice(0, 10);

})(typeof window !== 'undefined' ? window : globalThis);
