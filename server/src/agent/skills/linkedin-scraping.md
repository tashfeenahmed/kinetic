---
name: linkedin-scraping
description: Export LinkedIn/Sales Navigator data into a table with the Kinetic Companion extension — people searches, Sales Navigator lead/account searches, profiles, companies, employees, post likers/commenters, recent posts, group members, event attendees, "people also viewed", connections and inbox.
---
# LinkedIn scraping (Companion "phantoms")

LinkedIn data is read **inside the user's own logged-in browser** by the Kinetic Companion extension, at human pace. Kinetic never stores LinkedIn passwords or cookies. Nothing runs unless a browser is paired.

## 1. Check the extension is paired
`GET /api/companion/status` → `data.devices[]` (`online`, `paused`, `site_pauses.linkedin`).
- No devices: tell the user to install it from **Automations → Extension** (`/automations/extension`): download `/companion/extension.zip`, unzip, chrome://extensions → Developer mode → Load unpacked, then pair with a code from that page. Jobs can still be created; they wait until a browser polls.
- `site_pauses.linkedin` set: a safety stop (rate limit/challenge) happened. Tell the user; don't try to work around it.

## 2. Pick the phantom
`GET /api/automations/phantoms` lists every phantom with `fields` (the input schema), `outputs` (table columns) and `dedupeKey`. LinkedIn data phantoms:

| id | inputs |
|---|---|
| `linkedin.search_export` | `search_url` (a linkedin.com/search/results/people/ URL), `limit` |
| `sales_navigator.lead_search_export` / `sales_navigator.account_search_export` | `search_url` (Sales Navigator search URL with `query=` or `savedSearchId=`), `limit` |
| `linkedin.profile_scraper` | `targets`, `visit` (bool: count as a visit) |
| `linkedin.company_scraper` | `targets` (company pages) |
| `linkedin.company_employees` | `targets` (company pages), `title_keywords`, `limit` |
| `linkedin.post_reactors` / `linkedin.post_commenters` | `targets` (post URLs), `limit` |
| `linkedin.profile_activity` | `targets` (profiles/companies), `posts_per_profile` |
| `linkedin.group_members` | `group_url`, `limit` |
| `linkedin.event_attendees` | `event_url`, `limit` |
| `linkedin.people_also_viewed` | `targets` (profiles) |
| `linkedin.connections_export` | `limit` |
| `linkedin.inbox_export` | `limit`, `unread_only` |

`targets` is either newline-separated URLs (`"https://www.linkedin.com/in/a/\nhttps://www.linkedin.com/in/b/"`), an array of URLs, or a table column: `{"table_id": 12, "column": "LinkedIn URL"}` (every row's value is used).

## 3. Create the job
```
POST /api/automations/jobs
{"phantom": "linkedin.search_export", "name": "Heads of Growth Berlin",
 "params": {"search_url": "https://www.linkedin.com/search/results/people/?keywords=head%20of%20growth&geoUrn=%5B%22106967730%22%5D", "limit": 250},
 "table_name": "Heads of Growth · Berlin"}
```
- Results go to a **new table** (named after `table_name`/`name`) or an existing one with `"table_id": 12`. Map fields to other column names with `"column_map": {"profileUrl": "LinkedIn"}`.
- Rows are deduped by the phantom's key (e.g. `profileUrl`) against earlier results of this job and the table's matching column.
- Data phantoms start immediately (`status: "running"`). Response: `data.id`, `data.table_id`.
- Validation errors come back as 422 with `fields`.

## 4. Follow progress
- `GET /api/automations/jobs/:id` → `status`, `progress {done,total,message}`, `results_count`, `tasks {pending,leased,done,failed}`, `runs[]`.
- `GET /api/automations/jobs/:id/tasks?status=failed` → per-target errors.
- Results: the table at `/tables/{table_id}` (`GET /api/gtm/tables/:id`).
- Pause/resume/cancel: `POST /api/automations/jobs/:id/pause|resume|cancel`.

## Limits and pacing (tell the user when relevant)
- Default **1,000 LinkedIn profiles scraped per day** (`linkedin.scrape`). Large exports continue automatically the next day from where they stopped.
- Jobs only run during working hours unless "scrape outside hours" is on. See `GET /api/automations/settings` and `GET /api/automations/stats` (`limits[].used_today`).
- `linkedin.profile_scraper` with `visit: true` and `linkedin.profile_visitor` show up in "Who viewed your profile" and count against the 80/day visit limit.

## Pitfalls
- People search URLs must be LinkedIn's own search result URLs; Sales Navigator phantoms need a Sales Navigator seat.
- Group/event exports only work for groups/events the user belongs to/attends.
- If a job sits at `pending` with progress "Waiting for the extension", no paired browser is online or it's outside working hours.
- To schedule re-runs that add only new rows, load the `automations-watcher-mode` skill.
