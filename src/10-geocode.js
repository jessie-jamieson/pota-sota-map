/* =====================================================================
 * 10-geocode.js — PSM.geocode: input classification + geocoding
 *
 * Everything the app needs to turn what a user typed into a map centre:
 *   PSM.geocode.classify(text)            -> {kind, value}
 *   PSM.geocode.forward(text, {near})     -> {lat, lon, label, source, raw}
 *   PSM.geocode.reverse(lat, lon)         -> {label, parts, source}
 *   PSM.geocode.resolve(text, {near})     -> Center {lat, lon, label, source, ...}
 *
 * Services: Photon (photon.komoot.io) first — no usage limits published, CORS
 * open, good at POI names — then Nominatim as a fallback.  Nominatim's usage
 * policy allows at most one request per second, so every Nominatim call goes
 * through a module-level queue that spaces calls ≥ 1.1 s apart.  Browsers
 * cannot set a User-Agent header, so we simply stay well under the limit and
 * the UI shows attribution.
 *
 * Reverse geocodes are cached 30 days (they never really change) under
 * "rev:<lat4>,<lon4>".
 * ===================================================================== */
(function (global) {
  'use strict';

  const PSM = global.PSM || (global.PSM = {});

  const PHOTON_BASE = 'https://photon.komoot.io';
  const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
  const REVERSE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const TIMEOUT_MS = 15000;

  /* ------------------------------------------------------------------ */
  /* small helpers                                                       */
  /* ------------------------------------------------------------------ */
  function str(v) {
    if (v == null) return null;
    const s = String(v).trim();
    return s || null;
  }
  function num(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : null;
  }
  /** Join address fragments with ", ", dropping empties and echoes of the first part. */
  function joinParts(list) {
    const out = [];
    list.forEach(function (raw) {
      const v = str(raw);
      if (!v) return;
      if (out.length && out[0].toLowerCase() === v.toLowerCase()) return; // "Sloatsburg, Sloatsburg"
      if (out.length && out[out.length - 1].toLowerCase() === v.toLowerCase()) return;
      out.push(v);
    });
    return out.join(', ');
  }
  /** "New York" -> "NY" (US states only); anything else comes back unchanged. */
  function stateAbbrev(name) {
    const code = PSM.stateCodeForName && PSM.stateCodeForName(name);
    return code ? code.slice(3) : null;
  }
  function isUS(country) {
    const c = (str(country) || '').toLowerCase();
    return c === 'united states' || c === 'united states of america' || c === 'usa' || c === 'us';
  }
  function errText(e) {
    if (!e) return 'unknown error';
    return e.message || String(e);
  }

  /* ------------------------------------------------------------------ */
  /* Nominatim throttle (module level, shared by search + reverse)       */
  /* ------------------------------------------------------------------ */
  let nominatimChain = Promise.resolve();
  let lastNominatimAt = 0;

  /** Resolves when it is polite to issue the next Nominatim request. */
  function nominatimSlot() {
    const p = nominatimChain.then(async function () {
      const gap = geocode.nominatimMinIntervalMs - (Date.now() - lastNominatimAt);
      if (gap > 0) await PSM.sleep(gap);
      lastNominatimAt = Date.now();
    });
    nominatimChain = p.then(function () { /* keep the chain alive */ }, function () { /* ditto */ });
    return p;
  }

  async function nominatimJSON(url, opts) {
    await nominatimSlot();
    return PSM.fetchJSON(url, opts);
  }

  /* ------------------------------------------------------------------ */
  /* classify                                                            */
  /* ------------------------------------------------------------------ */
  /** Canonical Maidenhead casing: "fn21VE" -> "FN21ve". */
  function normalizeGrid(text) {
    const g = String(text == null ? '' : text).trim();
    let s = g.slice(0, 4).toUpperCase();
    if (g.length >= 6) s += g.slice(4, 6).toLowerCase();
    if (g.length >= 8) s += g.slice(6, 8);
    return s;
  }

  /**
   * What did the user type?  Order matters: lat/lon → grid → POTA → SOTA → free text.
   * `value` is normalised ({lat,lon} for latlon, "FN21ve", "US-2069", "W2/GC-001", trimmed text).
   */
  function classify(text) {
    const t = String(text == null ? '' : text).trim();
    const ll = PSM.parseLatLon(t);
    if (ll) return { kind: 'latlon', value: ll };
    if (PSM.isGrid(t)) return { kind: 'grid', value: normalizeGrid(t) };
    if (PSM.isPotaRef(t)) return { kind: 'pota', value: PSM.normalizePotaRef(t) };
    if (PSM.isSotaRef(t)) return { kind: 'sota', value: PSM.normalizeSotaRef(t) };
    return { kind: 'text', value: t };
  }

  /* ------------------------------------------------------------------ */
  /* Photon                                                              */
  /* ------------------------------------------------------------------ */
  /**
   * Photon properties -> one-line label.
   * e.g. {name:"Harriman State Park", county:"Rockland County", state:"New York",
   *       country:"United States"} -> "Harriman State Park, Rockland County, New York, United States"
   */
  function photonLabel(props) {
    const p = props || {};
    const road = str(p.street) || (p.housenumber ? str(p.name) : null);
    const house = str(p.housenumber);
    const primary = house && road ? house + ' ' + road : (str(p.name) || road);
    const city = str(p.city) || str(p.town) || str(p.village) || str(p.locality) || str(p.district);
    const county = str(p.county);
    const state = str(p.state);
    const country = str(p.country);
    return joinParts([primary, city, city ? null : county, state, country]);
  }

  function photonParts(props) {
    const p = props || {};
    return {
      house: str(p.housenumber),
      road: str(p.street) || (p.osm_key === 'highway' ? str(p.name) : null),
      city: str(p.city) || str(p.town) || str(p.village) || str(p.locality) || str(p.district),
      county: str(p.county),
      state: str(p.state),
      postcode: str(p.postcode),
      country: str(p.country)
    };
  }

  function photonFeature(geojson) {
    if (!geojson || !Array.isArray(geojson.features)) return null;
    for (let i = 0; i < geojson.features.length; i++) {
      const f = geojson.features[i];
      const c = f && f.geometry && f.geometry.coordinates;
      if (Array.isArray(c) && num(c[0]) != null && num(c[1]) != null) return f;
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Nominatim                                                           */
  /* ------------------------------------------------------------------ */
  function nominatimParts(address) {
    const a = address || {};
    return {
      house: str(a.house_number),
      road: str(a.road) || str(a.pedestrian) || str(a.footway) || str(a.path),
      city: str(a.city) || str(a.town) || str(a.village) || str(a.hamlet) || str(a.municipality) || str(a.suburb),
      county: str(a.county),
      state: str(a.state) || str(a.province),
      postcode: str(a.postcode),
      country: str(a.country)
    };
  }

  /* ------------------------------------------------------------------ */
  /* forward                                                             */
  /* ------------------------------------------------------------------ */
  /**
   * Free-text search.  Photon first, Nominatim as a fallback.
   * @param {string} text
   * @param {{near?:{lat:number,lon:number}, signal?:AbortSignal}} [opts]
   * @returns {Promise<{lat, lon, label, source:"photon"|"nominatim", raw}>}
   * @throws Error('No results for "…"') — the message also names the failing
   *         service(s) when the lookups failed rather than came back empty.
   */
  async function forward(text, opts) {
    opts = opts || {};
    const q = String(text == null ? '' : text).trim();
    const failures = [];
    if (!q) throw new Error('No results for ""');

    /* --- Photon --------------------------------------------------- */
    try {
      let url = PHOTON_BASE + '/api/?q=' + encodeURIComponent(q) + '&limit=5&lang=en';
      const near = opts.near;
      if (near && num(near.lat) != null && num(near.lon) != null) {
        url += '&lat=' + encodeURIComponent(num(near.lat)) + '&lon=' + encodeURIComponent(num(near.lon));
      }
      const gj = await PSM.fetchJSON(url, { timeoutMs: TIMEOUT_MS, signal: opts.signal });
      const f = photonFeature(gj);
      if (f) {
        const c = f.geometry.coordinates;
        return {
          lat: num(c[1]), lon: num(c[0]),
          label: photonLabel(f.properties) || q,
          source: 'photon',
          raw: f
        };
      }
      PSM.log('Photon had no match for "' + q + '"', 'warn');
    } catch (e) {
      failures.push('Photon: ' + errText(e));
      PSM.log('Photon geocoding failed: ' + errText(e), 'warn');
    }

    /* --- Nominatim ------------------------------------------------ */
    try {
      const url = NOMINATIM_BASE + '/search?q=' + encodeURIComponent(q) +
        '&format=jsonv2&limit=5&addressdetails=1';
      const arr = await nominatimJSON(url, { timeoutMs: TIMEOUT_MS, signal: opts.signal });
      const hit = Array.isArray(arr) ? arr.find(function (r) { return r && num(r.lat) != null && num(r.lon) != null; }) : null;
      if (hit) {
        return {
          lat: num(hit.lat), lon: num(hit.lon),
          label: str(hit.display_name) || q,
          source: 'nominatim',
          raw: hit
        };
      }
      PSM.log('Nominatim had no match for "' + q + '"', 'warn');
    } catch (e) {
      failures.push('Nominatim: ' + errText(e));
      PSM.log('Nominatim geocoding failed: ' + errText(e), 'warn');
    }

    const why = failures.length ? ' (geocoding service failed — ' + failures.join('; ') + ')' : '';
    throw new Error('No results for "' + q + '"' + why);
  }

  /* ------------------------------------------------------------------ */
  /* reverse                                                             */
  /* ------------------------------------------------------------------ */
  /** parts -> "123 Seven Lakes Drive, Sloatsburg, NY 10974" */
  function addressLabel(parts, lat, lon) {
    const p = parts || {};
    const street = joinParts([p.house && p.road ? p.house + ' ' + p.road : (p.road || null)]);
    const abbr = stateAbbrev(p.state);
    const tail = [abbr || p.state, p.postcode].filter(Boolean).join(' ');
    const label = joinParts([
      street || null,
      p.city || null,
      !street && !p.city ? p.county : null,
      tail || null,
      isUS(p.country) ? null : p.country
    ]);
    return label || PSM.fmt.latlon(lat, lon, 4);
  }

  async function reverseUncached(lat, lon, opts) {
    opts = opts || {};
    const failures = [];

    /* --- Photon reverse ------------------------------------------- */
    try {
      const url = PHOTON_BASE + '/reverse?lat=' + encodeURIComponent(lat) +
        '&lon=' + encodeURIComponent(lon) + '&lang=en';
      const gj = await PSM.fetchJSON(url, { timeoutMs: TIMEOUT_MS, signal: opts.signal });
      const f = photonFeature(gj);
      if (f) {
        const parts = photonParts(f.properties);
        return { label: addressLabel(parts, lat, lon), parts: parts, source: 'photon' };
      }
    } catch (e) {
      failures.push('Photon: ' + errText(e));
      PSM.log('Photon reverse geocoding failed: ' + errText(e), 'warn');
    }

    /* --- Nominatim reverse ---------------------------------------- */
    try {
      const url = NOMINATIM_BASE + '/reverse?lat=' + encodeURIComponent(lat) +
        '&lon=' + encodeURIComponent(lon) + '&format=jsonv2&zoom=17&addressdetails=1';
      const j = await nominatimJSON(url, { timeoutMs: TIMEOUT_MS, signal: opts.signal });
      if (j && (j.address || j.display_name)) {
        const parts = nominatimParts(j.address);
        const built = addressLabel(parts, lat, lon);
        return {
          label: built || str(j.display_name) || PSM.fmt.latlon(lat, lon, 4),
          parts: parts,
          source: 'nominatim'
        };
      }
    } catch (e) {
      failures.push('Nominatim: ' + errText(e));
      PSM.log('Nominatim reverse geocoding failed: ' + errText(e), 'warn');
    }

    throw new Error('No address for ' + PSM.fmt.latlon(lat, lon, 4) +
      (failures.length ? ' (geocoding service failed — ' + failures.join('; ') + ')' : ''));
  }

  /**
   * Approximate street address for a point.  Cached 30 days at ~11 m resolution.
   * @returns {Promise<{label, parts:{house,road,city,county,state,postcode,country}, source}>}
   */
  function reverse(lat, lon, opts) {
    const la = num(lat), lo = num(lon);
    if (la == null || lo == null) return Promise.reject(new Error('reverse(): bad coordinates'));
    const key = 'rev:' + la.toFixed(4) + ',' + lo.toFixed(4);
    return PSM.memo(key, REVERSE_TTL_MS, function () { return reverseUncached(la, lo, opts); });
  }

  /* ------------------------------------------------------------------ */
  /* resolve                                                             */
  /* ------------------------------------------------------------------ */
  /**
   * Anything the user typed -> a search Center.
   * POTA/SOTA references are resolved through PSM.pota / PSM.sota, which load
   * after this file — so they are looked up lazily, at call time.
   */
  async function resolve(text, opts) {
    opts = opts || {};
    const c = classify(text);

    if (c.kind === 'latlon') {
      return {
        lat: c.value.lat, lon: c.value.lon,
        label: PSM.fmt.latlon(c.value.lat, c.value.lon, 5),
        source: 'latlon'
      };
    }

    if (c.kind === 'grid') {
      const ll = PSM.gridToLatLon(c.value);
      if (!ll) throw new Error('Not a valid Maidenhead locator: "' + c.value + '"');
      return { lat: ll.lat, lon: ll.lon, label: c.value, source: 'grid', grid: c.value };
    }

    if (c.kind === 'pota') {
      const pota = PSM.pota;
      if (!pota || typeof pota.getPark !== 'function') throw new Error('POTA module not loaded');
      const d = await pota.getPark(c.value);
      if (!d) throw new Error('Unknown POTA reference "' + c.value + '"');
      const lat = num(d.latitude != null ? d.latitude : d.lat);
      const lon = num(d.longitude != null ? d.longitude : d.lon);
      if (lat == null || lon == null) throw new Error('POTA reference "' + c.value + '" has no coordinates');
      const label = typeof pota.displayName === 'function' ? pota.displayName(d) : (str(d.name) || c.value);
      return { lat: lat, lon: lon, label: label || c.value, source: 'pota', ref: str(d.reference) || c.value };
    }

    if (c.kind === 'sota') {
      const sota = PSM.sota;
      if (!sota || typeof sota.getSummit !== 'function') throw new Error('SOTA module not loaded');
      const d = await sota.getSummit(c.value);
      if (!d) throw new Error('Unknown SOTA reference "' + c.value + '"');
      const lat = num(d.latitude != null ? d.latitude : d.lat);
      const lon = num(d.longitude != null ? d.longitude : d.lon);
      if (lat == null || lon == null) throw new Error('SOTA reference "' + c.value + '" has no coordinates');
      return {
        lat: lat, lon: lon,
        label: str(d.name) || c.value,
        source: 'sota',
        code: str(d.summitCode) || c.value
      };
    }

    const r = await forward(c.value, opts);
    return { lat: r.lat, lon: r.lon, label: r.label, source: 'geocode', via: r.source };
  }

  /* ------------------------------------------------------------------ */
  const geocode = {
    classify: classify,
    forward: forward,
    reverse: reverse,
    resolve: resolve,
    /** Minimum spacing between Nominatim requests (its usage policy: 1 req/s). */
    nominatimMinIntervalMs: 1100,
    // exported for tests / other modules
    PHOTON_BASE: PHOTON_BASE,
    NOMINATIM_BASE: NOMINATIM_BASE,
    REVERSE_TTL_MS: REVERSE_TTL_MS,
    _photonLabel: photonLabel,
    _addressLabel: addressLabel,
    _normalizeGrid: normalizeGrid
  };

  PSM.geocode = geocode;

})(typeof window !== 'undefined' ? window : globalThis);
