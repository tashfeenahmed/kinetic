---
name: inbox-triage
description: Work the master inbox - read AI reply categories (meeting request, question, objection, referral, out of office, unsubscribe...), find replies by category, re-label, re-run AI sorting, and draft replies with AI. Use for "who wants a meeting?", "triage my replies", "draft an answer to Jane".
---
# Inbox triage (AI reply sorting)

Every inbound reply has a **label** (fine-grained) and a **category** (coarse, EmailBison-compatible).
Inbox sync stores the keyword-rule label first; when AI sorting is on and an OpenRouter key is set,
a background job re-labels human replies within ~15 s and adds a summary and a suggested next action.

Labels: `interested`, `meeting_request`, `more_info` (question), `objection` (with `ai_details.objection_type`:
price / timing / competitor / no_need / authority), `not_interested`, `referral` / `wrong_person`
(`ai_details.referral` = {name, email}), `out_of_office` (`ai_details.return_date`), `auto_reply`,
`unsubscribe`, `bounce`, plus rule-only `reply` (unsorted) and `other` (ignored phrase).

## Read
- Status and queue: `GET /api/replies/ai-status` -> `{active, configured, model, queued, failed, classified, manual}`.
  If `configured` is false, labels come from keyword rules only (tell the user to add an OpenRouter key on Integrations).
- By label: `GET /api/replies?folder=inbox&label=meeting_request,interested&per_page=50`
  (also `status=unread`, `campaign_id`, `sender_email_id`, `search`). One row per conversation.
  Each row has `label`, `label_source` (rules | ai | manual), `ai_summary`, `ai_next_action`, `ai_confidence`, `ai_details`.
- Full thread: `GET /api/replies/:id/conversation-thread` (marks it read).

Summarise for the user by label: meetings first, then questions/objections (with the objection type), referrals
(with the referred contact), out-of-office (with return date). Quote `ai_next_action`.

## Change labels (confirm with the user first)
- `PATCH /api/replies/:id/label` `{"label": "meeting_request"}` - a manual override. The AI never changes it afterwards.
  Side effects: `interested`/`meeting_request` mark the lead interested, stop its sequence and fire `LEAD_INTERESTED`
  (`meeting_request` also fires `LEAD_MEETING_REQUEST`); `unsubscribe` **unsubscribes the lead everywhere**;
  `out_of_office` with `"return_date": "2026-10-20"` pauses the lead's campaigns until then. Pass `"skip_webhooks": true` to stay quiet.
- Re-run AI on one reply: `POST /api/replies/:id/classify` `{"fresh": true}` (costs one model call; cached per message otherwise).
- Re-run AI in bulk: `POST /api/replies/reclassify` `{"reply_ids": [1,2]}` or `{"from": "2026-10-01", "to": "2026-10-31"}`
  -> `{queued, skipped_manual}`. Manual labels are never touched. Then `POST /api/replies/ai-queue/run` to process up to 24 now,
  or let the background job do it. Mention the cost (a fraction of a cent per reply on Haiku) before queueing thousands.

## Draft a reply (never send without approval)
1. `POST /api/replies/:id/draft-reply` `{"instructions": "offer Thursday or Friday afternoon"}` -> `{draft, knowledge_used}`.
   Uses the thread, the lead, the campaign and Knowledge Hub context when available. It does not send anything.
2. Show the draft to the user and get explicit approval.
3. Only then send: `POST /api/replies/:id/reply` `{"message": "<approved text>"}` (sends a real email from the mailbox).

## Settings
`GET/PATCH /api/workspaces/v1.1/master-inbox-settings`: `ai_reply_sorting` (on), `ai_reply_model` (null = default Haiku),
`ai_auto_unsubscribe` (on: unsubscribe intent unsubscribes the lead), `ai_pause_on_ooo` (on: pause until the return date).
Changing them is admin-only; confirm first.

## Pitfalls
- Never send, unsubscribe or relabel in bulk without the user's go-ahead.
- `category` stays coarse (`interested`, `not_interested`, `unsubscribe`, `auto_reply`, `bounce`, `reply`); filter on `label` for detail.
- Bounces and generic auto-replies are never sent to the AI; out-of-office notes are.
