# Kinetic

A self-hosted GTM platform: **Tables** to find, enrich, research and monitor accounts — and **Outreach** to email them, work replies and keep mailboxes healthy. One app, one login, one database. The two halves are wired together end to end.

```
Find (YC, GitHub, job boards, CSV, webhooks)
  → Tables: waterfall enrichment · AI research · signals
  → Send to campaign (enrichment/AI become {VARIABLES})
  → Outreach: sequences · warmup · master inbox
  → replies/interest/bounces flow back as "Outreach status" → alerts (Slack, webhooks)
```

## Quick start

Requirements: **Node.js 24+**. Docker is optional (local test mail server).

```bash
npm install
npm run build        # web UI → web/dist
npm start            # UI + API on http://localhost:4200
```

Open http://localhost:4200 and create your admin account. Settings go in `.env` (see `.env.example`); data (SQLite, attachments, encryption key) lives in `./data` — back it up.

Development: `npm run dev` (API with reload + Vite on http://localhost:5273).

Demo data (needs Docker): `npm run mail:up && DATA_DIR=./demo-data npm run demo && DATA_DIR=./demo-data npm start`, then log in as `demo@kinetic.test` / `demo-password`.

## Tables

Spreadsheets (Handsontable) whose columns do work. Column types: text, formula (JS), extract, **enrichment** (provider waterfalls), **AI research** (OpenRouter tool-calling agent — Claude Haiku 5.5 by default, free models or local Ollama), HTTP, **signal**, **action**.

- **Sources:** YC directory, GitHub org members and public ATS job boards (all free), CSV, per-table inbound webhook, HubSpot, Apollo — or **Open in table** from Leads / a campaign.
- **Enrichment (free first):** work email (website + PGP + GitHub commit pattern learning, SMTP-verified), verification (SMTP + disposable/free-mail lists), company data (YC, Wikidata, website), LinkedIn, domains — then paid providers (Icypeas, Hunter, Findymail, Prospeo, LeadMagic, Apollo, PDL, MillionVerifier, ZeroBounce) if keys are set.
- **Signals:** hiring (Greenhouse/Lever/Ashby/Workable/SmartRecruiters/Recruitee/Personio), Google News, GDELT, Hacker News, SEC Form D + 8-K events, US gov contracts, UK Companies House, tech stack (open Wappalyzer fingerprints + DNS), page changes, GitHub, new subdomains, job changes, **Outreach status**.
- **Automation:** auto-run columns, run-if conditions (`changed("Col")`), scheduled refresh, one-click signal pack with Slack/webhook alerts, Signals feed.
- **Actions:** Slack, webhooks, HubSpot, Salesforce, **Add to campaign**, **Create/update lead**.

Provider keys: the **Integrations** page (stored encrypted). See `docs/RESEARCH.md` and `docs/FREE_ALTERNATIVES.md` for pricing and free options.

## Outreach

Mailboxes (Google app password/OAuth, Microsoft 365 OAuth, any IMAP/SMTP), sending IPs, leads & lists, campaigns with A/B sequences, spintax and variables, timezone schedules and limits, master inbox with reply classification, private warmup pool, SPF/DKIM/DMARC checks, inbox placement tests, REST API (`/api/openapi.json`, reference at `/api/reference`) and 17 signed webhook events.

## How the two connect

| From | To | How |
|---|---|---|
| Table rows | Leads + campaign | **Send to campaign** / *Add to campaign* action: upsert lead, map any column to a custom variable, attach (blacklists, bounces, unsubscribes respected) |
| Enrichment / AI columns | Email copy | Mapped variables render in sequences: AI "Icebreaker" column → `{ICEBREAKER}` |
| Outreach events | Table | **Outreach status** column refreshes instantly on sends, opens, clicks, replies, interest, bounces, unsubscribes |
| Status changes | Alerts | Auto-run Slack/webhook action with `changed("Outreach status")` |
| Leads / lists / campaigns | Tables | **Open in table** (Leads page, campaign Leads tab); **Sync to lead** writes enrichment back as custom variables |
| Table signals | Webhooks | New **Signal Changed** webhook event |
| Both | Signals feed | Table changes + replies/interest/bounces/unsubscribes in one feed |
| Both | Workspaces | Tables, leads, campaigns and mailboxes are all scoped per workspace |

## Running it for real

Set `PUBLIC_URL` to an address recipients can reach (tracking, unsubscribe, OAuth callbacks, inbound table webhooks), put it behind HTTPS, run it under a process manager, and back up `DATA_DIR`. One process runs the web server, the outreach worker and the tables engine; `WORKERS=off` runs UI/API only.

## Layout

```
server/src/            Fastify + node:sqlite (TypeScript run natively)
  engine/ mail/ routes/   outreach: sequencer, inbox sync, warmup, placement, webhooks, API
  gtm/                    tables: engine (queue, cascades, scheduler), providers, AI agent, outreach bridge, API
web/src/               React + Vite + Tailwind; gtm/ holds the tables UI (Handsontable)
```

## Tests

```bash
npm test             # unit + API tests, incl. tables ⇄ outreach end-to-end
npm run mail:up      # GreenMail (Docker)
npm run test:mail    # real SMTP/IMAP: send, sync replies, bounces, warmup, placement
npm run typecheck
```
