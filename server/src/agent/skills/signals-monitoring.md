---
name: signals-monitoring
description: Use to watch accounts for buying signals (hiring, funding, news, tech stack, website changes, job changes, SEC/UK filings, outreach status) on a schedule, with Slack or webhook alerts when something changes.
---
# Signals and monitoring

Signal columns check a source per row; the value changes when something new happens, and that change can trigger alerts. Free sources need no key unless noted.

## Signal kinds (`config.kind`) and inputs
- `hiring` — open roles on public ATS boards. inputs: domain, companyName, keywords ("sdr, account executive"), target (careers URL)
- `news` — Google News headline. companyName, domain, keywords ("raises, acquires"), days
- `gdelt` — global news (slow, rate-limited). `hacker_news` — HN mentions.
- `funding_sec` — US Form D fundraises (needs SEC_USER_AGENT setting). companyName, days
- `sec_filings` — 8-K events (exec changes, M&A, layoffs). `gov_contracts` — US federal awards.
- `uk_filings` — Companies House (COMPANIES_HOUSE_API_KEY). companyName, target (company number)
- `tech_stack` — Wappalyzer fingerprints. domain
- `website_change` — page hash. target (URL) or domain
- `github` — last push for an org. `new_subdomains` — certificate logs (≈10/hour free).
- `job_change` — person left the company (PDL or Apollo key). email/linkedinUrl/fullName + companyName/domain
- `outreach_status` — live campaign state for the row's email. email

## Quick way: signal pack (columns + schedule + alert in one call)
`POST /api/gtm/tables/{id}/signal-pack`
```json
{ "nameColumn": "Company", "domainColumn": "Company domain",
  "signals": ["hiring", "news", "funding_sec", "tech_stack"],
  "everyMinutes": 1440, "alert": "slack", "slackChannel": "#signals" }
```
→ `{ columns, queued }`. Adds one column per signal, schedules them, runs a baseline now, and adds a "Signal alert" action that fires only when a signal changes later (`alert`: slack | webhook (+ `webhookUrl`) | none). Slack needs SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN — check `GET /api/gtm/catalog` actions[].ready and tell the user if it's missing.

## Manual columns
```json
{ "name": "Hiring SDRs", "type": "signal", "config": { "kind": "hiring", "inputs": { "domain": "{{Company domain}}", "companyName": "{{Company}}", "keywords": "sdr, sales development, bdr" } } }
```
Schedule with `PATCH /api/gtm/tables/{id}` `{ "schedule": { "enabled": true, "everyMinutes": 1440, "columnIds": [<signal col ids>] } }` (minimum 5 minutes; daily is sensible).
Alert on change with an action column: `{ "name": "Alert", "type": "action", "auto_run": true, "run_if": "changed(\"Hiring SDRs\")", "config": { "kind": "slack", "text": "{{Company}}: {{_changes}}" } }` — `{{_changes}}` lists what changed.

## Reading
- `GET /api/gtm/signals?limit=50` → recent changes across all tables plus outreach moments (replies, interested, bounces).
- `GET /api/gtm/tables/{id}` for current values.

Confirm with the user before turning on alerts that post to Slack/webhooks; running alert actions directly needs approval.
