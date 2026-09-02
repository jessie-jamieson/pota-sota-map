/* =====================================================================
 * 20-pota.js — PSM.pota: Parks on the Air data access
 *
 *   PSM.pota.loadNear(center, radiusKm, {onProgress, signal})
 *   PSM.pota.getPark / getStats / getActivations / getLeaderboard / lookup
 *   PSM.pota.searchAll(name)
 *   PSM.pota.toPark(row[, columns])   normaliser used by every path
 *   PSM.pota.parkUrl(ref) / displayName(detail)
 *
 * Loading cascade (ARCHITECTURE.md "POTA cascade"):
 *   1. window.PSM_SNAPSHOT.pota          — instant, offline, no API at all
 *   2. GET /location/parks/{US-XX}       — one call per state/province the search
 *                                          circle touches; carries activation stats
 *   3. GET /park/grid/{GRID4}            — last resort; name + position only
 * Whatever the base was, we then try the state lists in the background to fill in
 * attempts/activations/qsos (best effort — never fatal).
 *
 * api.pota.app quirks worth remembering:
 *   * a matched route with no data answers HTTP 200 with a body of `null`
 *   * an unmatched route answers HTTP 403
 *   * detail `name` is bare ("Harriman"); list endpoints give the full name
 * ===================================================================== */
(function (global) {
  'use strict';

  const PSM = global.PSM || (global.PSM = {});

  const BASE = 'https://api.pota.app';
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const STATE_TTL = DAY;      // /location/parks/{code}
  const GRID_TTL = DAY;       // /park/grid/{cell}
  const PARK_TTL = DAY;       // /park/{ref}
  const STATS_TTL = 6 * HOUR; // /park/stats, /park/activations
  const LOOKUP_TTL = DAY;
  const CONCURRENCY = 3;
  const MAX_ENRICH_CODES = 8; // don't hammer the API when a snapshot spans many states
  const SNAPSHOT_COLUMNS = ['ref', 'name', 'lat', 'lon', 'grid', 'loc', 'active'];

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
  /** Case-insensitive view of an object's keys (API/CSV/snapshot spellings differ). */
  function lcKeys(o) {
    const m = {};
    Object.keys(o).forEach(function (k) { m[String(k).toLowerCase()] = o[k]; });
    return m;
  }
  /** First present (non-null, non-empty-string) value among `names`. */
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
    if (signal && signal.aborted) throw abortError('POTA load aborted');
  }
  function errText(e) { return (e && e.message) || String(e); }
  function noop() {}

  /* ------------------------------------------------------------------ */
  /* toPark — the one normaliser                                         */
  /* ------------------------------------------------------------------ */
  /**
   * Accepts: snapshot rows (array + columns), /location/parks rows, /park/grid rows,
   * /park/{ref} detail objects, all_parks_ext.csv rows (array + header, or object)
   * and Park objects themselves.
   * @returns {Park|null} {ref, name, lat, lon, grid, loc, active, attempts, activations, qsos}
   */
  function toPark(row, columns) {
    if (!row) return null;
    let o = row;
    if (Array.isArray(row)) {
      const cols = columns && columns.length ? columns : SNAPSHOT_COLUMNS;
      o = {};
      for (let i = 0; i < cols.length; i++) o[cols[i]] = row[i];
    }
    if (typeof o !== 'object') return null;

    const m = lcKeys(o);
    const rawRef = str(get(m, 'reference', 'ref', 'parkreference', 'value'));
    if (!rawRef) return null;
    const ref = PSM.normalizePotaRef(rawRef) || rawRef.toUpperCase();

    let name = str(get(m, 'name', 'parkname', 'title', 'display'));
    // /lookup rows spell the name as display = "US-2069  Harriman State Park".
    if (name && name.slice(0, ref.length).toUpperCase() === ref) name = str(name.slice(ref.length)) || name;
    const typeDesc = str(get(m, 'parktypedesc', 'parktype'));
    if (name && typeDesc) name = withParkType(name, typeDesc);

    const lat = num(get(m, 'latitude', 'lat'));
    const lon = num(get(m, 'longitude', 'lon', 'lng', 'long'));

    return {
      ref: ref,
      name: name,
      lat: lat,
      lon: lon,
      grid: str(get(m, 'grid', 'grid6', 'grid4', 'locator')),
      loc: str(get(m, 'locationdesc', 'loc', 'location', 'locations')),
      active: int(get(m, 'active')),
      attempts: int(get(m, 'attempts')),
      activations: int(get(m, 'activations')),
      qsos: int(get(m, 'qsos', 'contacts'))
    };
  }

  /** "Harriman" + "State Park" -> "Harriman State Park"; never doubles the suffix. */
  function withParkType(name, typeDesc) {
    const n = str(name), t = str(typeDesc);
    if (!n) return t;
    if (!t) return n;
    if (n.toLowerCase().endsWith(t.toLowerCase())) return n;
    return n + ' ' + t;
  }

  /** Display name for a /park/{ref} detail object (list names are already complete). */
  function displayName(detail) {
    if (!detail) return '';
    if (typeof detail === 'string') return detail;
    const m = lcKeys(detail);
    const name = str(get(m, 'name', 'parkname', 'title'));
    const type = str(get(m, 'parktypedesc', 'parktype'));
    return withParkType(name, type) || str(get(m, 'reference', 'ref')) || '';
  }

  function parkUrl(ref) {
    const r = PSM.normalizePotaRef(ref) || String(ref || '').trim().toUpperCase();
    return 'https://pota.app/#/park/' + encodeURIComponent(r);
  }

  /* ------------------------------------------------------------------ */
  /* snapshot index (built once per snapshot object)                     */
  /* ------------------------------------------------------------------ */
  let snapSource = null;   // the PSM_SNAPSHOT.pota object we indexed
  let snapParks = null;    // Park[]

  function snapshotParks() {
    const snap = global.PSM_SNAPSHOT;
    const src = snap && snap.pota;
    if (!src || !Array.isArray(src.rows) || !src.rows.length) {
      snapSource = null; snapParks = null;
      return null;
    }
    if (snapSource === src && snapParks) return snapParks;
    const columns = Array.isArray(src.columns) && src.columns.length ? src.columns : SNAPSHOT_COLUMNS;
    const out = [];
    for (let i = 0; i < src.rows.length; i++) {
      const p = toPark(src.rows[i], columns);
      if (p && p.lat != null && p.lon != null) out.push(p);
    }
    snapSource = src;
    snapParks = out;
    PSM.log('POTA snapshot: ' + out.length + ' parks indexed');
    return snapParks;
  }

  /* ------------------------------------------------------------------ */
  /* endpoint wrappers                                                   */
  /* ------------------------------------------------------------------ */
  function stateList(code, signal) {
    return PSM.memo('pota:loc:' + code, STATE_TTL, function () {
      return PSM.fetchJSON(BASE + '/location/parks/' + encodeURIComponent(code), { signal: signal, timeoutMs: 25000 });
    });
  }

  function gridList(cell, signal) {
    return PSM.memo('pota:grid:' + cell, GRID_TTL, function () {
      return PSM.fetchJSON(BASE + '/park/grid/' + encodeURIComponent(cell), { signal: signal });
    });
  }

  /**
   * GET /park/{ref}.  Unknown references answer 200 with a body of `null` — we
   * pass that through as null and (thanks to PSM.memo) never cache it.
   */
  async function getPark(ref) {
    const r = PSM.normalizePotaRef(ref) || str(ref);
    if (!r) return null;
    try {
      const d = await PSM.memo('pota:park:' + r, PARK_TTL, function () {
        return PSM.fetchJSON(BASE + '/park/' + encodeURIComponent(r));
      });
      return d || null;
    } catch (e) {
      if (e && e.status === 404) return null;
      throw e;
    }
  }

  async function getStats(ref) {
    const r = PSM.normalizePotaRef(ref) || str(ref);
    if (!r) return null;
    try {
      const d = await PSM.memo('pota:stats:' + r, STATS_TTL, function () {
        return PSM.fetchJSON(BASE + '/park/stats/' + encodeURIComponent(r));
      });
      return d || null;
    } catch (e) {
      if (e && (e.status === 404 || e.status === 403)) return null;
      PSM.log('POTA stats for ' + r + ' failed: ' + errText(e), 'warn');
      return null;
    }
  }

  async function getActivations(ref, count) {
    const r = PSM.normalizePotaRef(ref) || str(ref);
    if (!r) return [];
    const n = count == null ? 10 : count; // "all" is also accepted by the API
    try {
      const d = await PSM.memo('pota:acts:' + r + ':' + n, STATS_TTL, function () {
        return PSM.fetchJSON(BASE + '/park/activations/' + encodeURIComponent(r) + '?count=' + encodeURIComponent(n));
      });
      return Array.isArray(d) ? d : [];
    } catch (e) {
      PSM.log('POTA activations for ' + r + ' failed: ' + errText(e), 'warn');
      return [];
    }
  }

  async function getLeaderboard(ref, count) {
    const r = PSM.normalizePotaRef(ref) || str(ref);
    if (!r) return null;
    const n = count == null ? 5 : count;
    try {
      const d = await PSM.memo('pota:leader:' + r + ':' + n, PARK_TTL, function () {
        return PSM.fetchJSON(BASE + '/park/leaderboard/' + encodeURIComponent(r) + '?count=' + encodeURIComponent(n));
      });
      return d || null;
    } catch (e) {
      PSM.log('POTA leaderboard for ' + r + ' failed: ' + errText(e), 'warn');
      return null;
    }
  }

  async function lookup(text) {
    const q = str(text);
    if (!q) return [];
    try {
      const d = await PSM.memo('pota:lookup:' + q.toLowerCase(), LOOKUP_TTL, function () {
        return PSM.fetchJSON(BASE + '/lookup?search=' + encodeURIComponent(q));
      });
      return Array.isArray(d) ? d : [];
    } catch (e) {
      PSM.log('POTA lookup "' + q + '" failed: ' + errText(e), 'warn');
      return [];
    }
  }

  /* ------------------------------------------------------------------ */
  /* loadNear                                                            */
  /* ------------------------------------------------------------------ */
  /** Fetch the state/province lists for `codes`; failures are warnings, not errors. */
  async function loadStateLists(codes, ctx) {
    const limit = PSM.pLimit(CONCURRENCY);
    const okCodes = [];
    const rows = [];
    let done = 0;
    await Promise.all(codes.map(function (code) {
      return limit(async function () {
        checkAbort(ctx.signal);
        ctx.onProgress('Loading POTA parks (' + code + ')…', codes.length ? done / codes.length : 0);
        try {
          const list = await stateList(code, ctx.signal);
          if (!Array.isArray(list)) throw new Error('empty response');
          okCodes.push(code);
          for (let i = 0; i < list.length; i++) rows.push(list[i]);
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
          ctx.warnings.push('state list ' + code + ' unavailable');
          PSM.log('POTA: /location/parks/' + code + ' failed (' + errText(e) + ')', 'warn');
        } finally {
          done++;
          ctx.onProgress('Loading POTA parks (' + code + ')…', codes.length ? done / codes.length : 1);
        }
      });
    }));
    return { okCodes: okCodes, rows: rows };
  }

  /** Fetch /park/grid for every 4-character cell touching the bbox. */
  async function loadGridCells(cells, ctx) {
    const limit = PSM.pLimit(CONCURRENCY);
    const okCells = [];
    const rows = [];
    let done = 0;
    await Promise.all(cells.map(function (cell) {
      return limit(async function () {
        checkAbort(ctx.signal);
        try {
          const list = await gridList(cell, ctx.signal);
          if (!Array.isArray(list)) throw new Error('empty response');
          okCells.push(cell);
          for (let i = 0; i < list.length; i++) rows.push(list[i]);
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
          ctx.warnings.push('grid square ' + cell + ' unavailable');
          PSM.log('POTA: /park/grid/' + cell + ' failed (' + errText(e) + ')', 'warn');
        } finally {
          done++;
          ctx.onProgress('Loading POTA parks (grid ' + cell + ')…', cells.length ? done / cells.length : 1);
        }
      });
    }));
    return { okCells: okCells, rows: rows };
  }

  /**
   * Best effort: pull the state lists covering these parks and merge in the
   * activation statistics (and grid/loc) the snapshot and grid endpoints lack.
   */
  async function enrichFromStateLists(parks, bbox, ctx) {
    if (!parks.length) return;
    try {
      const codes = {};
      parks.forEach(function (p) {
        if (!p.loc) return;
        String(p.loc).split(',').forEach(function (c) {
          const code = str(c);
          if (code) codes[code] = true;
        });
      });
      let list = Object.keys(codes);
      if (!list.length) list = PSM.locationsForBbox(bbox);
      if (list.length > MAX_ENRICH_CODES) {
        PSM.log('POTA: limiting stats enrichment to ' + MAX_ENRICH_CODES + ' of ' + list.length + ' locations');
        list = list.slice(0, MAX_ENRICH_CODES);
      }
      if (!list.length) return;

      const limit = PSM.pLimit(CONCURRENCY);
      const byRef = {};
      await Promise.all(list.map(function (code) {
        return limit(async function () {
          if (ctx.signal && ctx.signal.aborted) return;
          try {
            const rows = await stateList(code, ctx.signal);
            if (!Array.isArray(rows)) return;
            rows.forEach(function (r) {
              const p = toPark(r);
              if (p) byRef[p.ref] = p;
            });
          } catch (e) {
            ctx.warnings.push('state list ' + code + ' unavailable');
            PSM.log('POTA: stats enrichment from ' + code + ' failed (' + errText(e) + ')', 'warn');
          }
        });
      }));

      let filled = 0;
      parks.forEach(function (p) {
        const r = byRef[p.ref];
        if (!r) return;
        if (p.attempts == null && r.attempts != null) { p.attempts = r.attempts; filled++; }
        if (p.activations == null && r.activations != null) p.activations = r.activations;
        if (p.qsos == null && r.qsos != null) p.qsos = r.qsos;
        if (!p.grid && r.grid) p.grid = r.grid;
        if (!p.loc && r.loc) p.loc = r.loc;
        if (!p.name && r.name) p.name = r.name;
      });
      if (filled) PSM.log('POTA: enriched ' + filled + ' parks with activation stats');
    } catch (e) {
      // Enrichment is a bonus; a failure here must never break a search.
      PSM.log('POTA: stats enrichment skipped (' + errText(e) + ')', 'warn');
    }
  }

  /**
   * Parks within `radiusKm` of a centre, with distKm set, sorted, de-duplicated.
   * @returns {Promise<{parks:Park[], source:"snapshot"|"state"|"grid", sources:string[], warnings:string[], bbox}>}
   */
  async function loadNear(center, radiusKm, opts) {
    opts = opts || {};
    const ctx = {
      onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : noop,
      signal: opts.signal,
      warnings: []
    };
    const lat = Number(center && center.lat);
    const lon = Number(center && center.lon);
    const radius = Number(radiusKm) > 0 ? Number(radiusKm) : 0;
    if (!isFinite(lat) || !isFinite(lon)) throw new Error('pota.loadNear(): bad centre');

    const bbox = PSM.bboxAround(lat, lon, radius);
    const sources = [];
    let source = null;
    let rows = null;      // raw rows from whichever endpoint answered

    checkAbort(ctx.signal);

    /* --- 1. snapshot ---------------------------------------------- */
    const snap = snapshotParks();
    if (snap) {
      ctx.onProgress('Reading POTA snapshot…', 0.2);
      const hits = snap.filter(function (p) { return PSM.pointInBbox(p.lat, p.lon, bbox); });
      // A snapshot may cover only some programmes (build_snapshot.py --programs),
      // so an empty answer means "not in this snapshot", not "no parks here".
      if (hits.length) {
        rows = hits;
        source = 'snapshot';
        sources.push('snapshot');
      } else {
        PSM.log('POTA: snapshot has no parks in this area, asking the API');
      }
    }

    /* --- 2. state / province lists -------------------------------- */
    if (!rows) {
      const codes = PSM.locationsForBbox(bbox);
      if (codes.length) {
        const res = await loadStateLists(codes, ctx);
        if (res.okCodes.length) {
          rows = res.rows;
          source = 'state';
          res.okCodes.forEach(function (c) { sources.push('/location/parks/' + c); });
        }
      } else {
        ctx.warnings.push('no POTA location list covers this area');
      }
    }

    /* --- 3. Maidenhead grid cells --------------------------------- */
    if (!rows) {
      PSM.log('POTA: falling back to /park/grid', 'warn');
      const cells = PSM.grid4CellsForBbox(bbox);
      const res = await loadGridCells(cells, ctx);
      rows = res.rows;
      source = 'grid';
      res.okCells.forEach(function (c) { sources.push('/park/grid/' + c); });
      if (!res.okCells.length) ctx.warnings.push('POTA park lists are unreachable');
    }

    /* --- normalise, filter to the circle, de-duplicate ------------- */
    const byRef = {};
    const parks = [];
    for (let i = 0; i < rows.length; i++) {
      const p = toPark(rows[i]);
      if (!p || p.lat == null || p.lon == null) continue;
      const d = PSM.haversineKm(lat, lon, p.lat, p.lon);
      if (d > radius) continue;
      const prev = byRef[p.ref];
      if (prev) {
        // Same park from two sources (grid cells overlap, multi-state parks):
        // keep the richer record.
        ['name', 'grid', 'loc', 'active', 'attempts', 'activations', 'qsos'].forEach(function (k) {
          if (prev[k] == null && p[k] != null) prev[k] = p[k];
        });
        continue;
      }
      p.distKm = d;
      byRef[p.ref] = p;
      parks.push(p);
    }

    /* --- stats enrichment for snapshot / grid bases ---------------- */
    if (source !== 'state') {
      ctx.onProgress('Loading POTA activation stats…', 0.9);
      await enrichFromStateLists(parks, bbox, ctx);
    }

    parks.sort(function (a, b) { return a.distKm - b.distKm; });
    ctx.onProgress('POTA: ' + parks.length + ' parks', 1);
    PSM.log('POTA: ' + parks.length + ' parks within ' + Math.round(radius) + ' km (source: ' + source + ')');

    // The same location can fail twice (list + enrichment) — say it once.
    const warnings = ctx.warnings.filter(function (w, i) { return ctx.warnings.indexOf(w) === i; });
    return { parks: parks, source: source, sources: sources, warnings: warnings, bbox: bbox };
  }

  /* ------------------------------------------------------------------ */
  /* searchAll — name search across the whole programme                  */
  /* ------------------------------------------------------------------ */
  /**
   * Used by the n-fer trail matching: find parks by name anywhere, not just
   * near the search centre.  Snapshot when we have one, /lookup otherwise.
   */
  async function searchAll(name) {
    const q = str(name);
    if (!q) return [];
    const needle = q.toLowerCase();

    const snap = snapshotParks();
    if (snap) {
      const hits = [];
      for (let i = 0; i < snap.length; i++) {
        const p = snap[i];
        if (!p.name) continue;
        const lower = p.name.toLowerCase();
        const sub = lower.indexOf(needle) >= 0;
        const sim = PSM.nameSimilarity(q, p.name);
        if (!sub && sim < 0.6) continue;
        hits.push({ park: p, score: (sub ? 1 : 0) + sim });
      }
      hits.sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        return (a.park.name || '').length - (b.park.name || '').length;
      });
      return hits.slice(0, 10).map(function (h) { return Object.assign({}, h.park); });
    }

    const results = await lookup(q);
    const refs = [];
    results.forEach(function (r) {
      if (!r) return;
      if (r.type && String(r.type).toLowerCase() !== 'park') return;
      const ref = PSM.normalizePotaRef(r.value || r.display || '');
      if (ref && refs.indexOf(ref) < 0) refs.push(ref);
    });
    const top = refs.slice(0, 5);
    const limit = PSM.pLimit(CONCURRENCY);
    const parks = await Promise.all(top.map(function (ref) {
      return limit(async function () {
        try {
          const d = await getPark(ref);
          return d ? toPark(d) : null;
        } catch (e) {
          PSM.log('POTA searchAll: ' + ref + ' failed (' + errText(e) + ')', 'warn');
          return null;
        }
      });
    }));
    return parks.filter(Boolean);
  }

  /* ------------------------------------------------------------------ */
  PSM.pota = {
    BASE: BASE,
    loadNear: loadNear,
    getPark: getPark,
    getStats: getStats,
    getActivations: getActivations,
    getLeaderboard: getLeaderboard,
    lookup: lookup,
    searchAll: searchAll,
    toPark: toPark,
    parkUrl: parkUrl,
    displayName: displayName,
    SNAPSHOT_COLUMNS: SNAPSHOT_COLUMNS,
    // exported for tests
    _snapshotParks: snapshotParks,
    _withParkType: withParkType,
    TTL: { STATE: STATE_TTL, GRID: GRID_TTL, PARK: PARK_TTL, STATS: STATS_TTL, LOOKUP: LOOKUP_TTL }
  };

})(typeof window !== 'undefined' ? window : globalThis);
