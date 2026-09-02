#!/usr/bin/env node
/* =====================================================================
 * tests/mylog.test.js — offline unit tests for src/55-mylog.js
 *
 *   node tests/mylog.test.js       # exits non-zero if anything fails
 *
 * No test framework and no network. The module is loaded browser-style
 * (`global.window = globalThis`) on top of src/00-util.js, with a fake
 * localStorage so persistence can be exercised — including reloading the
 * module to prove the store really round-trips through storage.
 * ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/* ------------------------------------------------------------------ */
/* assertion harness (same shape as tests/data.test.js)                */
/* ------------------------------------------------------------------ */
let passed = 0;
const failures = [];
function ok(cond, msg, extra) {
  if (cond) { passed++; console.log('  ok   ' + msg); }
  else {
    failures.push(msg);
    console.log('  FAIL ' + msg + (extra !== undefined ? '\n         ' + extra : ''));
  }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}
function deepEq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  ok(a === b, msg, 'expected ' + b + '\n         got      ' + a);
}
function section(title) { console.log('\n== ' + title + ' =='); }

/* ------------------------------------------------------------------ */
/* fake localStorage + module loading                                  */
/* ------------------------------------------------------------------ */
function makeStorage() {
  const data = new Map();
  return {
    _data: data,
    _throwOnSet: false,
    getItem(k) { return data.has(k) ? data.get(k) : null; },
    setItem(k, v) {
      if (this._throwOnSet) throw new Error('QuotaExceededError (simulated)');
      data.set(k, String(v));
    },
    removeItem(k) { data.delete(k); },
    clear() { data.clear(); },
    get length() { return data.size; },
    key(i) { return Array.from(data.keys())[i] || null; }
  };
}

global.window = globalThis;
global.localStorage = makeStorage();

function loadModule(rel) {
  const p = path.join(ROOT, rel);
  vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: p });
}
loadModule('src/00-util.js');
loadModule('src/55-mylog.js');

const PSM = global.PSM;

// Keep PSM's own chatter out of the test output.
['log', 'warn', 'error'].forEach(function (level) {
  const orig = console[level].bind(console);
  console[level] = function () {
    if (arguments[0] === '[PSM]') return;
    orig.apply(null, arguments);
  };
});

let mylog = PSM.mylog;
function reload() {            // re-run the IIFE: rebuilds the store from localStorage
  loadModule('src/55-mylog.js');
  mylog = PSM.mylog;
  return mylog;
}
function reset() { mylog.clear(); }

/* ------------------------------------------------------------------ */
/* samples                                                             */
/* ------------------------------------------------------------------ */
function tag(name, value) { return '<' + name + ':' + String(value).length + '>' + value; }

function adifRecord(fields) {
  return Object.keys(fields).map(function (k) { return tag(k, fields[k]); }).join('') + '<eor>\n';
}

function repeatQso(n, fields, startNum) {
  let out = '';
  for (let i = 0; i < n; i++) {
    const f = Object.assign({}, fields);
    f.call = 'K' + (((startNum || 0) + i) % 10) + 'TST';
    f.time_on = String(140000 + i).padStart(6, '0');
    out += adifRecord(f);
  }
  return out;
}

// Header + mixed-case tags + a typed length (<QSO_DATE:8:D>).
const ADIF_SAMPLE =
  'ADIF export from a test logger\n' +
  '<ADIF_VER:5>3.1.4\n' +
  '<PROGRAMID:6>tester\n' +
  '<EOH>\n' +
  // 7 QSOs at both US-2069 and US-2010 (one QSO, two parks; the @US-NY suffix must be stripped)
  repeatQso(7, { QSO_DATE: '20260504', band: '20m', mode: 'CW', My_Pota_Ref: 'US-2069@US-NY,US-2010' }, 0) +
  // 5 more QSOs at US-2069 only, via MY_SIG / MY_SIG_INFO — 12 in the day => a valid activation
  repeatQso(5, { QSO_DATE: '20260504', band: '40m', mode: 'SSB', my_sig: 'POTA', my_sig_info: 'US-2069' }, 7) +
  // 5 QSOs from a summit => a valid SOTA activation (4 needed)
  repeatQso(5, { QSO_DATE: '20260505', band: '20m', mode: 'CW', MY_SOTA_REF: 'W2/GC-001' }, 0) +
  // hunted: legacy K-#### park reference (=> US-4556)
  repeatQso(3, { QSO_DATE: '20260601', band: '20m', mode: 'CW', pota_ref: 'K-4556' }, 0) +
  // hunted: SIG / SIG_INFO park
  repeatQso(2, { QSO_DATE: '20260602', band: '17m', mode: 'FT8', sig: 'POTA', sig_info: 'US-1234' }, 0) +
  // hunted: a summit, written by hand with a typed length field
  '<QSO_DATE:8:D>20260603<CALL:5>G0ABC<SOTA_REF:8>G/LD-001<EOR>\n' +
  // a plain QSO with no references at all
  adifRecord({ QSO_DATE: '20260604', call: 'N0REF', band: '20m', mode: 'SSB' });

const POTA_CSV_SAMPLE =
  'reference,name,active,entityId,locationDesc,latitude,longitude,grid,my_activations,my_attempts,my_qsos,my_hunted_qsos\n' +
  'US-2069,"Harriman State Park",1,291,US-NY,41.1753,-74.1783,FN21ve,3,4,120,6\n' +
  'US-4556,"Another Park",1,291,US-NJ,40.9,-74.6,FN20xx,0,1,0,17\n' +
  'US-9999,"Never Been",1,291,US-NY,42.0,-75.0,FN22aa,0,0,0,0\n';

const SOTA_CSV_SAMPLE =
  'V2,W2ABC,W2/GC-001,04/05/26,14:15,14MHz,CW,K1AAA\n' +
  'V2,W2ABC,W2/GC-001,04/05/2026,14:16,14MHz,CW,K2BBB\n' +      // DD/MM/YYYY, same day
  'V2,W2ABC,W2/GC-001,04/05/26,14:17,14MHz,CW,K3CCC\n' +
  'V2,W2ABC,W2/GC-001,04/05/26,14:18,14MHz,CW,K4DDD,W2/GC-002,S2S\n' +
  'V2,W2ABC,,05/05/26,09:00,7MHz,SSB,G0AAA,G/LD-001,chaser row\n';

const REFS_SAMPLE = 'US-2069, W2/GC-001\nK-4556\tUS-1234  not-a-ref';

/* ------------------------------------------------------------------ */
/* tests                                                               */
/* ------------------------------------------------------------------ */
function main() {
  /* ================================================================ */
  section('detect()');
  eq(mylog.detect(ADIF_SAMPLE), 'adif', 'detect(ADIF text) -> adif');
  eq(mylog.detect('nothing useful', 'mylog.adi'), 'adif', 'detect(*.adi by filename) -> adif');
  eq(mylog.detect(POTA_CSV_SAMPLE), 'pota-csv', 'detect(POTA park list CSV) -> pota-csv');
  eq(mylog.detect(SOTA_CSV_SAMPLE), 'sota-csv', 'detect(SOTA V2 CSV) -> sota-csv');
  eq(mylog.detect('{"version":1,"pota":{"US-2069":{"activated":true}},"sota":{}}'), 'json', 'detect(our JSON) -> json');
  eq(mylog.detect(REFS_SAMPLE), 'refs', 'detect(reference list) -> refs');
  eq(mylog.detect('just some prose with no references at all'), null, 'detect(prose) -> null');

  /* ================================================================ */
  section('parseADIF()');
  const recs = mylog.parseADIF(ADIF_SAMPLE);
  eq(recs.length, 24, 'parseADIF finds every record (header excluded)');
  deepEq(recs[0].myPota, ['US-2069', 'US-2010'], 'MY_POTA_REF list parsed, @US-NY suffix stripped');
  eq(recs[0].date, '2026-05-04', 'QSO_DATE YYYYMMDD -> ISO');
  eq(recs[0].mySota, null, 'no MY_SOTA_REF on a park QSO');
  deepEq(recs[7].myPota, ['US-2069'], 'MY_SIG=POTA + MY_SIG_INFO treated as a park reference');
  eq(recs[12].mySota, 'W2/GC-001', 'MY_SOTA_REF parsed');
  deepEq(recs[17].pota, ['US-4556'], 'hunted POTA_REF "K-4556" normalised to US-4556');
  deepEq(recs[20].pota, ['US-1234'], 'hunted SIG=POTA + SIG_INFO parsed');
  eq(recs[22].sota, 'G/LD-001', 'hunted SOTA_REF parsed (typed <QSO_DATE:8:D> tolerated)');
  eq(recs[22].date, '2026-06-03', 'typed length field still yields the date');
  deepEq(recs[23].myPota, [], 'a QSO with no references parses with empty lists');
  eq(mylog.parseADIF('').length, 0, 'parseADIF("") -> []');

  /* ================================================================ */
  section('importText(): ADIF');
  reset();
  const rAdif = mylog.importText(ADIF_SAMPLE, { filename: 'log.adi' });
  eq(rAdif.format, 'adif', 'format is adif');
  eq(rAdif.qsos, 23, '23 QSOs carried a reference (the 24th had none)');
  eq(rAdif.added.pota, 4, '4 new parks (US-2069, US-2010 + hunted US-4556, US-1234)');
  eq(rAdif.added.sota, 2, '2 new summits (W2/GC-001 activated, G/LD-001 hunted)');
  eq(rAdif.hunted.pota, 2, '2 hunted parks');
  eq(rAdif.hunted.sota, 1, '1 hunted summit');

  const p2069 = mylog.get('pota', 'US-2069');
  eq(p2069.activated, true, 'US-2069: 12 QSOs in a day -> activated');
  eq(p2069.activations, 1, 'US-2069: one valid activation day');
  eq(p2069.attempts, 1, 'US-2069: one day with QSOs');
  eq(p2069.qsos, 12, 'US-2069: 12 QSOs');
  eq(p2069.first, '2026-05-04', 'US-2069: first date');
  eq(p2069.last, '2026-05-04', 'US-2069: last date');
  eq(p2069.source, 'adif', 'US-2069: source adif');
  eq(mylog.isActivated('pota', 'US-2069'), true, 'isActivated(US-2069)');
  eq(mylog.isActivated('pota', 'k-2069'), true, 'isActivated() normalises "k-2069"');

  const p2010 = mylog.get('pota', 'US-2010');
  eq(p2010.activated, false, 'US-2010: 7 QSOs -> not a valid activation');
  eq(p2010.activations, 0, 'US-2010: no valid activation days');
  eq(p2010.attempts, 1, 'US-2010: one attempt');
  eq(p2010.qsos, 7, 'US-2010: 7 QSOs');
  eq(mylog.isAttempted('pota', 'US-2010'), true, 'isAttempted(US-2010)');
  eq(mylog.isAttempted('pota', 'US-2069'), false, 'isAttempted() is false once activated');

  const sGC1 = mylog.get('sota', 'W2/GC-001');
  eq(sGC1.activated, true, 'W2/GC-001: 5 QSOs -> activated (4 needed)');
  eq(sGC1.activations, 1, 'W2/GC-001: one valid activation day');
  eq(sGC1.qsos, 5, 'W2/GC-001: 5 QSOs');

  const h4556 = mylog.get('pota', 'US-4556');
  eq(h4556.activated, false, 'hunted-only park is not activated');
  deepEq(h4556.hunted, { qsos: 3, last: '2026-06-01' }, 'US-4556 hunted 3 QSOs');
  eq(mylog.isHunted('pota', 'US-4556'), true, 'isHunted(US-4556)');
  deepEq(mylog.get('pota', 'US-1234').hunted, { qsos: 2, last: '2026-06-02' }, 'US-1234 hunted via SIG_INFO');
  deepEq(mylog.get('sota', 'G/LD-001').hunted, { qsos: 1, last: '2026-06-03' }, 'G/LD-001 hunted via SOTA_REF');

  section('importText(): ADIF is idempotent (maxima, not sums)');
  const rAgain = mylog.importText(ADIF_SAMPLE, { filename: 'log.adi' });
  eq(rAgain.added.pota, 0, 're-import adds no new parks');
  eq(rAgain.updated.pota, 4, 're-import updates the 4 known parks');
  const p2069b = mylog.get('pota', 'US-2069');
  eq(p2069b.qsos, 12, 'QSOs stay at 12 across imports (max, not sum)');
  eq(p2069b.activations, 1, 'activations stay at 1 across imports');

  section('importText(): a second ADIF merges by maximum / earliest / latest');
  const ADIF2 = repeatQso(10, { QSO_DATE: '20260506', band: '20m', mode: 'CW', MY_POTA_REF: 'US-2069' }, 0);
  mylog.importText(ADIF2, { filename: 'later.adi' });
  const p2069c = mylog.get('pota', 'US-2069');
  eq(p2069c.qsos, 12, 'qsos = max(12, 10)');
  eq(p2069c.first, '2026-05-04', 'first = earliest across imports');
  eq(p2069c.last, '2026-05-06', 'last = latest across imports');
  eq(p2069c.activated, true, 'activated = any');

  section('P2P: one QSO can activate one park and hunt another');
  reset();
  const P2P = adifRecord({ QSO_DATE: '20260701', call: 'W1P2P', MY_POTA_REF: 'US-2069', POTA_REF: 'US-0001' });
  const rP2P = mylog.importText(P2P, {});
  eq(rP2P.qsos, 1, 'one QSO counted once');
  eq(mylog.get('pota', 'US-2069').qsos, 1, 'my park got the QSO');
  eq(mylog.get('pota', 'US-2069').activated, false, '1 QSO is not a valid POTA activation');
  deepEq(mylog.get('pota', 'US-0001').hunted, { qsos: 1, last: '2026-07-01' }, 'their park was hunted');

  /* ================================================================ */
  section('importText(): POTA park-list CSV');
  reset();
  const rCsv = mylog.importText(POTA_CSV_SAMPLE, { filename: 'park_list.csv' });
  eq(rCsv.format, 'pota-csv', 'format is pota-csv');
  eq(rCsv.added.pota, 2, 'two rows carried data (the third is all zeros)');
  const c2069 = mylog.get('pota', 'US-2069');
  eq(c2069.activated, true, 'my_activations 3 -> activated');
  eq(c2069.activations, 3, 'activations from the CSV');
  eq(c2069.attempts, 4, 'attempts from my_attempts');
  eq(c2069.source, 'pota-csv', 'source pota-csv');
  deepEq(c2069.hunted, { qsos: 6, last: null }, 'my_hunted_qsos becomes hunted.qsos');
  const c4556 = mylog.get('pota', 'US-4556');
  eq(c4556.activated, false, 'my_activations 0 -> not activated');
  deepEq(c4556.hunted, { qsos: 17, last: null }, 'hunted-only CSV row');
  eq(mylog.get('pota', 'US-9999'), null, 'an all-zero row creates no entry');

  /* ================================================================ */
  section('importText(): SOTA V2 CSV');
  reset();
  const rSota = mylog.importText(SOTA_CSV_SAMPLE, { filename: 'sotadata.csv' });
  eq(rSota.format, 'sota-csv', 'format is sota-csv');
  eq(rSota.qsos, 5, '5 V2 rows counted');
  const v2 = mylog.get('sota', 'W2/GC-001');
  eq(v2.activated, true, '4 QSOs in a day -> activated');
  eq(v2.activations, 1, 'one valid activation day');
  eq(v2.attempts, 1, 'DD/MM/YY and DD/MM/YYYY are the same day');
  eq(v2.qsos, 4, '4 activator QSOs');
  eq(v2.first, '2026-05-04', 'DD/MM/YY parsed as 2026-05-04');
  deepEq(mylog.get('sota', 'W2/GC-002').hunted, { qsos: 1, last: '2026-05-04' }, 'summit-to-summit row is hunted');
  eq(mylog.get('sota', 'W2/GC-002').activated, false, 'a hunted S2S summit is not activated');
  deepEq(mylog.get('sota', 'G/LD-001').hunted, { qsos: 1, last: '2026-05-05' }, 'chaser row (blank MySummit) is hunted');

  /* ================================================================ */
  section('importText(): reference list');
  reset();
  const rRefs = mylog.importText(REFS_SAMPLE, { filename: 'refs.txt' });
  eq(rRefs.format, 'refs', 'format is refs');
  eq(rRefs.added.pota, 3, '3 park references (US-2069, K-4556 -> US-4556, US-1234)');
  eq(rRefs.added.sota, 1, '1 summit reference');
  eq(mylog.isActivated('pota', 'US-4556'), true, 'K-4556 normalised and marked activated');
  eq(mylog.get('pota', 'US-2069').source, 'refs', 'source refs');
  eq(mylog.get('pota', 'US-2069').activations, 0, 'a bare reference records no counts');

  /* ================================================================ */
  section('mark() / unmark()');
  reset();
  mylog.mark('pota', 'us-2069');
  eq(mylog.isActivated('pota', 'US-2069'), true, 'mark() normalises the reference');
  eq(mylog.get('pota', 'US-2069').source, 'manual', 'source manual');
  eq(mylog.unmark('pota', 'US-2069'), true, 'unmark() returns true');
  eq(mylog.get('pota', 'US-2069'), null, 'unmark() drops an entry with no imported data');

  mylog.mark('sota', 'W2/GC-001', { date: '2026-05-05', note: 'windy' });
  const marked = mylog.get('sota', 'W2/GC-001');
  eq(marked.last, '2026-05-05', 'mark() records the date');
  eq(marked.note, 'windy', 'mark() records the note');

  reset();
  mylog.importText(ADIF_SAMPLE, {});                 // US-2010 = attempted, 7 QSOs
  mylog.mark('pota', 'US-2010');
  const m2010 = mylog.get('pota', 'US-2010');
  eq(m2010.activated, true, 'mark() on an imported entry sets the flag');
  eq(m2010.qsos, 7, 'mark() keeps the imported QSO count');
  eq(m2010.source, 'adif', 'mark() does not downgrade the recorded source');
  mylog.unmark('pota', 'US-2010');
  const u2010 = mylog.get('pota', 'US-2010');
  ok(u2010 && u2010.activated === false, 'unmark() keeps an imported entry but clears the flag',
    JSON.stringify(u2010));
  eq(u2010.qsos, 7, 'unmark() keeps the imported QSO count');
  mylog.unmark('pota', 'US-2069');
  eq(mylog.isActivated('pota', 'US-2069'), false, 'unmark() overrides imported activations');
  eq(mylog.unmark('pota', 'US-7777'), false, 'unmark() of an unknown reference is a no-op');

  /* ================================================================ */
  section('stats()');
  reset();
  mylog.importText(ADIF_SAMPLE, {});
  const st = mylog.stats();
  eq(st.pota, 1, 'stats: 1 activated park');
  eq(st.sota, 1, 'stats: 1 activated summit');
  eq(st.attempted.pota, 1, 'stats: 1 attempted park');
  eq(st.attempted.sota, 0, 'stats: no attempted summits');
  eq(st.hunted.pota, 2, 'stats: 2 hunted parks');
  eq(st.hunted.sota, 1, 'stats: 1 hunted summit');

  /* ================================================================ */
  section('exportJSON() / clear() / import round trip');
  const exported = mylog.exportJSON();
  ok(exported.indexOf('US-2069') > 0, 'export contains US-2069');
  const before = mylog.all();
  eq(before.version, 1, 'all().version is 1');
  ok(typeof before.updated === 'string' && before.updated.length > 10, 'all().updated is an ISO timestamp', before.updated);
  mylog.clear();
  eq(mylog.stats().pota, 0, 'clear() empties the log');
  eq(mylog.get('pota', 'US-2069'), null, 'clear() removes entries');
  const rJson = mylog.importText(exported, { filename: 'my-activations.json' });
  eq(rJson.format, 'json', 'format is json');
  const after = mylog.all();
  deepEq(after.pota, before.pota, 'round trip restores every park entry');
  deepEq(after.sota, before.sota, 'round trip restores every summit entry');

  /* ================================================================ */
  section('onChange()');
  const seen = [];
  const off = mylog.onChange(function (reason) { seen.push(reason); });
  mylog.mark('pota', 'US-3333');
  mylog.unmark('pota', 'US-3333');
  mylog.importText('US-4444', {});
  mylog.clear();
  deepEq(seen, ['mark', 'unmark', 'import', 'clear'], 'onChange fires for mark/unmark/import/clear');
  off();
  mylog.mark('pota', 'US-5555');
  eq(seen.length, 4, 'the unsubscribe function stops further callbacks');

  /* ================================================================ */
  section('persistence');
  reset();
  mylog.mark('pota', 'US-2069', { date: '2026-05-04' });
  mylog.importText(SOTA_CSV_SAMPLE, {});
  ok(!!global.localStorage.getItem('psm.mylog.v1'), 'the log is written to localStorage');
  reload();                                  // fresh module instance, same storage
  eq(mylog.isActivated('pota', 'US-2069'), true, 'a marked park survives a reload');
  eq(mylog.get('sota', 'W2/GC-001').qsos, 4, 'imported counters survive a reload');
  eq(mylog.get('sota', 'W2/GC-001').source, 'sota-csv', 'the source survives a reload');

  section('storage failures are survivable');
  global.localStorage._throwOnSet = true;
  mylog.mark('pota', 'US-8888');
  eq(mylog.isActivated('pota', 'US-8888'), true, 'a mark still works when localStorage refuses to save');
  global.localStorage._throwOnSet = false;

  const noStore = global.localStorage;
  delete global.localStorage;
  reload();
  eq(mylog.stats().pota, 0, 'the module loads with no localStorage at all');
  mylog.mark('pota', 'US-9999');
  eq(mylog.isActivated('pota', 'US-9999'), true, 'marks work in memory with no localStorage');
  global.localStorage = noStore;

  /* ================================================================ */
  section('text helpers');
  reload();
  reset();
  mylog.importText(ADIF_SAMPLE, {});
  const line = mylog.describeEntry('pota', 'US-2069');
  ok(/^You: activated 1×/.test(line) && line.indexOf('12 QSOs') > 0, 'describeEntry(): activated line', line);
  const attLine = mylog.describeEntry('pota', 'US-2010');
  ok(/^You: attempted on 2026-05-04/.test(attLine) && attLine.indexOf('7 QSOs') > 0,
    'describeEntry(): attempted line', attLine);
  const huntLine = mylog.describeEntry('pota', 'US-4556');
  ok(/^You: hunted 3 QSOs \(last 2026-06-01\)$/.test(huntLine), 'describeEntry(): hunted-only line', huntLine);
  eq(mylog.describeEntry('pota', 'US-0000'), '', 'describeEntry(): nothing for an unknown reference');
  const sum = mylog.summaryText();
  ok(sum.indexOf('1 park') === 0 && sum.indexOf('1 summit marked') > 0 && sum.indexOf('3 hunted') > 0,
    'summaryText(): counts', sum);
  reset();
  ok(/^Nothing marked yet/.test(mylog.summaryText()), 'summaryText(): empty log', mylog.summaryText());
  const desc = mylog.describeImport(mylog.importText(ADIF_SAMPLE, {}));
  ok(/^Imported ADIF: /.test(desc) && desc.indexOf('(4 new)') > 0 && desc.indexOf('23 QSOs') > 0,
    'describeImport(): status line', desc);

  /* ================================================================ */
  section('bad input');
  reset();
  const rBad = mylog.importText('this is just prose', {});
  eq(rBad.format, null, 'unrecognisable text -> format null');
  ok(rBad.warnings.length > 0, 'unrecognisable text -> a warning');
  eq(mylog.stats().pota, 0, 'unrecognisable text changes nothing');
  eq(mylog.get('pota', 'not-a-ref'), null, 'get() of a malformed reference is null');
  eq(mylog.isActivated('nope', 'US-2069'), false, 'an unknown kind is false, not a throw');
  const rEmptyJson = mylog.importText('{"version":1,"pota":{},"sota":{}}', {});
  eq(rEmptyJson.format, 'json', 'an empty JSON export still detects as json');

  /* ================================================================ */
  console.log('\n' + (failures.length ? 'FAILED' : 'PASSED') + ': ' + passed + ' assertions passed, ' +
    failures.length + ' failed');
  if (failures.length) {
    failures.forEach(function (f) { console.log('  - ' + f); });
    process.exit(1);
  }
}

try {
  main();
  process.exit(failures.length ? 1 : 0);
} catch (e) {
  console.error('\nUNEXPECTED ERROR:', (e && e.stack) || e);
  process.exit(2);
}
