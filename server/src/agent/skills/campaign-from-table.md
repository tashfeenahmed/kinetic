---
name: campaign-from-table
description: Use to turn a table into an email campaign — create the campaign, write a multi-step sequence with variables, attach sender mailboxes, push verified rows in as leads (enrichment/AI columns become {VARIABLES}) and launch only after the user approves.
---
# Campaign from a table

## 1. Check what exists
- `GET /api/campaigns?per_page=50` → `{ data: [{ id, name, status, ... }] }`
- `GET /api/sender-emails?per_page=100` → mailboxes (`id`, `email`, `status` — only `Connected` ones can send). No connected sender = can't launch; tell the user to connect one on Sender Emails. Never add or reconnect mailboxes yourself.
- `GET /api/gtm/tables/{id}` → column names (email, first name, company, AI columns…).
- Read the Knowledge Hub (`knowledge` tool) for offer, personas, proof and tone/email guidelines.

## 2. Create the campaign
`POST /api/campaigns` `{ "name": "Irish POS — CEOs — Oct", "type": "outbound" }` → `{ data: { id } }` (status `draft`).
Settings (optional): `PATCH /api/campaigns/{id}/update` `{ "max_emails_per_day": 100, "max_new_leads_per_day": 30, "plain_text": true, "open_tracking": false, "stop_on_reply": true }`.
Schedule: `PUT /api/campaigns/{id}/schedule` `{ "monday": true, "tuesday": true, "wednesday": true, "thursday": true, "friday": true, "saturday": false, "sunday": false, "start_time": "09:00", "end_time": "17:00", "timezone": "Europe/Dublin" }`.

## 3. Write the sequence
`PUT /api/campaigns/{id}/sequence`
```json
{ "title": "Main", "steps": [
  { "email_subject": "{FIRST_NAME|Hi}, quick one", "email_body": "Hi {FIRST_NAME|there},\n\n{ICEBREAKER}\n\n…\n\n{SENDER_FIRST_NAME}", "wait_in_days": 0 },
  { "email_subject": "", "email_body": "…", "wait_in_days": 3, "thread_reply": true },
  { "email_subject": "", "email_body": "…", "wait_in_days": 4, "thread_reply": true, "variants": [{ "email_subject": "", "email_body": "alt…" }] } ] }
```
- Variables: `{FIRST_NAME}`, `{LAST_NAME}`, `{COMPANY}`, `{TITLE}`, `{EMAIL}`, `{SENDER_NAME}`, `{SENDER_FIRST_NAME}`, `{SIGNATURE}`, plus any custom variable mapped from the table (uppercased, spaces → `_`). Fallback: `{FIRST_NAME|there}`. Spintax: `{Hi|Hello}`.
- Follow the Knowledge Hub tone; short, plain, one clear ask. Show the draft to the user (ask_user) before saving if they haven't seen it.
- Preview: `POST /api/campaigns/{id}/preview` `{ "email_subject": "...", "email_body": "...", "lead_id"?: n }`.

## 4. Attach senders
`POST /api/campaigns/{id}/attach-sender-emails` `{ "sender_email_ids": [1, 2] }`.

## 5. Push table rows in as leads
Add an action column that upserts a lead per row and attaches it to the campaign, then run it:
`POST /api/gtm/tables/{tableId}/columns`
```json
{ "name": "Push to campaign", "type": "action", "auto_run": false,
  "run_if": "row[\"Email status\"] === \"valid\"",
  "config": { "kind": "outreach_campaign", "campaignId": 12,
    "email": "{{Work email}}", "firstName": "{{First name}}", "lastName": "{{Last name}}", "company": "{{Company}}", "title": "{{Title}}",
    "variables": [{ "name": "icebreaker", "value": "{{Research.icebreaker}}" }],
    "behavior": "patch" } }
```
Optionally add `{ "name": "Outreach status", "type": "signal", "auto_run": true, "config": { "kind": "outreach_status", "inputs": { "email": "{{Work email}}" } } }`.
Then `POST /api/gtm/tables/{tableId}/run` `{ "columnIds": [<push col id>] }`. Blacklisted, bounced and unsubscribed leads are skipped automatically. Only push verified emails (`run_if` above) unless the user says otherwise.
**Leads first, campaign later** (when the user wants to review before choosing a campaign, or no campaign exists yet): create a list `POST /api/lead-lists` `{ "name": "<table name>" }` → `{ data: { id } }`, then push with `"kind": "outreach_update_lead"`, `"listId": <id>`, no `campaignId` (same field mapping; name the column `→ Leads: <list name>`). Later: `attach-lead-list` below.
Push only some rows: pass `"rowIds": [..]` (and `"force": true` to re-push rows already pushed) to the run call. Re-use an existing push column for the same campaign/list (`PATCH /api/gtm/columns/{id}`) instead of adding another. Leads are matched by email, so re-pushing updates, never duplicates.
Alternative without a table: `POST /api/campaigns/{id}/leads/attach-leads` `{ "lead_ids": [..] }` or `attach-lead-list` `{ "lead_list_id": n }`.

## 6. Check, then launch only with approval
- `GET /api/campaigns/{id}/launch-check` → `{ data: { problems: [...] } }` (needs a step, a connected sender, leads).
- Summarise for the user: leads count, senders, schedule, first email. Ask them (ask_user) to confirm.
- `POST /api/campaigns/{id}/launch` — always pauses for the user's Approve click. Pause: `PATCH /api/campaigns/{id}/pause`.

Never launch, resume or send test emails without explicit approval.
