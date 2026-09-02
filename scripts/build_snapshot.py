#!/usr/bin/env python3
"""
scripts/build_snapshot.py -- build data/snapshot.js from the POTA + SOTA bulk CSV exports.

Standard library only (urllib, csv, json, argparse, datetime, ...) -- no third-party packages,
no pip install needed. Python 3.9+.

## Usage

    python3 scripts/build_snapshot.py [options]

Downloads the POTA "all parks" CSV (`https://pota.app/all_parks_ext.csv`) and the SOTA
summits-list CSV (`https://www.sotadata.org.uk/summitslist.csv`, which redirects to
`storage.sota.org.uk`), filters them down to the programs/associations you care about, and
writes a compact `data/snapshot.js` (or plain JSON) that the map app loads instantly instead of
hitting the live APIs on every page load.

### Common invocations

    # Default: active US POTA parks + every W-prefixed SOTA association (the whole USA)
    python3 scripts/build_snapshot.py

    # Add Canada (POTA "VE" program + SOTA "VE*" associations)
    python3 scripts/build_snapshot.py --programs US VE --sota-assoc-prefix W VE

    # Re-run without touching the network, reusing whatever was cached last time
    python3 scripts/build_snapshot.py --offline

    # Build from CSVs already on disk (this is what the offline test suite does)
    python3 scripts/build_snapshot.py \\
        --pota-csv tests/fixtures/sample_all_parks_ext.csv \\
        --sota-csv tests/fixtures/sample_summitslist.csv \\
        --out /tmp/snapshot_test.js

    # Restrict to a bounding box (south west north east, decimal degrees) and emit plain JSON
    python3 scripts/build_snapshot.py --bbox 40.4 -79.9 45.1 -71.7 --format json --out ny.json

### Options

    --pota-csv PATH            Read POTA data from this local CSV instead of downloading.
    --sota-csv PATH            Read SOTA data from this local CSV instead of downloading.
    --cache-dir DIR            Directory for cached raw downloads (default: .snapshot-cache/).
    --offline                  Never touch the network; require --cache-dir (or --*-csv) to
                                already hold the data.
    --programs P [P ...]       POTA program/entity prefixes to keep, matched against the part of
                                the reference before the dash, e.g. "US" keeps US-1234 (default:
                                US).
    --sota-assoc-prefix P [P ...]
                                SOTA association-code prefixes to keep, matched as a *prefix* of
                                the part of SummitCode before "/", e.g. "W" keeps W1, W2, ...
                                W7A, ... W0 (default: W).
    --include-inactive-parks   Keep POTA parks with active=0 too (default: active parks only).
    --include-retired          Keep SOTA summits outside their validFrom..validTo window too
                                (default: only summits valid as of --today / today).
    --bbox S W N E             Geographic bounding box (south west north east, decimal degrees)
                                applied to both datasets.
    --out PATH                 Output file path (default: data/snapshot.js).
    --format {js,json}         js (default) writes `window.PSM_SNAPSHOT = {...};` with a header
                                comment; json writes the bare JSON object, no wrapper/comment.
    --user-agent STRING        User-Agent header sent with the two downloads.
    --timeout SECONDS          Per-request network timeout in seconds (default: 30).
    --today YYYY-MM-DD         Override "today" (UTC) used for SOTA retired-summit filtering;
                                mainly useful for reproducible tests. Defaults to the real date.

Exit status is non-zero, with a message pointing at --offline / --pota-csv / --sota-csv, if a
download fails and no cached or local alternative is available.

A one-line summary (rows kept per program/association, warnings, output size) is printed to
stderr on every run.

See tests/snapshot.test.sh for an offline, no-network exercise of this script against the small
fixtures in tests/fixtures/, and tests/fixtures/make_snapshot_sample.py for how a larger,
realistic tests/fixtures/snapshot_sample.js is assembled for browser/e2e tests.
"""

import argparse
import csv
import datetime
import io
import json
import os
import re
import sys
import urllib.error
import urllib.request
from collections import Counter

DEFAULT_POTA_URL = 'https://pota.app/all_parks_ext.csv'
DEFAULT_SOTA_URL = 'https://www.sotadata.org.uk/summitslist.csv'
DEFAULT_USER_AGENT = 'pota-sota-map snapshot builder (scripts/build_snapshot.py)'
DEFAULT_CACHE_DIR = '.snapshot-cache'
DEFAULT_OUT = 'data/snapshot.js'
DEFAULT_TIMEOUT = 30.0

POTA_CACHE_FILENAME = 'all_parks_ext.csv'
SOTA_CACHE_FILENAME = 'summitslist.csv'

POTA_COLUMNS = ['ref', 'name', 'lat', 'lon', 'grid', 'loc', 'active']
SOTA_COLUMNS = ['code', 'name', 'lat', 'lon', 'altM', 'altFt', 'points', 'bonus',
                'validFrom', 'validTo', 'actCount', 'actDate', 'actCall',
                'assocName', 'regionName']

POTA_REQUIRED_COLUMNS = ['reference', 'name', 'active', 'locationdesc', 'latitude', 'longitude', 'grid']
SOTA_REQUIRED_COLUMNS = ['summitcode', 'associationname', 'regionname', 'summitname', 'altm', 'altft',
                          'longitude', 'latitude', 'points', 'bonuspoints', 'validfrom', 'validto',
                          'activationcount', 'activationdate', 'activationcall']

_DMY_RE = re.compile(r'^(\d{1,2})/(\d{1,2})/(\d{4})$')
_ISO_PREFIX_RE = re.compile(r'^(\d{4}-\d{2}-\d{2})')


# --------------------------------------------------------------------------- #
# small utilities                                                             #
# --------------------------------------------------------------------------- #

def fail(message):
    """Print a one-line error to stderr and exit(1)."""
    print('build_snapshot.py: error: {}'.format(message), file=sys.stderr)
    sys.exit(1)


def clean_str(value):
    """Trim whitespace; None/absence becomes ''."""
    if value is None:
        return ''
    return str(value).strip()


def clean_str_or_none(value):
    s = clean_str(value)
    return s if s else None


def to_int(value):
    """Best-effort int parse. '' / None / unparseable -> None (never raises)."""
    s = clean_str(value)
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        pass
    try:
        return int(round(float(s)))
    except (ValueError, TypeError):
        return None


def to_float(value):
    s = clean_str(value)
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def round_coord(value):
    """Parse a lat/lon and round to 5 decimals; None if not a finite number."""
    f = to_float(value)
    if f is None:
        return None
    # NaN/Inf both fail a self-equality / range check further up the call chain, but guard here too.
    if f != f or f in (float('inf'), float('-inf')):
        return None
    return round(f, 5)


def parse_date_to_iso(value):
    """Accepts SOTA-CSV 'DD/MM/YYYY' or an ISO/ISO-datetime string (the two JSON snapshot
    fixtures use 'YYYY-MM-DDTHH:MM:SS'); returns 'YYYY-MM-DD' or None for blank/unparseable."""
    s = clean_str(value)
    if not s:
        return None
    m = _DMY_RE.match(s)
    if m:
        d, mo, y = (int(g) for g in m.groups())
        try:
            return datetime.date(y, mo, d).isoformat()
        except ValueError:
            return None
    m = _ISO_PREFIX_RE.match(s)
    if m:
        try:
            datetime.date.fromisoformat(m.group(1))
        except ValueError:
            return None
        return m.group(1)
    return None


def in_bbox(lat, lon, bbox):
    south, west, north, east = bbox
    return south <= lat <= north and west <= lon <= east


def read_bytes(path):
    try:
        with open(path, 'rb') as f:
            return f.read()
    except OSError as e:
        fail('could not read {}: {}'.format(path, e))


def decode_bytes(raw):
    """Strip a UTF-8 BOM if present; fall back to latin-1 for stray non-UTF-8 bytes rather than
    crashing on otherwise-usable data."""
    try:
        return raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        return raw.decode('latin-1')


def csv_rows(text):
    """CRLF/embedded-newline-safe CSV tokenizer. io.StringIO defaults to newline='\\n' (i.e. no
    universal-newline translation), which is what the csv module needs to see \\r\\n inside
    quoted fields correctly -- the text-mode-file equivalent of open(..., newline='')."""
    return list(csv.reader(io.StringIO(text)))


# --------------------------------------------------------------------------- #
# download / cache / local-file plumbing                                     #
# --------------------------------------------------------------------------- #

def download(url, user_agent, timeout):
    req = urllib.request.Request(url, headers={'User-Agent': user_agent})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def load_dataset_text(label, url, local_path, cache_dir, offline, user_agent, timeout, cache_filename):
    """Resolve one dataset's raw text via (in order): --{label}-csv PATH, the on-disk cache
    (--offline), or a fresh download (which then refreshes the cache)."""
    if local_path:
        return decode_bytes(read_bytes(local_path))

    cache_path = os.path.join(cache_dir, cache_filename)

    if offline:
        if not os.path.isfile(cache_path):
            fail(
                '--offline was given but no cached {label} data exists at {cache_path!r}. Run '
                'once without --offline to populate the cache, or pass --{label}-csv PATH to use '
                'a local file instead.'.format(label=label, cache_path=cache_path)
            )
        return decode_bytes(read_bytes(cache_path))

    try:
        raw = download(url, user_agent, timeout)
    except Exception as e:
        fail(
            'could not download {label} data from {url} ({err}). Use --offline to reuse a '
            'cached copy in {cache_dir!r} (if one exists), or --{label}-csv PATH to supply a '
            'local file instead.'.format(label=label, url=url, err=e, cache_dir=cache_dir)
        )
        return ''  # unreachable; fail() exits the process

    try:
        os.makedirs(cache_dir, exist_ok=True)
        with open(cache_path, 'wb') as f:
            f.write(raw)
    except OSError as e:
        print('build_snapshot.py: warning: could not write cache file {}: {}'.format(cache_path, e),
              file=sys.stderr)

    return decode_bytes(raw)


# --------------------------------------------------------------------------- #
# POTA CSV -> normalized rows                                                #
# --------------------------------------------------------------------------- #

def process_pota_csv_text(text, programs, include_inactive, bbox):
    """reference,name,active,entityId,locationDesc,latitude,longitude,grid -> [ref,name,lat,lon,
    grid,loc,active] rows, already filtered by program/active/bbox. Not yet deduped/sorted."""
    warnings = Counter()
    rows = csv_rows(text)
    if not rows:
        fail('POTA CSV is empty (no header row found).')

    header = [h.strip().lower() for h in rows[0]]
    idx = {name: i for i, name in enumerate(header)}
    missing = [c for c in POTA_REQUIRED_COLUMNS if c not in idx]
    if missing:
        fail('POTA CSV is missing expected column(s): {} (found: {})'.format(
            ', '.join(missing), ', '.join(header)))

    programs_set = {p.upper() for p in programs}
    out_rows = []

    for raw_row in rows[1:]:
        if not raw_row or not any(c.strip() for c in raw_row):
            continue  # blank line
        if len(raw_row) < len(header):
            warnings['short_row'] += 1
            continue

        ref = clean_str(raw_row[idx['reference']])
        if not ref:
            warnings['missing_ref'] += 1
            continue
        prefix = ref.split('-', 1)[0].upper()
        if prefix not in programs_set:
            continue

        name = clean_str(raw_row[idx['name']])
        if not name:
            warnings['missing_name'] += 1
            continue

        lat = round_coord(raw_row[idx['latitude']])
        lon = round_coord(raw_row[idx['longitude']])
        if lat is None or lon is None or not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            warnings['bad_latlon'] += 1
            continue
        if bbox is not None and not in_bbox(lat, lon, bbox):
            continue

        active = to_int(raw_row[idx['active']])
        if active is None:
            warnings['bad_active'] += 1  # kept as null in the output (matches active:1|0|null)
        if active != 1 and not include_inactive:
            continue

        grid = clean_str_or_none(raw_row[idx['grid']])
        loc = clean_str_or_none(raw_row[idx['locationdesc']])

        out_rows.append([ref, name, lat, lon, grid, loc, active])

    return out_rows, warnings


# --------------------------------------------------------------------------- #
# SOTA CSV -> normalized rows                                                 #
# --------------------------------------------------------------------------- #

def process_sota_csv_text(text, assoc_prefixes, include_retired, bbox, today_iso):
    """SummitCode,AssociationName,RegionName,SummitName,AltM,AltFt,GridRef1,GridRef2,Longitude,
    Latitude,Points,BonusPoints,ValidFrom,ValidTo,ActivationCount,ActivationDate,ActivationCall
    (banner line first) -> [code,name,lat,lon,altM,altFt,points,bonus,validFrom,validTo,actCount,
    actDate,actCall,assocName,regionName] rows, already filtered. Not yet deduped/sorted."""
    warnings = Counter()
    rows = csv_rows(text)

    i = 0
    while i < len(rows) and not any(c.strip() for c in rows[i]):
        i += 1  # skip blank leading lines, if any
    if i < len(rows) and (not rows[i] or rows[i][0].strip().lower() != 'summitcode'):
        i += 1  # skip the "SOTA Summits List (Date=...)" banner line
    if i >= len(rows):
        fail("SOTA CSV has no header row (expected a banner line then 'SummitCode,...').")

    header = [h.strip().lower() for h in rows[i]]
    idx = {name: j for j, name in enumerate(header)}
    missing = [c for c in SOTA_REQUIRED_COLUMNS if c not in idx]
    if missing:
        fail('SOTA CSV is missing expected column(s): {} (found: {})'.format(
            ', '.join(missing), ', '.join(header)))

    prefixes = [p.upper() for p in assoc_prefixes]
    out_rows = []

    for raw_row in rows[i + 1:]:
        if not raw_row or not any(c.strip() for c in raw_row):
            continue  # blank line
        if len(raw_row) < len(header):
            warnings['short_row'] += 1
            continue

        code = clean_str(raw_row[idx['summitcode']])
        if not code:
            warnings['missing_code'] += 1
            continue
        assoc = code.split('/', 1)[0].upper()
        if not any(assoc.startswith(p) for p in prefixes):
            continue

        name = clean_str(raw_row[idx['summitname']])
        if not name:
            warnings['missing_name'] += 1
            continue

        lat = round_coord(raw_row[idx['latitude']])
        lon = round_coord(raw_row[idx['longitude']])
        if lat is None or lon is None or not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            warnings['bad_latlon'] += 1
            continue
        if bbox is not None and not in_bbox(lat, lon, bbox):
            continue

        valid_from = parse_date_to_iso(raw_row[idx['validfrom']])
        valid_to = parse_date_to_iso(raw_row[idx['validto']])
        if valid_from is None or valid_to is None:
            warnings['bad_validity_date'] += 1
            continue
        if not include_retired and not (valid_from <= today_iso <= valid_to):
            continue

        alt_m = to_int(raw_row[idx['altm']])
        alt_ft = to_int(raw_row[idx['altft']])
        points = to_int(raw_row[idx['points']])
        bonus = to_int(raw_row[idx['bonuspoints']])
        act_count = to_int(raw_row[idx['activationcount']])
        act_date = parse_date_to_iso(raw_row[idx['activationdate']])
        act_call = clean_str_or_none(raw_row[idx['activationcall']])
        assoc_name = clean_str_or_none(raw_row[idx['associationname']])
        region_name = clean_str_or_none(raw_row[idx['regionname']])

        out_rows.append([code, name, lat, lon, alt_m, alt_ft, points, bonus,
                          valid_from, valid_to, act_count, act_date, act_call,
                          assoc_name, region_name])

    return out_rows, warnings


# --------------------------------------------------------------------------- #
# dedupe / sort / assemble / write                                           #
# --------------------------------------------------------------------------- #

def dedupe_and_sort(rows):
    """Keep the first occurrence of each rows[i][0] (ref/code); sort what remains by it."""
    seen = set()
    deduped = []
    dupes = 0
    for row in rows:
        key = row[0]
        if key in seen:
            dupes += 1
            continue
        seen.add(key)
        deduped.append(row)
    deduped.sort(key=lambda r: r[0])
    return deduped, dupes


def build_snapshot_obj(pota_rows, sota_rows, generated_iso):
    return {
        'generated': generated_iso,
        'pota': {'columns': POTA_COLUMNS, 'rows': pota_rows},
        'sota': {'columns': SOTA_COLUMNS, 'rows': sota_rows},
    }


def render_output_text(snapshot, fmt):
    payload = json.dumps(snapshot, separators=(',', ':'), ensure_ascii=False)
    if fmt == 'json':
        return payload + '\n'
    n_parks = len(snapshot['pota']['rows'])
    n_summits = len(snapshot['sota']['rows'])
    comment = '// Generated by scripts/build_snapshot.py on {} — {} parks, {} summits\n'.format(
        snapshot['generated'], n_parks, n_summits)
    return comment + 'window.PSM_SNAPSHOT = ' + payload + ';\n'


def write_output(snapshot, out_path, fmt):
    text = render_output_text(snapshot, fmt)
    out_dir = os.path.dirname(os.path.abspath(out_path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(out_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    return len(text.encode('utf-8'))


def print_summary(pota_rows, pota_warnings, pota_dupes,
                   sota_rows, sota_warnings, sota_dupes,
                   out_path, size, fmt):
    def counts_by(rows, key_fn):
        c = Counter(key_fn(r) for r in rows)
        return ', '.join('{}={}'.format(k, v) for k, v in sorted(c.items())) if c else '(none)'

    def warn_str(warnings):
        return ', '.join('{}={}'.format(k, v) for k, v in sorted(warnings.items())) if warnings else 'none'

    print('[build_snapshot] POTA: kept {} parks'.format(len(pota_rows)), file=sys.stderr)
    print('[build_snapshot]   by program: {}'.format(
        counts_by(pota_rows, lambda r: r[0].split('-', 1)[0])), file=sys.stderr)
    if pota_dupes:
        print('[build_snapshot]   dropped {} duplicate reference(s) (kept first)'.format(pota_dupes),
              file=sys.stderr)
    print('[build_snapshot]   warnings: {}'.format(warn_str(pota_warnings)), file=sys.stderr)

    print('[build_snapshot] SOTA: kept {} summits'.format(len(sota_rows)), file=sys.stderr)
    print('[build_snapshot]   by association: {}'.format(
        counts_by(sota_rows, lambda r: r[0].split('/', 1)[0])), file=sys.stderr)
    if sota_dupes:
        print('[build_snapshot]   dropped {} duplicate code(s) (kept first)'.format(sota_dupes),
              file=sys.stderr)
    print('[build_snapshot]   warnings: {}'.format(warn_str(sota_warnings)), file=sys.stderr)

    print('[build_snapshot] wrote {} ({} bytes, format={})'.format(out_path, size, fmt), file=sys.stderr)


# --------------------------------------------------------------------------- #
# CLI                                                                         #
# --------------------------------------------------------------------------- #

_EPILOG = """\
examples:
  python3 scripts/build_snapshot.py
  python3 scripts/build_snapshot.py --programs US VE --sota-assoc-prefix W VE
  python3 scripts/build_snapshot.py --offline
  python3 scripts/build_snapshot.py --pota-csv tests/fixtures/sample_all_parks_ext.csv \\
      --sota-csv tests/fixtures/sample_summitslist.csv --out /tmp/snapshot_test.js

See the module docstring (top of this file) for the full usage write-up.
"""


def build_arg_parser():
    p = argparse.ArgumentParser(
        prog='build_snapshot.py',
        description='Build data/snapshot.js from the POTA and SOTA bulk CSV exports.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=_EPILOG,
    )
    p.add_argument('--pota-csv', metavar='PATH',
                    help='Read POTA data from this local CSV instead of downloading.')
    p.add_argument('--sota-csv', metavar='PATH',
                    help='Read SOTA data from this local CSV instead of downloading.')
    p.add_argument('--cache-dir', default=DEFAULT_CACHE_DIR, metavar='DIR',
                    help='Directory for cached raw downloads (default: %(default)s).')
    p.add_argument('--offline', action='store_true',
                    help='Never touch the network; reuse --cache-dir (or --pota-csv/--sota-csv).')
    p.add_argument('--programs', nargs='+', default=['US'], metavar='PROGRAM',
                    help='POTA reference prefixes to keep, e.g. US VE (default: US).')
    p.add_argument('--sota-assoc-prefix', nargs='+', default=['W'], metavar='PREFIX',
                    help='SOTA association-code prefixes to keep, e.g. W VE (default: W).')
    p.add_argument('--include-inactive-parks', action='store_true',
                    help='Keep POTA parks with active=0 too (default: active parks only).')
    p.add_argument('--include-retired', action='store_true',
                    help='Keep SOTA summits outside their validFrom..validTo window too '
                         '(default: only currently-valid summits).')
    p.add_argument('--bbox', nargs=4, type=float, metavar=('SOUTH', 'WEST', 'NORTH', 'EAST'),
                    help='Geographic bounding box filter applied to both datasets.')
    p.add_argument('--out', default=DEFAULT_OUT, metavar='PATH',
                    help='Output file path (default: %(default)s).')
    p.add_argument('--format', choices=['js', 'json'], default='js',
                    help="js (default) writes 'window.PSM_SNAPSHOT = {...};' with a header "
                         'comment; json writes the bare JSON object.')
    p.add_argument('--user-agent', default=DEFAULT_USER_AGENT, metavar='STRING',
                    help='User-Agent header sent with the two downloads.')
    p.add_argument('--timeout', type=float, default=DEFAULT_TIMEOUT, metavar='SECONDS',
                    help='Per-request network timeout in seconds (default: %(default)s).')
    p.add_argument('--today', metavar='YYYY-MM-DD',
                    help='Override "today" (UTC) used for SOTA retired-summit filtering; '
                         'mainly for reproducible tests. Defaults to the real current date.')
    return p


def main(argv=None):
    args = build_arg_parser().parse_args(argv)

    bbox = None
    if args.bbox is not None:
        south, west, north, east = args.bbox
        if south > north:
            fail('--bbox south ({}) must be <= north ({})'.format(south, north))
        if west > east:
            fail('--bbox west ({}) must be <= east ({}) (antimeridian-crossing boxes are not supported)'.format(west, east))
        bbox = (south, west, north, east)

    if args.today:
        try:
            today = datetime.date.fromisoformat(args.today)
        except ValueError:
            fail("--today must be YYYY-MM-DD, got {!r}".format(args.today))
            return 1
    else:
        today = datetime.datetime.now(datetime.timezone.utc).date()
    today_iso = today.isoformat()

    generated_iso = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    pota_text = load_dataset_text('pota', DEFAULT_POTA_URL, args.pota_csv, args.cache_dir,
                                   args.offline, args.user_agent, args.timeout, POTA_CACHE_FILENAME)
    sota_text = load_dataset_text('sota', DEFAULT_SOTA_URL, args.sota_csv, args.cache_dir,
                                   args.offline, args.user_agent, args.timeout, SOTA_CACHE_FILENAME)

    pota_rows, pota_warnings = process_pota_csv_text(
        pota_text, args.programs, args.include_inactive_parks, bbox)
    sota_rows, sota_warnings = process_sota_csv_text(
        sota_text, args.sota_assoc_prefix, args.include_retired, bbox, today_iso)

    pota_rows, pota_dupes = dedupe_and_sort(pota_rows)
    sota_rows, sota_dupes = dedupe_and_sort(sota_rows)

    snapshot = build_snapshot_obj(pota_rows, sota_rows, generated_iso)
    size = write_output(snapshot, args.out, args.format)

    print_summary(pota_rows, pota_warnings, pota_dupes,
                  sota_rows, sota_warnings, sota_dupes,
                  args.out, size, args.format)
    return 0


if __name__ == '__main__':
    sys.exit(main())
