/* =====================================================================
 * 50-spots.js — PSM.spots: live POTA + SOTA activator spots
 *
 *   PSM.spots.fetchAll()                       -> {pota:[Spot], sota:[Spot], fetchedAt, warnings}
 *   PSM.spots.start(intervalMs, onUpdate)      poll now, then every intervalMs
 *   PSM.spots.stop()
 *   PSM.spots.toPotaSpot(row) / toSotaSpot(row)   normalisers (exported for tests)
 *
 * Spot = {program:"pota"|"sota", ref, name, activator, freqKHz, mode, timeISO,
 *         spotter, comments, lat, lon, loc, id, source, raw}
 *
 * Feed quirks:
 *   * POTA frequencies are kHz strings ("14285", "10119.9"); SOTA frequencies are
 *     MHz strings ("14.062") — both become kHz numbers.
 *   * SOTA spots carry no coordinates (lat/lon null) and their summitCode may
 *     arrive without the association prefix ("GC-001") — associationCode is
 *     prepended when that happens.
 *   * Both feeds timestamp in UTC without a zone marker; we append "Z".
 * Each feed is cached 60 s, and fetchAll() never rejects: a dead feed yields an
 * empty list plus a warning so the other programme still shows up.
 * ===================================================================== */
(function (global) {
  'use strict';

  const PSM = global.PSM || (global.PSM = {});

  const POTA_URL = 'https://api.pota.app/spot/activator';
  const SOTA_URL = 'https://api2.sota.org.uk/api/spots/1/all';
  const FEED_TTL = 60 * 1000;       // 60 s
  const MIN_INTERVAL_MS = 60000;    // etiquette floor: never poll either feed faster than 60 s
  const DEFAULT_INTERVAL_MS = 60000;

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
  function errText(e) { return (e && e.message) || String(e); }

  /** "14285" / "10119.9" (kHz) -> 14285 / 10119.9 */
  function khzFromKhz(v) {
    const n = num(v);
    if (n == null) return null;
    return Math.round(n * 10) / 10;
  }
  /** "14.062" / "14.062 CW" (MHz) -> 14062 */
  function khzFromMhz(v) {
    const s = str(v);
    if (s == null) return null;
    const m = /-?\d+(\.\d+)?/.exec(s);
    if (!m) return null;
    const mhz = parseFloat(m[0]);
    if (!isFinite(mhz)) return null;
    return Math.round(mhz * 1e6) / 1e3;
  }
  /** "2026-08-31T14:00:00" (UTC, no marker) -> "2026-08-31T14:00:00Z" */
  function toISO(v) {
    const s = str(v);
    if (!s) return null;
    if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) return s;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s + 'Z';
    const d = new Date(s);
    return isNaN(d) ? s : d.toISOString();
  }

  /* ------------------------------------------------------------------ */
  /* normalisers                                                         */
  /* ------------------------------------------------------------------ */
  /** GET https://api.pota.app/spot/activator row -> Spot */
  function toPotaSpot(row) {
    if (!row || typeof row !== 'object') return null;
    const ref = PSM.normalizePotaRef(row.reference) || str(row.reference);
    if (!ref) return null;
    return {
      program: 'pota',
      id: row.spotId != null ? String(row.spotId) : null,
      ref: ref,
      name: str(row.name) || str(row.parkName),
      activator: str(row.activator) || str(row.activatorCallsign),
      freqKHz: khzFromKhz(row.frequency),
      mode: str(row.mode),
      timeISO: toISO(row.spotTime),
      spotter: str(row.spotter),
      comments: str(row.comments),
      lat: num(row.latitude),
      lon: num(row.longitude),
      loc: str(row.locationDesc),
      source: str(row.source),
      expire: num(row.expire),
      raw: row
    };
  }

  /** GET https://api2.sota.org.uk/api/spots/1/all row -> Spot */
  function toSotaSpot(row) {
    if (!row || typeof row !== 'object') return null;
    let code = str(row.summitCode);
    const assoc = str(row.associationCode);
    if (code && code.indexOf('/') < 0 && assoc) code = assoc + '/' + code;
    code = code ? code.toUpperCase() : null;
    if (!code) return null;
    // summitDetails is a human string: "Slide Mountain, 1274m, 10 pts"
    const details = str(row.summitDetails);
    const name = details ? str(details.split(',')[0]) : null;
    return {
      program: 'sota',
      id: row.id != null ? String(row.id) : null,
      ref: code,
      name: name,
      activator: str(row.activatorCallsign) || str(row.activatorCall) || str(row.activator),
      freqKHz: khzFromMhz(row.frequency),
      mode: str(row.mode) ? String(row.mode).trim().toUpperCase() : null,
      timeISO: toISO(row.timeStamp || row.timestamp),
      spotter: str(row.callsign) || str(row.spotter),
      comments: str(row.comments),
      lat: null,
      lon: null,
      loc: assoc,
      source: str(row.source),
      raw: row
    };
  }

  /* ------------------------------------------------------------------ */
  /* feeds                                                               */
  /* ------------------------------------------------------------------ */
  async function fetchPota(signal) {
    const rows = await PSM.memo('spots:pota', FEED_TTL, function () {
      return PSM.fetchJSON(POTA_URL, { timeoutMs: 15000, retries: 0, signal: signal });
    });
    if (!Array.isArray(rows)) return [];
    return rows
      .filter(function (r) { return r && !r.invalid; })
      .map(toPotaSpot)
      .filter(Boolean);
  }

  async function fetchSota(signal) {
    const rows = await PSM.memo('spots:sota', FEED_TTL, function () {
      return PSM.fetchJSON(SOTA_URL, { timeoutMs: 15000, retries: 0, signal: signal });
    });
    if (!Array.isArray(rows)) return [];
    return rows.map(toSotaSpot).filter(Boolean);
  }

  /**
   * Both feeds at once.  Never rejects — a failed feed comes back as [] with a
   * warning, so one programme being down never hides the other.
   */
  async function fetchAll(opts) {
    opts = opts || {};
    const warnings = [];
    const results = await Promise.all([
      fetchPota(opts.signal).catch(function (e) {
        warnings.push('POTA spots unavailable: ' + errText(e));
        PSM.log('POTA spots failed: ' + errText(e), 'warn');
        return [];
      }),
      fetchSota(opts.signal).catch(function (e) {
        warnings.push('SOTA spots unavailable: ' + errText(e));
        PSM.log('SOTA spots failed: ' + errText(e), 'warn');
        return [];
      })
    ]);
    return {
      pota: results[0],
      sota: results[1],
      fetchedAt: new Date().toISOString(),
      warnings: warnings
    };
  }

  /* ------------------------------------------------------------------ */
  /* polling                                                             */
  /* ------------------------------------------------------------------ */
  let timer = null;
  let runId = 0;   // bumped by every start()/stop(); in-flight ticks of an old run are discarded

  /** Poll immediately, then every intervalMs, until stop(). */
  function start(intervalMs, onUpdate) {
    stop();
    const ms = Math.max(MIN_INTERVAL_MS, Number(intervalMs) || DEFAULT_INTERVAL_MS);
    const myRun = ++runId;
    const tick = async function () {
      const res = await fetchAll();
      // stop() (or a restart) while this request was in flight — the caller has already
      // torn the layer down, so delivering the result now would silently re-enable it.
      if (myRun !== runId) return;
      if (typeof onUpdate === 'function') {
        try { onUpdate(res); } catch (e) { PSM.log('spots onUpdate threw: ' + errText(e), 'error'); }
      }
    };
    timer = setInterval(tick, ms);
    const first = tick();
    return first;
  }

  function stop() {
    runId++;
    if (timer) { clearInterval(timer); timer = null; }
  }

  function isRunning() { return !!timer; }

  /* ------------------------------------------------------------------ */
  PSM.spots = {
    POTA_URL: POTA_URL,
    SOTA_URL: SOTA_URL,
    FEED_TTL: FEED_TTL,
    fetchAll: fetchAll,
    start: start,
    stop: stop,
    isRunning: isRunning,
    toPotaSpot: toPotaSpot,
    toSotaSpot: toSotaSpot,
    // exported for tests
    _khzFromKhz: khzFromKhz,
    _khzFromMhz: khzFromMhz,
    _toISO: toISO
  };

})(typeof window !== 'undefined' ? window : globalThis);
