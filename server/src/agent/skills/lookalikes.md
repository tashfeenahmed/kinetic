---
name: lookalikes
description: Find companies similar to seed companies (e.g. best customers) or people similar to seed people (titles/roles), scored 0–100 with reasons, and load them into a table. Use for "find companies like X", "more accounts like our customers", "people like our champions".
---
# Lookalikes

## Companies
`POST /api/sources/lookalikes/companies`
```json
{ "seeds": ["stripe.com", "adyen.com"], "limit": 50 }
```
or seeds from a table: `{ "table_id": 12, "column": "Company domain" }` (no `column` → each row's
detected domain; up to 25 rows).

How it works: each seed (max 10) is profiled from YC directory, Apollo/PDL (if keyed), Wikidata and
the homepage (+ Wappalyzer tech when ≤ 3 seeds or `"tech": true`), then merged into a profile
(keywords, industries, size, locations, tech; plus an AI summary when OpenRouter is set).
Candidates: Apollo/PDL company search when keys exist, plus the YC directory, Wikidata industry
peers and — when AI is configured and keyed providers are missing or thin — an AI web search.
Each candidate gets `Similarity` 0–100 and `Similarity reason` (shared keywords, industry, size,
location, tech). Seeds and excluded companies are removed. `min_score` (default 15) filters weak
matches; `"ai": false` skips AI calls.

Response: `{ source, profile, found, excluded, rows }`; rows have `Company, Company domain,
Description, Industry, Employees, Location, LinkedIn URL, Similarity, Similarity reason, Source`.

Only the profile: `POST /api/sources/lookalikes/profile` `{ "seeds": ["stripe.com"] }`.

## People
`POST /api/sources/lookalikes/people`
```json
{ "seeds": [{ "title": "VP Sales", "company": "Ramp" }, "Head of Revenue"], "companies": ["brex.com", "mercury.com"], "location": "New York", "limit": 50 }
```
(or `"titles": "VP Sales, Head of Revenue"`, or `"table_id"` with Title/Company columns).
Seniority and department are inferred from titles. With APOLLO_API_KEY or PDL_API_KEY it uses their
people search; otherwise web search for public LinkedIn profiles
(`site:linkedin.com/in "<title>" "<company>"`, up to `max_queries` = 12 searches) through the configured
search provider (Serper/Brave/… — DuckDuckGo fallback is slow and unreliable). Kinetic never visits
LinkedIn itself. Rows: `Full name, Title, Company, Company domain, LinkedIn URL, Location, Similarity,
Similarity reason, Source`. Without target `companies` it searches across the market.

## Into a table / watching
- New table: `POST /api/gtm/find` `{ "mode": "company_lookalikes", "query": "stripe.com, adyen.com", "limit": 50 }` (or `"people_lookalikes"` with `"query": "VP Sales"` and `"params": { "companies": [...] }`).
- Existing table: `POST /api/gtm/tables/{id}/import/source` `{ "source": "company_lookalikes", "params": { "seeds": [...] } }`.
- Previewed rows: `POST /api/sources/to-table` `{ "name": "…", "rows": [...] }`.
- Keep finding new ones weekly: saved search with source `company_lookalikes` (see `saved-searches-and-watchers`).
- Per-row enrichment: column type `enrich` with kind `lookalike_companies` (input `domain`) — value is a list of similar domains.

## Cost / confirm
Apollo/PDL searches use credits and the AI summary/search uses OpenRouter tokens; tell the user when
those keys are set and the request is large (many seeds, limit > 100, or scheduled runs).
