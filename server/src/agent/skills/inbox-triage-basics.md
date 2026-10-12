---
name: inbox-triage-basics
description: Use to review and triage the master inbox — list unread or interested replies, read threads, mark interested / not interested / read, unsubscribe, and draft (not send) replies for the user to approve.
---
# Inbox triage

## List and read
- `GET /api/replies?folder=inbox&status=unread&per_page=25` → `{ data: [...], meta, counts: { unread_inbox, unread_interested } }`
  - `folder`: inbox | spam | bounced | all. `status`: interested | not_interested | automated | not_automated | unread | unsubscribe. Also `campaign_id`, `sender_email_id`, `lead_id`, `search`.
- `GET /api/replies/{id}` → one message. `GET /api/replies/{id}/conversation-thread` → the whole thread with what we sent.
- Each reply has an automatic `category` (interested, not_interested, unsubscribe, auto_reply, bounce, reply) — check it rather than trusting it blindly.

## Triage actions (no email is sent)
- `PATCH /api/replies/{id}/mark-as-interested` `{}` / `PATCH /api/replies/{id}/mark-as-not-interested` `{}` — updates the lead's campaign status and fires webhooks.
- `PATCH /api/replies/{id}/mark-as-read-or-unread` `{ "read": true }`
- `PATCH /api/replies/{id}/mark-as-automated-or-not-automated` `{ "automated": true }` (out-of-office etc.)
- `PATCH /api/replies/{id}/unsubscribe` — stops all future emails to that contact. Confirm with the user first.

## Replying (needs approval — it sends email)
1. Draft the reply in chat using the thread and the Knowledge Hub (offer, proof, tone). Keep it short and specific.
2. Show the draft and ask the user (ask_user) whether to send it.
3. `POST /api/replies/{id}/reply` `{ "message": "…", "content_type": "text", "reply_all": false }` — pauses for the user's Approve click.
- Forward: `POST /api/replies/{id}/forward` `{ "message": "…", "to_emails": ["x@y.com"] }`; new email: `POST /api/replies/new` `{ "subject", "message", "sender_email_id", "to_emails": [...] }` — both need approval.
- Push into a reply follow-up campaign: `POST /api/replies/{id}/followup-campaign/push` `{ "campaign_id": n }` (approval).

## Good summary format
Group by: interested (with next step), questions/objections, not interested, unsubscribes, auto-replies. Link lead names to their campaign. Never send anything without the user's go-ahead.
