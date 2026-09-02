#!/usr/bin/env python3
"""
tests/fixtures/make_snapshot_sample.py -- build tests/fixtures/snapshot_sample.js.

A one-off helper (not part of the scripts/build_snapshot.py CLI contract) that assembles a
larger, more realistic data/snapshot.js stand-in for browser/e2e tests than the tiny hand-written
CSVs in tests/snapshot.test.sh can produce on their own. It combines, via
scripts/build_snapshot.py's own row-processing functions (imported directly, so this fixture is
always produced by the *same* normalization/filtering code the real CLI uses):

  1. The real reference data already used elsewhere in tests/fixtures/ for mocking individual
     POTA/SOTA API endpoints:
       - pota_location_parks_US-NY.json  (850 real NY parks; GET /location/parks/US-NY shape)
       - sota_region_W2_GC.json          (118 real W2/GC "Greater Catskills" summits, incl.
                                           Slide Mountain, near Harriman State Park; GET
                                           /api/regions/W2/GC shape)
     These carry no `active` flag (POTA) since the source endpoint only lists active parks, so
     every row is normalized with active=1.

  2. The long tail: tests/fixtures/sample_all_parks_ext.csv and sample_summitslist.csv, the same
     small fixtures tests/snapshot.test.sh exercises, run through build_snapshot's normal
     pipeline with the app's default filters (--programs US, --sota-assoc-prefix W) -- these add
     a handful of parks/summits *outside* New York/Greater Catskills so a test can exercise
     "nothing found nearby" or cross-country scenarios too.

The two sources are merged with the real JSON fixtures taking precedence (they're listed first
into the shared dedupe-keep-first pass), then re-sorted by ref/code -- e.g. sample_summitslist.csv
deliberately also contains a "W2/GC-001 Slide Mountain" row matching the real fixture verbatim,
which becomes a no-op duplicate here.

Usage:
    python3 tests/fixtures/make_snapshot_sample.py

Regenerate this whenever sample_all_parks_ext.csv, sample_summitslist.csv, or the two real JSON
fixtures change. Output: tests/fixtures/snapshot_sample.js (same contract shape as data/snapshot.js;
see tests/snapshot.test.sh for the checks that pin its exact contents).
"""
import datetime
import json
import os
import sys

FIXTURES_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(FIXTURES_DIR))
sys.path.insert(0, os.path.join(REPO_ROOT, 'scripts'))
import build_snapshot as bs  # noqa: E402  (sys.path must be set up first)

NY_PARKS_FIXTURE = os.path.join(FIXTURES_DIR, 'pota_location_parks_US-NY.json')
GC_SUMMITS_FIXTURE = os.path.join(FIXTURES_DIR, 'sota_region_W2_GC.json')
SAMPLE_POTA_CSV = os.path.join(FIXTURES_DIR, 'sample_all_parks_ext.csv')
SAMPLE_SOTA_CSV = os.path.join(FIXTURES_DIR, 'sample_summitslist.csv')
OUT_PATH = os.path.join(FIXTURES_DIR, 'snapshot_sample.js')


def pota_row_from_ny_fixture(d):
    """{reference,name,latitude,longitude,grid,locationDesc,...} -> [ref,name,lat,lon,grid,loc,active]
    (this endpoint only lists currently-active parks, so active is hardcoded to 1)."""
    return [
        bs.clean_str(d.get('reference')),
        bs.clean_str(d.get('name')),
        bs.round_coord(d.get('latitude')),
        bs.round_coord(d.get('longitude')),
        bs.clean_str_or_none(d.get('grid')),
        bs.clean_str_or_none(d.get('locationDesc')),
        1,
    ]


def sota_row_from_region_fixture(summit, assoc_name, region_name):
    """{summitCode,name,latitude,longitude,altM,altFt,points,bonusPoints,validFrom,validTo,
    activationCount,activationDate,activationCall,...} -> [code,name,lat,lon,altM,altFt,points,
    bonus,validFrom,validTo,actCount,actDate,actCall,assocName,regionName]."""
    return [
        bs.clean_str(summit.get('summitCode')),
        bs.clean_str(summit.get('name')),
        bs.round_coord(summit.get('latitude')),
        bs.round_coord(summit.get('longitude')),
        bs.to_int(summit.get('altM')),
        bs.to_int(summit.get('altFt')),
        bs.to_int(summit.get('points')),
        bs.to_int(summit.get('bonusPoints')),
        bs.parse_date_to_iso(summit.get('validFrom')),
        bs.parse_date_to_iso(summit.get('validTo')),
        bs.to_int(summit.get('activationCount')),
        bs.parse_date_to_iso(summit.get('activationDate')),
        bs.clean_str_or_none(summit.get('activationCall')),
        assoc_name,
        region_name,
    ]


def main():
    today_iso = datetime.datetime.now(datetime.timezone.utc).date().isoformat()

    # 1. Real fixtures (take precedence in the merge below).
    with open(NY_PARKS_FIXTURE, encoding='utf-8') as f:
        ny_parks = json.load(f)
    pota_real = [pota_row_from_ny_fixture(d) for d in ny_parks]

    with open(GC_SUMMITS_FIXTURE, encoding='utf-8') as f:
        region = json.load(f)
    assoc_name = bs.clean_str_or_none(region.get('associationName'))
    region_name = bs.clean_str_or_none(region.get('regionName'))
    sota_real_all = [sota_row_from_region_fixture(s, assoc_name, region_name)
                      for s in region.get('summits', [])]
    # Apply the same default validity filter build_snapshot.py itself would apply, so this
    # fixture never silently drifts from the real script's behaviour (a no-op today: every
    # W2/GC summit in this fixture currently has validTo=2099-12-31 and a validFrom years back).
    sota_real = [r for r in sota_real_all
                 if r[8] is not None and r[9] is not None and r[8] <= today_iso <= r[9]]

    # 2. Long-tail sample CSVs, through the real CLI pipeline, app-default filters (US / W).
    pota_text = bs.decode_bytes(bs.read_bytes(SAMPLE_POTA_CSV))
    sota_text = bs.decode_bytes(bs.read_bytes(SAMPLE_SOTA_CSV))
    pota_sample, _pota_warn = bs.process_pota_csv_text(pota_text, ['US'], False, None)
    sota_sample, _sota_warn = bs.process_sota_csv_text(sota_text, ['W'], False, None, today_iso)

    # 3. Merge (real data first so it wins any ref/code collision) + the usual dedupe/sort.
    pota_rows, pota_dupes = bs.dedupe_and_sort(pota_real + pota_sample)
    sota_rows, sota_dupes = bs.dedupe_and_sort(sota_real + sota_sample)

    generated_iso = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    snapshot = bs.build_snapshot_obj(pota_rows, sota_rows, generated_iso)
    size = bs.write_output(snapshot, OUT_PATH, 'js')

    print('[make_snapshot_sample] {} parks ({} from NY fixture, {} from sample CSV, '
          '{} collisions dropped)'.format(len(pota_rows), len(pota_real), len(pota_sample), pota_dupes),
          file=sys.stderr)
    print('[make_snapshot_sample] {} summits ({} from W2/GC fixture, {} from sample CSV, '
          '{} collisions dropped)'.format(len(sota_rows), len(sota_real), len(sota_sample), sota_dupes),
          file=sys.stderr)
    print('[make_snapshot_sample] wrote {} ({} bytes)'.format(OUT_PATH, size), file=sys.stderr)


if __name__ == '__main__':
    main()
