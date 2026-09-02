/* =====================================================================
 * 70-panel.js — PSM.panel: sidebar lists, detail panels, status line, log.
 *
 * All DOM lives here (except the map). Every external string goes through
 * PSM.esc. Detail panels render synchronously from what the list already
 * knows, then fill each async section independently — one failed request
 * degrades to a quiet "unavailable" note and never blanks the panel.
 * ===================================================================== */
(function (global) {
  'use strict';

  var PSM = global.PSM || (global.PSM = {});
  var esc = function (s) { return PSM.esc(s); };

  var els = {};
  var openSeq = 0;              // guards against slow responses from a previous panel
  var boundarySeq = 0;          // …and specifically against a superseded boundary lookup
  var boundaryCtrl = null;      // AbortController of the in-flight boundary lookup
  var current = { kind: null, id: null };
  var lastState = null;
  var logDirty = true;

  // A 100-mile radius in a dense state is 1500+ parks. Rendering them all is ~15 000 DOM
  // nodes per re-render (and renderLists runs on every filter/unit change), so rows are
  // revealed a page at a time behind a "Show more" button.
  var LIST_PAGE = 300;
  var shown = { parks: LIST_PAGE, summits: LIST_PAGE, multi: LIST_PAGE };

  function $(id) { return document.getElementById(id); }
  function units() { return (PSM.settings && PSM.settings.units) || 'mi'; }
  function log(m, l) { if (PSM.log) PSM.log(m, l); }

  function emit(name, detail) {
    try {
      document.dispatchEvent(new CustomEvent(name, { detail: detail, bubbles: true }));
    } catch (e) {
      var ev = document.createEvent('CustomEvent');
      ev.initCustomEvent(name, true, false, detail);
      document.dispatchEvent(ev);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Small formatting helpers                                          */
  /* ---------------------------------------------------------------- */
  function distBits(o, center) {
    if (!o || o.lat == null) return '';
    var km = o.distKm;
    if ((km == null || isNaN(km)) && center) km = PSM.haversineKm(center.lat, center.lon, o.lat, o.lon);
    if (km == null || isNaN(km)) return '';
    var s = PSM.fmt.dist(km, units());
    if (center) s += ' ' + PSM.compass(PSM.bearingDeg(center.lat, center.lon, o.lat, o.lon));
    return s;
  }

  /**
   * One <dt>/<dd> pair.  NOTE the contract: `value` is inserted as HTML so callers can pass
   * a badge or a link — every caller here therefore wraps external strings in esc() itself.
   * Same for `sub`/`badges` in row() below.
   */
  function kv(label, value, cls) {
    if (value == null || value === '' || value === '—') return '';
    return '<dt>' + esc(label) + '</dt><dd' + (cls ? ' class="' + cls + '"' : '') + '>' + value + '</dd>';
  }

  function chips(csv) {
    var parts = String(csv || '').split(/\s*,\s*/).filter(Boolean);
    if (!parts.length) return '';
    return '<div class="chips">' + parts.map(function (p) {
      return '<span class="chip">' + esc(p) + '</span>';
    }).join('') + '</div>';
  }

  function linkList(csv, label) {
    var parts = String(csv || '').split(/[\s,;]+/).filter(Boolean);
    var out = [];
    parts.forEach(function (u, i) {
      var href = PSM.safeUrl(u);
      if (!href) return;
      out.push('<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' +
        esc(label ? (parts.length > 1 ? label + ' ' + (i + 1) : label) : href) + '</a>');
    });
    return out.length ? '<div class="linklist">' + out.join('') + '</div>' : '';
  }

  /* ---------------------------------------------------------------- */
  /* My activations — small helpers shared by list rows and detail panels */
  /* ---------------------------------------------------------------- */
  /** kind here is the *panel's* vocabulary ("park"/"summit"); mylog's is "pota"/"sota". */
  function mylogKind(panelKind) { return panelKind === 'summit' ? 'sota' : 'pota'; }

  /** One badge for a list row: activated > attempted > hunted > nothing. */
  function mylogBadge(kind, id) {
    if (!PSM.mylog) return '';
    if (PSM.mylog.isActivated(kind, id)) return '<span class="badge badge-mine">✓ activated</span>';
    if (PSM.mylog.isAttempted(kind, id)) return '<span class="badge badge-attempted">attempted</span>';
    if (PSM.mylog.isHunted(kind, id)) return '<span class="badge badge-hunted">hunted</span>';
    return '';
  }

  function loadingBox(msg) { return '<div class="loading">' + esc(msg || 'loading…') + '</div>'; }
  function quiet(msg) { return '<div class="note quiet">' + esc(msg) + '</div>'; }
  function section(id, title, inner) {
    return '<div class="d-sec"><h3>' + esc(title) + '</h3><div id="' + id + '">' + (inner || '') + '</div></div>';
  }

  function multiline(text) {
    return '<div class="comments">' + esc(text) + '</div>'; // white-space: pre-wrap keeps the breaks
  }

  /* ---------------------------------------------------------------- */
  /* Async section filling                                             */
  /* ---------------------------------------------------------------- */
  /** Fills one section; the returned promise never rejects and settles once the DOM is written. */
  function fill(token, id, loader, render, emptyMsg) {
    return Promise.resolve().then(loader).then(function (v) {
      if (token !== openSeq) return;
      var el = $(id);
      if (!el) return;
      var html = '';
      try { html = (v == null || (Array.isArray(v) && !v.length)) ? '' : render(v); } catch (e) {
        log('panel: render failed for ' + id + ': ' + (e && e.message), 'warn');
        html = '';
      }
      el.innerHTML = html || quiet(emptyMsg || 'Not available.');
    }).catch(function (err) {
      if (token !== openSeq) return;
      var el = $(id);
      log('panel: ' + id + ' unavailable — ' + ((err && err.message) || err), 'warn');
      if (el) el.innerHTML = quiet('Unavailable right now.');
    });
  }

  /* ---------------------------------------------------------------- */
  /* Lists                                                             */
  /* ---------------------------------------------------------------- */
  /** true/false to include, or null when the "Mine" filter has nothing to say about it. */
  function passesMineFilter(f, kind, id) {
    if (!f.mine || f.mine === 'all' || !PSM.mylog) return true;
    var isMine = PSM.mylog.isActivated(kind, id);
    if (f.mine === 'mine') return isMine;
    if (f.mine === 'new') return !isMine;
    return true;
  }

  function filterParks(parks, f) {
    f = f || {};
    return (parks || []).filter(function (p) {
      if (f.potaUnactivated && !(p.activations === 0)) return false;
      if (!passesMineFilter(f, 'pota', p.ref)) return false;
      return true;
    });
  }

  function filterSummits(summits, f) {
    f = f || {};
    var min = Number(f.sotaMinPoints || 0);
    return (summits || []).filter(function (s) {
      if (min > 0 && !(Number(s.points) >= min)) return false;
      if (!passesMineFilter(f, 'sota', s.code)) return false;
      return true;
    });
  }

  function row(kind, id, iconCls, ref, name, sub, badges, extraCls) {
    return '<div class="item' + (extraCls ? ' ' + extraCls : '') + '" data-kind="' + esc(kind) + '" data-id="' + esc(id) +
      '" role="button" tabindex="0" aria-label="' + esc(ref + ' ' + name) + '">' +
      '<span class="item-icon ' + (iconCls || '') + '" aria-hidden="true"></span>' +
      '<div class="item-main">' +
      '<div class="item-title"><span class="ref">' + esc(ref) + '</span><span class="name">' + esc(name) + '</span></div>' +
      '<div class="item-sub">' + sub + '</div>' +
      '</div>' +
      (badges ? '<div class="item-badges">' + badges + '</div>' : '') +
      '</div>';
  }

  function parkRow(p, center, ferInfo) {
    var sub = [];
    var d = distBits(p, center);
    if (d) sub.push('<span class="dist">' + esc(d) + '</span>');
    if (p.loc) sub.push(esc(PSM.locationName(p.loc)));
    if (p.grid) sub.push(esc(p.grid));
    var badges = mylogBadge('pota', p.ref);
    if (ferInfo && ferInfo.count > 1) {
      badges += '<span class="badge badge-nfer' + (ferInfo.confirmed ? '' : ' hint') + '"' +
        (ferInfo.confirmed ? '' : ' title="Possible n-fer: reference points are close. Run “Find multi-activation spots” to confirm the boundaries overlap."') +
        '>' + esc(ferInfo.count) + '-fer' + (ferInfo.confirmed ? '' : '?') + '</span>';
    }
    if (p.activations === 0) badges += '<span class="badge badge-new">never activated</span>';
    else if (p.activations != null) badges += '<span class="badge badge-count">' + PSM.fmt.num(p.activations) + ' act</span>';
    if (p.qsos != null && p.qsos > 0) badges += '<span class="badge">' + PSM.fmt.num(p.qsos) + ' Q</span>';
    return row('park', p.ref, '', p.ref, p.name || p.ref, sub.join(' · '), badges,
      p.activations === 0 ? 'unact' : '');
  }

  function summitRow(s, center, comboRefs) {
    var sub = [];
    var d = distBits(s, center);
    if (d) sub.push('<span class="dist">' + esc(d) + '</span>');
    if (s.altM != null) sub.push(esc(PSM.fmt.elev(s.altM, units())));
    if (s.regionName || s.assocName) sub.push(esc(s.regionName || s.assocName));
    else if (s.assoc) sub.push(esc(s.assoc + (s.region ? '/' + s.region : '')));
    var badges = mylogBadge('sota', s.code);
    if (s.points != null) badges += '<span class="badge badge-pts">' + esc(s.points) + ' pt' + (Number(s.points) === 1 ? '' : 's') + '</span>';
    if (s.actCount === 0) badges += '<span class="badge badge-new">never activated</span>';
    else if (s.actCount != null) badges += '<span class="badge">' + PSM.fmt.num(s.actCount) + ' act</span>';
    if (comboRefs && comboRefs.length) badges += '<span class="badge badge-nfer">' + (comboRefs.length + 1) + '-fer</span>';
    var cls = [(comboRefs && comboRefs.length) ? 'combo' : '', s.actCount === 0 ? 'unact' : ''].filter(Boolean).join(' ');
    return row('summit', s.code, '', s.code, s.name || s.code, sub.join(' · '), badges, cls);
  }

  /** Of a zone's POTA refs, how many has the user not yet activated? 0 when nobody has activated
   *  anything yet (every zone would trivially be "all new" — not a useful signal to show). */
  function mylogNewCount(refs) {
    if (!PSM.mylog || !refs || !refs.length) return 0;
    var s = PSM.mylog.stats();
    if (!s.total) return 0;
    var n = 0;
    refs.forEach(function (r) {
      if (PSM.isPotaRef && PSM.isPotaRef(r) && !PSM.mylog.isActivated('pota', r)) n++;
    });
    return n;
  }

  function zoneRow(f) {
    var p = f.properties || {};
    var refs = p.refs || [];
    var sub = [];
    if (p.kind) sub.push(esc(String(p.kind).replace(/-/g, ' + ')));
    if (p.areaHa != null) sub.push(esc(PSM.fmt.num(p.areaHa >= 10 ? Math.round(p.areaHa) : p.areaHa)) + ' ha');
    if (p.summits && p.summits.length) sub.push('summit ' + esc(p.summits.join(', ')));
    if (p.confidence != null) sub.push('confidence ' + Math.round(p.confidence * 100) + '%');
    var newCount = mylogNewCount(refs);
    if (newCount > 0) sub.push(newCount + ' new to you');
    var names = (p.names || []).filter(Boolean);
    var badges = '<span class="badge badge-nfer">' + esc(p.count || refs.length) + '-fer</span>';
    return row('zone', p.id || ('zone-' + refs.join('-')), '', refs.join(' + '),
      names.length ? names.join(' + ') : 'Overlapping references', sub.join(' · '), badges);
  }

  function comboRow(c, center) {
    var sub = [];
    var d = distBits({ lat: c.lat, lon: c.lon }, center);
    if (d) sub.push('<span class="dist">' + esc(d) + '</span>');
    sub.push(c.inside ? 'inside ' + esc(c.refs.join(', ')) : 'within ' + esc(c.distM) + ' m of ' + esc(c.refs.join(', ')));
    var badges = '<span class="badge badge-nfer">' + (c.refs.length + 1) + '-fer</span>';
    return row('summit', c.code, '', c.code, c.name || c.code, sub.join(' · '), badges, 'combo');
  }

  function emptyBox(title, hint) {
    return '<div class="empty"><strong>' + esc(title) + '</strong>' +
      (hint ? '<span>' + esc(hint) + '</span>' : '') + '</div>';
  }

  /** Rows up to the current page limit, plus a "Show more" button when there are extras. */
  function pagedRows(rows, key, makeRow) {
    var limit = shown[key] || LIST_PAGE;
    var n = Math.min(rows.length, limit);
    var out = [];
    for (var i = 0; i < n; i++) out.push(makeRow(rows[i], i));
    var rest = rows.length - n;
    if (rest > 0) {
      out.push('<button type="button" class="show-more" data-list="' + esc(key) + '">' +
        'Show ' + Math.min(LIST_PAGE, rest) + ' more <span class="rest">(' + rest + ' hidden)</span></button>');
    }
    return out.join('');
  }

  function setTab(id, label, n) {
    var el = $(id);
    if (el) el.textContent = label + ' (' + n + ')';
  }

  function renderLists(state, opts) {
    lastState = state || lastState || {};
    state = lastState;
    // Any real re-render (new search, new filter) starts the lists back at page 1; only the
    // "Show more" button asks to keep the paging it just extended.
    if (!(opts && opts.keepPaging)) shown = { parks: LIST_PAGE, summits: LIST_PAGE, multi: LIST_PAGE };
    var center = state.center;
    var f = state.filters || {};
    var parks = filterParks(state.parks, f);
    var summits = filterSummits(state.summits, f);
    var nfer = state.nfer;
    var nferParks = state.nferParks || null;
    var zones = (nfer && nfer.zones && nfer.zones.features) || [];
    var combos = (nfer && nfer.summitCombos) || [];
    var comboByCode = new Map();
    combos.forEach(function (c) { if (c && c.code) comboByCode.set(c.code, c.refs || []); });

    setTab('tab-parks', 'Parks', parks.length);
    setTab('tab-summits', 'Summits', summits.length);
    setTab('tab-multi', 'Multi', zones.length + combos.length);

    if (els.listParks) {
      els.listParks.innerHTML = parks.length
        ? pagedRows(parks, 'parks', function (p) { return parkRow(p, center, nferParks && nferParks.get(p.ref)); })
        : emptyBox(center ? 'No parks here' : 'No search yet',
          center ? (f.potaUnactivated ? 'No never-activated parks in range — clear the filter to see all parks.'
            : 'Try a larger radius or a different location.')
            : 'Enter an address, coordinates, a grid square or a reference above.');
    }
    if (els.listSummits) {
      els.listSummits.innerHTML = summits.length
        ? pagedRows(summits, 'summits', function (s) { return summitRow(s, center, comboByCode.get(s.code)); })
        : emptyBox(center ? 'No summits here' : 'No search yet',
          center ? (Number(f.sotaMinPoints) > 0 ? 'No summits meet the points filter — try “Any”.'
            : 'SOTA summits are sparse outside hilly terrain; try a larger radius.')
            : 'Summits appear once you search.');
    }
    if (els.listMulti) {
      if (!nfer) {
        els.listMulti.innerHTML = emptyBox('No analysis yet',
          'Press “Find multi-activation spots” to look for overlapping park boundaries near you.');
      } else if (!zones.length && !combos.length) {
        els.listMulti.innerHTML = emptyBox('No overlaps found',
          'No two reference boundaries overlapped inside the analysed area. Unmatched parks: ' +
          ((nfer.unmatchedParks && nfer.unmatchedParks.length) || 0) + '.');
      } else {
        var multi = zones.map(function (z) { return { zone: z }; })
          .concat(combos.map(function (c) { return { combo: c }; }));
        els.listMulti.innerHTML = pagedRows(multi, 'multi', function (r) {
          return r.zone ? zoneRow(r.zone) : comboRow(r.combo, center);
        });
      }
    }
    markSelected();
  }

  function markSelected() {
    var nodes = document.querySelectorAll('#list-parks .item, #list-summits .item, #list-multi .item');
    Array.prototype.forEach.call(nodes, function (n) {
      var on = current.id && n.getAttribute('data-id') === current.id && n.getAttribute('data-kind') === current.kind;
      n.classList.toggle('selected', !!on);
    });
  }

  function selectTab(name) {
    ['parks', 'summits', 'multi'].forEach(function (n) {
      var tab = $('tab-' + n), list = $('list-' + n);
      if (tab) tab.setAttribute('aria-selected', n === name ? 'true' : 'false');
      if (list) list.hidden = n !== name;
    });
  }

  /* ---------------------------------------------------------------- */
  /* Detail panel plumbing                                             */
  /* ---------------------------------------------------------------- */
  function openPanel(kind, id, title) {
    // Whatever boundary is on the map belongs to the panel we are replacing; a
    // park re-draws its own a moment later, a summit/zone deliberately has none.
    clearBoundary();
    current = { kind: kind, id: id };
    if (els.detail) {
      els.detail.hidden = false;
      // next frame so the transform transition actually runs
      global.requestAnimationFrame(function () { if (els.detail) els.detail.classList.add('open'); });
    }
    if (els.detailTitle) els.detailTitle.textContent = title || 'Details';
    if (els.detailBody) els.detailBody.scrollTop = 0;
    document.body.classList.add('psm-detail-open');
    markSelected();
    emit('psm:detailopen', { kind: kind, id: id });
  }

  function close() {
    openSeq++;
    clearBoundary();
    current = { kind: null, id: null };
    if (els.detail) {
      els.detail.classList.remove('open');
      els.detail.hidden = true;
    }
    document.body.classList.remove('psm-detail-open');
    markSelected();
    emit('psm:detailclose', {});
  }

  /** "Mark as activated" / "Unmark activated" — kept in sync with the store on every render. */
  function mylogToggleBtn(opts) {
    if (!PSM.mylog || opts.kind !== 'park' && opts.kind !== 'summit') return '';
    var kind = mylogKind(opts.kind);
    var activated = PSM.mylog.isActivated(kind, opts.id);
    return '<button type="button" id="mylog-toggle-btn" class="btn small mylog-toggle" data-kind="' + esc(kind) +
      '" data-id="' + esc(opts.id) + '" aria-pressed="' + (activated ? 'true' : 'false') + '">' +
      (activated ? 'Unmark activated' : 'Mark as activated') + '</button>';
  }

  function actionBar(opts) {
    var b = [];
    if (opts.lat != null && opts.lon != null) {
      b.push('<button type="button" class="btn small js-showmap" data-lat="' + esc(opts.lat) + '" data-lon="' + esc(opts.lon) +
        '" data-kind="' + esc(opts.kind) + '" data-id="' + esc(opts.id) + '">Show on map</button>');
    }
    b.push('<button type="button" class="btn small js-copy" data-copy="' + esc(opts.id) + '">Copy reference</button>');
    if (opts.lat != null && opts.lon != null) {
      b.push('<button type="button" class="btn small js-copy" data-copy="' + esc(PSM.fmt.latlon(opts.lat, opts.lon)) + '">Copy coordinates</button>');
    }
    b.push(mylogToggleBtn(opts));
    return '<div class="d-actions">' + b.join('') + '</div>';
  }

  function mapLinks(lat, lon, extra) {
    if (lat == null || lon == null) return '';
    var ll = Number(lat).toFixed(6) + ',' + Number(lon).toFixed(6);
    var out = (extra || []).slice();
    out.push('<a href="https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(ll) +
      '" target="_blank" rel="noopener noreferrer">Google directions</a>');
    out.push('<a href="https://maps.apple.com/?daddr=' + encodeURIComponent(ll) +
      '" target="_blank" rel="noopener noreferrer">Apple Maps</a>');
    out.push('<a href="https://www.openstreetmap.org/?mlat=' + encodeURIComponent(Number(lat).toFixed(6)) +
      '&mlon=' + encodeURIComponent(Number(lon).toFixed(6)) + '#map=14/' + Number(lat).toFixed(5) + '/' + Number(lon).toFixed(5) +
      '" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>');
    return '<div class="linklist">' + out.join('') + '</div>';
  }

  function addressBlock(rev) {
    if (!rev || !rev.label) return '';
    return '<div>' + esc(rev.label) + '</div>' +
      '<div class="note quiet">Reverse-geocoded from the reference point — parks have no street address.</div>';
  }

  /* ---------------------------------------------------------------- */
  /* Park boundary (OSM) — drawn while a park's detail panel is open    */
  /* ---------------------------------------------------------------- */
  /** How the match was made, in words, for the "matched by …" clause. */
  var MATCH_PHRASE = { tag: 'tag', point: 'location + name', name: 'name', trail: 'trail name' };

  function boundaryText(msg) { return '<span class="b-text">' + esc('Boundary: ' + msg) + '</span>'; }

  /**
   * Forget whatever boundary is on the map and abandon any lookup still in
   * flight.  Called when the detail closes, when another item opens, and when a
   * new search invalidates the whole view.  Bumping boundarySeq is what stops a
   * late response from drawing over the next park.
   */
  function clearBoundary() {
    boundarySeq++;
    if (boundaryCtrl) {
      try { boundaryCtrl.abort(); } catch (e) { /* ignore */ }
      boundaryCtrl = null;
    }
    if (PSM.mapui && PSM.mapui.clearParkBoundary) PSM.mapui.clearParkBoundary();
  }

  function setBoundaryLine(token, seq, html) {
    if (token !== openSeq || seq !== boundarySeq) return;
    var el = $('boundary-line');
    if (el) el.innerHTML = html;
  }

  function drawBoundary(token, seq, ref, res) {
    if (token !== openSeq || seq !== boundarySeq) return;
    var n = 0;
    try { n = PSM.mapui.showParkBoundary(ref, res.fc, { focus: false }) || 0; } catch (e) { n = 0; }
    if (!n) {
      setBoundaryLine(token, seq, boundaryText('not mapped on OpenStreetMap yet — showing the reference point only'));
      return;
    }
    var how = MATCH_PHRASE[res.matchKind] || res.matchKind || 'name';
    var pct = Math.round((res.confidence == null ? 1 : res.confidence) * 100);
    setBoundaryLine(token, seq,
      boundaryText('shown on map · matched by ' + how + ' (' + pct + '% confidence) · © OpenStreetMap') +
      '<button type="button" id="boundary-zoom-btn" class="btn tiny">Zoom to boundary</button>');
  }

  /**
   * Fill #boundary-line and draw the park's OSM boundary.  Fire-and-forget: the
   * panel is already usable, this only ever adds to it.  A finished n-fer
   * analysis short-circuits the network entirely.
   *
   * @param {number} token   the openSeq of the panel that asked
   * @param {string} ref
   * @param {Object} park    what the list already knows (may have no coordinates)
   * @param {Promise} detailP  the /park/{ref} promise, for coordinates we lack
   */
  function startParkBoundary(token, ref, park, detailP) {
    var el = $('boundary-line');
    if (!el) return;
    // Same availability rule as the n-fer button: without turf/osmtogeojson there is
    // nothing that could turn an Overpass answer into a shape, so do not ask for one.
    if (!PSM.nfer || !PSM.nfer.parkBoundary || !PSM.mapui || !PSM.mapui.showParkBoundary ||
        !global.turf || !global.osmtogeojson) {
      el.innerHTML = boundaryText('not looked up — the boundary libraries did not load');
      return;
    }
    var seq = boundarySeq;

    // 1. Free path: the analysis this session already ran knows this park.
    try {
      var done = lastState && lastState.nfer && PSM.nfer.boundaryFromAnalysis
        ? PSM.nfer.boundaryFromAnalysis(ref, lastState.nfer) : null;
      if (done) { drawBoundary(token, seq, ref, done); return; }
    } catch (e) { log('boundary: reusing the analysis failed — ' + ((e && e.message) || e), 'warn'); }

    // 2. One small Overpass request for this park (cached 7 days).
    el.innerHTML = boundaryText('looking up OpenStreetMap…');
    var ctrl = (typeof global.AbortController === 'function')
      ? new global.AbortController() : { abort: function () { }, signal: null };
    boundaryCtrl = ctrl;

    var coordsP = (park && park.lat != null && park.lon != null)
      ? Promise.resolve({ lat: park.lat, lon: park.lon })
      : Promise.resolve(detailP).then(function (d) {
        return (d && d.latitude != null) ? { lat: d.latitude, lon: d.longitude } : null;
      }, function () { return null; });

    coordsP.then(function (c) {
      if (token !== openSeq || seq !== boundarySeq) return;
      if (!c) {
        setBoundaryLine(token, seq, boundaryText('not looked up — this reference has no coordinates'));
        return;
      }
      return PSM.nfer.parkBoundary(
        { ref: ref, name: (park && park.name) || ref, lat: c.lat, lon: c.lon },
        { signal: ctrl.signal }
      ).then(function (res) {
        if (boundaryCtrl === ctrl) boundaryCtrl = null;
        if (!res) {
          setBoundaryLine(token, seq,
            boundaryText('not mapped on OpenStreetMap yet — showing the reference point only'));
          return;
        }
        drawBoundary(token, seq, ref, res);
      });
    }).catch(function (err) {
      if (boundaryCtrl === ctrl) boundaryCtrl = null;
      if (PSM.isAbortError && PSM.isAbortError(err)) return;   // superseded — the next panel owns the map
      log('boundary ' + ref + ': ' + ((err && err.message) || err), 'warn');
      setBoundaryLine(token, seq, boundaryText('lookup failed (Overpass unreachable)'));
    });
  }

  /* ---------------------------------------------------------------- */
  /* Park detail                                                       */
  /* ---------------------------------------------------------------- */
  function showPark(ref, park) {
    var token = ++openSeq;
    if (!els.detailBody) return Promise.resolve();
    park = park || {};
    var name = park.name || ref;
    openPanel('park', ref, ref);

    var head = '<div class="d-head d-park">' +
      '<span class="d-ref">' + esc(ref) + '</span>' +
      '<div class="d-name" id="d-park-name">' + esc(name) + '</div>' +
      '<div class="d-tagline" id="d-park-tag">' + esc([distBits(park, lastState && lastState.center), park.loc ? PSM.locationName(park.loc) : ''].filter(Boolean).join(' · ')) + '</div>' +
      '</div>';

    var mylogLine = PSM.mylog ? PSM.mylog.describeEntry('pota', ref) : '';
    var body =
      head +
      '<div id="d-actions">' + actionBar({ kind: 'park', id: ref, lat: park.lat, lon: park.lon }) + '</div>' +
      '<div id="mylog-detail-line" class="mylog-detail-line"' + (mylogLine ? '' : ' hidden') + '>' + esc(mylogLine) + '</div>' +
      section('d-links', 'Open in', park.lat != null
        ? mapLinks(park.lat, park.lon, ['<a href="' + esc(potaUrl(ref)) + '" target="_blank" rel="noopener noreferrer">POTA park page</a>'])
        : loadingBox()) +
      '<div class="d-sec"><h3>Park information</h3><div id="d-info">' + loadingBox() + '</div>' +
      '<div id="boundary-line" class="boundary-line">' + boundaryText('looking up OpenStreetMap…') + '</div></div>' +
      section('d-addr', 'Approximate address', loadingBox()) +
      section('d-stats', 'Activity', loadingBox()) +
      section('d-acts', 'Recent activations', loadingBox()) +
      section('d-lead', 'Leaderboard', loadingBox());

    els.detailBody.innerHTML = body;

    if (!PSM.pota) {
      ['d-info', 'd-addr', 'd-stats', 'd-acts', 'd-lead'].forEach(function (id) {
        var el = $(id); if (el) el.innerHTML = quiet('The POTA data module is not loaded.');
      });
      startParkBoundary(token, ref, park, null);
      return Promise.resolve();
    }

    var detailP = Promise.resolve().then(function () { return PSM.pota.getPark(ref); });
    detailP.catch(function () { /* handled per-section */ });
    var pending = [];

    pending.push(fill(token, 'd-info', function () { return detailP; }, function (d) {
      // Header refinements
      var disp = PSM.pota.displayName ? PSM.pota.displayName(d) : (d.name || name);
      var nameEl = $('d-park-name'); if (nameEl && disp) nameEl.textContent = park.name || disp;
      var tagEl = $('d-park-tag');
      if (tagEl) {
        var tag = [distBits(park, lastState && lastState.center), d.parktypeDesc || '',
          PSM.locationName(d.locationDesc || park.loc || '')].filter(Boolean).join(' · ');
        if (tag) tagEl.textContent = tag;
      }
      if (park.lat == null && d.latitude != null) {
        var act = $('d-actions');
        if (act) act.innerHTML = actionBar({ kind: 'park', id: ref, lat: d.latitude, lon: d.longitude });
        var lk = $('d-links');
        if (lk) lk.innerHTML = mapLinks(d.latitude, d.longitude,
          ['<a href="' + esc(potaUrl(ref)) + '" target="_blank" rel="noopener noreferrer">POTA park page</a>']);
      }
      return parkInfoHtml(d, ref);
    }, 'No detail record for this reference.'));

    pending.push(fill(token, 'd-addr', function () {
      return detailP.then(function (d) {
        var lat = park.lat != null ? park.lat : (d && d.latitude);
        var lon = park.lon != null ? park.lon : (d && d.longitude);
        if (lat == null || lon == null || !PSM.geocode || !PSM.geocode.reverse) return null;
        return PSM.geocode.reverse(lat, lon);
      });
    }, addressBlock, 'No address found for this point.'));

    pending.push(fill(token, 'd-stats', function () { return PSM.pota.getStats(ref); }, function (st) {
      return '<div class="stat-row">' +
        '<div class="stat"><div class="v">' + PSM.fmt.num(st.attempts) + '</div><div class="k">Attempts</div></div>' +
        '<div class="stat"><div class="v">' + PSM.fmt.num(st.activations) + '</div><div class="k">Activations</div></div>' +
        '<div class="stat"><div class="v">' + PSM.fmt.num(st.contacts) + '</div><div class="k">Contacts</div></div>' +
        '</div>';
    }, 'No activity statistics.'));

    pending.push(fill(token, 'd-acts', function () { return PSM.pota.getActivations(ref, 8); }, function (rows) {
      var body = rows.slice(0, 8).map(function (a) {
        var modes = [];
        if (a.qsosCW) modes.push(a.qsosCW + ' CW');
        if (a.qsosDATA) modes.push(a.qsosDATA + ' DATA');
        if (a.qsosPHONE) modes.push(a.qsosPHONE + ' PHONE');
        return '<tr><td>' + esc(PSM.fmt.date(a.qso_date)) + '</td>' +
          '<td class="call">' + esc(a.activeCallsign || '—') + '</td>' +
          '<td class="num">' + PSM.fmt.num(a.totalQSOs) + '</td>' +
          '<td>' + esc(modes.join(' · ') || '—') + '</td></tr>';
      }).join('');
      return '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Callsign</th><th>QSOs</th><th>Modes</th></tr></thead>' +
        '<tbody>' + body + '</tbody></table></div>';
    }, 'No activations recorded yet.'));

    pending.push(fill(token, 'd-lead', function () { return PSM.pota.getLeaderboard(ref, 5); }, function (lb) {
      var blocks = [];
      var mk = function (title, arr) {
        if (!arr || !arr.length) return '';
        return '<div class="d-sub"><h4 class="k">' + esc(title) + '</h4><table class="tbl"><tbody>' +
          arr.slice(0, 5).map(function (r) {
            return '<tr><td class="call">' + esc(r.callsign) + '</td><td class="num">' + PSM.fmt.num(r.count) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      };
      blocks.push(mk('Top activators', lb.activations));
      blocks.push(mk('Most activator QSOs', lb.activator_qsos));
      blocks.push(mk('Top hunters', lb.hunter_qsos));
      var html = blocks.filter(Boolean).join('');
      return html || '';
    }, 'No leaderboard for this park.'));

    // Deliberately not in `pending`: the boundary paints itself onto the map and
    // into #boundary-line whenever it arrives, and nothing waits for it.
    startParkBoundary(token, ref, park, detailP);

    return Promise.all(pending).then(function () { });
  }

  function potaUrl(ref) {
    return (PSM.pota && PSM.pota.parkUrl) ? PSM.pota.parkUrl(ref) : ('https://pota.app/#/park/' + ref);
  }

  function parkInfoHtml(d, ref) {
    var rows = '';
    rows += kv('Reference', esc(d.reference || ref), 'mono');
    rows += kv('Name', esc(PSM.pota.displayName ? PSM.pota.displayName(d) : d.name));
    rows += kv('Park type', esc(d.parktypeDesc));
    rows += kv('Location', esc(PSM.locationName(d.locationDesc) || d.locationName || d.locationDesc));
    rows += kv('Entity', esc(d.entityName || d.entityId));
    rows += kv('Grid', esc([d.grid6, d.grid4].filter(Boolean).join(' / ')), 'mono');
    if (d.latitude != null) rows += kv('Coordinates', esc(PSM.fmt.latlon(d.latitude, d.longitude)), 'mono');
    // `active` is a number from /park/{ref} but a "1"/"0" string in the bulk CSV — coerce.
    var active = d.active == null || d.active === '' ? null : Number(d.active);
    rows += kv('Status', active === 0 ? '<span class="badge badge-new">inactive / retired</span>' : (active === 1 ? 'Active' : null));
    if (d.firstActivator) {
      rows += kv('First activation', esc(d.firstActivator) + (d.firstActivationDate ? ' on ' + esc(PSM.fmt.date(d.firstActivationDate)) : ''));
    }
    var html = rows ? '<dl class="kv">' + rows + '</dl>' : '';

    if (d.parkComments) html += '<div class="d-block"><h4 class="k">Park comments</h4>' + multiline(d.parkComments) + '</div>';
    if (d.accessibility) html += '<div class="d-block"><h4 class="k">Accessibility</h4>' + multiline(d.accessibility) + '</div>';
    if (d.sensitivity) html += '<div class="d-block"><h4 class="k">Sensitivity</h4>' + multiline(d.sensitivity) + '</div>';
    if (d.accessMethods) html += '<div class="d-block"><h4 class="k">Access methods</h4>' + chips(d.accessMethods) + '</div>';
    if (d.activationMethods) html += '<div class="d-block"><h4 class="k">Activation methods</h4>' + chips(d.activationMethods) + '</div>';
    if (d.agencies) {
      html += '<div class="d-block"><h4 class="k">Agencies</h4><div>' + esc(d.agencies) + '</div>' +
        linkList(d.agencyURLs, 'Agency site') + '</div>';
    }
    var extraLinks = [linkList(d.website, 'Official website'), linkList(d.parkURLs, 'Park link')].filter(Boolean).join('');
    if (extraLinks) html += '<div class="d-block"><h4 class="k">Links</h4>' + extraLinks + '</div>';
    return html;
  }

  /* ---------------------------------------------------------------- */
  /* Summit detail                                                     */
  /* ---------------------------------------------------------------- */
  function showSummit(code, summit) {
    var token = ++openSeq;
    if (!els.detailBody) return Promise.resolve();
    summit = summit || {};
    openPanel('summit', code, code);

    var head = '<div class="d-head d-summit">' +
      '<span class="d-ref">' + esc(code) + '</span>' +
      '<div class="d-name" id="d-sum-name">' + esc(summit.name || code) + '</div>' +
      '<div class="d-tagline" id="d-sum-tag">' + esc([distBits(summit, lastState && lastState.center),
        summit.altM != null ? PSM.fmt.elev(summit.altM, units()) : '',
        summit.points != null ? summit.points + ' pts' : ''].filter(Boolean).join(' · ')) + '</div>' +
      '</div>';

    var urls = (PSM.sota && PSM.sota.summitUrls) ? PSM.sota.summitUrls(code)
      : { sotlas: 'https://sotl.as/summits/' + code, sotadata: 'https://www.sotadata.org.uk/en/summit/' + code };

    var mylogLine = PSM.mylog ? PSM.mylog.describeEntry('sota', code) : '';
    var body =
      head +
      '<div id="d-actions">' + actionBar({ kind: 'summit', id: code, lat: summit.lat, lon: summit.lon }) + '</div>' +
      '<div id="mylog-detail-line" class="mylog-detail-line"' + (mylogLine ? '' : ' hidden') + '>' + esc(mylogLine) + '</div>' +
      section('d-links', 'Open in', summit.lat != null ? summitLinks(summit.lat, summit.lon, urls) : loadingBox()) +
      section('d-info', 'Summit information', loadingBox()) +
      section('d-addr', 'Approximate address', loadingBox()) +
      '<div class="d-sec"><div class="note">Activation zone: anywhere within 25 m (82 ft) vertically below the summit.</div></div>';

    els.detailBody.innerHTML = body;

    if (!PSM.sota) {
      ['d-info', 'd-addr'].forEach(function (id) { var el = $(id); if (el) el.innerHTML = quiet('The SOTA data module is not loaded.'); });
      return Promise.resolve();
    }

    var detailP = Promise.resolve().then(function () { return PSM.sota.getSummit(code); });
    detailP.catch(function () { });
    var pending = [];

    pending.push(fill(token, 'd-info', function () { return detailP; }, function (d) {
      var nameEl = $('d-sum-name');
      if (nameEl && d.name) nameEl.textContent = d.name;
      var tagEl = $('d-sum-tag');
      if (tagEl) {
        var t = [distBits(summit, lastState && lastState.center),
          d.altM != null ? PSM.fmt.elev(d.altM, units()) : '',
          d.points != null ? d.points + ' pts' : '',
          d.regionName || ''].filter(Boolean).join(' · ');
        if (t) tagEl.textContent = t;
      }
      if (summit.lat == null && d.latitude != null) {
        var act = $('d-actions');
        if (act) act.innerHTML = actionBar({ kind: 'summit', id: code, lat: d.latitude, lon: d.longitude });
        var lk = $('d-links');
        if (lk) lk.innerHTML = summitLinks(d.latitude, d.longitude, urls);
      }
      return summitInfoHtml(d, code, summit);
    }, 'No detail record for this summit.'));

    pending.push(fill(token, 'd-addr', function () {
      return detailP.then(function (d) {
        var lat = summit.lat != null ? summit.lat : (d && d.latitude);
        var lon = summit.lon != null ? summit.lon : (d && d.longitude);
        if (lat == null || lon == null || !PSM.geocode || !PSM.geocode.reverse) return null;
        return PSM.geocode.reverse(lat, lon);
      });
    }, function (rev) {
      if (!rev || !rev.label) return '';
      return '<div>' + esc(rev.label) + '</div>' +
        '<div class="note quiet">Reverse-geocoded from the summit coordinates — summits have no street address, and the road shown may not be the trailhead.</div>';
    }, 'No address found for this point.'));

    return Promise.all(pending).then(function () { });
  }

  function summitLinks(lat, lon, urls) {
    return mapLinks(lat, lon, [
      '<a href="' + esc(urls.sotlas) + '" target="_blank" rel="noopener noreferrer">sotl.as</a>',
      '<a href="' + esc(urls.sotadata) + '" target="_blank" rel="noopener noreferrer">SOTAdata</a>'
    ]);
  }

  function summitInfoHtml(d, code, listSummit) {
    var rows = '';
    var altM = d.altM != null ? d.altM : listSummit.altM;
    var altFt = d.altFt != null ? d.altFt : listSummit.altFt;
    rows += kv('Code', esc(d.summitCode || code), 'mono');
    rows += kv('Name', esc(d.name));
    rows += kv('Association', esc([d.associationName, (code.split('/')[0])].filter(Boolean).join(' · ')));
    rows += kv('Region', esc([d.regionName, d.shortCode ? d.shortCode.split('-')[0] : ''].filter(Boolean).join(' · ')));
    if (altM != null || altFt != null) {
      var ft = altFt != null ? PSM.fmt.num(Math.round(altFt)) : PSM.fmt.num(Math.round(altM * 3.28084));
      var m = altM != null ? PSM.fmt.num(Math.round(altM)) : PSM.fmt.num(Math.round(altFt / 3.28084));
      rows += kv('Altitude', esc(ft + ' ft (' + m + ' m)'));
    }
    var pts = d.points != null ? d.points : listSummit.points;
    if (pts != null) {
      rows += kv('Points', esc(pts + (d.bonusPoints ? ' + ' + d.bonusPoints + ' winter bonus' : '')));
    }
    rows += kv('Locator', esc(d.locator || listSummit.locator), 'mono');
    if (d.latitude != null) rows += kv('Coordinates', esc(PSM.fmt.latlon(d.latitude, d.longitude)), 'mono');
    rows += kv('Valid from', esc(PSM.fmt.date(d.validFrom || listSummit.validFrom)));
    rows += kv('Valid to', esc(PSM.fmt.date(d.validTo || listSummit.validTo)));
    var actCount = d.activationCount != null ? d.activationCount : listSummit.actCount;
    if (actCount != null) rows += kv('Activations', actCount === 0 ? '<span class="badge badge-new">never activated</span>' : PSM.fmt.num(actCount));
    if (d.activationDate || listSummit.actDate) {
      rows += kv('Last activation', esc(PSM.fmt.date(d.activationDate || listSummit.actDate) +
        (d.activationCall || listSummit.actCall ? ' by ' + (d.activationCall || listSummit.actCall) : '')));
    }
    var html = rows ? '<dl class="kv">' + rows + '</dl>' : '';

    var retired = false;
    try {
      if (d.valid === false) retired = true;
      else if (PSM.sota.isValid) retired = !PSM.sota.isValid(PSM.sota.toSummit ? PSM.sota.toSummit(d) : d);
      else {
        var to = PSM.fmt.date(d.validTo || listSummit.validTo);
        retired = /^\d{4}-\d{2}-\d{2}$/.test(to) && to < PSM.todayISO();
      }
    } catch (e) { retired = false; }
    if (retired) {
      html = '<div class="note warn">This summit is retired / not currently valid — activations no longer count.</div>' + html;
    }
    return html;
  }

  /* ---------------------------------------------------------------- */
  /* Zone detail                                                       */
  /* ---------------------------------------------------------------- */
  function showZone(feature) {
    openSeq++;
    if (!feature || !els.detailBody) return Promise.resolve();
    var p = feature.properties || {};
    var refs = p.refs || [];
    var names = p.names || [];
    var id = p.id || ('zone-' + refs.join('-'));
    openPanel('zone', id, (p.count || refs.length) + '-fer');

    var listHtml = refs.map(function (r, i) {
      return '<tr><td class="call">' + esc(r) + '</td><td>' + esc(names[i] || '') + '</td></tr>';
    }).join('');

    var rows = '';
    rows += kv('References', esc(p.count || refs.length));
    rows += kv('Kind', esc(String(p.kind || '').replace(/-/g, ' + ')));
    rows += kv('Overlap area', p.areaHa != null ? esc(PSM.fmt.num(p.areaHa >= 10 ? Math.round(p.areaHa) : p.areaHa) + ' ha (' +
      PSM.fmt.num(Math.round(p.areaHa * 2.47105 * 10) / 10) + ' acres)') : null);
    rows += kv('Confidence', p.confidence != null ? esc(Math.round(p.confidence * 100) + '%') : null);
    if (p.summits && p.summits.length) rows += kv('Summits inside', esc(p.summits.join(', ')));
    if (p.centroid) rows += kv('Centre', esc(PSM.fmt.latlon(p.centroid[1], p.centroid[0])), 'mono');

    var actions = '<div class="d-actions">' +
      (p.centroid ? '<button type="button" class="btn small js-zoomzone" data-id="' + esc(id) +
        '" data-lat="' + esc(p.centroid[1]) + '" data-lon="' + esc(p.centroid[0]) + '">Zoom to</button>' : '') +
      '<button type="button" class="btn small js-copy" data-copy="' + esc(refs.join(', ')) + '">Copy references</button>' +
      '</div>';

    els.detailBody.innerHTML =
      '<div class="d-head d-zone">' +
      '<span class="d-ref">' + esc((p.count || refs.length) + '-fer candidate') + '</span>' +
      '<div class="d-name">' + esc(refs.join(' + ')) + '</div>' +
      '<div class="d-tagline">' + esc(names.filter(Boolean).join(' + ')) + '</div>' +
      '</div>' +
      actions +
      '<div class="d-sec"><h3>References</h3><div class="tbl-wrap"><table class="tbl"><tbody>' + listHtml + '</tbody></table></div></div>' +
      '<div class="d-sec"><h3>Zone</h3><dl class="kv">' + rows + '</dl></div>' +
      '<div class="d-sec"><div class="note warn">Candidate based on OpenStreetMap boundaries — verify with official park maps before activating. ' +
      'POTA requires all parks’ boundaries to overlap at your operating spot.</div></div>';
    return Promise.resolve();
  }

  /* ---------------------------------------------------------------- */
  /* Status + log                                                      */
  /* ---------------------------------------------------------------- */
  function setStatus(text, level) {
    if (!els.status) return;
    els.status.textContent = text == null ? '' : String(text);
    els.status.classList.toggle('err', level === 'error');
  }

  function renderLog() {
    if (!els.log) return;
    var entries = (PSM.logEntries || []).slice(-50).reverse();
    els.log.innerHTML = entries.map(function (e) {
      var t = e.ts instanceof Date ? e.ts : new Date(e.ts);
      var hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0');
      return '<div class="log-line ' + esc(e.level || 'info') + '"><span class="t">' + hh + '</span><span class="m">' + esc(e.msg) + '</span></div>';
    }).join('') || '<div class="log-line"><span class="m">No log entries yet.</span></div>';
    logDirty = false;
  }

  function toggleLog(force) {
    if (!els.log || !els.logToggle) return;
    var show = force == null ? els.log.hidden : !!force;
    els.log.hidden = !show;
    els.logToggle.setAttribute('aria-expanded', show ? 'true' : 'false');
    els.logToggle.setAttribute('aria-pressed', show ? 'true' : 'false');
    if (show && logDirty) renderLog();
  }

  /* ---------------------------------------------------------------- */
  /* Clipboard                                                         */
  /* ---------------------------------------------------------------- */
  function copyText(text, btn) {
    var label = btn ? btn.textContent : '';
    var done = function (ok) {
      if (!btn) return;
      btn.textContent = ok ? 'Copied ✓' : 'Copy failed';
      global.setTimeout(function () { btn.textContent = label; }, 1400);
    };
    var fallback = function () {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        done(ok);
      } catch (e) { done(false); }
    };
    try {
      if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
      } else fallback();
    } catch (e) { fallback(); }
  }

  /* ---------------------------------------------------------------- */
  /* Wiring                                                            */
  /* ---------------------------------------------------------------- */
  function onListActivate(ev) {
    var more = ev.target && ev.target.closest ? ev.target.closest('.show-more') : null;
    if (more) {
      // It is a real <button>, so Enter/Space already arrive as a click — ignore keydown here
      // or the page would be extended twice.
      if (ev.type === 'keydown') return;
      var key = more.getAttribute('data-list');
      if (shown[key] != null) {
        shown[key] += LIST_PAGE;
        renderLists(null, { keepPaging: true });
      }
      return;
    }
    var item = ev.target && ev.target.closest ? ev.target.closest('.item') : null;
    if (!item) return;
    if (ev.type === 'keydown') {
      if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
      ev.preventDefault();
    }
    var kind = item.getAttribute('data-kind');
    var id = item.getAttribute('data-id');
    if (!kind || !id) return;
    emit('psm:select', { kind: kind, id: id, from: 'list' });
  }

  function init() {
    els = {
      listParks: $('list-parks'),
      listSummits: $('list-summits'),
      listMulti: $('list-multi'),
      detail: $('detail'),
      detailBody: $('detail-body'),
      detailTitle: $('detail-title'),
      detailClose: $('detail-close'),
      status: $('status'),
      log: $('log'),
      logToggle: $('log-toggle')
    };

    ['listParks', 'listSummits', 'listMulti'].forEach(function (k) {
      if (!els[k]) return;
      els[k].addEventListener('click', onListActivate);
      els[k].addEventListener('keydown', onListActivate);
    });

    if (els.detailClose) els.detailClose.addEventListener('click', function () { close(); });
    if (els.logToggle) els.logToggle.addEventListener('click', function () { toggleLog(); });

    if (els.detailBody) {
      els.detailBody.addEventListener('click', function (ev) {
        var t = ev.target && ev.target.closest ? ev.target.closest('button') : null;
        if (!t) return;
        if (t.classList.contains('js-copy')) { copyText(t.getAttribute('data-copy') || '', t); return; }
        if (t.id === 'boundary-zoom-btn') {
          if (PSM.app && PSM.app.zoomToParkBoundary) PSM.app.zoomToParkBoundary();
          return;
        }
        if (t.id === 'mylog-toggle-btn') {
          var mkind = t.getAttribute('data-kind'), mid = t.getAttribute('data-id');
          if (PSM.mylog && mkind && mid) {
            if (PSM.mylog.isActivated(mkind, mid)) PSM.mylog.unmark(mkind, mid);
            else PSM.mylog.mark(mkind, mid);
            // PSM.mylog.onChange (wired in 90-app.js) redraws this panel, the lists and the
            // markers — nothing further to do with `t` here, since this button is about to be
            // replaced by that redraw.
          }
          return;
        }
        if (t.classList.contains('js-showmap')) {
          var lat = parseFloat(t.getAttribute('data-lat')), lon = parseFloat(t.getAttribute('data-lon'));
          if (PSM.mapui) {
            PSM.mapui.highlight(t.getAttribute('data-kind'), t.getAttribute('data-id'));
            PSM.mapui.flyTo(lat, lon, 14);
            PSM.mapui.openPopup(t.getAttribute('data-kind'), t.getAttribute('data-id'));
          }
          emit('psm:showonmap', { kind: t.getAttribute('data-kind'), id: t.getAttribute('data-id'), lat: lat, lon: lon });
          return;
        }
        if (t.classList.contains('js-zoomzone')) {
          var zlat = parseFloat(t.getAttribute('data-lat')), zlon = parseFloat(t.getAttribute('data-lon'));
          if (PSM.mapui) {
            PSM.mapui.highlight('zone', t.getAttribute('data-id'), { zoom: true });
            if (!isNaN(zlat)) PSM.mapui.flyTo(zlat, zlon, 14);
          }
          return;
        }
      });
    }

    if (PSM.onLog) {
      PSM.onLog(function () {
        logDirty = true;
        if (els.log && !els.log.hidden) renderLog();
      });
    }
    renderLog();
    return api;
  }

  var api = {
    init: init,
    renderLists: renderLists,
    selectTab: selectTab,
    showPark: showPark,
    showSummit: showSummit,
    showZone: showZone,
    close: close,
    clearBoundary: clearBoundary,
    isOpen: function () { return !!(els.detail && !els.detail.hidden); },
    current: function () { return { kind: current.kind, id: current.id }; },
    setStatus: setStatus,
    renderLog: renderLog,
    toggleLog: toggleLog,
    markSelected: function (kind, id) {
      if (kind) current = { kind: kind, id: id };
      markSelected();
    },
    copyText: copyText
  };

  PSM.panel = api;

})(typeof window !== 'undefined' ? window : globalThis);
