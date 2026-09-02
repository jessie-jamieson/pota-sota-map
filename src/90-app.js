/* =====================================================================
 * 90-app.js — PSM.app: state, control wiring, URL hash, search flow.
 *
 * Loaded last. Owns the application state and orchestrates the data modules
 * (PSM.geocode / PSM.pota / PSM.sota / PSM.nfer / PSM.spots), the map
 * (PSM.mapui) and the sidebar (PSM.panel). Every failure ends up on the
 * status line and in the log — never as an unhandled rejection.
 * ===================================================================== */
(function (global) {
  'use strict';

  var PSM = global.PSM || (global.PSM = {});
  var KM_PER_MI = PSM.KM_PER_MI || 1.609344;
  var IDLE_VIEW = { lat: 39.5, lon: -98.35, zoom: 4 };
  var NFER_MAX_KM = 40;
  var GEO_TIMEOUT_MS = 8000;

  /* ---------------------------------------------------------------- */
  /* State                                                             */
  /* ---------------------------------------------------------------- */
  var state = {
    center: null,
    radiusKm: (PSM.settings && PSM.settings.radiusKm) || 25 * KM_PER_MI,
    parks: [],
    summits: [],
    nfer: null,
    spots: null,
    filters: { potaUnactivated: false, sotaMinPoints: 0, mine: 'all' },
    sources: { pota: null, sota: null }
  };

  var els = {};
  var inflight = null;         // AbortController of the running search
  var nferCtrl = null;         // AbortController of the running n-fer analysis
  var searchCount = 0;         // bumped by every searchAt(), used to drop stale work
  var nferRunning = false;
  var spotsTimerOn = false;
  var lastHashWritten = null;
  var radiusTimer = null;
  var progress = { pota: '', sota: '' };

  var resolveReady;
  var readyPromise = new Promise(function (res) { resolveReady = res; });

  function $(id) { return document.getElementById(id); }
  function log(m, l) { if (PSM.log) PSM.log(m, l); }
  function panel() { return PSM.panel; }
  function mapui() { return PSM.mapui; }
  function units() { return (PSM.settings && PSM.settings.units) || 'mi'; }

  function status(text, level) {
    if (PSM.panel && PSM.panel.setStatus) PSM.panel.setStatus(text, level);
    else if (els.status) els.status.textContent = text;
  }

  function settle(p) {
    return Promise.resolve(p).then(
      function (v) { return { ok: true, value: v }; },
      function (e) { return { ok: false, error: e }; }
    );
  }

  /* ---------------------------------------------------------------- */
  /* Units + radius                                                    */
  /* ---------------------------------------------------------------- */
  function radiusDisplay() {
    var v = units() === 'mi' ? state.radiusKm / KM_PER_MI : state.radiusKm;
    return Math.min(100, Math.max(1, Math.round(v)));
  }

  /**
   * Keep state.radiusKm inside the slider's own 1..100 range (in the current units) so the
   * control and the search can never disagree — e.g. "#41.2,-74.1,500" from a shared URL.
   */
  function clampRadiusKm(km) {
    var v = Number(km);
    if (!isFinite(v) || v <= 0) return state.radiusKm;
    var inUnits = units() === 'mi' ? v / KM_PER_MI : v;
    inUnits = Math.min(100, Math.max(1, inUnits));
    return units() === 'mi' ? inUnits * KM_PER_MI : inUnits;
  }

  function radiusLabel() {
    return radiusDisplay() + ' ' + units();
  }

  function syncRadiusUi() {
    if (els.radiusRange) els.radiusRange.value = String(radiusDisplay());
    if (els.radiusValue) els.radiusValue.textContent = radiusLabel();
    if (els.unitsToggle) {
      els.unitsToggle.textContent = units();
      els.unitsToggle.setAttribute('aria-pressed', units() === 'km' ? 'true' : 'false');
      els.unitsToggle.setAttribute('aria-label',
        'Distance units: ' + (units() === 'mi' ? 'miles. Switch to kilometres.' : 'kilometres. Switch to miles.'));
    }
  }

  function setRadiusFromSlider(rerun) {
    var v = Math.min(100, Math.max(1, parseFloat(els.radiusRange && els.radiusRange.value) || 25));
    state.radiusKm = units() === 'mi' ? v * KM_PER_MI : v;
    PSM.saveSettings({ radiusKm: state.radiusKm });
    syncRadiusUi();
    if (state.center && mapui()) mapui().setCenter(state.center, state.radiusKm, { fit: false });
    if (rerun) debouncedRerun();
  }

  function debouncedRerun() {
    if (radiusTimer) clearTimeout(radiusTimer);
    radiusTimer = setTimeout(function () {
      radiusTimer = null;
      if (state.center) searchAt(state.center, { keepLabel: true });
    }, 400);
  }

  function toggleUnits() {
    var next = units() === 'mi' ? 'km' : 'mi';
    PSM.saveSettings({ units: next });
    // The slider is expressed in the current units, so snap the radius to it.
    var snapped = Math.min(100, Math.max(1, Math.round(next === 'mi' ? state.radiusKm / KM_PER_MI : state.radiusKm)));
    state.radiusKm = next === 'mi' ? snapped * KM_PER_MI : snapped;
    PSM.saveSettings({ radiusKm: state.radiusKm });
    syncRadiusUi();
    renderAll();
    if (state.center && mapui()) mapui().setCenter(state.center, state.radiusKm, { fit: false });
    if (state.center) debouncedRerun();
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */
  function parkFilter() { return { unactivatedOnly: !!state.filters.potaUnactivated, mine: state.filters.mine }; }
  function summitFilter() { return { minPoints: Number(state.filters.sotaMinPoints) || 0, mine: state.filters.mine }; }

  function renderAll() {
    if (panel()) panel().renderLists(state);
    var m = mapui();
    if (!m || !m.getMap || !m.getMap()) return;
    m.renderParks(state.parks, { filter: parkFilter() });
    m.renderSummits(state.summits, { filter: summitFilter() });
    if (state.nfer) m.renderZones(state.nfer);
    if (state.spots) m.renderSpots(state.spots, { parks: state.parks, summits: state.summits });
  }

  /* ---------------------------------------------------------------- */
  /* URL hash                                                          */
  /* ---------------------------------------------------------------- */
  function parseHash() {
    var h = String(global.location && global.location.hash || '').replace(/^#/, '');
    if (!h) return null;
    var m = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?))?$/.exec(decodeURIComponent(h));
    if (!m) return null;
    var lat = parseFloat(m[1]), lon = parseFloat(m[2]);
    if (isNaN(lat) || isNaN(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat: lat, lon: lon, radiusKm: m[3] ? parseFloat(m[3]) : null };
  }

  function updateHash() {
    if (!state.center) return;
    var h = '#' + state.center.lat.toFixed(5) + ',' + state.center.lon.toFixed(5) + ',' + (Math.round(state.radiusKm * 10) / 10);
    lastHashWritten = h;
    try {
      if (global.history && global.history.replaceState) global.history.replaceState(null, '', h);
      else global.location.hash = h;
    } catch (e) {
      try { global.location.hash = h; } catch (e2) { /* file:// with a strict browser */ }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Search                                                            */
  /* ---------------------------------------------------------------- */
  function centerLabel(c) {
    return c.label || PSM.fmt.latlon(c.lat, c.lon, 4);
  }

  function showProgress() {
    var bits = [];
    if (progress.pota) bits.push('POTA: ' + progress.pota);
    if (progress.sota) bits.push('SOTA: ' + progress.sota);
    if (bits.length) status(bits.join(' · '));
  }

  function withDistance(list, center, key) {
    return (list || []).map(function (o) {
      if (o && (o.distKm == null || isNaN(o.distKm)) && o.lat != null) {
        o.distKm = PSM.haversineKm(center.lat, center.lon, o.lat, o.lon);
      }
      return o;
    }).sort(function (a, b) { return (a.distKm == null ? 1e9 : a.distKm) - (b.distKm == null ? 1e9 : b.distKm); });
  }

  /** "…/location/parks/US-NY" → "US-NY"; keeps the log line readable. */
  function sourceDetail(sources) {
    if (!sources || !sources.length) return '';
    var names = sources.map(function (s) {
      return String(s).replace(/^.*\//, '') || String(s);
    });
    var shown = names.slice(0, 8).join(', ');
    if (names.length > 8) shown += ' +' + (names.length - 8) + ' more';
    return ' (' + shown + ')';
  }

  var SOURCE_LABEL = {
    snapshot: 'the offline snapshot', state: 'state lists', grid: 'grid cells',
    api: 'api', csv: 'the summits CSV', none: 'no source'
  };

  function search(text) {
    text = String(text == null ? '' : text).trim();
    if (!text) { status('Type an address, coordinates, a grid square or a reference.'); return Promise.resolve(); }
    if (!PSM.geocode || !PSM.geocode.resolve) {
      status('The geocoding module is not loaded.', 'error');
      return Promise.resolve();
    }
    var cls = PSM.geocode.classify ? PSM.geocode.classify(text) : { kind: 'text' };
    status('Looking up “' + text + '”…');
    var near = state.center ? { lat: state.center.lat, lon: state.center.lon } : null;
    return Promise.resolve()
      .then(function () { return PSM.geocode.resolve(text, { near: near }); })
      .then(function (center) {
        if (!center || center.lat == null) throw new Error('No results for “' + text + '”');
        return searchAt(center).then(function () {
          if (cls.kind === 'pota') {
            return openPark(center.ref || (PSM.normalizePotaRef && PSM.normalizePotaRef(text)) || text);
          }
          if (cls.kind === 'sota') {
            return openSummit(center.code || (PSM.normalizeSotaRef && PSM.normalizeSotaRef(text)) || text);
          }
        });
      })
      .catch(function (err) {
        var msg = (err && err.message) || String(err);
        status(msg, 'error');
        log('search failed: ' + msg, 'error');
      });
  }

  function searchAt(center, opts) {
    opts = opts || {};
    if (!center || center.lat == null || center.lon == null) return Promise.resolve();
    var myCount = ++searchCount;
    if (inflight) { try { inflight.abort(); } catch (e) { /* ignore */ } }
    // An n-fer run belongs to the search that started it; a new search invalidates its area.
    if (nferCtrl) { try { nferCtrl.abort(); } catch (e) { /* ignore */ } nferCtrl = null; }
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : { abort: function () { }, signal: null };
    inflight = ctrl;

    if (opts.radiusKm) {
      state.radiusKm = clampRadiusKm(opts.radiusKm);
      PSM.saveSettings({ radiusKm: state.radiusKm });
      syncRadiusUi();
    }

    state.center = {
      lat: Number(center.lat), lon: Number(center.lon),
      label: center.label || PSM.fmt.latlon(center.lat, center.lon, 4),
      source: center.source || 'latlon'
    };
    state.nfer = null;
    state.parks = [];
    state.summits = [];
    progress = { pota: 'starting…', sota: 'starting…' };

    PSM.saveSettings({ lastSearch: { lat: state.center.lat, lon: state.center.lon, label: state.center.label, source: state.center.source } });
    updateHash();

    // A new area invalidates the highlighted park boundary too (and any lookup
    // still in flight for it) — m.clear() drops the layer, the panel the fetch.
    if (panel() && panel().clearBoundary) panel().clearBoundary();
    var m = mapui();
    if (m && m.getMap && m.getMap()) {
      m.clear();
      m.setCenter(state.center, state.radiusKm, { fit: true });
    }
    if (panel()) panel().renderLists(state);
    status('Searching within ' + radiusLabel() + ' of ' + centerLabel(state.center) + '…');
    log('Search: ' + centerLabel(state.center) + ' (' + PSM.fmt.latlon(state.center.lat, state.center.lon, 4) + ') radius ' + radiusLabel());

    var sig = ctrl.signal;
    var potaP = (PSM.pota && PSM.pota.loadNear)
      ? PSM.pota.loadNear(state.center, state.radiusKm, {
        signal: sig,
        onProgress: function (msg) { if (myCount === searchCount) { progress.pota = msg; showProgress(); } }
      })
      : Promise.resolve({ parks: [], source: 'none', sources: [], warnings: ['POTA module not loaded'] });

    var sotaP = (PSM.sota && PSM.sota.loadNear)
      ? PSM.sota.loadNear(state.center, state.radiusKm, {
        signal: sig,
        onProgress: function (msg) { if (myCount === searchCount) { progress.sota = msg; showProgress(); } }
      })
      : Promise.resolve({ summits: [], source: 'none', warnings: ['SOTA module not loaded'] });

    return Promise.all([settle(potaP), settle(sotaP)]).then(function (res) {
      if (myCount !== searchCount) return;   // a newer search took over
      var pr = res[0], sr = res[1];
      var errs = [];

      if (pr.ok && pr.value) {
        state.parks = withDistance(pr.value.parks || [], state.center);
        state.sources.pota = pr.value;
      } else {
        state.parks = [];
        errs.push('POTA: ' + ((pr.error && pr.error.message) || 'failed'));
      }
      if (sr.ok && sr.value) {
        state.summits = withDistance(sr.value.summits || [], state.center);
        state.sources.sota = sr.value;
      } else {
        state.summits = [];
        errs.push('SOTA: ' + ((sr.error && sr.error.message) || 'failed'));
      }

      renderAll();
      document.body.classList.add('psm-results');
      scrollToResults();

      var srcBits = [];
      if (pr.ok && pr.value) {
        var pl = SOURCE_LABEL[pr.value.source] || pr.value.source || 'unknown';
        srcBits.push('POTA: ' + state.parks.length + ' parks via ' + pl + sourceDetail(pr.value.sources));
      }
      if (sr.ok && sr.value) {
        srcBits.push('SOTA: ' + state.summits.length + ' summits via ' + (SOURCE_LABEL[sr.value.source] || sr.value.source || 'unknown'));
      }
      if (srcBits.length) log(srcBits.join(' · '));
      [].concat((pr.value && pr.value.warnings) || [], (sr.value && sr.value.warnings) || [])
        .forEach(function (w) { if (w) log(String(w), 'warn'); });

      if (errs.length && !state.parks.length && !state.summits.length) {
        status('Search failed — ' + errs.join(' · '), 'error');
      } else {
        var mineCount = countMineInResults();
        status(state.parks.length + ' park' + (state.parks.length === 1 ? '' : 's') + ' · ' +
          state.summits.length + ' summit' + (state.summits.length === 1 ? '' : 's') +
          ' within ' + radiusLabel() + ' of ' + centerLabel(state.center) +
          (mineCount > 0 ? ' · ' + mineCount + ' activated by you' : '') +
          (errs.length ? ' — ' + errs.join(' · ') : ''));
        if (errs.length) errs.forEach(function (e) { log(e, 'warn'); });
      }
      if (state.spots) refreshSpotsRender();
    }).catch(function (err) {
      if (myCount !== searchCount) return;
      var msg = (err && err.message) || String(err);
      status('Search failed: ' + msg, 'error');
      log('searchAt failed: ' + msg, 'error');
    });
  }

  /* ---------------------------------------------------------------- */
  /* Detail opening                                                    */
  /* ---------------------------------------------------------------- */
  function findPark(ref) {
    for (var i = 0; i < state.parks.length; i++) if (state.parks[i].ref === ref) return state.parks[i];
    return null;
  }
  function findSummit(code) {
    for (var i = 0; i < state.summits.length; i++) if (state.summits[i].code === code) return state.summits[i];
    return null;
  }

  function openPark(ref) {
    ref = (PSM.normalizePotaRef && PSM.normalizePotaRef(ref)) || ref;
    if (!ref) return Promise.resolve();
    var p = findPark(ref);
    var pre = p ? Promise.resolve(p) : (PSM.pota && PSM.pota.getPark
      ? settle(PSM.pota.getPark(ref)).then(function (r) {
        if (!r.ok || !r.value) return null;
        return PSM.pota.toPark ? PSM.pota.toPark(r.value) : {
          ref: ref, name: r.value.name, lat: r.value.latitude, lon: r.value.longitude,
          loc: r.value.locationDesc, grid: r.value.grid6
        };
      })
      : Promise.resolve(null));

    return pre.then(function (park) {
      if (park && park.lat != null && state.center && park.distKm == null) {
        park.distKm = PSM.haversineKm(state.center.lat, state.center.lon, park.lat, park.lon);
      }
      var m = mapui();
      if (m && m.getMap && m.getMap()) m.highlight('park', ref);
      if (panel()) { panel().markSelected('park', ref); return panel().showPark(ref, park || { ref: ref }); }
    });
  }

  function openSummit(code) {
    code = (PSM.normalizeSotaRef && PSM.normalizeSotaRef(code)) || code;
    if (!code) return Promise.resolve();
    var s = findSummit(code);
    var pre = s ? Promise.resolve(s) : (PSM.sota && PSM.sota.getSummit
      ? settle(PSM.sota.getSummit(code)).then(function (r) {
        if (!r.ok || !r.value) return null;
        return PSM.sota.toSummit ? PSM.sota.toSummit(r.value) : {
          code: code, name: r.value.name, lat: r.value.latitude, lon: r.value.longitude,
          altM: r.value.altM, altFt: r.value.altFt, points: r.value.points
        };
      })
      : Promise.resolve(null));

    return pre.then(function (summit) {
      if (summit && summit.lat != null && state.center && summit.distKm == null) {
        summit.distKm = PSM.haversineKm(state.center.lat, state.center.lon, summit.lat, summit.lon);
      }
      var m = mapui();
      if (m && m.getMap && m.getMap()) m.highlight('summit', code);
      if (panel()) { panel().markSelected('summit', code); return panel().showSummit(code, summit || { code: code }); }
    });
  }

  function openZone(id) {
    if (!state.nfer || !state.nfer.zones || !state.nfer.zones.features) return Promise.resolve();
    var f = null;
    state.nfer.zones.features.forEach(function (z) {
      if ((z.properties && z.properties.id) === id) f = z;
    });
    if (!f) return Promise.resolve();
    var m = mapui();
    if (m && m.getMap && m.getMap()) m.highlight('zone', id);
    if (panel()) { panel().markSelected('zone', id); return panel().showZone(f); }
    return Promise.resolve();
  }

  /* ---------------------------------------------------------------- */
  /* n-fer                                                             */
  /* ---------------------------------------------------------------- */
  function nferAvailable() {
    return !!(PSM.nfer && PSM.nfer.analyze && global.turf && global.osmtogeojson);
  }

  function runNfer() {
    if (nferRunning) return Promise.resolve();
    if (!state.center || (!state.parks.length && !state.summits.length)) {
      status('Search for a location first, then look for multi-activation spots.');
      return Promise.resolve();
    }
    if (!nferAvailable()) {
      var missing = [];
      if (!global.turf) missing.push('turf');
      if (!global.osmtogeojson) missing.push('osmtogeojson');
      if (!PSM.nfer || !PSM.nfer.analyze) missing.push('the n-fer module');
      status('Multi-activation analysis is unavailable (' + missing.join(', ') + ' did not load).', 'error');
      log('n-fer unavailable: missing ' + missing.join(', '), 'warn');
      return Promise.resolve();
    }

    nferRunning = true;
    var btn = els.nferBtn;
    var label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.classList.add('busy'); btn.textContent = 'Analysing…'; }

    var radiusKm = Math.min(state.radiusKm, NFER_MAX_KM);
    if (radiusKm < state.radiusKm) {
      log('n-fer: analysis radius capped at ' + NFER_MAX_KM + ' km (25 mi); the search radius is ' +
        Math.round(state.radiusKm) + ' km.', 'warn');
    }
    var bbox = PSM.bboxAround(state.center.lat, state.center.lon, radiusKm);
    var inArea = function (o) { return o.distKm == null || o.distKm <= radiusKm; };
    status('Analysing OSM boundaries… this can take 10–60 s');

    var ctrl = (typeof AbortController === 'function') ? new AbortController() : { abort: function () { }, signal: null };
    nferCtrl = ctrl;
    var myCount = searchCount;

    return settle(PSM.nfer.analyze({
      center: { lat: state.center.lat, lon: state.center.lon },
      radiusKm: radiusKm,
      bbox: bbox,
      parks: state.parks.filter(inArea),
      summits: state.summits.filter(inArea),
      allParksLookup: (PSM.pota && PSM.pota.searchAll) ? PSM.pota.searchAll : null,
      onProgress: function (msg, frac) {
        if (myCount !== searchCount) return;
        status('Multi-activation analysis: ' + msg + (frac != null ? ' (' + Math.round(frac * 100) + '%)' : ''));
      },
      signal: ctrl.signal
    })).then(function (r) {
      if (nferCtrl === ctrl) nferCtrl = null;
      if (btn) { btn.disabled = false; btn.classList.remove('busy'); btn.textContent = label || 'Find multi-activation spots'; }
      nferRunning = false;
      // The search area moved while we were analysing — these zones belong to the old one.
      if (myCount !== searchCount) {
        log('n-fer: result discarded, the search area changed while it was running', 'warn');
        return;
      }
      if (!r.ok) {
        var msg = (r.error && r.error.message) || String(r.error);
        status('Multi-activation analysis failed: ' + msg, 'error');
        log('n-fer failed: ' + msg, 'error');
        return;
      }
      state.nfer = r.value;
      var m = mapui();
      if (m && m.getMap && m.getMap()) m.renderZones(r.value);
      if (panel()) { panel().renderLists(state); panel().selectTab('multi'); }
      var st = r.value.stats || {};
      var zones = (r.value.zones && r.value.zones.features.length) || 0;
      var combos = (r.value.summitCombos && r.value.summitCombos.length) || 0;
      status(zones + ' overlap zone' + (zones === 1 ? '' : 's') + ' · ' + combos + ' summit combo' + (combos === 1 ? '' : 's') +
        ' from ' + (st.matched || 0) + ' matched boundaries' +
        (st.elapsedMs ? ' in ' + (st.elapsedMs / 1000).toFixed(1) + ' s' : '') +
        (radiusKm < state.radiusKm ? ' (analysis capped at ' + NFER_MAX_KM + ' km)' : ''));
      if (st.errors && st.errors.length) st.errors.forEach(function (e) { log('n-fer: ' + e, 'warn'); });
    });
  }

  /* ---------------------------------------------------------------- */
  /* Live spots                                                        */
  /* ---------------------------------------------------------------- */
  function refreshSpotsRender() {
    var m = mapui();
    if (m && m.getMap && m.getMap()) m.renderSpots(state.spots, { parks: state.parks, summits: state.summits });
  }

  function setSpots(on) {
    PSM.saveSettings({ showSpots: !!on });
    var m = mapui();
    if (m) m.setLayerVisible('spots', !!on);
    if (!PSM.spots || !PSM.spots.start) {
      if (on) log('Live spots unavailable: the spots module is not loaded.', 'warn');
      return;
    }
    if (on) {
      if (spotsTimerOn) return;
      spotsTimerOn = true;
      try {
        PSM.spots.start(60000, function (data, err) {
          if (err) { log('spots: ' + ((err && err.message) || err), 'warn'); return; }
          state.spots = data;
          refreshSpotsRender();
          var n = data ? (((data.pota || []).length) + ((data.sota || []).length)) : 0;
          log('Live spots: ' + n + ' active');
        });
      } catch (e) {
        spotsTimerOn = false;
        log('spots: could not start polling — ' + ((e && e.message) || e), 'warn');
      }
    } else {
      spotsTimerOn = false;
      try { PSM.spots.stop(); } catch (e) { /* ignore */ }
      state.spots = null;
      if (m && m.getMap && m.getMap()) m.renderSpots(null, {});
    }
  }

  /* ---------------------------------------------------------------- */
  /* My activations                                                    */
  /* ---------------------------------------------------------------- */
  function countMineInResults() {
    if (!PSM.mylog) return 0;
    var n = 0;
    state.parks.forEach(function (p) { if (PSM.mylog.isActivated('pota', p.ref)) n++; });
    state.summits.forEach(function (s) { if (PSM.mylog.isActivated('sota', s.code)) n++; });
    return n;
  }

  function updateMylogSummary() {
    if (els.mylogSummary && PSM.mylog) els.mylogSummary.textContent = PSM.mylog.summaryText();
  }

  /** Re-renders the currently-open park/summit detail panel from what is already loaded — no
   *  re-fetch needed beyond PSM.pota/PSM.sota's own 24 h cache that openPark/openSummit already go through. */
  function refreshOpenDetail() {
    if (!panel() || !panel().isOpen || !panel().isOpen()) return;
    var cur = panel().current ? panel().current() : {};
    if (cur.kind === 'park') openPark(cur.id).catch(function (e) { log('refresh park detail failed: ' + ((e && e.message) || e), 'warn'); });
    else if (cur.kind === 'summit') openSummit(cur.id).catch(function (e) { log('refresh summit detail failed: ' + ((e && e.message) || e), 'warn'); });
  }

  /** Shared by the file input and the paste box — both just hand text + a filename to the module. */
  function mylogImportText(text, filename) {
    if (!PSM.mylog) { status('The activation-log module is not loaded.', 'error'); return; }
    text = String(text == null ? '' : text);
    if (!text.trim()) { status('Nothing to import — choose a file or paste some text first.'); return; }
    var res = PSM.mylog.importText(text, { filename: filename || undefined });
    status(PSM.mylog.describeImport(res), res.format ? undefined : 'error');
    // #mylog-summary, the lists, the markers and any open detail panel all follow from the
    // PSM.mylog.onChange subscription wired in init() — importText() already fired it.
  }

  function mylogExport() {
    if (!PSM.mylog) return;
    var json = PSM.mylog.exportJSON();
    try {
      var blob = new Blob([json], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'my-activations.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 1000);
    } catch (e) {
      log('my activations: could not build the download — ' + ((e && e.message) || e), 'warn');
    }
    try {
      if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(json).then(function () {
          log('Export copied to your clipboard too.');
        }, function (e) {
          log('my activations: clipboard copy failed — ' + ((e && e.message) || e), 'warn');
        });
      }
    } catch (e) {
      log('my activations: clipboard copy failed — ' + ((e && e.message) || e), 'warn');
    }
  }

  function mylogClear() {
    if (!PSM.mylog) return;
    var ok = true;
    try { ok = global.confirm('Clear all your marked activations? This cannot be undone.'); } catch (e) { ok = true; }
    if (!ok) return;
    PSM.mylog.clear();
  }

  /* ---------------------------------------------------------------- */
  /* Geolocation                                                       */
  /* ---------------------------------------------------------------- */
  function geolocate(timeoutMs) {
    return new Promise(function (resolve) {
      if (!global.navigator || !navigator.geolocation) { resolve(null); return; }
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve(null); } }, timeoutMs + 500);
      try {
        navigator.geolocation.getCurrentPosition(function (pos) {
          if (done) return;
          done = true; clearTimeout(timer);
          resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy });
        }, function (err) {
          if (done) return;
          done = true; clearTimeout(timer);
          log('Geolocation unavailable (' + ((err && err.message) || 'denied') + ') — falling back.', 'warn');
          resolve(null);
        }, { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 600000 });
      } catch (e) { done = true; clearTimeout(timer); resolve(null); }
    });
  }

  function useMyLocation() {
    status('Finding your location…');
    var before = searchCount;
    return geolocate(GEO_TIMEOUT_MS).then(function (pos) {
      if (searchCount !== before) return;
      if (!pos) { status('Could not get your location — check location permission for this page.', 'error'); return; }
      return searchAt({ lat: pos.lat, lon: pos.lon, label: 'My location', source: 'geolocation' });
    });
  }

  function idleView() {
    var m = mapui();
    if (m && m.getMap && m.getMap()) m.getMap().setView([IDLE_VIEW.lat, IDLE_VIEW.lon], IDLE_VIEW.zoom);
    status('Enter an address, coordinates or grid to begin');
  }

  function startup() {
    var hash = parseHash();
    if (hash) {
      log('Opening the location from the URL hash.');
      return searchAt({ lat: hash.lat, lon: hash.lon, label: PSM.fmt.latlon(hash.lat, hash.lon, 4), source: 'latlon' },
        { radiusKm: hash.radiusKm || null });
    }
    status('Checking your location…');
    var before = searchCount;
    return geolocate(GEO_TIMEOUT_MS).then(function (pos) {
      if (searchCount !== before) return;    // the user searched while we waited
      if (pos) return searchAt({ lat: pos.lat, lon: pos.lon, label: 'My location', source: 'geolocation' });
      var last = PSM.settings && PSM.settings.lastSearch;
      if (last && last.lat != null && last.lon != null) {
        log('Restoring the last search: ' + (last.label || PSM.fmt.latlon(last.lat, last.lon, 4)));
        return searchAt({ lat: last.lat, lon: last.lon, label: last.label || 'Last search', source: last.source || 'latlon' });
      }
      idleView();
    });
  }

  /* ---------------------------------------------------------------- */
  /* Layout helpers                                                    */
  /* ---------------------------------------------------------------- */
  function afterLayout() {
    var m = mapui();
    if (!m) return;
    m.invalidateSize();
    setTimeout(function () { m.invalidateSize(); }, 60);
    setTimeout(function () { m.invalidateSize(); }, 260);
  }

  function isNarrow() {
    try { return global.matchMedia && global.matchMedia('(max-width: 800px)').matches; } catch (e) { return false; }
  }

  /* On a phone the sheet is short, so a detail panel temporarily grows it. */
  var sheetBeforeDetail = null;
  function expandSheetForDetail() {
    if (!isNarrow()) return;
    // Opening a second item without closing the first must not capture the expanded height
    // as "what the user had" — otherwise the sheet never shrinks back.
    if (sheetBeforeDetail === null) {
      sheetBeforeDetail = document.documentElement.style.getPropertyValue('--sheet-h') || '';
    }
    document.documentElement.style.setProperty('--sheet-h', '80%');
    document.body.classList.remove('sidebar-collapsed');
    afterLayout();
  }
  function restoreSheetAfterDetail() {
    if (sheetBeforeDetail === null) return;
    if (sheetBeforeDetail) document.documentElement.style.setProperty('--sheet-h', sheetBeforeDetail);
    else document.documentElement.style.removeProperty('--sheet-h');
    sheetBeforeDetail = null;
    afterLayout();
  }

  /** After a search on a phone, bring the result tabs into view. */
  function scrollToResults() {
    if (!isNarrow()) return;
    var scroller = $('sidebar-scroll');
    var tabs = document.querySelector('#sidebar .tabbar') || document.querySelector('#sidebar .tabs');
    if (!scroller || !tabs) return;
    try { scroller.scrollTop = tabs.offsetTop; } catch (e) { /* ignore */ }
  }

  /**
   * The counterpart to scrollToResults(): the sticky tab bar carries a "Search" button so the
   * input is always one tap away, however far down a long result list the user has scrolled.
   */
  function focusSearch() {
    document.body.classList.remove('sidebar-collapsed');
    if (panel() && panel().isOpen()) panel().close();
    var scroller = $('sidebar-scroll');
    if (scroller) { try { scroller.scrollTop = 0; } catch (e) { /* ignore */ } }
    if (!els.searchInput) return;
    try { els.searchInput.focus({ preventScroll: true }); } catch (e) { els.searchInput.focus(); }
    try { els.searchInput.select(); } catch (e) { /* ignore */ }
  }

  function toggleSidebar(force) {
    var collapsed = force == null ? !document.body.classList.contains('sidebar-collapsed') : !!force;
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    if (els.sidebarToggle) {
      els.sidebarToggle.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
      els.sidebarToggle.setAttribute('aria-label', collapsed ? 'Expand panel' : 'Collapse panel');
      els.sidebarToggle.title = collapsed ? 'Expand panel' : 'Collapse panel';
    }
    afterLayout();
  }

  function wireSheet() {
    var grip = els.sheetGrip;
    if (!grip) return;
    var dragging = false;
    var apply = function (clientY) {
      var h = global.innerHeight - clientY;
      var pct = Math.max(18, Math.min(88, (h / global.innerHeight) * 100));
      document.documentElement.style.setProperty('--sheet-h', pct.toFixed(1) + '%');
    };
    grip.addEventListener('pointerdown', function (ev) {
      dragging = true;
      document.body.classList.remove('sidebar-collapsed');
      try { grip.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      ev.preventDefault();
    });
    grip.addEventListener('pointermove', function (ev) {
      if (!dragging) return;
      apply(ev.clientY);
    });
    var end = function () {
      if (!dragging) return;
      dragging = false;
      afterLayout();
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('keydown', function (ev) {
      var cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sheet-h')) || 45;
      if (ev.key === 'ArrowUp') { document.documentElement.style.setProperty('--sheet-h', Math.min(88, cur + 8) + '%'); afterLayout(); ev.preventDefault(); }
      if (ev.key === 'ArrowDown') { document.documentElement.style.setProperty('--sheet-h', Math.max(18, cur - 8) + '%'); afterLayout(); ev.preventDefault(); }
    });
  }

  /* ---------------------------------------------------------------- */
  /* Wiring                                                            */
  /* ---------------------------------------------------------------- */
  function wire() {
    if (els.searchBtn) els.searchBtn.addEventListener('click', function () { search(els.searchInput ? els.searchInput.value : ''); });
    if (els.searchInput) {
      els.searchInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); search(els.searchInput.value); }
      });
    }
    if (els.locateBtn) els.locateBtn.addEventListener('click', function () { useMyLocation(); });

    if (els.radiusRange) {
      els.radiusRange.addEventListener('input', function () { setRadiusFromSlider(false); });
      els.radiusRange.addEventListener('change', function () { setRadiusFromSlider(true); });
    }
    if (els.unitsToggle) els.unitsToggle.addEventListener('click', function () { toggleUnits(); });

    var layerToggle = function (el, kind, settingKey) {
      if (!el) return;
      el.addEventListener('change', function () {
        var on = !!el.checked;
        var patch = {}; patch[settingKey] = on;
        PSM.saveSettings(patch);
        if (kind === 'spots') setSpots(on);
        else if (mapui()) mapui().setLayerVisible(kind, on);
      });
    };
    layerToggle(els.togglePota, 'pota', 'showPota');
    layerToggle(els.toggleSota, 'sota', 'showSota');
    layerToggle(els.toggleSpots, 'spots', 'showSpots');
    layerToggle(els.toggleBoundaries, 'boundaries', 'showBoundaries');

    if (els.basemapSelect) {
      els.basemapSelect.addEventListener('change', function () {
        PSM.saveSettings({ basemap: els.basemapSelect.value });
        if (mapui()) mapui().setBasemap(els.basemapSelect.value);
      });
    }

    if (els.filterUnact) {
      els.filterUnact.addEventListener('change', function () {
        state.filters.potaUnactivated = !!els.filterUnact.checked;
        renderAll();
      });
    }
    if (els.filterPoints) {
      els.filterPoints.addEventListener('change', function () {
        state.filters.sotaMinPoints = Number(els.filterPoints.value) || 0;
        renderAll();
      });
    }
    if (els.filterMine) {
      els.filterMine.addEventListener('change', function () {
        state.filters.mine = els.filterMine.value || 'all';
        renderAll();
      });
    }

    if (els.mylogFile) {
      els.mylogFile.addEventListener('change', function () {
        var f = els.mylogFile.files && els.mylogFile.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () { mylogImportText(String(reader.result == null ? '' : reader.result), f.name); els.mylogFile.value = ''; };
        reader.onerror = function () { status('Could not read that file.', 'error'); els.mylogFile.value = ''; };
        try { reader.readAsText(f); } catch (e) { status('Could not read that file: ' + ((e && e.message) || e), 'error'); }
      });
    }
    if (els.mylogImportBtn) {
      els.mylogImportBtn.addEventListener('click', function () {
        mylogImportText(els.mylogPaste ? els.mylogPaste.value : '', null);
      });
    }
    if (els.mylogExportBtn) els.mylogExportBtn.addEventListener('click', function () { mylogExport(); });
    if (els.mylogClearBtn) els.mylogClearBtn.addEventListener('click', function () { mylogClear(); });

    if (els.nferBtn) els.nferBtn.addEventListener('click', function () { runNfer(); });

    ['parks', 'summits', 'multi'].forEach(function (name) {
      var tab = $('tab-' + name);
      if (tab) tab.addEventListener('click', function () { if (panel()) panel().selectTab(name); });
    });

    if (els.sidebarToggle) els.sidebarToggle.addEventListener('click', function () { toggleSidebar(); });
    if (els.toSearch) els.toSearch.addEventListener('click', function () { focusSearch(); });
    wireSheet();

    document.addEventListener('psm:select', function (ev) {
      var d = (ev && ev.detail) || {};
      var p = d.kind === 'park' ? openPark(d.id)
        : d.kind === 'summit' ? openSummit(d.id)
          : d.kind === 'zone' ? openZone(d.id) : null;
      // A selection is fire-and-forget from here; surface failures on the log, never as an
      // unhandled rejection.
      if (p && p.catch) p.catch(function (e) { log('open ' + d.kind + ' failed: ' + ((e && e.message) || e), 'warn'); });
    });

    document.addEventListener('psm:searchhere', function (ev) {
      var d = (ev && ev.detail) || {};
      if (d.lat == null) return;
      searchAt({ lat: d.lat, lon: d.lon, label: PSM.fmt.latlon(d.lat, d.lon, 4), source: 'latlon' });
    });

    document.addEventListener('psm:detailopen', expandSheetForDetail);
    document.addEventListener('psm:detailclose', restoreSheetAfterDetail);

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        if (panel() && panel().isOpen()) { panel().close(); }
      }
    });

    global.addEventListener('hashchange', function () {
      var h = String(global.location.hash || '');
      if (h === lastHashWritten) return;
      var p = parseHash();
      if (p) searchAt({ lat: p.lat, lon: p.lon, label: PSM.fmt.latlon(p.lat, p.lon, 4), source: 'latlon' },
        { radiusKm: p.radiusKm || null });
    });

    // iOS fires a burst of resize events while the address bar animates; one invalidateSize
    // per burst is enough and keeps the map from thrashing its layout.
    var resizeTimer = null;
    global.addEventListener('resize', function () {
      if (resizeTimer) return;
      resizeTimer = setTimeout(function () {
        resizeTimer = null;
        if (mapui()) mapui().invalidateSize();
      }, 120);
    });

    global.addEventListener('error', function (ev) {
      if (ev && ev.message) log('Uncaught error: ' + ev.message, 'error');
    });
    global.addEventListener('unhandledrejection', function (ev) {
      var r = ev && ev.reason;
      log('Unhandled promise rejection: ' + ((r && r.message) || r), 'error');
    });
  }

  function collectEls() {
    els = {
      searchInput: $('search-input'), searchBtn: $('search-btn'), locateBtn: $('locate-btn'),
      radiusRange: $('radius-range'), radiusValue: $('radius-value'), unitsToggle: $('units-toggle'),
      togglePota: $('toggle-pota'), toggleSota: $('toggle-sota'), toggleSpots: $('toggle-spots'),
      toggleBoundaries: $('toggle-boundaries'), basemapSelect: $('basemap-select'),
      filterUnact: $('filter-pota-unactivated'), filterPoints: $('filter-sota-points'),
      filterMine: $('filter-mine'),
      nferBtn: $('nfer-btn'), status: $('status'), sidebarToggle: $('sidebar-toggle'),
      sheetGrip: $('sheet-grip'), toSearch: $('to-search'),
      mylogSummary: $('mylog-summary'), mylogFile: $('mylog-file'), mylogPaste: $('mylog-paste'),
      mylogImportBtn: $('mylog-import-btn'), mylogExportBtn: $('mylog-export-btn'), mylogClearBtn: $('mylog-clear-btn')
    };
  }

  function syncFromSettings() {
    var s = PSM.settings || {};
    if (els.togglePota) els.togglePota.checked = s.showPota !== false;
    if (els.toggleSota) els.toggleSota.checked = s.showSota !== false;
    if (els.toggleSpots) els.toggleSpots.checked = !!s.showSpots;
    if (els.toggleBoundaries) els.toggleBoundaries.checked = s.showBoundaries !== false;
    if (els.basemapSelect) els.basemapSelect.value = s.basemap || 'osm';
    if (els.filterUnact) state.filters.potaUnactivated = !!els.filterUnact.checked;
    if (els.filterPoints) state.filters.sotaMinPoints = Number(els.filterPoints.value) || 0;
    if (els.filterMine) state.filters.mine = els.filterMine.value || 'all';
    state.radiusKm = clampRadiusKm(state.radiusKm);   // a stored setting may predate the range
    syncRadiusUi();

    var m = mapui();
    if (m && m.getMap && m.getMap()) {
      m.setLayerVisible('pota', s.showPota !== false);
      m.setLayerVisible('sota', s.showSota !== false);
      m.setLayerVisible('boundaries', s.showBoundaries !== false);
      m.setLayerVisible('spots', !!s.showSpots);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Init                                                              */
  /* ---------------------------------------------------------------- */
  function init() {
    collectEls();
    if (PSM.panel) PSM.panel.init();

    if (PSM.mapui && PSM.mapui.available && PSM.mapui.available()) {
      PSM.mapui.init('map');
    } else {
      log('Leaflet is unavailable — the list still works, but there is no map.', 'error');
      status('The map library did not load. Lists still work; check your connection.', 'error');
    }

    wire();
    syncFromSettings();

    if (!nferAvailable() && els.nferBtn) {
      els.nferBtn.disabled = true;
      els.nferBtn.title = 'Requires turf.js and osmtogeojson, which did not load.';
    }

    if (PSM.panel) PSM.panel.renderLists(state);
    if (PSM.settings && PSM.settings.showSpots) setSpots(true);

    updateMylogSummary();
    if (PSM.mylog && PSM.mylog.onChange) {
      PSM.mylog.onChange(function () {
        updateMylogSummary();
        renderAll();
        refreshOpenDetail();
      });
    }

    document.body.classList.add('psm-ready');
    afterLayout();
    resolveReady(api);

    startup().catch(function (e) {
      log('startup: ' + ((e && e.message) || e), 'error');
      idleView();
    });
  }

  /* ---------------------------------------------------------------- */
  /* Public API (exposed before `ready` resolves)                      */
  /* ---------------------------------------------------------------- */
  var api = {
    state: state,
    ready: readyPromise,
    search: search,
    searchAt: searchAt,
    openPark: openPark,
    openSummit: openSummit,
    openZone: openZone,
    runNfer: runNfer,
    /** Fit the map to the boundary highlighted for the open park (#boundary-zoom-btn). */
    zoomToParkBoundary: function () {
      var m = mapui();
      if (!m || !m.parkBoundaryBounds || !m.getMap || !m.getMap()) return false;
      var b = m.parkBoundaryBounds();
      if (!b) return false;
      try { m.getMap().fitBounds(b, { padding: [40, 40] }); } catch (e) { return false; }
      return true;
    },
    close: function () { if (PSM.panel) PSM.panel.close(); },
    setRadiusKm: function (km, rerun) {
      state.radiusKm = clampRadiusKm(km);
      PSM.saveSettings({ radiusKm: state.radiusKm });
      syncRadiusUi();
      if (rerun !== false && state.center) return searchAt(state.center);
      return Promise.resolve();
    },
    setUnits: function (u) {
      if (u !== units()) toggleUnits();
    },
    setFilters: function (f) {
      Object.assign(state.filters, f || {});
      if (els.filterUnact) els.filterUnact.checked = !!state.filters.potaUnactivated;
      if (els.filterPoints) els.filterPoints.value = String(state.filters.sotaMinPoints || 0);
      if (els.filterMine) els.filterMine.value = state.filters.mine || 'all';
      renderAll();
    },
    selectTab: function (n) { if (PSM.panel) PSM.panel.selectTab(n); },
    toggleSidebar: toggleSidebar,
    render: renderAll,
    useMyLocation: useMyLocation
  };

  PSM.app = api;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

})(typeof window !== 'undefined' ? window : globalThis);
