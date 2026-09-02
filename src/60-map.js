/* =====================================================================
 * 60-map.js — PSM.mapui: the Leaflet map, its layers, markers and popups.
 *
 * Owns nothing but the map: it never reads the DOM outside its container and
 * never calls into the panel. Selection travels out as a DOM CustomEvent
 * `psm:select` {kind:"park"|"summit"|"zone", id} on `document`; a shift-click
 * or long-press on empty map fires `psm:searchhere` {lat, lon}.
 *
 * Degrades gracefully: without L.markerClusterGroup it uses plain feature
 * groups (no clustering); without Leaflet at all every method is a no-op.
 * ===================================================================== */
(function (global) {
  'use strict';

  var PSM = global.PSM || (global.PSM = {});
  var L = global.L;

  /* ---------------------------------------------------------------- */
  /* Basemaps (URL templates + attributions per ARCHITECTURE.md)       */
  /* ---------------------------------------------------------------- */
  var OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
  var BASEMAPS = {
    osm: {
      label: 'OpenStreetMap',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: { maxZoom: 19, maxNativeZoom: 19, attribution: OSM_ATTR }
    },
    topo: {
      label: 'OpenTopoMap',
      url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      options: {
        maxZoom: 19, maxNativeZoom: 17, subdomains: 'abc',
        attribution: 'Map data ' + OSM_ATTR + ', SRTM | Style &copy; <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA)'
      }
    },
    usgs: {
      label: 'USGS Topo',
      url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
      options: {
        maxZoom: 19, maxNativeZoom: 16,
        attribution: 'Tiles courtesy of the <a href="https://www.usgs.gov/" target="_blank" rel="noopener">U.S. Geological Survey</a> — The National Map'
      }
    },
    esri: {
      label: 'Esri Imagery',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      options: {
        maxZoom: 19, maxNativeZoom: 19,
        attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
      }
    }
  };

  var COLORS = {
    pota: '#2e7d32', potaDark: '#1b5e20',
    sota: '#e65100', sotaDark: '#bf360c',
    zone2: '#7b1fa2', zone3: '#880e4f',
    boundary: '#5f7d63',
    spot: '#1565c0',
    mine: '#00897b', mineDark: '#00695c'
  };

  /* ---------------------------------------------------------------- */
  /* Module state                                                      */
  /* ---------------------------------------------------------------- */
  var map = null;
  var baseLayer = null;
  var baseKey = 'osm';
  var layers = {};             // parks, summits, zones, boundaries, spots, center
  var parkMarkers = new Map(); // ref -> marker
  var summitMarkers = new Map();
  var parkByRef = new Map();
  var summitByCode = new Map();
  var comboByCode = new Map(); // summit code -> combo (from the n-fer run)
  var zoneLayers = new Map();  // zone id -> layer
  var parkBoundaryLayer = null;   // the open park's OSM boundary (one at a time)
  var parkBoundaryRef = null;
  var centerMarker = null, centerCircle = null;
  var selected = { kind: null, id: null };
  var clustered = false;
  var visible = { pota: true, sota: true, spots: true, boundaries: true };

  function log(msg, level) { if (PSM.log) PSM.log(msg, level); }
  function esc(s) { return PSM.esc ? PSM.esc(s) : String(s == null ? '' : s); }
  function units() { return (PSM.settings && PSM.settings.units) || 'mi'; }
  function reducedMotion() {
    try { return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }

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
  /* Groups                                                            */
  /* ---------------------------------------------------------------- */
  function clusterIconFactory(kind) {
    return function (cluster) {
      var n = cluster.getChildCount();
      var bucket = n < 10 ? 'small' : (n < 100 ? 'medium' : 'large');
      var size = n < 10 ? 34 : (n < 100 ? 40 : 46);
      return L.divIcon({
        html: '<div><span>' + n + '</span></div>',
        className: 'marker-cluster marker-cluster-' + bucket + ' psm-cluster-' + kind,
        iconSize: L.point(size, size)
      });
    };
  }

  function makeGroup(kind) {
    if (typeof L.markerClusterGroup === 'function') {
      clustered = true;
      return L.markerClusterGroup({
        disableClusteringAtZoom: 12,
        spiderfyOnMaxZoom: false,
        showCoverageOnHover: false,
        removeOutsideVisibleBounds: true,
        maxClusterRadius: 55,
        chunkedLoading: true,
        iconCreateFunction: clusterIconFactory(kind)
      });
    }
    return L.featureGroup();
  }

  /* ---------------------------------------------------------------- */
  /* Popups                                                            */
  /* ---------------------------------------------------------------- */
  /** Build a popup element; `.p-details` is wired to fire psm:select. */
  function popupEl(cls, html, kind, id) {
    var el = document.createElement('div');
    el.className = 'psm-popup ' + cls;
    el.innerHTML = html;
    var btn = el.querySelector('.p-details');
    if (btn && kind && id) {
      btn.setAttribute('role', 'button');
      btn.setAttribute('tabindex', '0');
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        emit('psm:select', { kind: kind, id: id, from: 'map' });
      });
      btn.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); btn.click(); }
      });
    }
    return el;
  }

  function distLine(o) {
    if (o == null || o.distKm == null || isNaN(o.distKm)) return '';
    var b = '';
    if (centerCircle && centerCircle.getLatLng && PSM.bearingDeg) {
      var c = centerCircle.getLatLng();
      b = ' ' + PSM.compass(PSM.bearingDeg(c.lat, c.lng, o.lat, o.lon));
    }
    return PSM.fmt.dist(o.distKm, units()) + b;
  }

  function parkPopup(p) {
    var bits = [];
    bits.push('<div class="p-ref">' + esc(p.ref) + '</div>');
    bits.push('<div class="p-name">' + esc(p.name || p.ref) + '</div>');
    var meta = [];
    var d = distLine(p);
    if (d) meta.push(d);
    if (p.loc) meta.push(esc(PSM.locationName(p.loc)));
    if (p.activations === 0) meta.push('never activated');
    else if (p.activations != null) meta.push(PSM.fmt.num(p.activations) + ' activations');
    if (meta.length) bits.push('<div class="p-meta">' + meta.join(' · ') + '</div>');
    if (mylogState('pota', p.ref) === 'mine') bits.push('<div class="p-meta p-mine">✓ activated by you</div>');
    bits.push('<a class="p-details" href="#">Details</a>');
    return popupEl('park', bits.join(''), 'park', p.ref);
  }

  function summitPopup(s) {
    var bits = [];
    bits.push('<div class="p-ref">' + esc(s.code) + '</div>');
    bits.push('<div class="p-name">' + esc(s.name || s.code) + '</div>');
    var meta = [];
    var d = distLine(s);
    if (d) meta.push(d);
    if (s.altM != null) meta.push(PSM.fmt.elev(s.altM, units()));
    if (s.points != null) meta.push(s.points + ' pt' + (s.points === 1 ? '' : 's'));
    if (meta.length) bits.push('<div class="p-meta">' + meta.join(' · ') + '</div>');
    var combo = comboByCode.get(s.code);
    if (combo && combo.refs && combo.refs.length) {
      bits.push('<div class="p-meta">Also in: ' + esc(combo.refs.join(', ')) + '</div>');
    }
    if (mylogState('sota', s.code) === 'mine') bits.push('<div class="p-meta p-mine">✓ activated by you</div>');
    bits.push('<a class="p-details" href="#">Details</a>');
    return popupEl('summit', bits.join(''), 'summit', s.code);
  }

  function zonePopup(f) {
    var p = f.properties || {};
    var refs = p.refs || [];
    var names = p.names || [];
    var items = refs.map(function (r, i) {
      return '<li><strong>' + esc(r) + '</strong>' + (names[i] ? ' — ' + esc(names[i]) : '') + '</li>';
    }).join('');
    var bits = [];
    bits.push('<div class="p-ref">' + esc(p.count || refs.length) + '-fer candidate</div>');
    bits.push('<div class="p-name">' + esc(refs.join(' + ')) + '</div>');
    bits.push('<ul>' + items + '</ul>');
    var meta = [];
    if (p.kind) meta.push(esc(p.kind));
    if (p.areaHa != null) meta.push(PSM.fmt.num(Math.round(p.areaHa)) + ' ha');
    if (p.summits && p.summits.length) meta.push('summit: ' + esc(p.summits.join(', ')));
    if (meta.length) bits.push('<div class="p-meta">' + meta.join(' · ') + '</div>');
    bits.push('<a class="p-details" href="#">Details</a>');
    return popupEl('zone', bits.join(''), 'zone', p.id);
  }

  function spotPopup(sp) {
    var bits = [];
    bits.push('<div class="p-ref">' + esc((sp.program || '').toUpperCase()) + ' spot · ' + esc(sp.ref || '') + '</div>');
    bits.push('<div class="p-name">' + esc(sp.activator || 'unknown') + '</div>');
    var line = [];
    if (sp.freqKHz != null) line.push(PSM.fmt.freq(sp.freqKHz));
    if (sp.mode) line.push(esc(sp.mode));
    if (sp.timeISO) line.push(PSM.fmt.ago(sp.timeISO));
    if (line.length) bits.push('<div class="p-meta">' + line.join(' · ') + '</div>');
    if (sp.name) bits.push('<div class="p-meta">' + esc(sp.name) + '</div>');
    if (sp.comments) bits.push('<div class="p-meta">“' + esc(sp.comments) + '”</div>');
    if (sp.spotter) bits.push('<div class="p-meta">spotted by ' + esc(sp.spotter) + '</div>');
    if (sp.ref) bits.push('<a class="p-details" href="#">Details</a>');
    return popupEl('spot', bits.join(''), sp.program === 'sota' ? 'summit' : 'park', sp.ref);
  }

  /* ---------------------------------------------------------------- */
  /* Icons                                                             */
  /* ---------------------------------------------------------------- */
  /** "mine" | "attempted" | "none" from PSM.mylog, degrading quietly when the module is absent. */
  function mylogState(kind, id) {
    if (!PSM.mylog) return 'none';
    if (PSM.mylog.isActivated(kind, id)) return 'mine';
    if (PSM.mylog.isAttempted(kind, id)) return 'attempted';
    return 'none';
  }

  function summitIcon(s) {
    var combo = comboByCode.get(s.code);
    var cls = 'psm-summit-icon';
    if (combo) cls += ' combo';
    if (selected.kind === 'summit' && selected.id === s.code) cls += ' selected';
    var mine = mylogState('sota', s.code);
    if (mine === 'mine') cls += ' psm-summit-mine';
    else if (mine === 'attempted') cls += ' psm-attempted';
    var html = '<div class="tri' + (s.actCount === 0 ? ' unact' : '') + '"></div>';
    if (mine === 'mine') html += '<span class="mcheck" aria-hidden="true">✓</span>';
    if (combo && combo.refs && combo.refs.length) {
      html += '<span class="cbadge">' + (combo.refs.length + 1) + '</span>';
    }
    return L.divIcon({ className: cls, html: html, iconSize: [18, 15], iconAnchor: [9, 13], popupAnchor: [0, -12] });
  }

  function parkStyle(p, isSelected) {
    // Activated-by-you wins over every other visual state, including "never activated by anyone".
    var mine = mylogState('pota', p.ref);
    if (mine === 'mine') {
      return {
        className: 'psm-park-mine',
        radius: isSelected ? 10 : 7,
        color: isSelected ? COLORS.mineDark : '#ffffff',
        weight: isSelected ? 3 : 2.5,
        opacity: 1,
        fillColor: COLORS.mine,
        fillOpacity: 0.95
      };
    }
    // Never-activated (by anyone) parks are drawn hollow: white fill, green ring.
    var never = p.activations === 0;
    var style = {
      radius: isSelected ? 10 : 7,
      color: isSelected ? COLORS.potaDark : (never ? COLORS.pota : '#ffffff'),
      weight: isSelected ? 3 : (never ? 2.5 : 2),
      opacity: 1,
      fillColor: never ? '#ffffff' : COLORS.pota,
      fillOpacity: never ? 1 : 0.92
    };
    // Attempted-but-not-activated-by-you overlays a thin dashed teal ring on top of that shape.
    if (mine === 'attempted') {
      style.className = 'psm-attempted';
      style.color = COLORS.mine;
      style.weight = isSelected ? 3 : 2;
      style.dashArray = isSelected ? '3 3' : '2 3';
    }
    return style;
  }

  /* ---------------------------------------------------------------- */
  /* Public API                                                        */
  /* ---------------------------------------------------------------- */
  var api = {};

  api.available = function () { return !!(L && L.map); };
  api.isClustered = function () { return clustered; };

  api.init = function (containerId) {
    if (!L || !L.map) { log('Leaflet did not load — the map is unavailable.', 'error'); return null; }
    if (map) return map;
    var el = document.getElementById(containerId || 'map');
    if (!el) { log('Map container #' + containerId + ' not found', 'error'); return null; }

    map = L.map(el, {
      zoomControl: true,
      worldCopyJump: true,
      preferCanvas: false,
      zoomSnap: 0.5,
      // An explicit maxZoom keeps map.getMaxZoom() finite, which
      // Leaflet.markercluster requires when its group is added to the map.
      minZoom: 2,
      maxZoom: 19,
      center: [39.5, -98.35],
      zoom: 4
    });

    if (typeof L.markerClusterGroup !== 'function') {
      log('Leaflet.markercluster not available — markers will not be clustered.', 'warn');
    }

    api.setBasemap((PSM.settings && PSM.settings.basemap) || 'osm');

    layers.parks = makeGroup('pota').addTo(map);
    layers.summits = makeGroup('sota').addTo(map);
    layers.boundaries = L.layerGroup().addTo(map);
    // The open park's own boundary highlight. Deliberately its own group: it is
    // not part of the n-fer result and #toggle-boundaries must not hide it.
    layers.parkBoundary = L.layerGroup().addTo(map);
    layers.zones = L.layerGroup().addTo(map);
    layers.spots = L.layerGroup().addTo(map);
    layers.center = L.layerGroup().addTo(map);

    L.control.scale({ imperial: true, metric: true, position: 'bottomleft' }).addTo(map);
    addLegend();

    // Shift-click (desktop) / long-press (touch, arrives as contextmenu) = "search here".
    map.on('click', function (e) {
      if (e.originalEvent && (e.originalEvent.shiftKey || e.originalEvent.metaKey)) {
        emit('psm:searchhere', { lat: e.latlng.lat, lon: e.latlng.lng });
      }
    });
    map.on('contextmenu', function (e) {
      emit('psm:searchhere', { lat: e.latlng.lat, lon: e.latlng.lng });
    });

    return map;
  };

  function addLegend() {
    try {
      var ctl = L.control({ position: 'bottomright' });
      ctl.onAdd = function () {
        var d = L.DomUtil.create('div', 'psm-legend');
        d.innerHTML =
          '<div class="li"><i class="pota"></i> POTA park</div>' +
          '<div class="li"><i class="sota"></i> SOTA summit</div>' +
          '<div class="li"><i class="zone"></i> Multi-activation zone</div>' +
          '<div class="li"><i class="spot"></i> Live spot</div>' +
          '<div class="li"><i class="mine"></i> activated by you</div>' +
          '<div class="li hint"><i class="hollow"></i> never activated</div>';
        L.DomEvent.disableClickPropagation(d);
        return d;
      };
      ctl.addTo(map);
    } catch (e) { /* legend is cosmetic */ }
  }

  api.getMap = function () { return map; };

  api.setBasemap = function (key) {
    if (!map) return;
    var def = BASEMAPS[key] || BASEMAPS.osm;
    baseKey = BASEMAPS[key] ? key : 'osm';
    if (baseLayer) { map.removeLayer(baseLayer); baseLayer = null; }
    baseLayer = L.tileLayer(def.url, def.options).addTo(map);
    baseLayer.setZIndex(0);
    return baseKey;
  };

  api.basemaps = BASEMAPS;

  api.invalidateSize = function () {
    if (!map) return;
    try { map.invalidateSize({ animate: false }); } catch (e) { /* ignore */ }
  };

  api.flyTo = function (lat, lon, zoom) {
    if (!map || lat == null || lon == null) return;
    var z = zoom == null ? Math.max(map.getZoom(), 13) : zoom;
    if (reducedMotion()) map.setView([lat, lon], z, { animate: false });
    else map.flyTo([lat, lon], z, { duration: 0.7 });
  };

  api.setCenter = function (center, radiusKm, opts) {
    if (!map || !center) return;
    opts = opts || {};
    layers.center.clearLayers();
    var icon = L.divIcon({
      className: 'psm-center-icon',
      html: '<div class="psm-center-dot"></div>',
      iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -10]
    });
    centerMarker = L.marker([center.lat, center.lon], { icon: icon, keyboard: false, zIndexOffset: 500 })
      .bindPopup(popupEl('center', '<div class="p-name">' + esc(center.label || 'Search centre') + '</div>' +
        '<div class="p-meta">' + esc(PSM.fmt.latlon(center.lat, center.lon)) + '</div>'))
      .addTo(layers.center);
    var r = Math.max(0.1, radiusKm || 0) * 1000;
    centerCircle = L.circle([center.lat, center.lon], {
      radius: r, color: COLORS.spot, weight: 1.5, opacity: 0.55,
      fillColor: COLORS.spot, fillOpacity: 0.055, dashArray: '5 6', interactive: false
    }).addTo(layers.center);
    if (opts.fit !== false) {
      try { map.fitBounds(centerCircle.getBounds(), { padding: [24, 24], animate: !reducedMotion() }); } catch (e) { /* ignore */ }
    }
  };

  /* --- parks -------------------------------------------------------- */
  function makeFilter(filter) {
    if (typeof filter === 'function') return filter;
    if (filter && typeof filter === 'object') {
      return function (o) {
        if (filter.unactivatedOnly && !(o.activations === 0)) return false;
        if (filter.minPoints && !(Number(o.points) >= Number(filter.minPoints))) return false;
        if (filter.mine && filter.mine !== 'all') {
          // Parks carry .ref, summits carry .code — that alone tells the two apart here.
          var kind = o.ref != null ? 'pota' : 'sota';
          var id = o.ref != null ? o.ref : o.code;
          var isMine = mylogState(kind, id) === 'mine';
          if (filter.mine === 'mine' && !isMine) return false;
          if (filter.mine === 'new' && isMine) return false;
        }
        return true;
      };
    }
    return function () { return true; };
  }

  api.renderParks = function (parks, opts) {
    if (!map) return;
    opts = opts || {};
    var keep = makeFilter(opts.filter);
    layers.parks.clearLayers();
    parkMarkers.clear();
    parkByRef.clear();
    var list = (parks || []).filter(function (p) { return p && p.lat != null && p.lon != null; });
    var batch = [];
    list.forEach(function (p) {
      parkByRef.set(p.ref, p);
      if (!keep(p)) return;
      var m = L.circleMarker([p.lat, p.lon], parkStyle(p, selected.kind === 'park' && selected.id === p.ref));
      m.psmKind = 'park'; m.psmId = p.ref;
      m.bindPopup(function () { return parkPopup(p); }, { autoPanPadding: [24, 24] });
      parkMarkers.set(p.ref, m);
      batch.push(m);
    });
    if (batch.length) {
      if (typeof layers.parks.addLayers === 'function') layers.parks.addLayers(batch);
      else batch.forEach(function (m) { layers.parks.addLayer(m); });
    }
    api.setLayerVisible('pota', visible.pota);
    return batch.length;
  };

  /* --- summits ------------------------------------------------------ */
  api.renderSummits = function (summits, opts) {
    if (!map) return;
    opts = opts || {};
    var keep = makeFilter(opts.filter);
    layers.summits.clearLayers();
    summitMarkers.clear();
    summitByCode.clear();
    var batch = [];
    (summits || []).forEach(function (s) {
      if (!s || s.lat == null || s.lon == null) return;
      summitByCode.set(s.code, s);
      if (!keep(s)) return;
      var m = L.marker([s.lat, s.lon], { icon: summitIcon(s), riseOnHover: true, title: s.name || s.code });
      m.psmKind = 'summit'; m.psmId = s.code; m.psmData = s;
      m.bindPopup(function () { return summitPopup(s); }, { autoPanPadding: [24, 24] });
      summitMarkers.set(s.code, m);
      batch.push(m);
    });
    if (batch.length) {
      if (typeof layers.summits.addLayers === 'function') layers.summits.addLayers(batch);
      else batch.forEach(function (m) { layers.summits.addLayer(m); });
    }
    api.setLayerVisible('sota', visible.sota);
    return batch.length;
  };

  function refreshSummitIcons() {
    summitMarkers.forEach(function (m) {
      if (m.psmData && m.setIcon) m.setIcon(summitIcon(m.psmData));
    });
  }

  /** Repaint just these summit markers (selection changes touch at most two). */
  function refreshSummitIcon(code) {
    if (!code) return;
    var m = summitMarkers.get(code);
    if (m && m.psmData && m.setIcon) m.setIcon(summitIcon(m.psmData));
  }

  /* --- n-fer zones + boundaries ------------------------------------- */
  api.renderZones = function (nfer) {
    if (!map) return;
    layers.zones.clearLayers();
    layers.boundaries.clearLayers();
    zoneLayers.clear();
    comboByCode.clear();
    if (!nfer) { refreshSummitIcons(); return 0; }

    // Matched OSM boundaries: dashed outlines, toggled by #toggle-boundaries.
    if (nfer.boundaries && nfer.boundaries.features && nfer.boundaries.features.length) {
      try {
        L.geoJSON(nfer.boundaries, {
          style: function (f) {
            var trail = f.properties && f.properties.kind === 'trail';
            return {
              color: COLORS.boundary,
              weight: trail ? 2.5 : 1.6,
              opacity: 0.85,
              dashArray: trail ? '2 6' : '6 5',
              fill: false,
              interactive: false
            };
          },
          onEachFeature: function (f, lyr) {
            var p = f.properties || {};
            if (p.name || (p.refs && p.refs.length)) {
              lyr.bindTooltip(esc((p.refs || []).join(', ') + (p.name ? ' — ' + p.name : '')), { sticky: true });
            }
          }
        }).addTo(layers.boundaries);
      } catch (e) { log('Could not draw OSM boundaries: ' + (e && e.message), 'warn'); }
    }

    // Overlap zones.
    var n = 0;
    if (nfer.zones && nfer.zones.features) {
      nfer.zones.features.forEach(function (f) {
        var p = f.properties || {};
        var deep = (p.count || 0) >= 3;
        try {
          var lyr = L.geoJSON(f, {
            style: {
              color: deep ? COLORS.zone3 : COLORS.zone2,
              weight: 2, opacity: 0.95,
              fillColor: deep ? COLORS.zone3 : COLORS.zone2,
              fillOpacity: 0.35
            }
          });
          lyr.bindPopup(function () { return zonePopup(f); }, { maxWidth: 280 });
          lyr.addTo(layers.zones);
          if (p.id) zoneLayers.set(p.id, lyr);
          n++;
        } catch (e) { /* skip broken geometry */ }
      });
    }

    (nfer.summitCombos || []).forEach(function (c) { if (c && c.code) comboByCode.set(c.code, c); });
    refreshSummitIcons();
    api.setLayerVisible('boundaries', visible.boundaries);
    return n;
  };

  /* --- the open park's OSM boundary --------------------------------- */
  /**
   * Draw ONE park's boundary (from PSM.nfer.parkBoundary / boundaryFromAnalysis).
   * Calling it again replaces whatever was drawn before — only ever one park is
   * highlighted, the one whose detail panel is open.  Non-interactive, so a
   * click inside the polygon still reaches the park/summit markers under it.
   *
   * @param {string} ref  the POTA reference the shapes belong to
   * @param {Object} fc   GeoJSON FeatureCollection
   * @param {Object} [opts] {focus:false} — pass focus:true to also zoom to it
   * @returns {number} how many shapes were drawn (0 = nothing usable)
   */
  api.showParkBoundary = function (ref, fc, opts) {
    if (!map) return 0;
    opts = opts || {};
    api.clearParkBoundary();
    if (!fc || !fc.features || !fc.features.length) return 0;
    var drawn = 0;
    var lyr;
    try {
      lyr = L.geoJSON(null, {
        // Set at construction so the class and the non-interactivity are on the
        // <path> from the moment Leaflet creates it.
        className: 'psm-selected-boundary',
        interactive: false,
        style: function (f) {
          var line = !!(f && f.geometry && /LineString$/.test(f.geometry.type));
          return {
            className: 'psm-selected-boundary',
            color: COLORS.potaDark,
            weight: line ? 4 : 3,
            opacity: 0.95,
            dashArray: null,               // solid: this one is the answer, not a candidate
            fill: !line,
            fillColor: COLORS.pota,
            fillOpacity: 0.14,
            interactive: false
          };
        }
      });
    } catch (e) {
      log('Could not draw the boundary for ' + ref + ': ' + (e && e.message), 'warn');
      return 0;
    }
    // One feature at a time: a single unusable ring must not lose the others.
    fc.features.forEach(function (f) {
      try { lyr.addData(f); drawn++; } catch (e) {
        log('Skipped one boundary shape of ' + ref + ': ' + (e && e.message), 'warn');
      }
    });
    if (!drawn) return 0;
    lyr.addTo(layers.parkBoundary);
    parkBoundaryLayer = lyr;
    parkBoundaryRef = ref || null;
    if (opts.focus) api.zoomToParkBoundary();
    return drawn;
  };

  api.clearParkBoundary = function () {
    parkBoundaryLayer = null;
    parkBoundaryRef = null;
    if (layers.parkBoundary && layers.parkBoundary.clearLayers) layers.parkBoundary.clearLayers();
  };

  /** The drawn boundary's LatLngBounds, or null when nothing is drawn. */
  api.parkBoundaryBounds = function () {
    if (!parkBoundaryLayer || !parkBoundaryLayer.getBounds) return null;
    try {
      var b = parkBoundaryLayer.getBounds();
      return (b && b.isValid && b.isValid()) ? b : null;
    } catch (e) { return null; }
  };

  /** Which park is highlighted right now (null when none). */
  api.parkBoundaryRef = function () { return parkBoundaryRef; };

  api.zoomToParkBoundary = function () {
    var b = api.parkBoundaryBounds();
    if (!map || !b) return false;
    try { map.fitBounds(b, { padding: [40, 40], animate: !reducedMotion() }); } catch (e) { return false; }
    return true;
  };

  /* --- live spots --------------------------------------------------- */
  function normalizeSpots(spots) {
    if (!spots) return [];
    if (Array.isArray(spots)) return spots;
    return [].concat(spots.pota || [], spots.sota || []);
  }

  api.renderSpots = function (spots, ctx) {
    if (!map) return 0;
    ctx = ctx || {};
    layers.spots.clearLayers();
    var list = normalizeSpots(spots);
    if (!list.length) { api.setLayerVisible('spots', visible.spots); return 0; }

    var parkIdx = new Map();
    (ctx.parks || []).forEach(function (p) { if (p && p.ref) parkIdx.set(p.ref, p); });
    parkByRef.forEach(function (v, k) { if (!parkIdx.has(k)) parkIdx.set(k, v); });
    var summitIdx = new Map();
    (ctx.summits || []).forEach(function (s) { if (s && s.code) summitIdx.set(s.code, s); });
    summitByCode.forEach(function (v, k) { if (!summitIdx.has(k)) summitIdx.set(k, v); });

    var drawn = 0;
    list.forEach(function (sp) {
      if (!sp) return;
      var lat = sp.lat, lon = sp.lon, src = null;
      if (lat == null || lon == null) {
        src = sp.program === 'sota' ? summitIdx.get(sp.ref) : parkIdx.get(sp.ref);
        if (src) { lat = src.lat; lon = src.lon; }
      }
      if (lat == null || lon == null) return; // unresolvable (e.g. a SOTA spot outside the loaded area)
      var icon = L.divIcon({
        className: 'psm-spot-icon' + (sp.program === 'sota' ? ' sota' : ''),
        html: '<div class="pulse"></div><div class="dot"></div>',
        iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -12]
      });
      var m = L.marker([lat, lon], { icon: icon, zIndexOffset: 400, title: (sp.activator || '') + ' ' + (sp.ref || '') });
      m.bindPopup(function () { return spotPopup(sp); }, { autoPanPadding: [24, 24] });
      m.addTo(layers.spots);
      drawn++;
    });
    api.setLayerVisible('spots', visible.spots);
    return drawn;
  };

  /* --- selection ---------------------------------------------------- */
  api.highlight = function (kind, id, opts) {
    opts = opts || {};
    var prev = selected;
    selected = { kind: kind || null, id: id || null };

    if (prev.kind === 'park' && parkMarkers.has(prev.id)) {
      var pm = parkMarkers.get(prev.id);
      pm.setStyle(parkStyle(parkByRef.get(prev.id) || {}, false));
    }
    if (kind === 'park' && parkMarkers.has(id)) {
      var m = parkMarkers.get(id);
      m.setStyle(parkStyle(parkByRef.get(id) || {}, true));
      if (m.bringToFront) m.bringToFront();
      panToLayer(m, opts);
    }
    // Only the two summits whose selected state actually changed need a new icon — repainting
    // every marker on every click is a few hundred DOM writes for nothing.
    if (prev.kind === 'summit') refreshSummitIcon(prev.id);
    if (kind === 'summit') refreshSummitIcon(id);
    if (kind === 'summit' && summitMarkers.has(id)) panToLayer(summitMarkers.get(id), opts);

    zoneLayers.forEach(function (lyr, zid) {
      try {
        lyr.setStyle({ weight: zid === id && kind === 'zone' ? 4 : 2 });
      } catch (e) { /* ignore */ }
    });
    if (kind === 'zone' && zoneLayers.has(id)) {
      var zl = zoneLayers.get(id);
      try { if (opts.zoom) map.fitBounds(zl.getBounds(), { padding: [40, 40] }); } catch (e) { /* ignore */ }
    }
  };

  function panToLayer(m, opts) {
    if (!map || !m || !m.getLatLng) return;
    var ll = m.getLatLng();
    var inView = map.getBounds().pad(-0.12).contains(ll);
    if (opts && opts.zoom) { api.flyTo(ll.lat, ll.lng, opts.zoom === true ? 14 : opts.zoom); return; }
    if (!inView) map.panTo(ll, { animate: !reducedMotion() });
  }

  api.openPopup = function (kind, id) {
    var m = kind === 'park' ? parkMarkers.get(id) : (kind === 'summit' ? summitMarkers.get(id) : zoneLayers.get(id));
    if (!m) return false;
    try {
      if (layers.parks.zoomToShowLayer && kind === 'park' && layers.parks.hasLayer(m)) {
        layers.parks.zoomToShowLayer(m, function () { m.openPopup(); });
      } else m.openPopup();
      return true;
    } catch (e) { return false; }
  };

  api.setLayerVisible = function (kind, on) {
    if (!map) return;
    visible[kind] = !!on;
    var lyr = kind === 'pota' ? layers.parks
      : kind === 'sota' ? layers.summits
        : kind === 'spots' ? layers.spots
          : kind === 'boundaries' ? layers.boundaries : null;
    if (!lyr) return;
    if (on && !map.hasLayer(lyr)) map.addLayer(lyr);
    else if (!on && map.hasLayer(lyr)) map.removeLayer(lyr);
  };

  api.clear = function () {
    if (!map) return;
    ['parks', 'summits', 'zones', 'boundaries', 'parkBoundary', 'spots', 'center'].forEach(function (k) {
      if (layers[k] && layers[k].clearLayers) layers[k].clearLayers();
    });
    parkBoundaryLayer = null; parkBoundaryRef = null;
    parkMarkers.clear(); summitMarkers.clear(); zoneLayers.clear();
    parkByRef.clear(); summitByCode.clear(); comboByCode.clear();
    centerMarker = null; centerCircle = null;
    selected = { kind: null, id: null };
  };

  api.fitToResults = function () {
    if (!map) return;
    var pts = [];
    parkMarkers.forEach(function (m) { pts.push(m.getLatLng()); });
    summitMarkers.forEach(function (m) { pts.push(m.getLatLng()); });
    if (pts.length > 1) { try { map.fitBounds(L.latLngBounds(pts), { padding: [30, 30] }); } catch (e) { /* ignore */ } }
  };

  PSM.mapui = api;

})(typeof window !== 'undefined' ? window : globalThis);
