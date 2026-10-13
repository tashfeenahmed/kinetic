---
name: saved-searches-and-watchers
description: Save any prospect search (Google Maps, recently funded companies, YC, Apollo, GitHub, job boards, lookalikes, AI company search) and re-run it on demand or hourly/daily/weekly so only NEW rows land in a table, with optional Slack/webhook alerts. Use for "watch", "monitor for new", "alert me when new … appear".
---
# Saved searches (watchers)

A saved search = source + params + target table + schedule. Every run searches again, drops rows on
exclusion lists, drops rows it already delivered (dedupe keys: place id, domain, email, LinkedIn URL
or a name+city hash depending on the source) and appends only the new ones. Each run is recorded.

## Sources and params
`GET /api/sources` lists ids, labels and readiness. Common params:
| source | params example |
|---|---|
| `google_maps` | `{"query": "dentist", "location": "Berlin", "radius_km": 10}` or `{"query": "cafe", "bbox": {...}}` |
| `funding_rounds` | `{"countries": "us,uk,fr", "sector": "tech", "days": 2}` — companies that just raised money (see `funding-rounds`); run daily with `days: 2` |
| `company_lookalikes` | `{"seeds": ["stripe.com", "adyen.com"]}` or `{"table_id": 12}` |
| `people_lookalikes` | `{"seeds": ["VP Sales"], "companies": ["ramp.com"]}` |
| `find_companies` | `{"query": "restaurant POS"}` (YC, then AI web search) |
| `ai_companies` | `{"query": "UK payroll software"}` (needs OpenRouter) |
| `yc_companies` | `{"query": "fintech", "batch": "W24", "hiring": "yes"}` |
| `apollo_companies` / `apollo_people` | `{"keywords": "logistics", "locations": "Germany"}` / `{"titles": "Head of Sales", "domains": "ramp.com"}` (needs APOLLO_API_KEY) |
| `github_people` | `{"org": "vercel"}` |
| `jobs` | `{"domains": "ramp.com, linear.app", "keywords": "sales"}` |

Preview any source without saving: `POST /api/sources/preview` `{ "source": "yc_companies", "params": {...}, "limit": 20 }`.

## Create
`POST /api/saved-searches`
```json
{ "name": "Berlin dentists", "source": "google_maps", "params": { "query": "dentist", "location": "Berlin" },
  "max_results": 200, "schedule": "daily", "table_id": null, "apply_exclusions": true,
  "alert": { "kind": "slack", "channel": "#new-leads" }, "run_now": true }
```
- `schedule`: `off` | `hourly` | `daily` | `weekly`. The background worker runs due searches every minute.
- `table_id`: append to an existing table; null → a table named after the search is created on the first run with results.
- `alert`: `{}` (none), `{"kind":"slack","channel":"#x"}` (uses the Slack settings) or `{"kind":"webhook","url":"https://…"}` (POSTs `{event:"saved_search.new_results", search, table, count, rows}`). Alerts fire only when a run finds new rows.
- `run_now: true` runs immediately and returns `run` with `table_id`.

## Run, inspect, change
- `POST /api/saved-searches/{id}/run` → `{ status, found, new_count, excluded, table_id, new_rows }`.
- `GET /api/saved-searches` (each with `last_run`, `seen_count`, `table_name`), `GET /api/saved-searches/{id}` (with `runs`), `GET /api/saved-searches/{id}/runs`.
- `PATCH /api/saved-searches/{id}` `{ "schedule": "weekly", "params": {...}, "alert": {...} }`.
- `DELETE /api/saved-searches/{id}` (the table stays). `DELETE /api/saved-searches/{id}/seen` forgets delivered keys so the next run re-adds everything — confirm with the user first (it creates duplicates in the table).

## Pitfalls
- Confirm with the user before scheduling searches that cost credits (Google Maps with a key, Apollo, PDL, AI search) — hourly runs multiply cost.
- The first run delivers everything (baseline); later runs only new rows. A failed run is recorded with `status: "error"` and the schedule moves on.
- The UI lives at /searches (Saved searches tab).
