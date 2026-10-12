---
name: build-prospect-list
description: Use when the user wants a list of companies or people to prospect ("find 50 Irish POS companies and their CEO emails", "SaaS companies hiring SDRs") — finds prospects into a new table, then adds a work-email waterfall, verification and an AI research column.
---
# Build a prospect list

Goal: one table with the right companies/people, a verified work email per person, and a short AI research note per row. Read the Knowledge Hub first (`knowledge` tool) so targeting matches the ICP and respects "Do NOT target".

## 1. Find the prospects (creates the table — ONE table per request)
`POST /api/gtm/find` (add `"table_name"` when the user named the table) → `{ "id": <tableId>, "rows": n, "source": "..." }` (404 `no_results` with a helpful message when nothing matched)
```json
{ "mode": "companies", "query": "point of sale software Ireland", "limit": 50 }
```
- `mode: "companies"` searches the free YC directory first, then (with an OpenRouter key) an AI web search (max 40 rows). Force the AI web search with `"ai": true` for anything that isn't a startup/YC-type company (local businesses, regional markets, "Irish POS companies").
  Columns: `Company`, `Company domain`, `Description` (+ YC fields).
- `mode: "people"` = public GitHub org members (`query` = org name like `vercel`, or a domain). Columns: `Full name`, `Company`, `Company domain`, `GitHub`, `Email`…
- `mode: "jobs"` = open roles on public job boards; `query` = comma-separated company domains. Good for "companies hiring X".
- Apollo (needs APOLLO_API_KEY): create a table, then `POST /api/gtm/tables/{id}/import/source` with `{ "source": "apollo_people", "params": { "titles": "CEO, Founder", "domains": "a.com, b.com", "locations": "Ireland" }, "limit": 100 }` (or `apollo_companies`).
- For CSV or other shapes see the `table-building` skill.

Keep row counts modest (≤100) unless the user asks for more.

**One request = one table.** The first find creates the table; every further search for the same list MUST go into that table by passing `"table_id": <id>` — never create a second table for "batch 2". With `table_id`, find adds only rows not already in the table and returns `{ id, rows: <added>, duplicates, appended: true }`:
```json
{ "mode": "companies", "query": "EPOS systems Ireland", "ai": true, "limit": 40, "table_id": 12 }
```
Vary the wording between searches (AI web search returns overlapping results); stop when `rows` comes back 0–2 twice — say how many you reached instead of looping. Add enrichment columns once, after the rows are in (new rows pick up auto-run columns automatically).

## 2. People: who to contact at each company
A companies table has no person yet. Cheapest options first:
- AI research column that finds the decision maker (works everywhere, uses AI tokens):
  `POST /api/gtm/tables/{id}/columns`
  ```json
  { "name": "CEO", "type": "ai", "config": {
      "prompt": "Who is the current CEO (or founder / managing director) of {{Company}} ({{Company domain}})? Check the company site, LinkedIn results and press.",
      "outputs": [{ "name": "full_name", "type": "string" }, { "name": "title", "type": "string" }, { "name": "linkedin", "type": "url" }],
      "webSearch": true, "fetchPages": true, "maxSteps": 6 } }
  ```
  Then pull the name into its own column so enrichment can use it (extract columns run automatically):
  `{ "name": "CEO name", "type": "extract", "config": { "source": "CEO", "path": "full_name" } }`
- Apollo people search (key) — step 1.

## 3. Work email waterfall + verification
Both via `POST /api/gtm/tables/{id}/columns`:
```json
{ "name": "Work email", "type": "enrich", "auto_run": true, "config": { "kind": "work_email", "inputs": { "fullName": "{{CEO name}}", "domain": "{{Company domain}}" } } }
{ "name": "Email status", "type": "enrich", "auto_run": true, "config": { "kind": "verify_email", "inputs": { "email": "{{Work email}}" } } }
```
The waterfall order (free finder first, then paid providers whose keys are set, unverified pattern guess last) is automatic; restrict it with `"providers": ["free_finder", "pattern"]`. Details and costs: `enrich-emails-and-phones`.

## 4. AI research column (personalisation)
```json
{ "name": "Research", "type": "ai", "config": {
  "prompt": "Research {{Company}} ({{Company domain}}). What do they sell, to whom, and what changed recently? Note anything relevant to our offer.",
  "outputs": [{ "name": "summary", "type": "string", "description": "two sentences" }, { "name": "icebreaker", "type": "string", "description": "one personal opening line for a cold email" }],
  "webSearch": true, "fetchPages": true, "maxSteps": 6, "useKnowledge": true } }
```
`useKnowledge: true` appends the Knowledge Hub so the AI judges fit and writes on-brand lines.

## 5. Run it
`POST /api/gtm/tables/{id}/run` with `{ "columnIds": [<CEO col>, <Work email col>, <Email status col>, <Research col>] }` → `{ "queued": n }`.
- Dependants (email after name, verify after email) re-run automatically when their inputs fill in; `auto_run` columns also run on new rows.
- Paid providers on >100 rows pause for the user's approval automatically — mention the cost first.
- Runs continue in the background. Check progress with `GET /api/gtm/tables/{id}` (`queue.pending` / `queue.running`; row cells are keyed by column id).

## 6. Report
Give the table id and name (the UI links it), row count, columns added, what's still running, and next steps — e.g. "send the verified rows to a campaign" (`campaign-from-table`).

Pitfalls: `{{…}}` names must match column names exactly. Column names are unique per table. Don't invent domains — blanks are skipped by the finder.
