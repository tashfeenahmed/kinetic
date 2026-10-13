---
name: leads-and-lists
description: Manage outreach leads directly — create one or many leads (JSON or CSV with a column mapping), update or delete them, set status, unsubscribe or blacklist, read one lead's sent emails, replies and scheduled emails, organise leads into lead lists, tag leads/campaigns/mailboxes, and manage custom lead variables ({VARIABLES} in emails). Use for "add these people as leads", "put them in a list", "tag them hot", "what did we send to jane@…", "unsubscribe him".
---
# Leads, lists, tags and variables

Leads are the people campaigns email (tables are the research workspace; `campaign-from-table` pushes table rows in
as leads). Finding leads by email activity is `lead-filters-by-email-stats`; do-not-contact rules are `exclusions`.

## Create
- One: `POST /api/leads` `{ "email": "jane@acme.com", "first_name": "Jane", "last_name": "Doe", "title": "CEO", "company": "Acme", "custom_variables": { "icebreaker": "…" } }`.
- Many (JSON): `POST /api/leads/multiple` `{ "leads": [{ "email": "…", "first_name": "…", … }], "existing_lead_behavior": "patch", "lead_list_id": 3 }`.
  `existing_lead_behavior`: `patch` (fill in new fields, default), `put` (replace) or `skip`.
  `POST /api/leads/create-or-update/multiple` takes the same body.
- CSV: `POST /api/leads/bulk/csv` `{ "csv": "<text>", "mapping": { "email": "Email", "first_name": "First", "company": "Company", "icebreaker": "Opener" }, "include_unmapped": true, "new_list_name": "Funded Oct", "campaign_id": 12 }`.
  Mapping keys are lead fields (email — required — first_name, last_name, title, company, notes) or custom variable
  names; values are the CSV column headers. `include_unmapped` keeps the other
  columns as custom variables. `campaign_id` adds the imported leads to that campaign.

## Where each lead came from
Every lead records its `source` (e.g. `Table "Funded tech" · found by ai_read · verified · published on https://acme.com/team`, `CSV import`, `API`) and `source_detail` (table, column, provider, method, page). Table pushes fill it from the email cell automatically. Use it when someone asks "where did you get my email?" — and never invent a source.

## Read and change
- `GET /api/leads/{id}`; history: `GET /api/leads/{id}/sent-emails`, `GET /api/leads/{id}/replies`, `GET /api/leads/{id}/scheduled-emails`.
- Update: `PATCH /api/leads/{id}` (only given fields) or `PUT` (replace).
- Status: `PATCH /api/leads/{id}/update-status` `{ "status": "verified" }` or bulk
  `PATCH /api/leads/bulk-update-status` `{ "lead_ids": [..], "status": "bounced" }`
  (verified|unverified|unknown|unsubscribed|risky|inactive|bounced).
- Unsubscribe (stops all emails): `PATCH /api/leads/{id}/unsubscribe`. Blacklist the address for the whole workspace:
  `POST /api/leads/{id}/blacklist` — do this when someone asks never to be contacted again.
- Delete: `DELETE /api/leads/{id}` or `DELETE /api/leads/bulk` `{ "lead_ids": [..] }` (approval; confirm first — the
  email history goes too. Prefer unsubscribe/blacklist for people who opted out, so they can't be re-imported).

## Do-not-email lists (blacklists)
Blacklisted addresses and domains are never emailed by any campaign (wider exclusion lists for prospecting are in
`exclusions`). **Unsubscribes are permanent:** every unsubscribe (link, reply, manual) is added to the email blacklist with
`reason: "unsubscribed"` and stays there even if the lead is deleted or imported again; `GET /api/leads/{id}` shows it as
`suppressed`. Never remove an unsubscribed address unless the person themselves asked to be emailed again.
- Emails: `GET /api/blacklisted-emails` (`search`, paging), `GET /api/blacklisted-emails/{id}`, add
  `POST /api/blacklisted-emails` `{ "email": "…" }` or `POST /api/blacklisted-emails/bulk` `{ "emails": [..] }`,
  remove `DELETE /api/blacklisted-emails/{id}` (approval).
- Domains (a whole company, competitors, existing customers): `GET /api/blacklisted-domains`, `GET /api/blacklisted-domains/{id}`,
  `POST /api/blacklisted-domains` `{ "domain": "acme.com" }`, `POST /api/blacklisted-domains/bulk` `{ "domains": [..] }`,
  `DELETE /api/blacklisted-domains/{id}` (approval).

## Lead lists
`GET /api/lead-lists`, `GET /api/lead-lists/{id}`, create `POST /api/lead-lists` `{ "name": "…" }`, rename
`PUT /api/lead-lists/{id}` `{ "name": "…" }`, delete `DELETE /api/lead-lists/{id}` (keeps the leads). Put leads in a list
with `lead_list_id` when creating them, then add the list to a campaign with
`POST /api/campaigns/{id}/leads/attach-lead-list` (see `campaign-management`).

## Tags
`GET /api/tags`, `GET /api/tags/{id}`, create `POST /api/tags` `{ "name": "hot" }`, delete `DELETE /api/tags/{id}`.
Attach/remove (all take `tag_ids` plus the targets):
- leads: `POST /api/tags/attach-to-leads` and `POST /api/tags/remove-from-leads` `{ "tag_ids": [1], "lead_ids": [..] }`
- campaigns: `POST /api/tags/attach-to-campaigns` and `POST /api/tags/remove-from-campaigns` `{ "tag_ids": [1], "campaign_ids": [..] }`
- mailboxes: `POST /api/tags/attach-to-sender-emails` and `POST /api/tags/remove-from-sender-emails` `{ "tag_ids": [1], "sender_email_ids": [..] }`
Tags fire webhooks; pass `"skip_webhooks": true` for bulk housekeeping. Filter by tag with `tag_id` on the list routes.

## Custom variables
`GET /api/custom-variables`, create `POST /api/custom-variables` `{ "name": "icebreaker" }`, delete
`DELETE /api/custom-variables/{id}`. A variable named `icebreaker` is used in emails as `{ICEBREAKER}`; set it per lead
through `custom_variables`. Importing leads with a new variable creates it automatically; create one by hand only to
use it in a sequence before any lead has it.
