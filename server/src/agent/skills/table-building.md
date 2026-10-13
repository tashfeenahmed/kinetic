---
name: table-building
description: Reference for building and editing Kinetic tables — create tables and templates, every column type (text, formula, extract, enrich, ai, http, signal, action), running cells, editing rows, CSV import/export and data sources (YC, GitHub, job boards, HubSpot, Apollo, webhooks, leads).
---
# Tables: build, edit, run

A table = columns + rows; cells hold values. A column's `config` drives what it does; `{{Column name}}` (or `{{Column.path}}`) inserts another column's value for the row.

## Tables
- `GET /api/gtm/tables` → `[{ id, name, row_count }]`
- `POST /api/gtm/tables` `{ "name": "Q4 targets", "template": "blank|people|companies|company_research|find_emails|signals" }` → `{ id }`
  - `people`: Full name, Company, Company domain, Title, LinkedIn URL. `companies` / `signals`: Company, Company domain.
  - `company_research`: + company enrichment, employees, tech stack, open roles, AI research, Fit score. `find_emails`: Full name, Company domain + Work email, Email status, LinkedIn.
- `GET /api/gtm/tables/{id}` → `{ table, columns, rows: [{ id, cells: { <columnId>: { value, status, error } } }], queue }` (large; truncated for you)
- `PATCH /api/gtm/tables/{id}` `{ "name": "...", "schedule": { "enabled": true, "everyMinutes": 1440, "columnIds": [..] } }` (scheduled refresh)
- `DELETE /api/gtm/tables/{id}` (needs approval)

## Rows & cells
- `POST /api/gtm/tables/{id}/rows` `{ "rows": [{ "Company": "Acme", "Company domain": "acme.com" }] }` — keys are column names; unknown keys create text columns. `{ "count": 10 }` adds blank rows. → `{ ids }`
- `PATCH /api/gtm/tables/{id}/cells` `{ "changes": [{ "rowId": 1, "columnId": 2, "value": "x" }] }` — text columns only.
- `DELETE /api/gtm/tables/{id}/rows` `{ "ids": [..] }` (approval).

## Columns — `POST /api/gtm/tables/{id}/columns`
Body `{ "name", "type", "config", "auto_run"?, "run_if"? }` → `{ id }`. Update with `PATCH /api/gtm/columns/{id}` (same fields minus type, plus `position`); delete with `DELETE /api/gtm/columns/{id}`.
- **text** — plain input. `{}`
- **formula** (auto-runs) — JS expression over `row`: `{ "expression": "row[\"First name\"] + ' at ' + row.Company" }`. Helpers: `domain(x)`, `lower(x)`, `first(name)`, `last(name)`, `get(v, "a.b")`.
- **extract** (auto-runs) — a field from a JSON cell: `{ "source": "Company info", "path": "employees" }`
- **enrich** — provider waterfall: `{ "kind": "work_email|verify_email|mobile_phone|linkedin_url|person_profile|company_profile|company_domain|company_linkedin|fit_score", "inputs": { "fullName": "{{Full name}}", "domain": "{{Company domain}}" }, "providers"?: ["free_finder"] }`. Inputs: firstName, lastName, fullName, email, domain, companyName, linkedinUrl. `GET /api/gtm/catalog` lists kinds, required inputs, provider steps, costs and which are ready (keys set).
  - **Fit score** (`fit_score`): scores each row 0–100 against the Knowledge Hub's "Ideal customer profile" / "Buyer personas" docs with one cheap AI call (temperature 0). Reads the row's other columns automatically; `context` (e.g. `"{{Research.summary}}"`) adds text and makes it wait for that column. Value = score; `{{Fit score.tier}}` = strong|possible|poor, `{{Fit score.reason}}` = one sentence. Filter with `run_if: row["Fit score"] >= 70`. Without ICP content the cell errors "Add your ideal customer profile in the Knowledge Hub" — offer to write that doc first.
- **ai** — research agent: `{ "prompt": "…{{Company}}…", "outputs": [{ "name": "summary", "type": "string|number|boolean|list|url", "description": "…" }], "webSearch": true, "fetchPages": true, "maxSteps": 8, "model"?: "…", "useKnowledge"?: true }`. With several outputs, read one with an extract column.
- **http** — `{ "url": "https://api.example.com/{{Company domain}}", "method": "GET", "headers": {}, "body"?: "…", "extract"?: "data.field" }`
- **signal** — monitors (see `signals-monitoring`): `{ "kind": "hiring", "inputs": { "domain": "{{Company domain}}", "companyName": "{{Company}}", "keywords": "sdr, sales development" } }`
- **action** — does something per row: `outreach_campaign`, `outreach_update_lead` (see `campaign-from-table`), `slack` `{ "text": "…", "channel"?: "#x" }`, `webhook` `{ "url", "method", "body"? }`, `hubspot_contact` `{ "email": "{{Email}}", "fields": [{ "name", "value" }] }`, `hubspot_company`, `salesforce`. Running Slack/webhook/CRM actions needs the user's approval.
- `auto_run: true` → runs for new rows and when inputs change. `run_if` is a JS condition: `row["Email status"] === "valid"` or `changed("Hiring (open roles)")`.

## Running
- `POST /api/gtm/tables/{id}/run` `{ "columnIds"?: [..], "rowIds"?: [..], "force"?: false }` → `{ queued }`. Without `force`, finished cells are skipped. Omit columnIds to run every runnable column.
- `POST /api/gtm/tables/{id}/stop` cancels queued cells. `GET /api/gtm/cells/{rowId}/{columnId}` → one cell with provider details.
- `GET /api/gtm/activity?tableId=..` → recent log lines (provider errors show here).

## Import / export / sources
- CSV text: `POST /api/gtm/tables/{id}/import/csv` `{ "csv": "Company,Company domain\nAcme,acme.com" }` → `{ imported }`
- Export: `GET /api/gtm/tables/{id}/export.csv` (CSV text, all rows). Only some rows, in a given order: `POST /api/gtm/tables/{id}/export.csv` `{ "ids": [rowId, ...] }`.
- Flow: tables (research) → Leads (`campaign-from-table`: push rows to a lead list or straight into a campaign) → campaigns → Master Inbox.
- Sources: `POST /api/gtm/tables/{id}/import/source` `{ "source": "yc_companies|github_people|jobs|apollo_people|apollo_companies|hubspot_contacts|hubspot_companies", "params": {...}, "limit": 100 }`
  - yc_companies: `query`, `batch` ("W24"), `region`, `hiring` ("yes"/"no"), `status`
  - github_people: `org` or `domain`. jobs: `domains` (comma list), `keywords`
  - apollo_people: `titles`, `domains`, `locations`, `seniorities` (comma lists; APOLLO_API_KEY)
- Leads → table: `POST /api/gtm/tables/from-leads` `{ "list_id"?: n, "campaign_id"?: n, "lead_ids"?: [..], "all"?: true }`
- Inbound webhook: the table's `webhookUrl` (from GET table) accepts POSTed JSON rows.

Pitfalls: names are unique per table and case-sensitive in `{{…}}`; formulas see headline values (`row.X`), use `raw` for full payloads.
