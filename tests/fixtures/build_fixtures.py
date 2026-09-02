#!/usr/bin/env python3
"""Build deterministic API fixtures for offline tests from the NY reference data in
/home/claude/research/pota/repos/potamapol_repo/public/data/US-NY (potamap.ol repo).

Outputs (tests/fixtures/):
  pota_location_parks_US-NY.json   GET https://api.pota.app/location/parks/US-NY
  pota_park_grid_FN21.json / FN31  GET https://api.pota.app/park/grid/FN21
  pota_park_US-2069.json           GET https://api.pota.app/park/US-2069 (real capture)
  pota_park_stats_US-2069.json, pota_park_activations_US-2069.json, pota_park_leaderboard_US-2069.json
  pota_spots.json                  GET https://api.pota.app/spot/activator
  sota_associations.json           GET https://api2.sota.org.uk/api/associations
  sota_association_W2.json         GET https://api2.sota.org.uk/api/associations/W2
  sota_region_W2_GC.json           GET https://api2.sota.org.uk/api/regions/W2/GC
  sota_summit_W2_GC-001.json       GET https://api2.sota.org.uk/api/summits/W2/GC-001
  sota_spots.json                  GET https://api2.sota.org.uk/api/spots/1/all
  photon_search.json / photon_reverse.json / nominatim_search.json / nominatim_reverse.json
  ny_state_parks.geojson           polygons (for Overpass fixture generation)
"""
import json, math, os, random, sys

SRC = '/home/claude/research/pota/repos/potamapol_repo/public/data/US-NY'
OUT = os.path.dirname(os.path.abspath(__file__))
random.seed(42)

def grid6(lat, lon):
    A = 'ABCDEFGHIJKLMNOPQRSTUVWX'
    lon += 180; lat += 90
    s = A[int(lon // 20)] + A[int(lat // 10)]
    lon %= 20; lat %= 10
    s += str(int(lon // 2)) + str(int(lat // 1))
    lon %= 2; lat %= 1
    s += A[int(lon / (2 / 24))].lower() + A[int(lat / (1 / 24))].lower()
    return s

def grid4_of(lat, lon):
    return grid6(lat, lon)[:4]

# ---------------- POTA ----------------
parks_fc = json.load(open(os.path.join(SRC, 'parks-US-NY.geojson')))
parks = []
for f in parks_fc['features']:
    lon, lat = f['geometry']['coordinates'][:2]
    ref = f['properties']['NAME']; name = f['properties']['TITLE']
    acts = random.choice([0, 0, 1, 2, 5, 12, 40, 150])
    parks.append({
        'reference': ref, 'name': name, 'latitude': round(lat, 4), 'longitude': round(lon, 4),
        'grid': grid6(lat, lon), 'locationDesc': 'US-NY',
        'attempts': acts + random.choice([0, 0, 1, 3]), 'activations': acts, 'qsos': acts * random.randint(10, 60)
    })
parks.sort(key=lambda p: p['reference'])
json.dump(parks, open(os.path.join(OUT, 'pota_location_parks_US-NY.json'), 'w'))

for cell in ('FN21', 'FN31', 'FN20', 'FN30', 'FN22', 'FN32', 'FN12', 'FN13', 'FN23', 'FN33', 'FN02', 'FN03', 'FN11', 'FN10'):
    rows = [{'reference': p['reference'], 'name': p['name'], 'latitude': p['latitude'], 'longitude': p['longitude']}
            for p in parks if grid4_of(p['latitude'], p['longitude']) == cell]
    json.dump(rows, open(os.path.join(OUT, f'pota_park_grid_{cell}.json'), 'w'))

detail = {"parkId": 2069, "reference": "US-2069", "name": "Harriman", "latitude": 41.1753, "longitude": -74.1783,
          "grid4": "FN21", "grid6": "FN21ve", "parktypeId": 101, "active": 1,
          "parkComments": "Large park with many trailheads. Verify boundaries before activating near the edges.",
          "accessibility": None, "sensitivity": None, "accessMethods": "Automobile,Foot",
          "activationMethods": "Automobile,Campground,Pedestrian", "agencies": "NYS OPRHP",
          "agencyURLs": "https://parks.ny.gov", "parkURLs": None, "website": "https://parks.ny.gov/parks/145",
          "createdByAdmin": None, "parktypeDesc": "State Park", "locationDesc": "US-NY", "locationName": "New York",
          "entityId": 291, "entityName": "United States of America", "referencePrefix": "US", "entityDeleted": 0,
          "firstActivator": "WK2S", "firstActivationDate": "2017-06-01"}
json.dump(detail, open(os.path.join(OUT, 'pota_park_US-2069.json'), 'w'))
json.dump({"reference": "US-2069", "attempts": 212, "activations": 198, "contacts": 6120}, open(os.path.join(OUT, 'pota_park_stats_US-2069.json'), 'w'))
json.dump([{"activeCallsign": "WK2S", "qso_date": "20260815", "totalQSOs": 44, "qsosCW": 0, "qsosDATA": 4, "qsosPHONE": 40, "locationDesc": "US-NY"},
           {"activeCallsign": "K2ABC", "qso_date": "20260802", "totalQSOs": 17, "qsosCW": 17, "qsosDATA": 0, "qsosPHONE": 0, "locationDesc": "US-NY"}],
          open(os.path.join(OUT, 'pota_park_activations_US-2069.json'), 'w'))
json.dump({"activations": [{"callsign": "WK2S", "count": 31}, {"callsign": "K2ABC", "count": 9}],
           "activator_qsos": [{"callsign": "WK2S", "count": 1200}], "hunter_qsos": [{"callsign": "N1XYZ", "count": 25}]},
          open(os.path.join(OUT, 'pota_park_leaderboard_US-2069.json'), 'w'))
json.dump([{"spotId": 1, "activator": "WK2S", "frequency": "14285", "mode": "SSB", "reference": "US-2069", "parkName": None,
            "spotTime": "2026-08-31T14:00:00", "spotter": "N2XYZ", "comments": "QRP", "source": "Web", "invalid": None,
            "name": "Harriman State Park", "locationDesc": "US-NY", "grid4": "FN21", "grid6": "FN21ve",
            "latitude": 41.1753, "longitude": -74.1783, "count": 3, "expire": 1700}],
          open(os.path.join(OUT, 'pota_spots.json'), 'w'))

# ---------------- SOTA ----------------
gc = json.load(open(os.path.join(SRC, 'W2--GC.geojson')))
summits = []
for f in gc['features']:
    lon, lat = f['geometry']['coordinates'][:2]
    p = f['properties']
    alt = random.randint(600, 1275)
    cnt = random.choice([0, 0, 3, 9, 25, 80])
    summits.append({
        'summitCode': p['NAME'], 'name': p['TITLE'], 'shortCode': p['NAME'].split('/')[1], 'altM': alt, 'altFt': int(alt * 3.28084),
        'gridRef1': str(round(lon, 4)), 'gridRef2': str(round(lat, 4)), 'longitude': round(lon, 5), 'latitude': round(lat, 5),
        'points': int(p['POINTS']), 'bonusPoints': int(p['BONUSPOINTS']), 'validFrom': '2010-05-01T00:00:00', 'validTo': '2099-12-31T00:00:00',
        'activationCount': cnt, 'activationDate': '2026-07-04T00:00:00' if cnt else None, 'activationCall': 'W2XYZ' if cnt else None,
        'locator': grid6(lat, lon)
    })
summits.sort(key=lambda s: s['summitCode'])
json.dump({'associationCode': 'W2', 'associationName': 'USA - NJ / NY', 'regionCode': 'GC', 'regionName': 'Greater Catskills', 'summits': summits},
          open(os.path.join(OUT, 'sota_region_W2_GC.json'), 'w'))
for rc, rn in (('EH', 'Eastern Hudson'), ('GA', 'Greater Adirondacks'), ('WE', 'Western NY'), ('NJ', 'New Jersey')):
    json.dump({'associationCode': 'W2', 'associationName': 'USA - NJ / NY', 'regionCode': rc, 'regionName': rn, 'summits': []},
              open(os.path.join(OUT, f'sota_region_W2_{rc}.json'), 'w'))
json.dump([
    {'associationCode': 'W2', 'associationName': 'USA - NJ / NY', 'minLat': 40.4, 'maxLat': 45.1, 'minLong': -79.8, 'maxLong': -71.8, 'summitsCount': 700},
    {'associationCode': 'W1', 'associationName': 'USA - New England', 'minLat': 41.0, 'maxLat': 47.5, 'minLong': -73.8, 'maxLong': -66.9, 'summitsCount': 600},
    {'associationCode': 'W3', 'associationName': 'USA - PA/MD/DE', 'minLat': 37.9, 'maxLat': 42.3, 'minLong': -80.6, 'maxLong': -74.6, 'summitsCount': 500},
    {'associationCode': 'W6', 'associationName': 'USA - California', 'minLat': 32.5, 'maxLat': 42.0, 'minLong': -124.5, 'maxLong': -114.1, 'summitsCount': 5000},
], open(os.path.join(OUT, 'sota_associations.json'), 'w'))
json.dump({'associationCode': 'W2', 'associationName': 'USA - NJ / NY',
           'regions': [{'regionCode': 'GC', 'regionName': 'Greater Catskills'}, {'regionCode': 'EH', 'regionName': 'Eastern Hudson'},
                       {'regionCode': 'GA', 'regionName': 'Greater Adirondacks'}, {'regionCode': 'WE', 'regionName': 'Western NY'},
                       {'regionCode': 'NJ', 'regionName': 'New Jersey'}]},
          open(os.path.join(OUT, 'sota_association_W2.json'), 'w'))
for code in ('W1', 'W3'):
    json.dump({'associationCode': code, 'regions': []}, open(os.path.join(OUT, f'sota_association_{code}.json'), 'w'))
s0 = next(s for s in summits if s['summitCode'] == 'W2/GC-001')
det = dict(s0); det.update({'associationName': 'USA - NJ / NY', 'regionName': 'Greater Catskills', 'valid': True})
json.dump(det, open(os.path.join(OUT, 'sota_summit_W2_GC-001.json'), 'w'))
json.dump([{'id': 1, 'userID': 1, 'timeStamp': '2026-08-31T14:05:00', 'comments': 'CQ SOTA', 'callsign': 'N2SPOT',
            'associationCode': 'W2', 'summitCode': 'GC-001', 'activatorCallsign': 'W2XYZ', 'activatorName': 'Sam',
            'frequency': '14.062', 'mode': 'CW', 'summitDetails': 'Slide Mountain, 1274m, 10 pts'}],
          open(os.path.join(OUT, 'sota_spots.json'), 'w'))

# ---------------- Geocoding ----------------
json.dump({'type': 'FeatureCollection', 'features': [
    {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [-74.1783, 41.1753]},
     'properties': {'osm_type': 'R', 'osm_id': 1, 'osm_key': 'leisure', 'osm_value': 'park', 'name': 'Harriman State Park',
                    'state': 'New York', 'county': 'Rockland County', 'country': 'United States', 'countrycode': 'US', 'type': 'other'}}]},
    open(os.path.join(OUT, 'photon_search.json'), 'w'))
json.dump({'type': 'FeatureCollection', 'features': [
    {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [-74.18, 41.175]},
     'properties': {'osm_type': 'W', 'osm_id': 2, 'osm_key': 'highway', 'osm_value': 'residential', 'name': 'Seven Lakes Drive',
                    'street': 'Seven Lakes Drive', 'city': 'Sloatsburg', 'postcode': '10974', 'state': 'New York', 'county': 'Rockland County',
                    'country': 'United States', 'countrycode': 'US'}}]},
    open(os.path.join(OUT, 'photon_reverse.json'), 'w'))
json.dump([{'place_id': 1, 'lat': '41.1753', 'lon': '-74.1783', 'display_name': 'Harriman State Park, Rockland County, New York, United States',
            'type': 'park', 'importance': 0.6, 'address': {'state': 'New York', 'county': 'Rockland County', 'country': 'United States', 'country_code': 'us'}}],
          open(os.path.join(OUT, 'nominatim_search.json'), 'w'))
json.dump({'place_id': 2, 'lat': '41.175', 'lon': '-74.18', 'display_name': 'Seven Lakes Drive, Sloatsburg, Rockland County, New York, 10974, United States',
           'address': {'road': 'Seven Lakes Drive', 'town': 'Sloatsburg', 'county': 'Rockland County', 'state': 'New York', 'postcode': '10974', 'country': 'United States', 'country_code': 'us'}},
          open(os.path.join(OUT, 'nominatim_reverse.json'), 'w'))

# ---------------- Polygons for Overpass fixture ----------------
os.system(f'cp "{os.path.join(SRC, "new_york_state_parks.geojson")}" "{os.path.join(OUT, "ny_state_parks.geojson")}"')
print('fixtures written to', OUT, '| parks:', len(parks), '| summits:', len(summits))
