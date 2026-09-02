/* =====================================================================
 * 40-nfer.js — PSM.nfer: OSM boundaries (Overpass) + n-fer overlap analysis
 *
 * Pure data module: no DOM, no Leaflet.  Needs the globals `turf` (Turf.js 7)
 * and `osmtogeojson` (3.x), plus PSM core helpers from 00-util.js.
 *
 * An "n-fer" is a spot from which several POTA parks / SOTA summits can be
 * activated at once.  We find them by pulling protected-area polygons and
 * hiking-route lines out of OpenStreetMap, tying them to POTA references, and
 * intersecting the results.
 *
 * Public API (see ARCHITECTURE.md):
 *   PSM.nfer.buildOverpassQuery(bbox) -> string
 *   PSM.nfer.fetchBoundaries(bbox, {signal, onProgress}) -> Promise<FeatureCollection>
 *   PSM.nfer.matchFeaturesToParks(features, parks, opts) -> Promise<[match]>
 *   PSM.nfer.analyze({center, radiusKm, bbox, parks, summits, ...}) -> Promise<result>
 *   PSM.nfer.buildParkQuery(park) -> string
 *   PSM.nfer.parkBoundary(park, {signal}) -> Promise<{fc, matchKind, confidence, name, source}|null>
 *   PSM.nfer.boundaryFromAnalysis(ref, nferResult) -> same shape | null  (no network)
 * ===================================================================== */
(function (global) {
  'use strict';

  const PSM = global.PSM || (global.PSM = {});

  /* --- Tunables ------------------------------------------------------ */
  const ENDPOINTS = [
    { source: 'overpass-api.de', url: 'https://overpass-api.de/api/interpreter' },
    { source: 'overpass.kumi.systems', url: 'https://overpass.kumi.systems/api/interpreter' }
  ];
  const CACHE_MS = 24 * 60 * 60 * 1000;   // Overpass responses cached 24 h
  const PARK_CACHE_MS = 7 * 24 * 60 * 60 * 1000;   // one park's boundary: 7 d
  const PARK_AROUND_M = 15000;            // radius of the single-park candidate sweep
  const PARK_SIMPLIFY_TOL = 0.00008;      // ~8 m — display only, dense shapes only
  const PARK_MAX_VERTICES = 8000;         // above this a boundary is worth simplifying
  const SIMPLIFY_TOL = 0.00005;           // ~5 m — cheap, keeps shapes honest
  const MIN_ZONE_M2 = 2000;               // 0.2 ha — drops shared-border slivers
  const TRAIL_BUFFER_M = 20;              // half a trail corridor
  const SUMMIT_NEAR_M = 150;              // "just outside the fence"
  const POINT_NAME_MIN = 0.34;            // point-in-polygon + decent name match
  const NAME_ONLY_MIN = 0.6;              // name-only match must be strong
  const NAME_ONLY_KM = 3;                 // …and the park point must be close
  const TRAIL_NAME_MIN = 0.5;
  const MAX_UNMATCHED_FEATURES = 200;
  const POTA_TAG = 'communication:amateur_radio:pota';

  /** Lazily resolved so a test loader may define the globals after this file. */
  function T() {
    const t = global.turf;
    if (!t) throw new Error('PSM.nfer requires the turf global (Turf.js 7)');
    return t;
  }
  function OTG() {
    const o = global.osmtogeojson;
    if (!o) throw new Error('PSM.nfer requires the osmtogeojson global');
    return o;
  }

  /* --- Small helpers ------------------------------------------------- */
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function abortError(msg) {
    const e = new Error(msg || 'aborted'); e.name = 'AbortError'; return e;
  }
  function checkAbort(signal) {
    if (signal && signal.aborted) throw abortError('n-fer analysis aborted');
  }

  /** osmtogeojson may emit flat tags or {tags:{...}} — cope with both. */
  function featTags(f) {
    const p = (f && f.properties) || {};
    return p.tags && typeof p.tags === 'object' ? p.tags : p;
  }
  function featName(f) {
    const t = featTags(f);
    return t.name || t['name:en'] || t.official_name || t.alt_name || t.short_name || null;
  }
  function featOsmId(f) {
    if (f && f.id != null) return String(f.id);
    const p = (f && f.properties) || {};
    if (p.id == null) return null;
    return p.type ? p.type + '/' + p.id : String(p.id);
  }
  function featOsmType(f) {
    const id = featOsmId(f) || '';
    if (id.indexOf('/') > 0) return id.split('/')[0];
    return ((f && f.properties) || {}).type || null;
  }
  const geomType = (f) => (f && f.geometry && f.geometry.type) || null;
  const isAreaFeature = (f) => geomType(f) === 'Polygon' || geomType(f) === 'MultiPolygon';
  const isLineFeature = (f) => geomType(f) === 'LineString' || geomType(f) === 'MultiLineString';

  /**
   * POTA reference normaliser ("k-1234" -> "US-1234").  PSM.normalizePotaRef
   * first; its regex only allows 1–2 letter prefixes, so fall back to a slightly
   * more permissive form for exotic OSM tag values ("VE2-1234", "3B8-0001").
   */
  function normRef(s) {
    const raw = String(s == null ? '' : s).trim();
    if (!raw) return null;
    const std = PSM.normalizePotaRef ? PSM.normalizePotaRef(raw) : null;
    if (std) return std;
    const m = /^([A-Z0-9]{1,4})-(\d{3,6})$/.exec(raw.toUpperCase());
    return m ? (m[1] === 'K' ? 'US' : m[1]) + '-' + m[2] : null;
  }
  /** Split a `communication:amateur_radio:pota` tag value into refs. */
  function refsFromTag(value) {
    return value ? String(value).split(/[;,]/).map(normRef).filter(Boolean) : [];
  }

  const refKey = (refs) => refs.slice().sort().join('|');

  function sharedTokenCount(a, b) {
    const ta = new Set(PSM.nameTokens(a));
    let n = 0;
    PSM.nameTokens(b).forEach((w) => { if (ta.has(w)) n++; });
    return n;
  }

  /** [minLon, minLat, maxLon, maxLat] — never throws. */
  function safeBbox(f) { try { return T().bbox(f); } catch (e) { return null; } }
  function bboxOverlap(a, b, pad) {
    const p = pad || 0;
    return !!a && !!b && !(a[2] + p < b[0] || a[0] - p > b[2] || a[3] + p < b[1] || a[1] - p > b[3]);
  }
  function bboxContainsPoint(bb, lon, lat, pad) {
    const p = pad || 0;
    return !!bb && lon >= bb[0] - p && lon <= bb[2] + p && lat >= bb[1] - p && lat <= bb[3] + p;
  }

  /** Cheap validity screen: every ring must still have >= 4 positions. */
  function ringsOk(geom) {
    if (!geom) return false;
    const polys = geom.type === 'Polygon' ? [geom.coordinates]
      : geom.type === 'MultiPolygon' ? geom.coordinates : null;
    if (!polys || !polys.length) return false;
    for (const poly of polys) {
      if (!poly || !poly.length) return false;
      for (const ring of poly) if (!ring || ring.length < 4) return false;
    }
    return true;
  }

  /** A zero-width buffer is turf's usual cure for self-intersecting rings. */
  function repairPolygon(feature) {
    try {
      const b = T().buffer(feature, 0, { units: 'meters' });
      return b && ringsOk(b.geometry) ? b : null;
    } catch (e) { return null; }
  }

  /** Simplify + truncate + repair a polygon feature.  Returns null if hopeless. */
  function preparePolygon(feature) {
    const turf = T();
    let g = null;
    try {
      g = turf.simplify(clone(feature), { tolerance: SIMPLIFY_TOL, highQuality: false, mutate: true });
    } catch (e) { g = null; }
    if (!g || !ringsOk(g.geometry)) { try { g = clone(feature); } catch (e) { return null; } }
    try { g = turf.truncate(g, { precision: 6, coordinates: 2, mutate: true }); } catch (e) { /* keep g */ }
    try { const c = turf.cleanCoords(g, { mutate: false }); if (ringsOk(c.geometry)) g = c; } catch (e) { /* keep g */ }
    if (!ringsOk(g.geometry)) g = repairPolygon(feature);   // last resort
    return g && ringsOk(g.geometry) ? g : null;
  }

  function safeArea(f) {
    try { const a = T().area(f); return isFinite(a) ? a : 0; } catch (e) { return 0; }
  }
  function pointInFeature(lon, lat, f, bb) {
    if (bb && !bboxContainsPoint(bb, lon, lat)) return false;
    try { return T().booleanPointInPolygon([lon, lat], f); } catch (e) { return false; }
  }

  /** Every LineString of whatever turf.polygonToLine returned (Feature or FC). */
  function outlineLines(polyFeature) {
    const turf = T();
    const out = [];
    let ln;
    try { ln = turf.polygonToLine(polyFeature); } catch (e) { return out; }
    const collect = (feat) => {
      const g = feat && feat.geometry;
      if (!g) return;
      if (g.type === 'LineString') out.push(feat);
      else if (g.type === 'MultiLineString') g.coordinates.forEach((c) => {
        try { out.push(turf.lineString(c)); } catch (e) { /* skip a bad ring */ }
      });
    };
    if (ln && ln.type === 'FeatureCollection') (ln.features || []).forEach(collect); else collect(ln);
    return out;
  }

  /** Metres from a point to the outline of a polygon (0 if it lies on it). */
  function distToOutlineM(lon, lat, polyFeature, cachedLines) {
    const turf = T();
    const lines = cachedLines || outlineLines(polyFeature);
    let best = Infinity, pt;
    try { pt = turf.point([lon, lat]); } catch (e) { return Infinity; }
    for (const line of lines) {
      try {
        const d = turf.pointToLineDistance(pt, line, { units: 'meters' });
        if (isFinite(d) && d < best) best = d;
      } catch (e) { /* skip a bad ring */ }
    }
    return best;
  }

  /* --- a) Overpass query --------------------------------------------- */
  /**
   * Build the Overpass QL for one bbox.
   * `out tags geom;` gives geometry for ways *and* for relation members, which
   * osmtogeojson turns into (Multi)Polygons and (Multi)LineStrings.
   */
  function buildOverpassQuery(bbox) {
    const f6 = (v) => Number(v).toFixed(6);
    const bb = '(' + f6(bbox.south) + ',' + f6(bbox.west) + ',' +
      f6(bbox.north) + ',' + f6(bbox.east) + ')';
    const lines = [
      '[out:json][timeout:90];',
      '(',
      // POTA-blessed tag: a direct feature <-> park link, any element type.
      '  nwr["' + POTA_TAG + '"]' + bb + ';',
      '  way["boundary"="protected_area"]' + bb + ';',
      '  relation["boundary"="protected_area"]' + bb + ';',
      '  way["boundary"="national_park"]' + bb + ';',
      '  relation["boundary"="national_park"]' + bb + ';',
      '  way["leisure"="nature_reserve"]' + bb + ';',
      '  relation["leisure"="nature_reserve"]' + bb + ';',
      // leisure=park: relations are worth having, plain ways are mostly tiny
      // urban parks — so only take ways whose name looks like a real reserve.
      '  relation["leisure"="park"]' + bb + ';',
      '  way["leisure"="park"]["name"~"State Park|State Forest|National|County Park|Reservation|Preserve|Wildlife|Recreation Area",i]' + bb + ';',
      // Long-distance hiking routes (national / international networks).
      '  relation["route"="hiking"]["network"~"^(nwn|iwn)$"]' + bb + ';',
      ');',
      'out tags geom;'
    ];
    return lines.join('\n');
  }

  /* --- b) Fetch + convert boundaries --------------------------------- */
  /** Cache key: the bbox rounded outwards to 3 decimals (~100 m). */
  function bboxCacheKey(bbox) {
    const r = (v, dir) => (dir < 0 ? Math.floor(v * 1000) / 1000 : Math.ceil(v * 1000) / 1000).toFixed(3);
    return r(bbox.south, -1) + ',' + r(bbox.west, -1) + ',' + r(bbox.north, 1) + ',' + r(bbox.east, 1);
  }

  /**
   * Administrative boundaries (`type=boundary` + `boundary=administrative`) are
   * town/county outlines that occasionally also carry a park tag.  They are not
   * parks and would swallow everything inside them, so they never survive.
   */
  function isAdminBoundary(f) {
    const t = featTags(f);
    return !!t && t.type === 'boundary' && t.boundary === 'administrative';
  }

  /**
   * POST one Overpass query, trying each endpoint in turn.  Shared by the area
   * sweep (fetchBoundaries) and the single-park lookup (parkBoundary) so both
   * get the same mirror fallback, the same "remark" handling and the same abort
   * behaviour — and so the endpoint list lives in exactly one place.
   *
   * Resolves `{osm, source}`; rejects with `.overpassErrors` (the per-endpoint
   * messages) once every endpoint has failed.  Never resolves for a payload we
   * would not want cached, so it is safe to wrap in PSM.memo().
   *
   * @param {string} query                Overpass QL
   * @param {Object} opts  {signal, onProgress, errors, timeoutMs}
   */
  async function postOverpass(query, opts) {
    opts = opts || {};
    const errors = opts.errors || [];
    const onProgress = opts.onProgress || function () {};
    let lastErr = null;
    for (let i = 0; i < ENDPOINTS.length; i++) {
      const ep = ENDPOINTS[i];
      checkAbort(opts.signal);
      onProgress('Querying Overpass (' + ep.source + ')…', 0.08 + i * 0.05);
      try {
        const text = await PSM.fetchText(ep.url, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeoutMs: opts.timeoutMs || 95000,
          retries: 0,
          signal: opts.signal
        });
        const json = JSON.parse(text);
        if (!json || !Array.isArray(json.elements)) throw new Error('unexpected Overpass payload');
        // Overpass reports runtime errors (timeout, out of memory) in `remark`
        // with HTTP 200 and no elements — never cache that as an answer.
        if (!json.elements.length && json.remark) {
          throw new Error('remark: ' + String(json.remark).slice(0, 120));
        }
        return { osm: json, source: ep.source };
      } catch (err) {
        // 429 / 5xx / timeout / network error all fall through to the mirror;
        // so do hard client errors — the mirrors sometimes differ in rules.
        lastErr = err;
        errors.push(ep.source + ': ' + ((err && err.message) || 'error'));
        PSM.log('Overpass ' + ep.source + ': ' + ((err && err.message) || 'error'), 'warn');
        if (opts.signal && opts.signal.aborted) throw abortError('Overpass request aborted');
      }
    }
    // Every endpoint failed.  Carry the per-endpoint messages on the error so
    // analyze() can surface them in stats.errors (fc.errors never gets set).
    const fatal = lastErr || new Error('all Overpass endpoints failed');
    fatal.overpassErrors = errors.slice();
    throw fatal;
  }

  /**
   * Fetch OSM boundaries for a bbox and convert them to GeoJSON.
   * Returns a FeatureCollection with two extra fields: `.source`
   * ("overpass-api.de" | "overpass.kumi.systems" | "cache") and `.errors`.
   * Polygons and route lines are kept; points and administrative outlines go.
   */
  async function fetchBoundaries(bbox, opts) {
    opts = opts || {};
    const onProgress = opts.onProgress || function () {};
    const errors = [];
    const query = buildOverpassQuery(bbox);
    const key = 'overpass:' + bboxCacheKey(bbox);

    // Probe the cache first purely so we can report source:"cache".
    let wasCached = false;
    try { wasCached = !!(await PSM.cache.getFresh(key, CACHE_MS)); } catch (e) { /* ignore */ }

    checkAbort(opts.signal);
    const payload = await PSM.memo(key, CACHE_MS, () => postOverpass(query, {
      signal: opts.signal, onProgress: onProgress, errors: errors, timeoutMs: 95000
    }));

    checkAbort(opts.signal);
    onProgress('Converting OSM data…', 0.28);

    let gj;
    try {
      gj = OTG()(payload.osm, { flatProperties: false });
    } catch (err) {
      errors.push('osmtogeojson: ' + ((err && err.message) || 'conversion failed'));
      gj = { type: 'FeatureCollection', features: [] };
    }

    // Keep polygons (parks) and lines (hiking routes); drop points and the
    // administrative outlines that sometimes ride along.
    const features = (gj.features || []).filter((f) =>
      (isAreaFeature(f) && !isAdminBoundary(f)) || isLineFeature(f));
    const fc = { type: 'FeatureCollection', features: features };
    fc.source = wasCached ? 'cache' : (payload.source || 'overpass-api.de');
    fc.errors = errors;
    return fc;
  }

  /* --- c) Matching OSM features to POTA parks ------------------------ */
  /**
   * @param {Array<Feature>} features  polygons and lines from fetchBoundaries
   * @param {Array<Park>} parks        {ref, name, lat, lon}
   * @param {Object} opts              {allParksLookup, signal, onProgress, errors}
   * @returns {Promise<Array<{feature, refs, names, matchKind, confidence, kind, ...}>>}
   */
  async function matchFeaturesToParks(features, parks, opts) {
    opts = opts || {};
    const errors = opts.errors || [];
    const onProgress = opts.onProgress || function () {};
    const list = (parks || []).filter((p) => p && p.ref && isFinite(p.lat) && isFinite(p.lon));
    const byRef = new Map();
    list.forEach((p) => { if (!byRef.has(p.ref)) byRef.set(p.ref, p); });

    // Resolve names for refs that are not in the local park list.
    const lookupCache = new Map();
    async function resolveRefName(ref) {
      if (byRef.has(ref)) return byRef.get(ref).name;
      if (lookupCache.has(ref)) return lookupCache.get(ref);
      let name;
      if (typeof opts.allParksLookup === 'function') {
        try {
          const found = await opts.allParksLookup(ref);
          const hit = (found || []).find((p) => p && normRef(p.ref) === ref);
          if (hit) name = hit.name;
        } catch (e) { errors.push('allParksLookup(' + ref + '): ' + (e && e.message)); }
      }
      lookupCache.set(ref, name);
      return name;
    }

    const areas = [], lines = [];
    for (const f of features || []) {
      if (isAreaFeature(f)) areas.push(f);
      else if (isLineFeature(f)) lines.push(f);
    }

    const matches = [];
    const mkMatch = (feature, refs, names, matchKind, confidence, kind, bb) => {
      // refs are sorted for stable keys — names[i] must travel with refs[i].
      const pairs = refs.map((r, i) => [r, names ? names[i] : undefined])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return {
        feature: feature,
        osmId: featOsmId(feature),
        osmType: featOsmType(feature),
        name: featName(feature),
        refs: pairs.map((p) => p[0]),
        names: pairs.map((p) => p[1]),
        matchKind: matchKind,
        confidence: confidence,
        kind: kind,
        tags: featTags(feature),
        bbox: bb || safeBbox(feature),
        areaM2: kind === 'area' ? safeArea(feature) : 0
      };
    };

    /** TAG rule — authoritative, works even for parks outside the search area. */
    async function tagMatch(f, kind, bb) {
      const refs = Array.from(new Set(refsFromTag(featTags(f)[POTA_TAG])));
      if (!refs.length) return null;
      const names = [];
      for (const ref of refs) names.push(await resolveRefName(ref));
      return mkMatch(f, refs, names, 'tag', 1.0, kind, bb);
    }

    /* ---- areas ------------------------------------------------------ */
    for (let i = 0; i < areas.length; i++) {
      if (i % 25 === 0) checkAbort(opts.signal);
      const f = areas[i];
      const fname = featName(f);
      const bb = safeBbox(f);

      const tagged = await tagMatch(f, 'area', bb);
      if (tagged) { matches.push(tagged); continue; }
      if (!bb) continue;

      // 2. POINT — park reference point inside the polygon + name evidence.
      const inside = list.filter((p) => pointInFeature(p.lon, p.lat, f, bb));
      if (inside.length) {
        // Only parks with name evidence are attached: a PAD-US-style umbrella
        // polygon swallowing a dozen unrelated parks must not claim them all.
        let picked = inside
          .filter((p) => PSM.nameSimilarity(fname, p.name) >= POINT_NAME_MIN)
          .map((p) => ({ park: p, conf: 0.85 }));
        // Relaxed rule: a polygon holding exactly one park point needs only a
        // single shared (non-stop-word) token.
        if (!picked.length && inside.length === 1 && fname &&
            sharedTokenCount(fname, inside[0].name) >= 1) {
          picked = [{ park: inside[0], conf: 0.7 }];
        }
        if (picked.length) {
          matches.push(mkMatch(f, picked.map((x) => x.park.ref), picked.map((x) => x.park.name),
            'point', Math.min.apply(null, picked.map((x) => x.conf)), 'area', bb));
        }
        continue;   // points inside but no name evidence -> deliberately unmatched
      }

      // 3. NAME — strong name match and the park point is within 3 km.
      if (!fname) continue;
      let bestPark = null, bestSim = 0;
      for (const p of list) {
        if (!bboxContainsPoint(bb, p.lon, p.lat, 0.05)) continue;   // ~5 km pad
        const sim = PSM.nameSimilarity(fname, p.name);
        if (sim >= NAME_ONLY_MIN && sim > bestSim) { bestSim = sim; bestPark = p; }
      }
      if (bestPark) {
        let distKm = Infinity;
        try { distKm = distToOutlineM(bestPark.lon, bestPark.lat, f) / 1000; } catch (e) { /* ignore */ }
        if (!isFinite(distKm)) {
          // Fall back to the polygon centroid if the outline could not be walked.
          try {
            const c = T().centroid(f).geometry.coordinates;
            distKm = PSM.haversineKm(bestPark.lat, bestPark.lon, c[1], c[0]);
          } catch (e) { distKm = Infinity; }
        }
        if (distKm <= NAME_ONLY_KM) {
          matches.push(mkMatch(f, [bestPark.ref], [bestPark.name], 'name', 0.6, 'area', bb));
        }
      }
    }

    onProgress('Matching trails…', 0.5);

    /* ---- trails ----------------------------------------------------- */
    for (const f of lines) {
      checkAbort(opts.signal);
      const tname = featName(f);
      const bb = safeBbox(f);

      // A trail may carry the POTA tag too — that wins outright.
      const tagged = await tagMatch(f, 'trail', bb);
      if (tagged) { matches.push(tagged); continue; }
      if (!tname) continue;

      const hits = list.filter((p) => /trail/i.test(p.name || '') &&
        PSM.nameSimilarity(tname, p.name) >= TRAIL_NAME_MIN);
      if (!hits.length && typeof opts.allParksLookup === 'function') {
        // Long trails have their POTA reference point far outside the bbox
        // (e.g. the AT is referenced in Georgia), so ask the full park list.
        try {
          const found = await opts.allParksLookup(tname);
          (found || []).forEach((p) => {
            if (!p || !p.ref || !p.name) return;
            if (!/trail/i.test(p.name)) return;
            if (PSM.nameSimilarity(tname, p.name) < TRAIL_NAME_MIN) return;
            const ref = normRef(p.ref) || p.ref;
            if (!hits.some((h) => h.ref === ref)) hits.push({ ref: ref, name: p.name, lat: p.lat, lon: p.lon });
          });
        } catch (e) { errors.push('allParksLookup("' + tname + '"): ' + (e && e.message)); }
      }
      if (hits.length) {
        matches.push(mkMatch(f, hits.map((h) => h.ref), hits.map((h) => h.name), 'trail', 0.75, 'trail', bb));
      }
    }

    return dedupeMatches(matches);
  }

  /**
   * Near-identical shape with the same refs — an OSM way and the relation that
   * wraps it, or the same park mapped twice.  Deliberately strict: a genuinely
   * smaller second unit that merely sits inside the bigger one's bbox is kept,
   * because multi-unit parks are exactly what the zone step needs.
   */
  function isDuplicateShape(m, kept) {
    if (m.kind !== kept.kind || !m.bbox || !kept.bbox) return false;
    if (!(m.bbox[0] >= kept.bbox[0] && m.bbox[1] >= kept.bbox[1] &&
          m.bbox[2] <= kept.bbox[2] && m.bbox[3] <= kept.bbox[3])) return false;
    if (kept.kind === 'trail') return true;          // same trail twice
    return m.areaM2 > 0 && m.areaM2 >= kept.areaM2 * 0.9 && m.areaM2 <= kept.areaM2 * 1.001;
  }

  /**
   * Prefer one polygon per park (best confidence, then largest) but keep the
   * other units of multi-unit parks.  Within a ref-set group we merge away
   * duplicates: the same OSM element twice, or a near-identical copy of a
   * bigger sibling with an identical ref set (way + relation duplicates).
   */
  function dedupeMatches(matches) {
    const groups = new Map();
    for (const m of matches) {
      const k = refKey(m.refs);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }
    const out = [];
    groups.forEach((group) => {
      group.sort((a, b) => (b.confidence - a.confidence) || (b.areaM2 - a.areaM2));
      const kept = [];
      const seenIds = new Set();
      for (const m of group) {
        if (m.osmId && seenIds.has(m.osmId)) continue;
        if (kept.some((k) => isDuplicateShape(m, k))) continue;
        if (m.osmId) seenIds.add(m.osmId);
        m.primary = kept.length === 0;
        kept.push(m);
      }
      out.push.apply(out, kept);
    });
    out.sort((a, b) => (b.confidence - a.confidence) || (b.areaM2 - a.areaM2));
    return out;
  }

  /* --- c2) One park's boundary (detail panel) ------------------------ */
  /**
   * Escape a value for an Overpass double-quoted string literal.
   * POTA references are `[A-Z0-9]{1,4}-\d{3,6}`, so nothing here ever fires —
   * it is here so a hand-typed or future exotic reference cannot break out of
   * the quotes and change the meaning of the query.
   */
  function quoteTagValue(s) {
    return String(s == null ? '' : s).replace(/([\\"])/g, '\\$1');
  }
  /**
   * Escape a value for use inside an Overpass regex literal.  Only real regex
   * metacharacters are escaped: a "-" (the one punctuation a POTA reference
   * actually contains) is a plain literal outside a bracket expression in both
   * POSIX ERE and ECMAScript, and escaping it is what is undefined, not
   * leaving it alone.  Quotes/backslashes still get the string escaping too.
   */
  function escapeRegex(s) {
    return quoteTagValue(String(s == null ? '' : s).replace(/[.*+?^${}()|[\]]/g, '\\$&'));
  }

  /**
   * Build the Overpass QL for ONE park: much smaller than the area sweep, so
   * it is cheap enough to run every time a detail panel opens (once per park,
   * then 7 days of cache).  Two arms:
   *   (a) the POTA reference tag, looked up globally — authoritative, and it
   *       finds the feature wherever it sits (a trail referenced hundreds of
   *       km away, a park whose OSM polygon is offset from its POTA point).
   *       Exact value first, then the multi-value form ("US-2069;US-2010").
   *   (b) candidate protected areas within 15 km of the reference point, for
   *       the (still common) case of a park OSM knows but has not tagged.
   */
  function buildParkQuery(park) {
    park = park || {};
    const ref = normRef(park.ref) || String(park.ref == null ? '' : park.ref).trim();
    const lat = Number(park.lat).toFixed(6);
    const lon = Number(park.lon).toFixed(6);
    const near = '(around:' + PARK_AROUND_M + ',' + lat + ',' + lon + ')';
    const lines = [
      '[out:json][timeout:30];',
      '(',
      '  nwr["' + POTA_TAG + '"="' + quoteTagValue(ref) + '"];',
      '  nwr["' + POTA_TAG + '"~"(^|;)' + escapeRegex(ref) + '(;|$)"];',
      '  way["boundary"~"^(protected_area|national_park)$"]' + near + ';',
      '  relation["boundary"~"^(protected_area|national_park)$"]' + near + ';',
      '  way["leisure"="nature_reserve"]' + near + ';',
      '  relation["leisure"="nature_reserve"]' + near + ';',
      '  relation["leisure"="park"]' + near + ';',
      '  way["leisure"="park"]' + near + ';',
      ');',
      'out tags geom;'
    ];
    return lines.join('\n');
  }

  /** Total number of positions in a geometry — cheap, no turf, no allocation. */
  function countPositions(geom) {
    if (!geom || !geom.coordinates) return 0;
    let n = 0;
    (function walk(a) {
      if (!Array.isArray(a) || !a.length) return;
      if (typeof a[0] === 'number') { n++; return; }
      for (let i = 0; i < a.length; i++) walk(a[i]);
    })(geom.coordinates);
    return n;
  }

  /** Simplify for *display* only; any failure keeps the original feature. */
  function simplifyForDisplay(feature) {
    try {
      const s = T().simplify(clone(feature), {
        tolerance: PARK_SIMPLIFY_TOL, highQuality: false, mutate: true
      });
      if (!s || !s.geometry) return feature;
      if (isAreaFeature(s)) return ringsOk(s.geometry) ? s : feature;
      return countPositions(s.geometry) >= 2 ? s : feature;
    } catch (e) { return feature; }
  }

  /** The match ranking used by both boundary paths: tag beats point beats name. */
  const KIND_RANK = { tag: 3, trail: 2, point: 1, name: 0 };
  function betterMatch(a, b) {
    if (!a) return b;
    if (!b) return a;
    const ca = a.confidence == null ? 0 : a.confidence;
    const cb = b.confidence == null ? 0 : b.confidence;
    if (cb > ca) return b;
    if (cb < ca) return a;
    return (KIND_RANK[b.matchKind] || 0) > (KIND_RANK[a.matchKind] || 0) ? b : a;
  }

  function boundaryFeature(m, geometry) {
    return {
      type: 'Feature',
      geometry: geometry || m.feature.geometry,
      properties: {
        osmId: m.osmId, osmType: m.osmType, name: m.name,
        refs: m.refs, names: m.names,
        matchKind: m.matchKind, confidence: m.confidence,
        kind: m.kind, primary: !!m.primary, tags: m.tags
      }
    };
  }

  /**
   * Every polygon / line OpenStreetMap has for ONE park.
   *
   * Uses exactly the same matcher as the n-fer analysis, so a boundary drawn
   * under a detail panel and a boundary drawn by the analysis agree — with the
   * same caveats (OSM coverage, POTA tagging still being filled in).
   *
   * @param {Object} park  {ref, name, lat, lon, …} — the app's Park shape
   * @param {Object} [opts] {signal}
   * @returns {Promise<{fc, matchKind, confidence, name, source}|null>}
   *          null when nothing matched (or the park has no reference point).
   */
  async function parkBoundary(park, opts) {
    opts = opts || {};
    if (!park || !park.ref) return null;
    const ref = normRef(park.ref) || String(park.ref).trim();
    const lat = Number(park.lat), lon = Number(park.lon);
    // No reference point, no request: the around: sweep needs one, and asking
    // Overpass for a tag that may not exist anywhere is not worth a round trip.
    if (!ref || !isFinite(lat) || !isFinite(lon)) return null;

    const key = 'overpass:park:' + ref;
    const errors = [];
    const query = buildParkQuery({ ref: ref, lat: lat, lon: lon });

    // Probe the cache first purely so we can report source:"cache".
    let wasCached = false;
    try { wasCached = !!(await PSM.cache.getFresh(key, PARK_CACHE_MS)); } catch (e) { /* ignore */ }

    checkAbort(opts.signal);
    // PSM.memo only stores what the producer *resolves*, and drops a rejected
    // in-flight entry (re-running for the next caller when the first one was
    // merely aborted) — so an abort here can never poison the 7-day cache.
    const payload = await PSM.memo(key, PARK_CACHE_MS, () => postOverpass(query, {
      signal: opts.signal, errors: errors, timeoutMs: 35000
    }));
    checkAbort(opts.signal);

    let gj;
    try {
      gj = OTG()(payload.osm, { flatProperties: false });
    } catch (err) {
      PSM.log('boundary ' + ref + ': osmtogeojson failed — ' + ((err && err.message) || err), 'warn');
      return null;
    }
    const features = (gj.features || []).filter((f) =>
      (isAreaFeature(f) && !isAdminBoundary(f)) || isLineFeature(f));
    if (!features.length) return null;

    const matches = await matchFeaturesToParks(features, [{
      ref: ref, name: park.name || ref, lat: lat, lon: lon
    }], { signal: opts.signal });
    // Bear Mountain's own tagged polygon rides along in the same response —
    // keep only what actually belongs to this reference.
    const mine = matches.filter((m) => m.refs.indexOf(ref) > -1);
    if (!mine.length) return null;

    // Multi-unit parks are the norm, not the exception: keep every piece.
    let out = mine.map((m) => boundaryFeature(m));
    let vertices = 0;
    out.forEach((f) => { vertices += countPositions(f.geometry); });
    if (vertices > PARK_MAX_VERTICES) {
      out = mine.map((m) => boundaryFeature(m, simplifyForDisplay(m.feature).geometry));
    }

    let best = null;
    mine.forEach((m) => { best = betterMatch(best, m); });
    return {
      fc: { type: 'FeatureCollection', features: out },
      matchKind: best.matchKind,
      confidence: best.confidence,
      name: best.name || park.name || null,
      source: wasCached ? 'cache' : (payload.source || ENDPOINTS[0].source)
    };
  }

  /**
   * The shortcut the app tries first: a finished analysis already holds every
   * boundary it matched, so a park the user just analysed needs no network at
   * all.  Same return shape as parkBoundary(); null when this run knows
   * nothing about `ref`.
   */
  function boundaryFromAnalysis(ref, nferResult) {
    const want = normRef(ref) || String(ref == null ? '' : ref).trim();
    if (!want || !nferResult || !nferResult.boundaries) return null;
    const feats = (nferResult.boundaries.features || []).filter((f) => {
      const refs = (f && f.properties && f.properties.refs) || [];
      return refs.indexOf(want) > -1;
    });
    if (!feats.length) return null;
    let best = null;
    feats.forEach((f) => { best = betterMatch(best, f.properties || {}); });
    return {
      fc: { type: 'FeatureCollection', features: feats },
      matchKind: best.matchKind || null,
      confidence: best.confidence == null ? null : best.confidence,
      name: best.name || null,
      source: 'analysis'
    };
  }

  /* --- d) Full analysis ---------------------------------------------- */
  async function analyze(opts) {
    opts = opts || {};
    const t0 = Date.now();
    const onProgress = opts.onProgress || function () {};
    const signal = opts.signal;
    const errors = [];
    const parks = (opts.parks || []).filter((p) => p && p.ref && isFinite(p.lat) && isFinite(p.lon));
    const summits = (opts.summits || []).filter((s) => s && s.code && isFinite(s.lat) && isFinite(s.lon));
    const bbox = opts.bbox || (opts.center
      ? PSM.bboxAround(opts.center.lat, opts.center.lon, opts.radiusKm || 40)
      : null);
    if (!bbox) throw new Error('PSM.nfer.analyze needs bbox or center+radiusKm');

    /* --- 1. boundaries ------------------------------------------------- */
    onProgress('Fetching park boundaries from OpenStreetMap…', 0.02);
    let fc = { type: 'FeatureCollection', features: [], source: 'none', errors: [] };
    try {
      fc = await fetchBoundaries(bbox, { signal: signal, onProgress: onProgress });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      (err && err.overpassErrors || []).forEach((e) => errors.push(e));
      errors.push('overpass: ' + ((err && err.message) || 'failed'));
      PSM.log('n-fer: Overpass failed — ' + ((err && err.message) || err), 'error');
    }
    (fc.errors || []).forEach((e) => errors.push(e));
    const source = fc.source || 'none';
    checkAbort(signal);

    /* --- 2. matching --------------------------------------------------- */
    onProgress('Matching ' + fc.features.length + ' OSM features to POTA parks…', 0.4);
    let matches = [];
    try {
      matches = await matchFeaturesToParks(fc.features, parks, {
        allParksLookup: opts.allParksLookup,
        signal: signal,
        onProgress: onProgress,
        errors: errors
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      errors.push('matching: ' + ((err && err.message) || 'failed'));
    }
    checkAbort(signal);

    /* --- 3. prepare geometry (simplify / repair) ----------------------- */
    onProgress('Preparing ' + matches.length + ' matched boundaries…', 0.55);
    const areaMatches = [];   // {match, geom, bbox, areaM2, lines}
    const trailMatches = [];  // {match, geom(line), buffer(polygon), bbox}
    for (const m of matches) {
      checkAbort(signal);
      if (m.kind === 'area') {
        const g = preparePolygon(m.feature);
        if (!g) { errors.push('unusable polygon ' + m.osmId); continue; }
        const bb = safeBbox(g);
        areaMatches.push({ match: m, geom: g, bbox: bb, areaM2: safeArea(g), lines: null });
      } else {
        let buf = null;
        try { buf = T().buffer(m.feature, TRAIL_BUFFER_M, { units: 'meters' }); } catch (e) { buf = null; }
        if (buf && !ringsOk(buf.geometry)) buf = repairPolygon(buf);
        if (!buf) { errors.push('could not buffer trail ' + m.osmId); continue; }
        trailMatches.push({ match: m, geom: m.feature, buffer: buf, bbox: safeBbox(buf) });
      }
    }
    const trailRefSet = new Set();
    trailMatches.forEach((t) => t.match.refs.forEach((r) => trailRefSet.add(r)));
    const nameByRef = new Map();
    matches.forEach((m) => m.refs.forEach((r, i) => {
      if (m.names && m.names[i] && !nameByRef.has(r)) nameByRef.set(r, m.names[i]);
    }));
    parks.forEach((p) => { if (!nameByRef.has(p.ref)) nameByRef.set(p.ref, p.name); });

    /* --- 4. overlap zones ---------------------------------------------- */
    onProgress('Intersecting boundaries…', 0.6);
    const pieces = [];   // {geom, seedRefs, conf}
    const turf = T();

    /**
     * Intersect two polygons and push every usable piece.  Any turf failure is
     * recorded and swallowed — one bad ring must never abort the analysis.
     */
    function addPieces(a, b, refsA, refsB) {
      let inter;
      try {
        inter = turf.intersect(turf.featureCollection([a.geom, b.geom]));
      } catch (e) {
        // Self-intersecting ring: retry once with buffer(0)-repaired copies.
        const ra = repairPolygon(a.geom), rb = repairPolygon(b.geom);
        try { inter = turf.intersect(turf.featureCollection([ra || a.geom, rb || b.geom])); }
        catch (e2) {
          errors.push('intersect ' + a.match.osmId + ' x ' + b.match.osmId + ': ' +
            ((e2 && e2.message) || 'failed'));
          return;
        }
      }
      if (!inter || !inter.geometry) return;
      let parts;
      try { parts = turf.flatten(inter).features; } catch (e) { parts = [inter]; }
      const conf = Math.min(a.match.confidence, b.match.confidence);
      for (const part of parts) {
        if (!ringsOk(part.geometry) || safeArea(part) < MIN_ZONE_M2) continue;
        pieces.push({ geom: part, seedRefs: refsA.concat(refsB), conf: conf });
      }
    }

    for (let i = 0; i < areaMatches.length; i++) {
      checkAbort(signal);
      const A = areaMatches[i];
      const ka = refKey(A.match.refs);
      for (let j = i + 1; j < areaMatches.length; j++) {
        const B = areaMatches[j];
        if (ka === refKey(B.match.refs)) continue;           // same park(s)
        if (!bboxOverlap(A.bbox, B.bbox)) continue;          // cheap pre-check
        addPieces(A, B, A.match.refs, B.match.refs);
      }
    }

    /* --- 5. trail × park zones ----------------------------------------- */
    onProgress('Intersecting trails…', 0.72);
    for (const Tm of trailMatches) {
      checkAbort(signal);
      const buffered = { geom: Tm.buffer, match: Tm.match };
      for (const A of areaMatches) {
        if (!bboxOverlap(Tm.bbox, A.bbox)) continue;
        if (refKey(Tm.match.refs) === refKey(A.match.refs)) continue;
        addPieces(buffered, A, Tm.match.refs, A.match.refs);
      }
    }

    /* --- 6. resolve the full ref set of each piece --------------------- */
    onProgress('Resolving overlap zones…', 0.8);
    const byRefSet = new Map();
    for (const piece of pieces) {
      checkAbort(signal);
      let rep = null;
      try { rep = turf.pointOnFeature(piece.geom).geometry.coordinates; } catch (e) { rep = null; }
      if (!rep) { try { rep = turf.centroid(piece.geom).geometry.coordinates; } catch (e) { rep = null; } }
      const refs = new Set(piece.seedRefs);
      // Confidence of a zone = the weakest match that put a ref into it.
      let conf = piece.conf;
      if (rep) {
        for (const A of areaMatches) {
          if (!bboxContainsPoint(A.bbox, rep[0], rep[1])) continue;
          if (!pointInFeature(rep[0], rep[1], A.geom, A.bbox)) continue;
          if (A.match.refs.some((r) => !refs.has(r))) conf = Math.min(conf, A.match.confidence);
          A.match.refs.forEach((r) => refs.add(r));
        }
        for (const Tm of trailMatches) {
          if (!bboxContainsPoint(Tm.bbox, rep[0], rep[1])) continue;
          if (!pointInFeature(rep[0], rep[1], Tm.buffer, Tm.bbox)) continue;
          if (Tm.match.refs.some((r) => !refs.has(r))) conf = Math.min(conf, Tm.match.confidence);
          Tm.match.refs.forEach((r) => refs.add(r));
        }
      }
      const list = Array.from(refs).sort();
      if (list.length < 2) continue;
      const k = list.join('|');
      if (!byRefSet.has(k)) byRefSet.set(k, { refs: list, parts: [], conf: conf });
      const entry = byRefSet.get(k);
      entry.parts.push(piece.geom);
      entry.conf = Math.min(entry.conf, conf);
    }

    /* --- 7. union same-ref-set pieces, build zone features ------------- */
    const zoneFeatures = [];
    byRefSet.forEach((entry) => {
      let shapes = entry.parts;
      if (shapes.length > 1) {
        try {
          // One union call over the whole collection — no O(n^2) chaining.
          const u = turf.union(turf.featureCollection(shapes));
          if (u && ringsOk(u.geometry)) shapes = [u];
        } catch (err) {
          errors.push('union ' + entry.refs.join('+') + ': ' + ((err && err.message) || 'failed'));
        }
      }
      const nParkRefs = entry.refs.filter((r) => !trailRefSet.has(r)).length;
      const kind = nParkRefs === entry.refs.length ? 'park-park'
        : (nParkRefs >= 2 ? 'park-park-trail' : 'trail-park');
      for (const shape of shapes) {
        const areaHa = safeArea(shape) / 10000;
        if (!(areaHa > 0)) continue;
        let centroid = null;
        try {
          centroid = turf.centroid(shape).geometry.coordinates.map((v) => Math.round(v * 1e6) / 1e6);
        } catch (e) { centroid = null; }
        const zb = safeBbox(shape);
        const inZone = summits
          .filter((s) => bboxContainsPoint(zb, s.lon, s.lat) && pointInFeature(s.lon, s.lat, shape, zb))
          .map((s) => s.code);
        zoneFeatures.push({
          type: 'Feature',
          geometry: shape.geometry,
          properties: {
            id: null,
            refs: entry.refs,
            names: entry.refs.map((r) => nameByRef.get(r) || null),
            count: entry.refs.length,
            kind: kind,
            areaHa: Math.round(areaHa * 100) / 100,
            confidence: Math.round(entry.conf * 100) / 100,
            summits: inZone,
            centroid: centroid
          }
        });
      }
    });
    zoneFeatures.sort((a, b) =>
      (b.properties.count - a.properties.count) || (b.properties.areaHa - a.properties.areaHa));
    zoneFeatures.forEach((z, i) => { z.properties.id = 'zone-' + (i + 1); });

    /* --- 8. summit combos ---------------------------------------------- */
    onProgress('Checking ' + summits.length + ' summits…', 0.9);
    const padDeg = SUMMIT_NEAR_M / 111000 + 0.0005;
    const summitCombos = [];
    const testables = areaMatches.concat(trailMatches.map((t) =>
      ({ match: t.match, geom: t.buffer, bbox: t.bbox, lines: null })));
    for (const s of summits) {
      checkAbort(signal);
      const found = new Map();   // ref -> park name (kept aligned when sorted)
      let inside = false, bestDist = Infinity, minConf = 1;
      for (const A of testables) {
        if (!bboxContainsPoint(A.bbox, s.lon, s.lat, padDeg)) continue;
        let hit = false, d = Infinity;
        if (pointInFeature(s.lon, s.lat, A.geom, A.bbox)) { hit = true; d = 0; inside = true; }
        else {
          if (!A.lines) A.lines = outlineLines(A.geom);
          d = distToOutlineM(s.lon, s.lat, A.geom, A.lines);
          if (isFinite(d) && d <= SUMMIT_NEAR_M) hit = true;
        }
        if (!hit) continue;
        if (d < bestDist) bestDist = d;
        minConf = Math.min(minConf, A.match.confidence);
        A.match.refs.forEach((r, i) => {
          if (!found.has(r)) found.set(r, (A.match.names && A.match.names[i]) || nameByRef.get(r) || null);
        });
      }
      if (!found.size) continue;
      const refs = Array.from(found.keys()).sort();
      summitCombos.push({
        code: s.code, name: s.name || null, lat: s.lat, lon: s.lon,
        refs: refs, names: refs.map((r) => found.get(r)),
        // `inside` = the summit stands in at least one matched boundary;
        // `distM` = metres to the nearest contributing boundary (0 when inside).
        inside: inside, distM: inside ? 0 : Math.round(bestDist), confidence: minConf
      });
    }
    summitCombos.sort((a, b) => (b.refs.length - a.refs.length) || (a.distM - b.distM));

    /* --- 9. leftovers -------------------------------------------------- */
    const matchedRefs = new Set();
    matches.forEach((m) => m.refs.forEach((r) => matchedRefs.add(r)));
    const unmatchedParks = parks.filter((p) => !matchedRefs.has(p.ref)).map((p) => p.ref);

    const matchedIds = new Set(matches.map((m) => m.osmId));
    const unmatchedFeatures = [];
    for (const f of fc.features) {
      if (unmatchedFeatures.length >= MAX_UNMATCHED_FEATURES) break;
      const id = featOsmId(f);
      if (matchedIds.has(id)) continue;
      const name = featName(f);
      if (!name) continue;
      unmatchedFeatures.push({ osmId: id, name: name, tags: featTags(f) });
    }

    /* --- 10. boundaries FeatureCollection (simplified geometry) -------- */
    const geomFor = new Map();
    areaMatches.forEach((a) => geomFor.set(a.match, a.geom));
    const boundaryFeatures = matches.map((m) =>
      boundaryFeature(m, (geomFor.get(m) || m.feature).geometry));

    onProgress('Done', 1);
    const result = {
      boundaries: { type: 'FeatureCollection', features: boundaryFeatures },
      zones: { type: 'FeatureCollection', features: zoneFeatures },
      summitCombos: summitCombos,
      unmatchedParks: unmatchedParks,
      unmatchedFeatures: unmatchedFeatures,
      stats: {
        osmFeatures: fc.features.length, matched: matches.length,
        zones: zoneFeatures.length, combos: summitCombos.length,
        elapsedMs: Date.now() - t0, source: source, errors: errors
      }
    };
    PSM.log('n-fer: ' + result.stats.matched + ' boundaries matched, ' +
      result.stats.zones + ' zones, ' + result.stats.combos + ' summit combos (' +
      result.stats.elapsedMs + ' ms, ' + source + ')');
    return result;
  }

  /* --- e) Per-park n-fer index (map chips + list badges) ------------- */
  /**
   * Collapse the overlap picture down to "what does THIS park stack with",
   * for the map count-chips and the park-list badges.  Two tiers:
   *
   *   confirmed — analyze() found the park's OSM boundary actually overlapping
   *               another reference (a zone), or a summit sitting inside / just
   *               outside it (a summitCombo).  Authoritative.
   *   hint      — no confirmed overlap, but another park's *reference point* is
   *               within `proximityM`.  A cheap "these might be an n-fer" flag
   *               that needs no Overpass call — but adjacency is not overlap, so
   *               it is always reported unconfirmed (the UI marks it "?").
   *
   * A confirmed fact always wins over a hint for the same park.  The park's
   * count is the largest simultaneous stack it takes part in (an honest lower
   * bound: we never merge a park-overlap and a summit-combo into one bigger
   * number unless the geometry actually put them in the same zone).
   *
   * @param {Array<Park>} parks
   * @param {Object|null} nferResult   the result of analyze(), or null
   * @param {Object} [opts] {proximityM=500, maxCluster=6}
   * @returns {Map<string,{count:number, confirmed:boolean, partners:string[]}>}
   *          keyed by POTA reference; only parks that stack with something appear.
   */
  function parkNferIndex(parks, nferResult, opts) {
    opts = opts || {};
    const proximityM = opts.proximityM == null ? 500 : opts.proximityM;
    const maxCluster = opts.maxCluster == null ? 6 : opts.maxCluster;
    const list = (parks || []).filter((p) => p && p.ref && isFinite(p.lat) && isFinite(p.lon));
    const index = new Map();

    /** Create or upgrade one park's entry; confirmed beats hint, never the reverse. */
    function bump(ref, count, confirmed, partners) {
      if (!ref || !(count > 1)) return;
      let e = index.get(ref);
      if (!e) { e = { count: 0, confirmed: false, partners: [] }; index.set(ref, e); }
      if (confirmed && !e.confirmed) { e.confirmed = true; e.count = 0; e.partners = []; }
      if (!confirmed && e.confirmed) return;          // keep the confirmed picture
      if (count > e.count) e.count = count;
      const seen = new Set(e.partners);
      (partners || []).forEach((r) => { if (r && !seen.has(r)) { seen.add(r); e.partners.push(r); } });
    }

    /* confirmed: park×park (and trail×park) overlap zones */
    const zones = (nferResult && nferResult.zones && nferResult.zones.features) || [];
    zones.forEach((z) => {
      const refs = (z.properties && z.properties.refs) || [];
      if (refs.length < 2) return;
      refs.forEach((ref) => bump(ref, refs.length, true, refs.filter((r) => r !== ref)));
    });

    /* confirmed: summit-in-park combos — the summit is one of the "fer" */
    const combos = (nferResult && nferResult.summitCombos) || [];
    combos.forEach((c) => {
      const refs = (c && c.refs) || [];
      if (!refs.length) return;
      const count = refs.length + 1;                  // + the summit itself
      refs.forEach((ref) => bump(ref, count, true,
        refs.filter((r) => r !== ref).concat(c.code ? [c.code] : [])));
    });

    /* hint: reference points sitting within proximityM of each other */
    if (proximityM > 0 && list.length > 1) {
      const km = proximityM / 1000;
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        const near = [];
        for (let j = 0; j < list.length && near.length < maxCluster - 1; j++) {
          if (j === i) continue;
          const b = list[j];
          if (PSM.haversineKm(a.lat, a.lon, b.lat, b.lon) <= km) near.push(b.ref);
        }
        if (near.length) bump(a.ref, near.length + 1, false, near);
      }
    }

    return index;
  }

  /* ------------------------------------------------------------------ */
  PSM.nfer = {
    buildOverpassQuery: buildOverpassQuery, fetchBoundaries: fetchBoundaries,
    matchFeaturesToParks: matchFeaturesToParks, analyze: analyze,
    // Single-park boundary (the detail panel's highlight).
    buildParkQuery: buildParkQuery, parkBoundary: parkBoundary,
    boundaryFromAnalysis: boundaryFromAnalysis,
    // Per-park stacking index for the map chips + list badges.
    parkNferIndex: parkNferIndex,
    // Low-level helpers, exported for the tests and for other modules that need
    // to read OSM tags / normalise POTA refs exactly the way we do.
    _normRef: normRef, _refsFromTag: refsFromTag, _featTags: featTags,
    _featName: featName, _preparePolygon: preparePolygon, _bboxCacheKey: bboxCacheKey,
    _countPositions: countPositions,
    CONST: {
      CACHE_MS: CACHE_MS, SIMPLIFY_TOL: SIMPLIFY_TOL, MIN_ZONE_M2: MIN_ZONE_M2,
      TRAIL_BUFFER_M: TRAIL_BUFFER_M, SUMMIT_NEAR_M: SUMMIT_NEAR_M,
      POTA_TAG: POTA_TAG, ENDPOINTS: ENDPOINTS,
      PARK_CACHE_MS: PARK_CACHE_MS, PARK_AROUND_M: PARK_AROUND_M,
      PARK_SIMPLIFY_TOL: PARK_SIMPLIFY_TOL, PARK_MAX_VERTICES: PARK_MAX_VERTICES
    }
  };

})(typeof window !== 'undefined' ? window : globalThis);
