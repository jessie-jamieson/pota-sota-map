/* =====================================================================
 * 30-sota.js — PSM.sota: Summits on the Air data access
 *
 *   PSM.sota.loadNear(center, radiusKm, {onProgress, signal, includeRetired})
 *   PSM.sota.getSummit(code)
 *   PSM.sota.toSummit(row[, columns][, hint])   normaliser used by every path
 *   PSM.sota.isValid(summit[, dateISO])
 *   PSM.sota.summitUrls(code)
 *
 * There is no "summits near me" endpoint, so the cascade synthesises one
 * (ARCHITECTURE.md "SOTA cascade"):
 *   1. window.PSM_SNAPSHOT.sota
 *   2. GET /api/associations           -> keep the associations whose bounding box
 *                                         touches the search circle
 *      GET /api/associations/{CODE}    -> regions[]
 *      GET /api/regions/{A}/{R}        -> summits[]      (cached 7 d each)
 *   3. https://storage.sota.org.uk/summitslist.csv (~20 MB, ~150k rows) parsed
 *      into compact rows and cached 7 d — used only when the API is unusable.
 *
 * Field-name defensiveness: the region endpoint and the CSV disagree about
 * spelling and case (altM/AltM, activationCall/activationCallsign/ActivationCall)
 * and about date format ("2010-05-01T00:00:00" vs "01/08/2026"), so every read
 * goes through a case-insensitive lookup and PSM.fmt.date.
 * ===================================================================== */
(function (global) {
  'use strict';

  const PSM = global.PSM || (global.PSM = {});

  const BASE = 'https://api2.sota.org.uk/api';
  const CSV_URL = 'https://storage.sota.org.uk/summitslist.csv';
  const DAY = 24 * 60 * 60 * 1000;
  const WEEK = 7 * DAY;
  const SUMMIT_TTL = DAY;
  const CONCURRENCY = 3;
  const MAX_ASSOCIATIONS = 8;   // hard ceiling on the association fan-out (see loadFromApi)
  const MAX_REGIONS = 200;      // …and on the region walk it feeds
  const MAX_SOURCES = 12;       // `sources` is for the UI, not an audit log

  /** Compact row layout used by the CSV cache and by data/snapshot.js. */
  const COMPACT_COLUMNS = ['code', 'name', 'lat', 'lon', 'altM', 'altFt', 'points', 'bonus',
    'validFrom', 'validTo', 'actCount', 'actDate', 'actCall', 'assocName', 'regionName'];

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */
  function str(v) {
    if (v == null) return null;
    const s = String(v).trim();
    return s || null;
  }
  function num(v) {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : null;
  }
  function int(v) {
    const n = num(v);
    return n == null ? null : Math.round(n);
  }
  /**
   * Tolerant date -> ISO "YYYY-MM-DD"; null when there is nothing parseable.
   * Anything PSM.fmt.date could not turn into a date comes back as null rather
   * than as itself — isValid() compares these strings, and a stray non-date
   * would silently retire a summit.
   */
  function iso(v) {
    const s = str(v);
    if (!s) return null;
    const d = PSM.fmt.date(s);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  }
  function lcKeys(o) {
    const m = {};
    Object.keys(o).forEach(function (k) { m[String(k).toLowerCase()] = o[k]; });
    return m;
  }
  function get(m) {
    for (let i = 1; i < arguments.length; i++) {
      const v = m[arguments[i]];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  }
  function abortError(msg) {
    const e = new Error(msg || 'aborted');
    e.name = 'AbortError';
    return e;
  }
  function checkAbort(signal) {
    if (signal && signal.aborted) throw abortError('SOTA load aborted');
  }
  function errText(e) { return (e && e.message) || String(e); }
  function noop() {}

  /** "w2/gc-001" -> {code:"W2/GC-001", assoc:"W2", region:"GC"} */
  function splitCode(code) {
    const s = (str(code) || '').toUpperCase();
    if (!s) return { code: null, assoc: null, region: null };
    const m = /^([A-Z0-9]{1,4})\/([A-Z]{2})-(\d{1,4})$/.exec(s);
    if (m) return { code: m[1] + '/' + m[2] + '-' + m[3], assoc: m[1], region: m[2] };
    const slash = s.indexOf('/');
    if (slash > 0) {
      const rest = s.slice(slash + 1);
      const dash = rest.indexOf('-');
      return { code: s, assoc: s.slice(0, slash), region: dash > 0 ? rest.slice(0, dash) : null };
    }
    // Bare "GC-001" (the spots feed does this) — caller supplies the association.
    const dash = s.indexOf('-');
    return { code: s, assoc: null, region: dash > 0 ? s.slice(0, dash) : null };
  }

  function summitUrls(code) {
    const c = PSM.normalizeSotaRef(code) || String(code || '').trim().toUpperCase();
    // Both sites want the "W2/GC-001" shape, so the slash stays — everything else is encoded
    // in case a spot feed hands us something that is not a well-formed reference.
    const path = c.split('/').map(encodeURIComponent).join('/');
    return {
      sotlas: 'https://sotl.as/summits/' + path,
      sotadata: 'https://www.sotadata.org.uk/en/summit/' + path
    };
  }

  /* ------------------------------------------------------------------ */
  /* toSummit — the one normaliser                                       */
  /* ------------------------------------------------------------------ */
  /**
   * Accepts API region rows, API summit detail objects, CSV rows (array + header
   * row, or objects), snapshot/compact rows (array + columns) and Summit objects.
   * @param {object|Array} row
   * @param {string[]} [columns]  header/column names when `row` is an array
   * @param {{assoc?,region?,assocName?,regionName?}} [hint] context from the caller
   * @returns {Summit|null}
   */
  function toSummit(row, columns, hint) {
    if (!row) return null;
    let o = row;
    if (Array.isArray(row)) {
      const cols = columns && columns.length ? columns : COMPACT_COLUMNS;
      o = {};
      for (let i = 0; i < cols.length; i++) o[cols[i]] = row[i];
    }
    if (typeof o !== 'object') return null;
    hint = hint || {};

    const m = lcKeys(o);
    const rawCode = str(get(m, 'summitcode', 'code', 'summit'));
    if (!rawCode) return null;
    let parts = splitCode(rawCode);
    if (!parts.assoc) {
      const assoc = str(get(m, 'associationcode', 'assoc')) || str(hint.assoc);
      if (assoc) {
        parts = splitCode(assoc.toUpperCase() + '/' + parts.code);
      }
    }

    const validFrom = iso(get(m, 'validfrom', 'valid_from'));
    const validTo = iso(get(m, 'validto', 'valid_to'));

    return {
      code: parts.code,
      name: str(get(m, 'name', 'summitname', 'title')),
      lat: num(get(m, 'latitude', 'lat')),
      lon: num(get(m, 'longitude', 'lon', 'lng', 'long')),
      altM: int(get(m, 'altm', 'altitudem', 'altitude', 'elevationm')),
      altFt: int(get(m, 'altft', 'altitudeft', 'elevationft')),
      points: int(get(m, 'points', 'point')),
      bonus: int(get(m, 'bonuspoints', 'bonus')),
      validFrom: validFrom,
      validTo: validTo,
      actCount: int(get(m, 'activationcount', 'actcount')),
      actDate: iso(get(m, 'activationdate', 'actdate')),
      actCall: str(get(m, 'activationcall', 'activationcallsign', 'actcall')),
      locator: str(get(m, 'locator', 'grid', 'gridref')),
      assoc: parts.assoc || str(hint.assoc),
      region: parts.region || str(hint.region),
      assocName: str(get(m, 'associationname', 'assocname')) || str(hint.assocName),
      regionName: str(get(m, 'regionname')) || str(hint.regionName)
    };
  }

  /**
   * A summit can be activated when validFrom <= today <= validTo.  Both are ISO
   * "YYYY-MM-DD" strings so a lexicographic compare is exactly a date compare.
   * The API's own `valid` flag is unreliable on the region endpoint, so it is
   * deliberately ignored.
   */
  function isValid(summit, dateISO) {
    if (!summit) return false;
    const today = dateISO || PSM.todayISO();
    if (summit.validFrom && summit.validFrom > today) return false;
    if (summit.validTo && summit.validTo < today) return false;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* snapshot index                                                      */
  /* ------------------------------------------------------------------ */
  let snapSource = null;
  let snapSummits = null;

  function snapshotSummits() {
    const snap = global.PSM_SNAPSHOT;
    const src = snap && snap.sota;
    if (!src || !Array.isArray(src.rows) || !src.rows.length) {
      snapSource = null; snapSummits = null;
      return null;
    }
    if (snapSource === src && snapSummits) return snapSummits;
    const columns = Array.isArray(src.columns) && src.columns.length ? src.columns : COMPACT_COLUMNS;
    const out = [];
    for (let i = 0; i < src.rows.length; i++) {
      const s = toSummit(src.rows[i], columns);
      if (s && s.lat != null && s.lon != null) out.push(s);
    }
    snapSource = src;
    snapSummits = out;
    PSM.log('SOTA snapshot: ' + out.length + ' summits indexed');
    return snapSummits;
  }

  /* ------------------------------------------------------------------ */
  /* endpoint wrappers                                                   */
  /* ------------------------------------------------------------------ */
  function associations(signal) {
    return PSM.memo('sota:assocs', WEEK, function () {
      return PSM.fetchJSON(BASE + '/associations', { signal: signal, timeoutMs: 25000 });
    });
  }

  function association(code, signal) {
    return PSM.memo('sota:assoc:' + code, WEEK, function () {
      return PSM.fetchJSON(BASE + '/associations/' + encodeURIComponent(code), { signal: signal });
    });
  }

  function regionSummits(assoc, region, signal) {
    return PSM.memo('sota:region:' + assoc + '/' + region, WEEK, function () {
      return PSM.fetchJSON(BASE + '/regions/' + encodeURIComponent(assoc) + '/' + encodeURIComponent(region),
        { signal: signal, timeoutMs: 30000 });
    });
  }

  /** GET /api/summits/{ASSOC}/{REGION-NNN}; unknown codes 404 -> null. */
  async function getSummit(code) {
    const c = PSM.normalizeSotaRef(code) || (splitCode(code).code);
    if (!c || c.indexOf('/') < 0) return null;
    const bits = c.split('/');
    try {
      const d = await PSM.memo('sota:summit:' + c, SUMMIT_TTL, function () {
        return PSM.fetchJSON(BASE + '/summits/' + encodeURIComponent(bits[0]) + '/' + encodeURIComponent(bits[1]));
      });
      if (!d || (typeof d === 'object' && d.error)) return null;
      return d;
    } catch (e) {
      if (e && (e.status === 404 || e.status === 400)) return null;
      throw e;
    }
  }

  /* ------------------------------------------------------------------ */
  /* CSV fallback                                                        */
  /* ------------------------------------------------------------------ */
  /** Column index by header name, case-insensitively. */
  function headerIndex(header) {
    const idx = {};
    (header || []).forEach(function (h, i) { idx[String(h).trim().toLowerCase()] = i; });
    return function () {
      for (let i = 0; i < arguments.length; i++) {
        const k = idx[arguments[i]];
        if (k !== undefined) return k;
      }
      return -1;
    };
  }

  /**
   * Download + parse summitslist.csv into compact rows (COMPACT_COLUMNS order).
   * Line 1 is a banner ("SOTA Summits List (Date=31/08/2026)"), line 2 the header.
   */
  function csvRows(signal) {
    return PSM.memo('sota:csv', WEEK, async function () {
      PSM.log('SOTA: downloading summitslist.csv (~20 MB, this can take a while)…', 'warn');
      const text = await PSM.fetchText(CSV_URL, { timeoutMs: 120000, retries: 1, signal: signal });
      let body = String(text || '');
      // Skip the banner line before the real CSV header.
      const nl = body.indexOf('\n');
      if (nl > 0 && !/summitcode/i.test(body.slice(0, nl))) body = body.slice(nl + 1);
      const rows = PSM.parseCSV(body);
      if (!rows.length) throw new Error('summitslist.csv was empty');
      const at = headerIndex(rows[0]);
      const iCode = at('summitcode', 'code');
      const iName = at('summitname', 'name');
      const iLat = at('latitude', 'lat');
      const iLon = at('longitude', 'lon');
      if (iCode < 0 || iLat < 0 || iLon < 0) throw new Error('summitslist.csv header not recognised');
      const iAltM = at('altm'), iAltFt = at('altft'), iPoints = at('points'), iBonus = at('bonuspoints', 'bonus');
      const iFrom = at('validfrom'), iTo = at('validto'), iCount = at('activationcount');
      const iDate = at('activationdate'), iCall = at('activationcall', 'activationcallsign');
      const iAssoc = at('associationname'), iRegion = at('regionname');
      const pick = function (r, i) { return i >= 0 ? r[i] : null; };

      const out = [];
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.length < 4) continue;
        const code = str(pick(r, iCode));
        const lat = num(pick(r, iLat));
        const lon = num(pick(r, iLon));
        if (!code || lat == null || lon == null) continue;
        out.push([
          code.toUpperCase(), str(pick(r, iName)), lat, lon,
          int(pick(r, iAltM)), int(pick(r, iAltFt)), int(pick(r, iPoints)), int(pick(r, iBonus)),
          iso(pick(r, iFrom)), iso(pick(r, iTo)),
          int(pick(r, iCount)), iso(pick(r, iDate)), str(pick(r, iCall)),
          str(pick(r, iAssoc)), str(pick(r, iRegion))
        ]);
      }
      PSM.log('SOTA: summitslist.csv parsed — ' + out.length + ' summits');
      return out;
    });
  }

  /* ------------------------------------------------------------------ */
  /* loadNear                                                            */
  /* ------------------------------------------------------------------ */
  /** {south,west,north,east} for an association row, or null when the API gave us no box. */
  function assocBbox(a) {
    if (!a) return null;
    const lat1 = num(a.minLat), lat2 = num(a.maxLat);
    const lon1 = num(a.minLong !== undefined ? a.minLong : a.minLon);
    const lon2 = num(a.maxLong !== undefined ? a.maxLong : a.maxLon);
    if (lat1 == null || lat2 == null || lon1 == null || lon2 == null) return null;
    // Don't trust min/max to actually be min/max (southern-hemisphere rows have been seen swapped).
    return {
      south: Math.min(lat1, lat2), north: Math.max(lat1, lat2),
      west: Math.min(lon1, lon2), east: Math.max(lon1, lon2)
    };
  }

  /** Association bbox (missing/partial boxes are treated as "might intersect"). */
  function associationIntersects(a, bbox) {
    const b = assocBbox(a);
    if (!b) return true;
    return PSM.bboxesIntersect(b, bbox);
  }

  /** Rough distance from the search box centre to an association box, for ranking. */
  function assocRank(a, bbox) {
    const b = assocBbox(a);
    if (!b) return Infinity;
    const cLat = (bbox.south + bbox.north) / 2, cLon = (bbox.west + bbox.east) / 2;
    const lat = Math.min(b.north, Math.max(b.south, cLat));
    const lon = Math.min(b.east, Math.max(b.west, cLon));
    return PSM.haversineKm(cLat, cLon, lat, lon);
  }

  /** API cascade: associations -> regions -> summits.  Returns null if it is unusable. */
  async function loadFromApi(bbox, ctx) {
    let assocs;
    try {
      assocs = await associations(ctx.signal);
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      ctx.warnings.push('SOTA association list unavailable');
      PSM.log('SOTA: /associations failed (' + errText(e) + ')', 'warn');
      return null;
    }
    if (!Array.isArray(assocs) || !assocs.length) {
      ctx.warnings.push('SOTA association list unavailable');
      return null;
    }

    let candidates = assocs.filter(function (a) { return a && str(a.associationCode) && associationIntersects(a, bbox); });
    if (!candidates.length) {
      PSM.log('SOTA: no association covers this area');
      return { summits: [], sources: ['/api/associations'], anyAssoc: true };
    }
    // Without bounding boxes every association "matches", and blindly walking ~190 of them
    // (each with dozens of regions) would be thousands of requests. If any row has a box,
    // trust the boxes; then cap what is left, nearest first.
    const boxed = candidates.filter(function (a) { return !!assocBbox(a); });
    if (candidates.length > MAX_ASSOCIATIONS && boxed.length) candidates = boxed;
    if (candidates.length > MAX_ASSOCIATIONS) {
      ctx.warnings.push('SOTA: ' + candidates.length + ' associations match this area; using the nearest ' + MAX_ASSOCIATIONS);
      PSM.log('SOTA: association list has no usable bounding boxes — limiting to ' + MAX_ASSOCIATIONS, 'warn');
      candidates = candidates.slice().sort(function (a, b) { return assocRank(a, bbox) - assocRank(b, bbox); })
        .slice(0, MAX_ASSOCIATIONS);
    }

    /* --- association -> region list ------------------------------- */
    const limit = PSM.pLimit(CONCURRENCY);
    let jobs = [];        // {assoc, assocName, region, regionName}
    let okAssoc = 0;
    await Promise.all(candidates.map(function (a) {
      return limit(async function () {
        checkAbort(ctx.signal);
        const code = str(a.associationCode);
        try {
          const detail = await association(code, ctx.signal);
          if (!detail) throw new Error('empty response');
          okAssoc++;
          const regions = Array.isArray(detail.regions) ? detail.regions : [];
          regions.forEach(function (r) {
            const rc = str(r && (r.regionCode || r.code));
            if (!rc) return;
            jobs.push({
              assoc: code,
              assocName: str(detail.associationName) || str(a.associationName),
              region: rc,
              regionName: str(r.regionName) || str(r.name)
            });
          });
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
          ctx.warnings.push('SOTA association ' + code + ' unavailable');
          PSM.log('SOTA: /associations/' + code + ' failed (' + errText(e) + ')', 'warn');
        }
      });
    }));

    // Every association failed -> the API path is unusable, fall back to the CSV.
    if (!okAssoc) return null;

    if (jobs.length > MAX_REGIONS) {
      ctx.warnings.push('SOTA: only the first ' + MAX_REGIONS + ' of ' + jobs.length + ' regions were loaded');
      PSM.log('SOTA: capping the region walk at ' + MAX_REGIONS + ' of ' + jobs.length + ' regions', 'warn');
      jobs = jobs.slice(0, MAX_REGIONS);
    }

    /* --- region -> summits ---------------------------------------- */
    const sources = ['/api/associations'];
    const summits = [];
    let done = 0;
    await Promise.all(jobs.map(function (job) {
      return limit(async function () {
        checkAbort(ctx.signal);
        const label = job.assoc + '/' + job.region;
        try {
          const data = await regionSummits(job.assoc, job.region, ctx.signal);
          const list = data && Array.isArray(data.summits) ? data.summits : [];
          const hint = {
            assoc: job.assoc,
            region: job.region,
            assocName: (data && str(data.associationName)) || job.assocName,
            regionName: (data && str(data.regionName)) || job.regionName
          };
          list.forEach(function (row) {
            const s = toSummit(row, null, hint);
            if (s && s.lat != null && s.lon != null) summits.push(s);
          });
          if (sources.length < MAX_SOURCES) sources.push('/api/regions/' + label);
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
          ctx.warnings.push('SOTA region ' + label + ' unavailable');
          PSM.log('SOTA: /regions/' + label + ' failed (' + errText(e) + ')', 'warn');
        } finally {
          done++;
          ctx.onProgress('Loading SOTA summits (' + label + ')…', jobs.length ? done / jobs.length : 1);
        }
      });
    }));

    return { summits: summits, sources: sources, anyAssoc: true };
  }

  /**
   * Summits within `radiusKm` of a centre, with distKm set and sorted.
   * @returns {Promise<{summits:Summit[], source:"snapshot"|"api"|"csv", sources:string[], warnings:string[], bbox}>}
   */
  async function loadNear(center, radiusKm, opts) {
    opts = opts || {};
    const ctx = {
      onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : noop,
      signal: opts.signal,
      warnings: []
    };
    const includeRetired = !!opts.includeRetired;
    const lat = Number(center && center.lat);
    const lon = Number(center && center.lon);
    const radius = Number(radiusKm) > 0 ? Number(radiusKm) : 0;
    if (!isFinite(lat) || !isFinite(lon)) throw new Error('sota.loadNear(): bad centre');

    const bbox = PSM.bboxAround(lat, lon, radius);
    const today = PSM.todayISO();
    let source = null;
    let sources = [];
    let candidates = null;

    checkAbort(ctx.signal);

    /* --- 1. snapshot ---------------------------------------------- */
    const snap = snapshotSummits();
    if (snap) {
      ctx.onProgress('Reading SOTA snapshot…', 0.2);
      const hits = snap.filter(function (s) { return PSM.pointInBbox(s.lat, s.lon, bbox); });
      // A snapshot may hold only some associations (build_snapshot.py
      // --sota-assoc-prefix), so "nothing here" means "ask the API", not "no summits".
      if (hits.length) {
        candidates = hits;
        source = 'snapshot';
        sources = ['snapshot'];
      } else {
        PSM.log('SOTA: snapshot has no summits in this area, asking the API');
      }
    }

    /* --- 2. API cascade ------------------------------------------- */
    if (!candidates) {
      const api = await loadFromApi(bbox, ctx);
      if (api) {
        candidates = api.summits;
        source = 'api';
        sources = api.sources;
      }
    }

    /* --- 3. bulk CSV ---------------------------------------------- */
    if (!candidates) {
      PSM.log('SOTA: falling back to summitslist.csv', 'warn');
      ctx.onProgress('Downloading the SOTA summits list…', 0.3);
      try {
        const rows = await csvRows(ctx.signal);
        candidates = [];
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          // Cheap bbox reject before building an object (the CSV holds ~150k rows).
          const rLat = r[2], rLon = r[3];
          if (rLat == null || rLon == null) continue;
          if (rLat < bbox.south || rLat > bbox.north || rLon < bbox.west || rLon > bbox.east) continue;
          const s = toSummit(r, COMPACT_COLUMNS);
          if (s) candidates.push(s);
        }
        source = 'csv';
        sources = [CSV_URL];
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        ctx.warnings.push('SOTA summits list unavailable');
        PSM.log('SOTA: summitslist.csv failed (' + errText(e) + ')', 'error');
        candidates = [];
        source = 'csv';
        sources = [];
      }
    }

    /* --- filter to the circle + validity, de-duplicate ------------- */
    const seen = {};
    const summits = [];
    for (let i = 0; i < candidates.length; i++) {
      const s = candidates[i];
      if (!s || s.lat == null || s.lon == null || !s.code) continue;
      if (seen[s.code]) continue;
      if (!includeRetired && !isValid(s, today)) continue;
      const d = PSM.haversineKm(lat, lon, s.lat, s.lon);
      if (d > radius) continue;
      const copy = Object.assign({}, s);
      copy.distKm = d;
      seen[s.code] = true;
      summits.push(copy);
    }
    summits.sort(function (a, b) { return a.distKm - b.distKm; });

    ctx.onProgress('SOTA: ' + summits.length + ' summits', 1);
    PSM.log('SOTA: ' + summits.length + ' summits within ' + Math.round(radius) + ' km (source: ' + source + ')');

    const warnings = ctx.warnings.filter(function (w, i) { return ctx.warnings.indexOf(w) === i; });
    return { summits: summits, source: source, sources: sources, warnings: warnings, bbox: bbox };
  }

  /* ------------------------------------------------------------------ */
  PSM.sota = {
    BASE: BASE,
    CSV_URL: CSV_URL,
    loadNear: loadNear,
    getSummit: getSummit,
    toSummit: toSummit,
    isValid: isValid,
    summitUrls: summitUrls,
    COMPACT_COLUMNS: COMPACT_COLUMNS,
    // exported for tests / other modules
    _splitCode: splitCode,
    _csvRows: csvRows,
    _snapshotSummits: snapshotSummits,
    TTL: { ASSOC: WEEK, REGION: WEEK, CSV: WEEK, SUMMIT: SUMMIT_TTL }
  };

})(typeof window !== 'undefined' ? window : globalThis);
