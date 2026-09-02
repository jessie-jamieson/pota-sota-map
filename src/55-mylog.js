/* =====================================================================
 * 55-mylog.js — PSM.mylog: the operator's own activation / hunter log.
 *
 * Pure data (no DOM, no Leaflet): which POTA parks and SOTA summits *this*
 * user has activated (or attempted, or hunted), kept in localStorage under
 * `psm.mylog.v1` with an in-memory copy so private-mode browsers still work
 * for the session.
 *
 * Entries can be created by hand (mark/unmark) or imported from a log file —
 * ADIF, the POTA "Park List" CSV, the SOTA V2 CSV (activator or chaser), our
 * own JSON export, or a bare list of references. Imports MERGE and never
 * delete: within one import counters are summed, across imports the maximum
 * of each counter wins, with the earliest `first` and the latest `last`.
 *
 * Validity thresholds (used to decide whether a day counts as an activation):
 *   POTA: ≥ 10 QSOs at one reference on one UTC date
 *   SOTA: ≥ 4 QSOs from one summit on one UTC date
 * ===================================================================== */
(function (global) {
  'use strict';

  var PSM = global.PSM || (global.PSM = {});

  var STORAGE_KEY = 'psm.mylog.v1';
  var VERSION = 1;
  var POTA_MIN_QSOS = 10;   // POTA: a valid activation needs 10 QSOs in one UTC day
  var SOTA_MIN_QSOS = 4;    // SOTA General Rules: 4 QSOs make an activation

  // Which import knows most about a reference — a later, poorer import never
  // downgrades the recorded provenance.
  var SOURCE_RANK = { manual: 1, refs: 2, json: 3, 'sota-csv': 4, 'pota-csv': 5, adif: 6 };

  var FORMAT_LABEL = {
    adif: 'ADIF', 'pota-csv': 'POTA park list', 'sota-csv': 'SOTA CSV',
    json: 'JSON', refs: 'reference list'
  };

  function log(msg, level) { if (PSM.log) PSM.log(msg, level); }
  function isKind(k) { return k === 'pota' || k === 'sota'; }

  function normId(kind, id) {
    if (!isKind(kind) || id == null) return null;
    if (kind === 'pota') return PSM.normalizePotaRef ? PSM.normalizePotaRef(id) : String(id).toUpperCase();
    return PSM.normalizeSotaRef ? PSM.normalizeSotaRef(id) : String(id).toUpperCase();
  }

  function intOr(v, dflt) {
    var n = parseInt(String(v == null ? '' : v).replace(/[^0-9-]/g, ''), 10);
    return isFinite(n) && !isNaN(n) ? n : (dflt || 0);
  }

  /** "20260504" | "2026-05-04" | Date-ish → "2026-05-04"; anything else → null. */
  function isoDate(v) {
    if (v == null || v === '') return null;
    var s = String(v).trim();
    var m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    return null;
  }

  /** SOTA CSV dates: "13/05/24" or "13/05/2024" (DD/MM/YY[YY]) → ISO. */
  function sotaDate(v) {
    var m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s*$/.exec(String(v == null ? '' : v));
    if (!m) return isoDate(v);
    var d = m[1].length === 1 ? '0' + m[1] : m[1];
    var mo = m[2].length === 1 ? '0' + m[2] : m[2];
    var y = m[3];
    if (y.length === 2) y = (Number(y) <= 69 ? '20' : '19') + y;
    return y + '-' + mo + '-' + d;
  }

  function minDate(a, b) { if (!a) return b || null; if (!b) return a; return a < b ? a : b; }
  function maxDate(a, b) { if (!a) return b || null; if (!b) return a; return a > b ? a : b; }

  function blankEntry() {
    return {
      activated: false, activations: 0, attempts: 0, qsos: 0,
      first: null, last: null, hunted: null, source: 'manual', note: ''
    };
  }

  function sanitizeHunted(h) {
    if (!h || typeof h !== 'object') return null;
    var q = intOr(h.qsos, 0);
    var last = isoDate(h.last);
    if (q <= 0 && !last) return null;
    return { qsos: Math.max(0, q), last: last };
  }

  /** Coerce anything that arrives from storage / a JSON import into a valid entry. */
  function sanitizeEntry(e) {
    if (!e || typeof e !== 'object') return null;
    var out = blankEntry();
    out.activations = Math.max(0, intOr(e.activations, 0));
    out.attempts = Math.max(0, intOr(e.attempts, 0));
    out.qsos = Math.max(0, intOr(e.qsos, 0));
    out.activated = !!e.activated || out.activations > 0;
    out.first = isoDate(e.first);
    out.last = isoDate(e.last);
    out.hunted = sanitizeHunted(e.hunted);
    out.source = SOURCE_RANK[e.source] ? e.source : 'json';
    out.note = e.note == null ? '' : String(e.note);
    if (!out.activated && !out.attempts && !out.qsos && !out.hunted && !out.note) return null;
    return out;
  }

  function bestSource(a, b) {
    return (SOURCE_RANK[b] || 0) > (SOURCE_RANK[a] || 0) ? b : (a || b || 'manual');
  }

  /** Across imports: max of every counter, earliest first, latest last, activated = any. */
  function mergeEntry(cur, add) {
    var out = {
      activated: !!(cur.activated || add.activated),
      activations: Math.max(cur.activations || 0, add.activations || 0),
      attempts: Math.max(cur.attempts || 0, add.attempts || 0),
      qsos: Math.max(cur.qsos || 0, add.qsos || 0),
      first: minDate(cur.first, add.first),
      last: maxDate(cur.last, add.last),
      hunted: null,
      source: bestSource(cur.source, add.source),
      note: add.note || cur.note || ''
    };
    if (cur.hunted || add.hunted) {
      var ch = cur.hunted || { qsos: 0, last: null };
      var ah = add.hunted || { qsos: 0, last: null };
      out.hunted = { qsos: Math.max(ch.qsos || 0, ah.qsos || 0), last: maxDate(ch.last, ah.last) };
    }
    if (out.activations > 0) out.activated = true;
    if (out.attempts < out.activations) out.attempts = out.activations;
    return out;
  }

  function copyEntry(e) {
    if (!e) return null;
    var c = {
      activated: !!e.activated, activations: e.activations || 0, attempts: e.attempts || 0,
      qsos: e.qsos || 0, first: e.first || null, last: e.last || null,
      hunted: null, source: e.source || 'manual', note: e.note || ''
    };
    if (e.hunted) c.hunted = { qsos: e.hunted.qsos || 0, last: e.hunted.last || null };
    return c;
  }

  /* ------------------------------------------------------------------ */
  /* Storage                                                             */
  /* ------------------------------------------------------------------ */
  function emptyStore() { return { version: VERSION, updated: null, pota: {}, sota: {} }; }

  function loadStore() {
    var s = emptyStore();
    var raw = null;
    try { raw = global.localStorage && global.localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
    if (!raw) return s;
    try {
      var o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return s;
      s.updated = typeof o.updated === 'string' ? o.updated : null;
      ['pota', 'sota'].forEach(function (kind) {
        var src = o[kind];
        if (!src || typeof src !== 'object') return;
        Object.keys(src).forEach(function (key) {
          var id = normId(kind, key);
          var e = sanitizeEntry(src[key]);
          if (id && e) s[kind][id] = s[kind][id] ? mergeEntry(s[kind][id], e) : e;
        });
      });
    } catch (e) {
      log('my activations: stored log could not be read (' + ((e && e.message) || e) + ') — starting empty.', 'warn');
    }
    return s;
  }

  var store = loadStore();
  var listeners = [];

  function save() {
    store.updated = new Date().toISOString();
    try {
      if (global.localStorage) global.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (e) {
      // Private mode / quota: the in-memory copy still drives this session.
      log('my activations: could not save to this browser (' + ((e && e.message) || e) + ').', 'warn');
    }
  }

  function fire(reason) {
    listeners.forEach(function (fn) {
      try { fn(reason, api.stats()); } catch (e) { log('my activations: onChange listener failed — ' + ((e && e.message) || e), 'warn'); }
    });
  }

  /* ------------------------------------------------------------------ */
  /* ADIF                                                                */
  /* ------------------------------------------------------------------ */
  // <NAME:len[:type]>value, plus the length-less markers <EOH> / <EOR>.
  var TAG_RE = /<([A-Za-z0-9_./\\-]+)(?::(\d+))?(?::([^>]*))?>/g;

  function splitRefs(v) {
    if (!v) return [];
    return String(v).split(/[,;\s]+/).map(function (t) {
      // ADIF 3.1.4 allows a location suffix on each item: "US-2069@US-NY".
      return normId('pota', t.split('@')[0]);
    }).filter(Boolean);
  }

  function uniq(list) {
    var seen = {}, out = [];
    list.forEach(function (v) { if (v && !seen[v]) { seen[v] = 1; out.push(v); } });
    return out;
  }

  function recordFromFields(f) {
    var myPota = splitRefs(f.MY_POTA_REF);
    var mySota = normId('sota', (f.MY_SOTA_REF || '').split('@')[0]);
    var mySig = String(f.MY_SIG || '').trim().toUpperCase();
    if (mySig === 'POTA') myPota = myPota.concat(splitRefs(f.MY_SIG_INFO));
    else if (mySig === 'SOTA' && !mySota) mySota = normId('sota', f.MY_SIG_INFO);

    var pota = splitRefs(f.POTA_REF);
    var sota = normId('sota', (f.SOTA_REF || '').split('@')[0]);
    var sig = String(f.SIG || '').trim().toUpperCase();
    if (sig === 'POTA') pota = pota.concat(splitRefs(f.SIG_INFO));
    else if (sig === 'SOTA' && !sota) sota = normId('sota', f.SIG_INFO);

    return {
      date: isoDate(f.QSO_DATE),
      myPota: uniq(myPota), mySota: mySota,
      pota: uniq(pota), sota: sota,
      call: f.CALL || null
    };
  }

  /** Parse ADIF text into QSO records (exported for tests). */
  function parseADIF(text) {
    var s = String(text == null ? '' : text);
    var out = [];
    var fields = {};
    var any = false;
    var m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(s))) {
      var name = String(m[1]).trim().toUpperCase();
      var after = m.index + m[0].length;
      if (name === 'EOR') {
        if (any) out.push(recordFromFields(fields));
        fields = {}; any = false;
        continue;
      }
      if (name === 'EOH') { fields = {}; any = false; continue; }  // drop the header block
      if (m[2] == null) continue;                                   // a marker we do not know
      var len = parseInt(m[2], 10) || 0;
      fields[name] = s.substr(after, len);
      any = true;
      TAG_RE.lastIndex = after + len;
    }
    if (any) out.push(recordFromFields(fields));   // tolerate a missing final <EOR>
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Import aggregation                                                  */
  /* ------------------------------------------------------------------ */
  /** One import's working set: per reference, QSOs per UTC day plus hunter QSOs. */
  function newAgg() { return { pota: {}, sota: {} }; }

  function addActivatorQso(agg, kind, id, date, n) {
    if (!id) return false;
    var bucket = agg[kind][id] || (agg[kind][id] = { days: {}, qsos: 0, undated: 0 });
    var q = n == null ? 1 : n;
    bucket.qsos += q;
    if (date) bucket.days[date] = (bucket.days[date] || 0) + q;
    else bucket.undated += q;
    return true;
  }

  function addHunterQso(agg, kind, id, date, n) {
    if (!id) return false;
    var bucket = agg[kind][id] || (agg[kind][id] = { days: {}, qsos: 0, undated: 0 });
    bucket.hunt = bucket.hunt || { qsos: 0, last: null };
    bucket.hunt.qsos += (n == null ? 1 : n);
    bucket.hunt.last = maxDate(bucket.hunt.last, date);
    return true;
  }

  /** Turn one reference's aggregated days into an entry delta. */
  function entryFromBucket(kind, bucket, source) {
    var minQ = kind === 'pota' ? POTA_MIN_QSOS : SOTA_MIN_QSOS;
    var days = Object.keys(bucket.days).sort();
    var valid = days.filter(function (d) { return bucket.days[d] >= minQ; });
    var e = blankEntry();
    e.source = source;
    e.activations = valid.length;
    e.attempts = days.length;
    e.qsos = bucket.qsos;
    e.activated = valid.length > 0;
    e.first = days.length ? days[0] : null;
    e.last = days.length ? days[days.length - 1] : null;
    if (bucket.hunt) e.hunted = { qsos: bucket.hunt.qsos, last: bucket.hunt.last };
    return e;
  }

  function blankResult(format) {
    return {
      format: format || null,
      added: { pota: 0, sota: 0 }, updated: { pota: 0, sota: 0 },
      hunted: { pota: 0, sota: 0 }, qsos: 0, warnings: []
    };
  }

  /**
   * Does this delta carry anything worth telling the user about? A hunted-only
   * delta (activated/attempts/qsos all still 0) still counts — it is brand-new
   * information about a reference the store may never have seen before, so it
   * belongs in added/updated just as much as an activation does.
   */
  function deltaHasData(delta) {
    return !!(delta.activated || delta.attempts > 0 || delta.qsos > 0 || delta.hunted);
  }

  /** Merge one import's aggregate into the store and fill in the result counters. */
  function commitAgg(agg, source, res) {
    ['pota', 'sota'].forEach(function (kind) {
      Object.keys(agg[kind]).forEach(function (id) {
        var delta = entryFromBucket(kind, agg[kind][id], source);
        var existed = Object.prototype.hasOwnProperty.call(store[kind], id);
        var cur = existed ? store[kind][id] : blankEntry();
        store[kind][id] = mergeEntry(cur, delta);
        if (deltaHasData(delta)) {
          if (existed) res.updated[kind]++; else res.added[kind]++;
        }
        if (delta.hunted) res.hunted[kind]++;
      });
    });
  }

  /** Merge already-built entries (JSON / reference list imports). */
  function commitEntries(entries, res) {
    ['pota', 'sota'].forEach(function (kind) {
      Object.keys(entries[kind]).forEach(function (id) {
        var delta = entries[kind][id];
        var existed = Object.prototype.hasOwnProperty.call(store[kind], id);
        var cur = existed ? store[kind][id] : blankEntry();
        store[kind][id] = mergeEntry(cur, delta);
        if (deltaHasData(delta)) {
          if (existed) res.updated[kind]++; else res.added[kind]++;
        }
        if (delta.hunted) res.hunted[kind]++;
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Format detection                                                    */
  /* ------------------------------------------------------------------ */
  function firstNonEmptyLine(text) {
    var lines = String(text || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) if (lines[i].trim()) return lines[i];
    return '';
  }

  function looksLikeOurJson(text) {
    var s = String(text || '').trim();
    if (!s || s[0] !== '{') return false;
    try {
      var o = JSON.parse(s);
      return !!(o && typeof o === 'object' && (o.pota || o.sota));
    } catch (e) { return false; }
  }

  function detect(text, filename) {
    var s = String(text == null ? '' : text);
    var name = String(filename || '').toLowerCase();
    if (/\.(adi|adif)$/.test(name) || /<eor>/i.test(s) || /<eoh>/i.test(s)) return 'adif';
    if (looksLikeOurJson(s)) return 'json';
    var head = firstNonEmptyLine(s).toLowerCase();
    if (head.indexOf('reference') >= 0 && head.indexOf('my_activations') >= 0) return 'pota-csv';
    if (/(^|\n)\s*v2\s*,/i.test(s)) return 'sota-csv';
    if (/[A-Z0-9]{1,3}\/[A-Z]{2}-\d{3}/i.test(s) || /\b[A-Z]{1,2}-\d{4,6}\b/i.test(s)) return 'refs';
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Importers                                                           */
  /* ------------------------------------------------------------------ */
  function importAdif(text, res) {
    var recs = parseADIF(text);
    var agg = newAgg();
    var undated = 0;
    recs.forEach(function (r) {
      var used = false;
      r.myPota.forEach(function (ref) { used = addActivatorQso(agg, 'pota', ref, r.date) || used; });
      if (r.mySota) used = addActivatorQso(agg, 'sota', r.mySota, r.date) || used;
      r.pota.forEach(function (ref) { used = addHunterQso(agg, 'pota', ref, r.date) || used; });
      if (r.sota) used = addHunterQso(agg, 'sota', r.sota, r.date) || used;
      if (used) {
        res.qsos++;
        if (!r.date) undated++;
      }
    });
    if (!recs.length) res.warnings.push('No ADIF records found (records end with <EOR>).');
    else if (!res.qsos) res.warnings.push('No MY_POTA_REF / MY_SOTA_REF / POTA_REF / SOTA_REF fields in ' + recs.length + ' record(s).');
    if (undated) res.warnings.push(undated + ' QSO(s) had no QSO_DATE — counted, but they cannot make a valid activation day.');
    commitAgg(agg, 'adif', res);
  }

  function headerIndex(cols, names) {
    for (var i = 0; i < names.length; i++) {
      var at = cols.indexOf(names[i]);
      if (at >= 0) return at;
    }
    return -1;
  }

  function importPotaCsv(text, res) {
    var rows = PSM.parseCSV(text);
    var hdr = -1, cols = [];
    for (var i = 0; i < rows.length && i < 10; i++) {
      var lc = rows[i].map(function (c) { return String(c == null ? '' : c).trim().toLowerCase(); });
      if (lc.indexOf('reference') >= 0 && lc.indexOf('my_activations') >= 0) { hdr = i; cols = lc; break; }
    }
    if (hdr < 0) { res.warnings.push('No POTA park-list header row (needs "reference" and "my_activations").'); return; }
    var iRef = headerIndex(cols, ['reference', 'ref']);
    var iAct = headerIndex(cols, ['my_activations']);
    var iAtt = headerIndex(cols, ['my_attempts']);
    var iQso = headerIndex(cols, ['my_qsos', 'my_activator_qsos']);
    var iHunt = headerIndex(cols, ['my_hunted_qsos', 'my_hunter_qsos']);
    var entries = { pota: {}, sota: {} };
    var skipped = 0;
    for (var r = hdr + 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row || !row.length) continue;
      var ref = normId('pota', row[iRef]);
      if (!ref) { if (String(row[iRef] || '').trim()) skipped++; continue; }
      var acts = iAct >= 0 ? intOr(row[iAct], 0) : 0;
      var hunt = iHunt >= 0 ? intOr(row[iHunt], 0) : 0;
      if (acts <= 0 && hunt <= 0) continue;
      var e = blankEntry();
      e.source = 'pota-csv';
      if (acts > 0) {
        e.activated = true;
        e.activations = acts;
        e.attempts = Math.max(acts, iAtt >= 0 ? intOr(row[iAtt], 0) : 0);
        e.qsos = iQso >= 0 ? intOr(row[iQso], 0) : 0;   // the park list carries no activator QSO count
      }
      if (hunt > 0) e.hunted = { qsos: hunt, last: null };
      entries.pota[ref] = entries.pota[ref] ? mergeEntry(entries.pota[ref], e) : e;
    }
    if (skipped) res.warnings.push(skipped + ' row(s) had an unrecognised reference and were skipped.');
    commitEntries(entries, res);
  }

  function importSotaCsv(text, res) {
    var rows = PSM.parseCSV(text);
    var agg = newAgg();
    var seen = 0;
    rows.forEach(function (row) {
      if (!row || !row.length) return;
      if (String(row[0] || '').trim().toUpperCase() !== 'V2') return;
      seen++;
      var mine = normId('sota', row[2]);
      var date = sotaDate(row[3]);
      var other = normId('sota', row.length > 8 ? row[8] : null);
      var used = false;
      if (mine) used = addActivatorQso(agg, 'sota', mine, date) || used;
      if (other) used = addHunterQso(agg, 'sota', other, date) || used;
      if (used) res.qsos++;
    });
    if (!seen) res.warnings.push('No SOTA V2 rows found (each row must start with "V2,").');
    else if (!res.qsos) res.warnings.push('No summit codes recognised in ' + seen + ' V2 row(s).');
    commitAgg(agg, 'sota-csv', res);
  }

  function importJson(text, res) {
    var o;
    try { o = JSON.parse(text); } catch (e) {
      res.warnings.push('That does not look like valid JSON (' + ((e && e.message) || e) + ').');
      return;
    }
    if (!o || typeof o !== 'object') { res.warnings.push('JSON import needs an object with "pota" / "sota" keys.'); return; }
    var entries = { pota: {}, sota: {} };
    var bad = 0;
    ['pota', 'sota'].forEach(function (kind) {
      var src = o[kind];
      if (!src || typeof src !== 'object') return;
      Object.keys(src).forEach(function (key) {
        var id = normId(kind, key);
        var e = sanitizeEntry(src[key]);
        if (!id || !e) { bad++; return; }
        entries[kind][id] = entries[kind][id] ? mergeEntry(entries[kind][id], e) : e;
      });
    });
    if (bad) res.warnings.push(bad + ' JSON entr' + (bad === 1 ? 'y was' : 'ies were') + ' unusable and skipped.');
    commitEntries(entries, res);
  }

  function importRefs(text, res) {
    var entries = { pota: {}, sota: {} };
    var tokens = String(text || '').split(/[\s,;]+/);
    tokens.forEach(function (t) {
      if (!t) return;
      var kind = null, id = null;
      if (PSM.isSotaRef && PSM.isSotaRef(t)) { kind = 'sota'; id = normId('sota', t); }
      else if (PSM.isPotaRef && PSM.isPotaRef(t)) { kind = 'pota'; id = normId('pota', t); }
      if (!kind || !id) return;
      var e = blankEntry();
      e.activated = true;
      e.source = 'refs';
      entries[kind][id] = entries[kind][id] || e;
    });
    if (!Object.keys(entries.pota).length && !Object.keys(entries.sota).length) {
      res.warnings.push('No POTA or SOTA references found in that text.');
    }
    commitEntries(entries, res);
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */
  var api = {};

  api.POTA_MIN_QSOS = POTA_MIN_QSOS;
  api.SOTA_MIN_QSOS = SOTA_MIN_QSOS;
  api.FORMAT_LABEL = FORMAT_LABEL;

  api.get = function (kind, id) {
    var key = normId(kind, id);
    if (!key) return null;
    return copyEntry(store[kind][key] || null);
  };

  api.isActivated = function (kind, id) {
    var key = normId(kind, id);
    return !!(key && store[kind][key] && store[kind][key].activated);
  };

  api.isAttempted = function (kind, id) {
    var key = normId(kind, id);
    var e = key && store[kind][key];
    return !!(e && e.attempts > 0 && !e.activated);
  };

  api.isHunted = function (kind, id) {
    var key = normId(kind, id);
    var e = key && store[kind][key];
    return !!(e && e.hunted && (e.hunted.qsos > 0 || e.hunted.last));
  };

  /** Manual mark. Keeps any imported counters; only the flag (and dates/note) change. */
  api.mark = function (kind, id, opts) {
    var key = normId(kind, id);
    if (!key) return null;
    opts = opts || {};
    var e = store[kind][key] ? copyEntry(store[kind][key]) : blankEntry();
    e.activated = true;
    var date = isoDate(opts.date);
    if (date) {
      e.first = minDate(e.first, date);
      e.last = maxDate(e.last, date);
      if (e.attempts < 1) e.attempts = 1;
    }
    if (opts.note != null) e.note = String(opts.note);
    e.source = bestSource(e.source, 'manual');
    store[kind][key] = e;
    save();
    fire('mark');
    return copyEntry(e);
  };

  api.unmark = function (kind, id) {
    var key = normId(kind, id);
    if (!key || !store[kind][key]) return false;
    var e = store[kind][key];
    // Drop the whole entry when nothing was imported for it; otherwise keep the
    // imported counters and just clear the flag the user set.
    var imported = e.activations > 0 || e.attempts > 0 || e.qsos > 0 || !!e.hunted;
    if (imported) {
      e.activated = false;
      e.activations = 0;
      if (e.note) e.note = '';
    } else {
      delete store[kind][key];
    }
    save();
    fire('unmark');
    return true;
  };

  api.all = function () {
    var out = { version: VERSION, updated: store.updated, pota: {}, sota: {} };
    ['pota', 'sota'].forEach(function (kind) {
      Object.keys(store[kind]).sort().forEach(function (id) { out[kind][id] = copyEntry(store[kind][id]); });
    });
    return out;
  };

  api.exportJSON = function () { return JSON.stringify(api.all(), null, 2); };

  api.clear = function () {
    store = emptyStore();
    save();
    fire('clear');
  };

  api.stats = function () {
    var s = { pota: 0, sota: 0, attempted: { pota: 0, sota: 0 }, hunted: { pota: 0, sota: 0 } };
    ['pota', 'sota'].forEach(function (kind) {
      Object.keys(store[kind]).forEach(function (id) {
        var e = store[kind][id];
        if (e.activated) s[kind]++;
        else if (e.attempts > 0) s.attempted[kind]++;
        if (e.hunted && (e.hunted.qsos > 0 || e.hunted.last)) s.hunted[kind]++;
      });
    });
    s.total = s.pota + s.sota;
    return s;
  };

  api.onChange = function (fn) {
    if (typeof fn !== 'function') return function () { };
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  };

  api.detect = detect;
  api.parseADIF = parseADIF;

  api.importText = function (text, opts) {
    opts = opts || {};
    var format = detect(text, opts.filename);
    var res = blankResult(format);
    if (!format) {
      res.warnings.push('Could not recognise that file — expected ADIF, a POTA park-list CSV, a SOTA CSV, our JSON export, or a list of references.');
      return res;
    }
    if (format === 'adif') importAdif(text, res);
    else if (format === 'pota-csv') importPotaCsv(text, res);
    else if (format === 'sota-csv') importSotaCsv(text, res);
    else if (format === 'json') importJson(text, res);
    else importRefs(text, res);
    save();
    fire('import');
    log('my activations: imported ' + (FORMAT_LABEL[format] || format) + ' — ' +
      (res.added.pota + res.updated.pota) + ' parks, ' + (res.added.sota + res.updated.sota) + ' summits' +
      (res.qsos ? ', ' + res.qsos + ' QSOs' : ''));
    res.warnings.forEach(function (w) { log('my activations: ' + w, 'warn'); });
    return res;
  };

  /** One-line summary of an importText() result, for the status line. */
  api.describeImport = function (res) {
    if (!res) return '';
    if (!res.format) return res.warnings[0] || 'Nothing imported.';
    var bits = [];
    var parks = res.added.pota + res.updated.pota;
    var summits = res.added.sota + res.updated.sota;
    if (parks) bits.push(parks + ' park' + (parks === 1 ? '' : 's') + (res.added.pota ? ' (' + res.added.pota + ' new)' : ''));
    if (summits) bits.push(summits + ' summit' + (summits === 1 ? '' : 's') + (res.added.sota ? ' (' + res.added.sota + ' new)' : ''));
    var hunted = res.hunted.pota + res.hunted.sota;
    if (hunted) bits.push(hunted + ' hunted');
    if (res.qsos) bits.push(res.qsos + ' QSOs');
    return 'Imported ' + (FORMAT_LABEL[res.format] || res.format) + ': ' + (bits.length ? bits.join(', ') : 'nothing new');
  };

  /** "14 parks · 3 summits marked · 5 hunted" (or a nudge when the log is empty). */
  api.summaryText = function () {
    var s = api.stats();
    if (!s.total && !s.hunted.pota && !s.hunted.sota && !s.attempted.pota && !s.attempted.sota) {
      return 'Nothing marked yet — import a log or mark a park or summit from its detail panel.';
    }
    var bits = [s.pota + ' park' + (s.pota === 1 ? '' : 's'), s.sota + ' summit' + (s.sota === 1 ? '' : 's') + ' marked'];
    var att = s.attempted.pota + s.attempted.sota;
    if (att) bits.push(att + ' attempted');
    var hunted = s.hunted.pota + s.hunted.sota;
    if (hunted) bits.push(hunted + ' hunted');
    return bits.join(' · ');
  };

  /**
   * "You: …" line for a detail panel (empty string when there is no entry).
   * e.g. "You: activated 3× (first 2024-05-04, last 2026-05-04), 41 QSOs · hunted 5 QSOs"
   */
  api.describeEntry = function (kind, id) {
    var e = api.get(kind, id);
    if (!e) return '';
    var minQ = kind === 'pota' ? POTA_MIN_QSOS : SOTA_MIN_QSOS;
    var bits = [];
    if (e.activated) {
      if (e.activations > 0) {
        var s = 'activated ' + e.activations + '×';
        var dates = [];
        if (e.first) dates.push('first ' + e.first);
        if (e.last && e.last !== e.first) dates.push('last ' + e.last);
        if (dates.length) s += ' (' + dates.join(', ') + ')';
        if (e.qsos > 0) s += ', ' + e.qsos + ' QSOs';
        bits.push(s);
      } else {
        bits.push('activated' + (e.last ? ' on ' + e.last : '') + ' (marked by hand)');
      }
    } else if (e.attempts > 0) {
      bits.push('attempted' + (e.last ? ' on ' + e.last : '') +
        (e.qsos > 0 ? ' (' + e.qsos + ' QSO' + (e.qsos === 1 ? '' : 's') + ' — ' + minQ + ' needed for a valid activation)' : ''));
    }
    if (e.hunted && (e.hunted.qsos > 0 || e.hunted.last)) {
      var h = 'hunted' + (e.hunted.qsos ? ' ' + e.hunted.qsos + ' QSO' + (e.hunted.qsos === 1 ? '' : 's') : '');
      if (e.hunted.last && !bits.length) h += ' (last ' + e.hunted.last + ')';
      bits.push(h);
    }
    if (e.note) bits.push(e.note);
    return bits.length ? 'You: ' + bits.join(' · ') : '';
  };

  PSM.mylog = api;

})(typeof window !== 'undefined' ? window : globalThis);
