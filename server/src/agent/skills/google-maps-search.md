---
name: google-maps-search
description: Find local businesses (dentists, cafes, plumbers, agencies…) in a city, radius or map rectangle via Google Maps (Places API) or free OpenStreetMap, preview them and put them in a table. Use for any "businesses in <place>" request.
---
# Local business search (Google Maps / OpenStreetMap)

Provider: **Google Places API (New)** when `GOOGLE_MAPS_API_KEY` is set on the Integrations page,
otherwise **OpenStreetMap** (Nominatim geocoding + Overpass) — free, no key, but fewer phones/websites
and no ratings. Check which one is active: `GET /api/sources` → `google_maps.provider` (`google` | `osm`).

## 1. Preview (no table created)
`POST /api/sources/google-maps/search`
```json
{ "query": "dentist", "location": "Berlin, Germany", "radius_km": 5, "limit": 100 }
```
Area options (pick one):
- `"location": "<city or address>"` alone → the city's own bounds (a street address → 5 km around it).
- `"location"` or `"center": {"lat": 52.52, "lng": 13.40}` + `"radius_km": 1–200` → circle (results outside are dropped).
- `"bbox": {"south": 52.45, "west": 13.30, "north": 52.56, "east": 13.48}` → rectangle.

Other fields: `provider` (`auto` | `google` | `osm`), `fields` (`contact` default: phone, website,
rating, reviews; `basic` is the cheaper Google SKU without them), `max_tiles` (request cap, default 40
for Google, 16 for OSM), `exclusions` (default true).

`query` can be a category ("coffee shop", "law firm"), keywords ("sushi"), several comma-separated
("bakery, cafe") or a raw OSM tag ("shop=bicycle").

Response: `{ provider, area, tiles, requests, capped, found, excluded, rows }`. Each row has
`Company, Category, Address, City, Country, Phone, Website, Company domain, Rating, Reviews, Lat, Lng,
Maps URL, Place ID` (Google) or `OSM ID` (OSM), `Source`. `Company domain` is blank when the listing
links to Facebook/Instagram/booking sites instead of its own website.

## 2. Put results in a table
- Create a new table directly: `POST /api/gtm/find` `{ "mode": "google_maps", "query": "dentist", "params": { "location": "Berlin", "radius_km": 5 }, "limit": 200 }` → `{ id, rows, source, excluded }`.
- Or add previewed rows: `POST /api/sources/to-table` `{ "name": "Dentists · Berlin", "rows": [...] }` (or `"table_id"` to append).
- Or into an existing table: `POST /api/gtm/tables/{id}/import/source` `{ "source": "google_maps", "params": { "query": "dentist", "location": "Berlin" }, "limit": 200 }`.
- To keep watching the area for new businesses, save it — see the `saved-searches-and-watchers` skill (source `google_maps`, same params).

## Limits and cost
- Google Text Search returns at most 60 places per query (3 pages of 20). Kinetic splits any box that
  hits 60 into quadrants and searches again, up to `max_tiles` requests. Each page is one billed
  request; Google gives free monthly usage per SKU, then charges per 1,000. Ask before running searches
  with `limit` > 500 or `max_tiles` > 40 on the Google provider.
- OpenStreetMap is rate-limited (~1 request/second, one at a time); large areas are split into
  ≤ 20 km tiles (max 16 by default) and can take a minute. If Overpass says it's busy, retry later.
- Exclusion lists are applied automatically; the response says how many rows were dropped.

## Next steps to offer
Find emails (`work_email` enrichment on `Company domain`), enrich company, or send to a campaign.
