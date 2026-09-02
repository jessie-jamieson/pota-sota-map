#!/usr/bin/env python3
"""
build_overpass_fixture.py — generate tests/fixtures/overpass_harriman.json

Produces an Overpass-API-shaped JSON response ("out tags geom;" flavour) for the
bbox (41.10, -74.40, 41.45, -73.85) — the Harriman / Bear Mountain / Sterling
Forest corner of New York — built from the real NYS OPRHP park polygons in
tests/fixtures/ny_state_parks.geojson.

The result is consumed by tests/nfer.test.js, which feeds it through
osmtogeojson and PSM.nfer.  Everything is offline: no network access needed.

Emitted element shapes (exactly what Overpass returns for `out tags geom;`):

  way       {type:"way", id, tags:{...}, geometry:[{lat,lon}, ...]}   closed ring
  relation  {type:"relation", id, tags:{type:"multipolygon", ...},
             members:[{type:"way", ref, role:"outer"|"inner", geometry:[...]}]}
  relation  {type:"relation", id, tags:{type:"route", route:"hiking", ...},
             members:[{type:"way", ref, role:"", geometry:[...]}]}    hiking route

Synthetic extras (documented so test expectations stay honest):
  * POTA tag communication:amateur_radio:pota=US-2069 on the largest Harriman
    State Park polygon and =US-2010 on the largest Bear Mountain polygon.
  * A hiking route relation 156553 "Appalachian Trail" that provably crosses
    both the Harriman and the Bear Mountain polygons.
  * A distractor umbrella polygon "Palisades Interstate Park Commission" that
    contains the reference points of many unrelated parks (the matcher must NOT
    attach it to all of them).
  * A distractor administrative relation "Town of Tuxedo" (type=boundary,
    boundary=administrative) that also carries leisure=park — fetchBoundaries
    must drop it.
  * An overlap-test polygon "Harriman-Bear Mountain overlap test" tagged
    communication:amateur_radio:pota=US-9999 that genuinely overlaps Harriman,
    so the park-park zone path is exercised even if the real polygons only
    touch along a shared border.

Usage:  python3 tests/fixtures/build_overpass_fixture.py
"""

import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "ny_state_parks.geojson")
OUT = os.path.join(HERE, "overpass_harriman.json")

# bbox of interest: south, west, north, east
SOUTH, WEST, NORTH, EAST = 41.10, -74.40, 41.45, -73.85

SIMPLIFY_TOL = 0.0002  # degrees (~20 m); keeps the fixture well under 1.5 MB

# Deterministic id ranges so the fixture is stable across rebuilds.
WAY_ID_BASE = 100_000_000
REL_ID_BASE = 9_000_000
MEMBER_WAY_ID_BASE = 800_000_000

BASE_TAGS = {
    "boundary": "protected_area",
    "protect_class": "5",
    "leisure": "park",
    "operator": "NYS OPRHP",
}


# --------------------------------------------------------------------------- #
# Small geometry helpers (no shapely / no numpy — plain Python on purpose)     #
# --------------------------------------------------------------------------- #
def ring_bbox(ring):
    """(minlon, minlat, maxlon, maxlat) of a list of [lon, lat] pairs."""
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return min(xs), min(ys), max(xs), max(ys)


def geom_bbox(geom):
    xs, ys = [], []

    def walk(c):
        if c and isinstance(c[0], (int, float)):
            xs.append(c[0])
            ys.append(c[1])
        else:
            for sub in c:
                walk(sub)

    walk(geom["coordinates"])
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def bbox_intersects(b, south=SOUTH, west=WEST, north=NORTH, east=EAST):
    if b is None:
        return False
    w, s, e, n = b
    return not (e < west or w > east or n < south or s > north)


def point_in_ring(lon, lat, ring):
    """Ray casting; ring is a list of [lon, lat] (closed or not)."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat):
            # x coordinate of the edge at this latitude
            x_at = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lon < x_at:
                inside = not inside
        j = i
    return inside


def point_in_polygon(lon, lat, polygon_rings):
    """polygon_rings = [outer, hole1, hole2, ...]."""
    if not polygon_rings:
        return False
    if not point_in_ring(lon, lat, polygon_rings[0]):
        return False
    for hole in polygon_rings[1:]:
        if point_in_ring(lon, lat, hole):
            return False
    return True


def point_in_geometry(lon, lat, geom):
    if geom["type"] == "Polygon":
        return point_in_polygon(lon, lat, geom["coordinates"])
    if geom["type"] == "MultiPolygon":
        return any(point_in_polygon(lon, lat, poly) for poly in geom["coordinates"])
    return False


def perp_dist(p, a, b):
    """Perpendicular distance from p to segment a-b, in degrees (planar)."""
    (px, py), (ax, ay), (bx, by) = p[:2], a[:2], b[:2]
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def douglas_peucker(points, tol):
    """Classic iterative-stack Douglas-Peucker on [lon, lat] pairs."""
    if len(points) < 3:
        return list(points)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        dmax, idx = 0.0, first
        for i in range(first + 1, last):
            d = perp_dist(points[i], points[first], points[last])
            if d > dmax:
                dmax, idx = d, i
        if dmax > tol:
            keep[idx] = True
            stack.append((first, idx))
            stack.append((idx, last))
    return [p for p, k in zip(points, keep) if k]


def simplify_ring(ring, tol=SIMPLIFY_TOL):
    """Simplify a closed ring, keeping it closed and valid (>= 4 points)."""
    pts = [list(p[:2]) for p in ring]
    if len(pts) >= 2 and pts[0] == pts[-1]:
        open_pts = pts[:-1]
    else:
        open_pts = pts
    if len(open_pts) < 3:
        return None
    # Simplify the open sequence, then re-close.
    simp = douglas_peucker(open_pts + [open_pts[0]], tol)
    if simp[0] != simp[-1]:
        simp.append(list(simp[0]))
    if len(simp) < 4:
        # too small to survive simplification — fall back to the raw ring
        simp = open_pts + [list(open_pts[0])]
    if len(simp) < 4:
        return None
    return [[round(x, 6), round(y, 6)] for x, y in simp]


def ring_area(ring):
    """Shoelace area in square degrees (absolute)."""
    a = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[i + 1][0], ring[i + 1][1]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0


def geom_area(geom):
    if geom["type"] == "Polygon":
        return ring_area(geom["coordinates"][0]) if geom["coordinates"] else 0.0
    if geom["type"] == "MultiPolygon":
        return sum(ring_area(p[0]) for p in geom["coordinates"] if p)
    return 0.0


def as_geometry_nodes(ring):
    """[lon, lat] pairs -> Overpass geometry [{lat, lon}, ...]."""
    return [{"lat": round(p[1], 7), "lon": round(p[0], 7)} for p in ring]


# --------------------------------------------------------------------------- #
# Build                                                                        #
# --------------------------------------------------------------------------- #
def load_source():
    with open(SRC, "r", encoding="utf-8") as fh:
        return json.load(fh)


def select_features(fc):
    """Features whose bbox intersects the area of interest, largest first."""
    out = []
    for feat in fc.get("features", []):
        geom = feat.get("geometry") or {}
        if geom.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        bb = geom_bbox(geom)
        if not bbox_intersects(bb):
            continue
        name = (feat.get("properties") or {}).get("NAME") or ""
        out.append({"name": name.strip(), "geom": geom, "area": geom_area(geom)})
    out.sort(key=lambda f: -f["area"])
    return out


def simplify_feature(feat):
    """Return list of polygons, each a list of rings, after simplification."""
    geom = feat["geom"]
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    simplified = []
    for poly in polys:
        rings = []
        for i, ring in enumerate(poly):
            s = simplify_ring(ring)
            if s is None:
                if i == 0:
                    rings = []
                    break
                continue  # drop an unusable hole, keep the outer ring
            rings.append(s)
        if rings:
            simplified.append(rings)
    return simplified


def make_elements(features):
    """Turn selected + simplified features into Overpass elements."""
    elements = []
    way_id = WAY_ID_BASE
    rel_id = REL_ID_BASE
    member_id = MEMBER_WAY_ID_BASE
    index = {}  # name -> list of (element, polygon rings)

    for feat in features:
        polys = simplify_feature(feat)
        if not polys:
            continue
        name = feat["name"]
        tags = dict(BASE_TAGS)
        if name:
            tags["name"] = name

        simple = len(polys) == 1 and len(polys[0]) == 1
        if simple:
            way_id += 1
            el = {
                "type": "way",
                "id": way_id,
                "tags": tags,
                "geometry": as_geometry_nodes(polys[0][0]),
            }
        else:
            rel_id += 1
            rel_tags = {"type": "multipolygon"}
            rel_tags.update(tags)
            members = []
            for poly in polys:
                for i, ring in enumerate(poly):
                    member_id += 1
                    members.append({
                        "type": "way",
                        "ref": member_id,
                        "role": "outer" if i == 0 else "inner",
                        "geometry": as_geometry_nodes(ring),
                    })
            el = {"type": "relation", "id": rel_id, "tags": rel_tags, "members": members}
        elements.append(el)
        index.setdefault(name, []).append((el, polys))

    return elements, index, way_id, rel_id, member_id


def largest_for(index, name):
    """(element, polygons) with the biggest outer ring for a given park name."""
    entries = index.get(name) or []
    if not entries:
        return None, None
    best, best_area = None, -1.0
    for el, polys in entries:
        a = sum(ring_area(p[0]) for p in polys)
        if a > best_area:
            best, best_area = (el, polys), a
    return best


def interior_points(polys, count, prefer=None):
    """
    Sample `count` points that are provably inside the given polygons.
    `prefer` is an optional [lon, lat] the samples should be sorted towards.
    """
    all_rings = [p for p in polys]
    minx = min(ring_bbox(p[0])[0] for p in all_rings)
    miny = min(ring_bbox(p[0])[1] for p in all_rings)
    maxx = max(ring_bbox(p[0])[2] for p in all_rings)
    maxy = max(ring_bbox(p[0])[3] for p in all_rings)
    found = []
    steps = 60
    for i in range(1, steps):
        for j in range(1, steps):
            lon = minx + (maxx - minx) * i / steps
            lat = miny + (maxy - miny) * j / steps
            if any(point_in_polygon(lon, lat, rings) for rings in all_rings):
                found.append([round(lon, 6), round(lat, 6)])
    if not found:
        return []
    if prefer:
        found.sort(key=lambda p: (p[0] - prefer[0]) ** 2 + (p[1] - prefer[1]) ** 2)
    else:
        found.sort(key=lambda p: (p[0], p[1]))
    # Spread the picks out a little instead of returning near-duplicates.
    picks = []
    for p in found:
        if all((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 > 0.0005 ** 2 for q in picks):
            picks.append(p)
        if len(picks) >= count:
            break
    return picks or found[:count]


def densify(waypoints, step=0.004):
    """Interpolate along a polyline so the route has realistic vertex spacing."""
    out = []
    for i in range(len(waypoints) - 1):
        ax, ay = waypoints[i]
        bx, by = waypoints[i + 1]
        dist = math.hypot(bx - ax, by - ay)
        n = max(1, int(dist / step))
        for k in range(n):
            t = k / n
            out.append([round(ax + (bx - ax) * t, 6), round(ay + (by - ay) * t, 6)])
    out.append([round(waypoints[-1][0], 6), round(waypoints[-1][1], 6)])
    return out


def build_trail(harriman_polys, bear_polys, member_id):
    """
    A synthetic "Appalachian Trail" hiking route relation that provably runs
    through both the Harriman and the Bear Mountain polygons.
    """
    # Anchor points guaranteed to sit inside each park.
    h_pts = interior_points(harriman_polys, 3, prefer=[-74.13, 41.21])
    b_pts = interior_points(bear_polys, 2, prefer=[-73.99, 41.30])
    if not h_pts or not b_pts:
        raise SystemExit("could not find interior points for the trail route")
    h_pts.sort(key=lambda p: p[0])   # west -> east
    b_pts.sort(key=lambda p: p[0])

    waypoints = [[-74.27, 41.20]] + h_pts + b_pts + [[-73.98, 41.32]]
    line = densify(waypoints)

    inside_h = sum(1 for p in line if any(point_in_polygon(p[0], p[1], r) for r in harriman_polys))
    inside_b = sum(1 for p in line if any(point_in_polygon(p[0], p[1], r) for r in bear_polys))
    if inside_h < 2 or inside_b < 2:
        raise SystemExit(
            "trail does not cross both parks (harriman=%d bear=%d)" % (inside_h, inside_b))

    # Split into two member ways, the way a real route relation is built.
    mid = len(line) // 2
    part_a, part_b = line[:mid + 1], line[mid:]
    rel = {
        "type": "relation",
        "id": 156553,
        "tags": {
            "type": "route",
            "route": "hiking",
            "network": "nwn",
            "name": "Appalachian Trail",
            "ref": "AT",
            "operator": "Appalachian Trail Conservancy",
        },
        "members": [
            {"type": "way", "ref": member_id + 1, "role": "", "geometry": as_geometry_nodes(part_a)},
            {"type": "way", "ref": member_id + 2, "role": "", "geometry": as_geometry_nodes(part_b)},
        ],
    }
    return rel, inside_h, inside_b


def build_overlap_polygon(harriman_polys, way_id):
    """
    A rectangle that genuinely overlaps Harriman (and reaches towards Bear
    Mountain), tagged with a fake POTA ref so the park-park zone path is
    always exercised.
    """
    pts = interior_points(harriman_polys, 6, prefer=[-74.03, 41.30])
    if not pts:
        raise SystemExit("no interior point for the overlap polygon")
    cx, cy = pts[0]
    d = 0.012
    ring = [
        [round(cx - d, 6), round(cy - d, 6)],
        [round(cx - d, 6), round(cy + d, 6)],
        [round(cx + d, 6), round(cy + d, 6)],
        [round(cx + d, 6), round(cy - d, 6)],
        [round(cx - d, 6), round(cy - d, 6)],
    ]
    return {
        "type": "way",
        "id": way_id,
        "tags": {
            "name": "Harriman-Bear Mountain overlap test",
            "boundary": "protected_area",
            "protect_class": "5",
            "leisure": "park",
            "operator": "Test",
            "communication:amateur_radio:pota": "US-9999",
        },
        "geometry": as_geometry_nodes(ring),
    }, [cx, cy]


def build_admin_boundary(rel_id):
    """
    Distractor: a town outline (type=boundary + boundary=administrative) that
    also carries leisure=park, the way a few sloppy OSM town relations do.  The
    matcher must drop it in fetchBoundaries — it is not a park and it would
    otherwise swallow every reference inside the town.
    """
    ring = [
        [-74.30, 41.14],
        [-74.30, 41.24],
        [-74.14, 41.24],
        [-74.14, 41.14],
        [-74.30, 41.14],
    ]
    return {
        "type": "relation",
        "id": rel_id,
        "tags": {
            "type": "boundary",
            "boundary": "administrative",
            "admin_level": "8",
            "leisure": "park",
            "name": "Town of Tuxedo",
        },
        "members": [
            {"type": "way", "ref": rel_id * 10, "role": "outer",
             "geometry": as_geometry_nodes(ring)},
        ],
    }


def build_umbrella(way_id):
    """
    Distractor: a huge "umbrella" polygon (PAD-US style) covering most of the
    area.  It shares no name tokens with any POTA park in the area, so the
    matcher must leave it unmatched even though it contains many park points.
    """
    ring = [
        [-74.36, 41.11],
        [-74.36, 41.42],
        [-73.88, 41.42],
        [-73.88, 41.11],
        [-74.36, 41.11],
    ]
    return {
        "type": "way",
        "id": way_id,
        "tags": {
            "name": "Palisades Interstate Park Commission",
            "boundary": "protected_area",
            "protect_class": "5",
            "operator": "Palisades Interstate Park Commission",
            "ownership": "state",
        },
        "geometry": as_geometry_nodes(ring),
    }


def main():
    if not os.path.exists(SRC):
        print("missing source geojson: %s" % SRC, file=sys.stderr)
        return 1

    fc = load_source()
    feats = select_features(fc)
    print("source features intersecting bbox: %d" % len(feats))

    elements, index, way_id, rel_id, member_id = make_elements(feats)
    print("emitted park elements: %d" % len(elements))

    # --- POTA tags on the two flagship parks -------------------------------- #
    harriman = largest_for(index, "Harriman State Park")
    bear = largest_for(index, "Bear Mountain State Park")
    if not harriman or not bear:
        print("Harriman / Bear Mountain not found in source data", file=sys.stderr)
        return 1
    harriman[0]["tags"]["communication:amateur_radio:pota"] = "US-2069"
    harriman[0]["tags"]["protect_class"] = "5"
    bear[0]["tags"]["communication:amateur_radio:pota"] = "US-2010"
    print("tagged %s/%s = US-2069 (Harriman), %s/%s = US-2010 (Bear Mountain)"
          % (harriman[0]["type"], harriman[0]["id"], bear[0]["type"], bear[0]["id"]))

    # Collect *all* polygons of each park so the trail can cross any unit.
    harriman_polys = [p for _, polys in index["Harriman State Park"] for p in polys]
    bear_polys = [p for _, polys in index["Bear Mountain State Park"] for p in polys]

    # --- synthetic hiking route --------------------------------------------- #
    trail, in_h, in_b = build_trail(harriman_polys, bear_polys, member_id)
    member_id += 2
    elements.append(trail)
    print("appalachian trail relation: %d vertices inside Harriman, %d inside Bear Mountain"
          % (in_h, in_b))

    # --- overlap test polygon ------------------------------------------------ #
    way_id += 1
    overlap, centre = build_overlap_polygon([p for p in harriman[1]], way_id)
    elements.append(overlap)
    print("overlap polygon (US-9999) centred at %.5f, %.5f" % (centre[1], centre[0]))

    # --- umbrella distractor -------------------------------------------------- #
    way_id += 1
    umbrella = build_umbrella(way_id)
    elements.append(umbrella)

    # --- administrative-boundary distractor ----------------------------------- #
    rel_id += 1
    elements.append(build_admin_boundary(rel_id))

    doc = {
        "version": 0.6,
        "generator": "build_overpass_fixture.py (synthetic, from NYS OPRHP park polygons)",
        "osm3s": {
            "timestamp_osm_base": "2026-08-31T00:00:00Z",
            "copyright": "Synthetic test fixture. Source polygons: NYS OPRHP / data.ny.gov.",
        },
        "elements": elements,
    }

    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, separators=(",", ":"))

    size = os.path.getsize(OUT)
    ways = sum(1 for e in elements if e["type"] == "way")
    rels = sum(1 for e in elements if e["type"] == "relation")
    print("wrote %s (%d elements: %d ways, %d relations, %.2f MB)"
          % (OUT, len(elements), ways, rels, size / 1e6))
    if size > 1_500_000:
        print("WARNING: fixture is larger than 1.5 MB", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
