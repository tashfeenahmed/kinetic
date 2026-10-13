---
name: exclusions
description: Manage workspace exclusion lists (customers, competitors, do-not-contact, people already in campaigns) — domains, emails, company names, LinkedIn URLs, place ids — that every prospect search and import skips. Use when the user wants to keep companies/people out of searches or check whether someone is excluded.
---
# Exclusion lists

Values are normalised (`https://www.Acme.com/x` → `acme.com`, `Acme, Inc.` → `acme`, LinkedIn URLs
→ `linkedin.com/in/slug`) and stored in an indexed table, so lists of 300k+ entries are fine.
A row is excluded when its place id, LinkedIn URL, email, domain (an email's domain counts) or
company name matches any list in the workspace.

Applied automatically in: `POST /api/gtm/find`, `POST /api/gtm/tables/{id}/import/source`
(`"exclude": false` to skip), saved searches (`apply_exclusions`), the sourcing previews
(`/api/sources/*`, `"exclusions": false` to skip) and, when `"exclude": true` is passed,
`POST /api/gtm/tables/{id}/import/csv`. Responses report an `excluded` count.

## Lists
- `GET /api/exclusions` → lists with `counts` per kind (`domain`, `email`, `company`, `linkedin`, `place`) and `total`.
- `POST /api/exclusions` `{ "name": "Customers", "text": "acme.com\njane@globex.com" }` → `{ id, added, duplicates, skipped }`.
- `PATCH /api/exclusions/{id}` `{ "name": "…" }`; `DELETE /api/exclusions/{id}` (confirm first — those entries stop being excluded).

## Adding entries
- Paste: `POST /api/exclusions/{id}/entries` `{ "text": "one value per line", "kind": "auto" }` or `{ "values": [...] }`. `kind` forces a type (`domain`, `email`, `company`, `linkedin`, `place`, `phone`); `auto` detects each value (phones need a country code, e.g. +49…).
- CSV: `POST /api/exclusions/{id}/upload` `{ "csv": "<file text>", "column": "Website" }`. Without `column`, every domain/website, email, company/name, LinkedIn and place-id column is used; a header-less file is read as a one-column list.
- From a table: `POST /api/exclusions/{id}/from-table` `{ "table_id": 12 }` (optionally `"kinds": ["domain"]`).
- From outreach: `POST /api/exclusions/{id}/from-outreach` `{ "scope": "campaigns" | "leads", "include_domains": true, "include_companies": false }` — everyone already in a campaign (or all leads), plus their work-email domains.
- Remove: `DELETE /api/exclusions/{id}/entries` `{ "values": ["acme.com"] }`.

## Checking
- `POST /api/exclusions/check` `{ "values": ["acme.com", "bob@x.com"] }` or `{ "rows": [{ "Company": "Acme", "Company domain": "acme.com" }] }` → `{ excluded, reasons, results: [{ index, excluded }] }`.
- Browse: `GET /api/exclusions/{id}/entries?kind=domain&q=acme&page=1&per_page=100`.

## Tips
- "Exclude our customers" → create a list named Customers and add from the CRM table or a CSV.
- "Don't contact anyone we've already emailed" → `from-outreach` with `scope: "campaigns"`.
- Company-name matching is exact after normalisation; prefer domains when available.
- UI: /searches → Exclusions tab.
