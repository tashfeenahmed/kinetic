---
name: replies-templates-and-sent-mail
description: Inbox helpers around replies — saved reply templates (canned answers) and using one in a reply, ignore phrases that mark matching replies as automated so they don't count as real replies, downloading a reply's attachment, and the log of every email sent (campaign, manual and replies) with full details. Use for "save this as a template", "stop counting the ticket-system emails as replies", "what did we send today?".
---
# Reply templates, ignore phrases and sent mail

Reading, sorting and answering replies is `inbox-triage` / `inbox-triage-basics`. This skill adds the supporting pieces.

## Reply templates
- `GET /api/reply-templates`, `GET /api/reply-templates/{id}`.
- Create `POST /api/reply-templates` `{ "name": "Book a call", "body": "Thanks for getting back to me — here is my calendar: …" }`;
  update `PUT /api/reply-templates/{id}` (same body); delete `DELETE /api/reply-templates/{id}`.
- Use one when replying: `POST /api/replies/{id}/reply` `{ "reply_template_id": 3, "message": "-" }` (sends → approval).
  The template body replaces `message` (which must still be non-empty) and is sent exactly as written: `{VARIABLES}`
  are not filled in. For a personalised answer, copy the template text into `message` and edit it instead.
Write templates in the user's tone (Knowledge Hub) and keep them short; one per common answer (pricing question,
"send more info", meeting link, not now).

## Ignore phrases
A reply containing an ignore phrase (anywhere in subject or body, case-insensitive) is filed as automated (category
"other"), the same way auto-replies are, instead of as a real reply. Use for ticket systems, "this mailbox is not monitored", CRM notifications.
`GET /api/ignore-phrases`, add `POST /api/ignore-phrases` `{ "phrase": "ticket has been created" }`, remove
`DELETE /api/ignore-phrases/{id}`. Applies to replies synced from now on. Keep phrases specific: a phrase like "thanks"
would hide real replies.

## Attachments
A reply's `attachments[]` lists files; download one with `GET /api/replies/{id}/attachments/{index}` (0-based). Binary
files come back as raw bytes; for anything but text, tell the user to open it in the Inbox instead.

## Sent mail
- `GET /api/sent-emails` (`kind` all|campaign|manual|reply, `sender_email_id`, `search`, paging) → what went out, from
  which mailbox, to whom, when.
- `GET /api/sent-emails/{id}` → full subject and body.
- Per lead: `GET /api/leads/{id}/sent-emails` (see `leads-and-lists`).
