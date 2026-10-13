---
name: funding-rounds
description: Use when the user wants companies that just raised money / recently funded startups / new funding rounds (US, UK, France, Spain, Switzerland, Norway) to cold email — finds them from official filings with a named founder or director, then sets up domain → email → verify → research columns and a daily watcher.
---
# Recently funded companies (official filings)

Freshly funded companies have new budget and are hiring and buying, so they are among the best cold-email
targets. Source `funding_rounds` reads free official registers. Each row is one company with a named person:

| Country | Register | What a row means | Person |
|---|---|---|---|
| `us` | SEC Form D | Raised $X (most VC and angel rounds), industry group | Executive officers and directors on the filing |
| `uk` | Companies House SH01 (filing stream) | Allotted new shares; capital before → after | Active directors (CEO first) |
| `fr` | BODACC capital notices | Capital increase before → after | Président / DG |
| `es` | BORME (daily register bulletin) | Capital increase; only small issues (0.5–60% new shares) that look like investment rounds | Directors appointed in the same notice (often none) |
| `ch` | SOGC / SHAB | Nominal capital increase before → after | Officers newly registered (often none) |
| `no` | Brønnøysund | Share capital changed | CEO (daglig leder) and chair, often with company website and email |

Europe gives **share capital** (a nominal value), not the round size: "New shares issued" (the % of the company
issued) is the useful signal. Only the US gives the amount raised. UK needs two free keys, `COMPANIES_HOUSE_API_KEY`
and `COMPANIES_HOUSE_STREAM_KEY` (a "Streaming API" key), and only finds allotments filed after the stream key
was added. Without them, UK shows up in `warnings` and the other countries still run.

## Params
`countries` ("us,uk,fr,es,ch,no" or "all", default all) · `days` (1–90, default 7) · `sector` (`tech`, `health`,
`fintech`, `energy`, `consumer`) · `query`/`keywords` (words matched at word starts in the name and activity, in any
language; a single sector name works too) · `industry_codes` (NACE/SIC/NAF prefixes such as "62,63") ·
`min_amount` (US $) · `min_capital` (Europe) · `region` (US state code, e.g. "CA") · `include_funds` (default
false: funds, holdings, property vehicles and founder top-ups are dropped).

## 1. Find (creates the table)
`POST /api/gtm/find`
```json
{ "mode": "funding_rounds", "query": "tech", "params": { "countries": "us,uk,fr", "days": 14 }, "limit": 100, "table_name": "Funded · tech · last 14 days" }
```
→ `{ id, rows, source, warnings? }`. Mention any `warnings` (e.g. the UK stream key) to the user.
Columns: `Company`, `Company domain` (Norway often; elsewhere blank), `Country`, `City`, `Funding date`,
`Amount raised`, `New shares issued`, `Signal`, `Industry`, `Full name`, `First name`, `Last name`, `Title`,
`People`, `Company email`, `Company phone`, `Filing URL`, `Registry ID`, `Source`.

## 2. Turn rows into sendable leads
Add these with `POST /api/gtm/tables/{id}/columns`, in this order:
```json
{ "name": "Domain", "type": "enrich", "auto_run": true, "config": { "kind": "company_domain", "inputs": { "companyName": "{{Company}}" } } }
{ "name": "Work email", "type": "enrich", "auto_run": true, "config": { "kind": "work_email", "inputs": { "fullName": "{{Full name}}", "domain": "{{Domain}}" } } }
{ "name": "Email status", "type": "enrich", "auto_run": true, "config": { "kind": "verify_email", "inputs": { "email": "{{Work email}}" } } }
```
- When most rows already have `Company domain` (Norway), use `{{Company domain}}` and skip the Domain column.
- Rows without a person (common in Spain and Switzerland): add a `decision_makers` column on `{{Domain}}` instead —
  it finds the right person and their email for free first (see `enrich-emails-and-phones`).
- For the opening line, use an AI column with `useKnowledge: true`, and give it the funding facts so it doesn't make any up:
```json
{ "name": "Opener", "type": "ai", "config": { "prompt": "{{Company}} ({{Domain}}, {{City}}, {{Country}}) just raised new money: {{Signal}} on {{Funding date}}. In one short sentence for a cold email to {{First name}} ({{Title}}), congratulate them on the raise without inventing figures, and connect it to what they will need next that our offer solves.", "outputs": [{ "name": "opener", "type": "string" }], "webSearch": true, "maxSteps": 4, "useKnowledge": true } }
```
Then run the columns (`POST /api/gtm/tables/{id}/run`) and send verified rows to a campaign (`campaign-from-table`).

## 3. Keep it coming (watcher)
`POST /api/saved-searches` with `{ "name": "Funded tech · US/UK/FR", "source": "funding_rounds", "params": { "countries": "us,uk,fr", "sector": "tech", "days": 3 }, "max_results": 100, "schedule": "daily", "table_id": <id>, "run_now": true }`.
Only new companies are added, and the auto-run columns then fill in each one's domain, email and status.

Pitfalls: don't call the European capital figure "raised" — say "issued new shares" / "increased capital".
Names in registers are legal names; the domain finder does the matching, so check a few rows before a big send.
