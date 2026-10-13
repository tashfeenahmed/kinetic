---
name: warmup-and-placement
description: Mailbox warmup and inbox placement — which mailboxes are warming and how healthy they are (sent, landed in inbox vs spam, replies), turn warmup on/off, set warmup daily volume, the warmup timezone, and run inbox placement tests of a campaign step against seed inboxes. Use for "how is warmup going", "warm up jo@", "is my campaign landing in spam?", "are we ready to send?".
---
# Warmup and inbox placement

## Warmup
- Overview: `GET /api/warmup/sender-emails` → each mailbox with `warmup_enabled`, `warmup_daily_limit` (ceiling),
  `today_target` (today's ramped volume), `warmup_started_at` and `stats` for 7 days (`sent`, `landed_inbox`, `landed_spam`,
  `received`, `rescued` = pulled out of spam, `replies_sent`); `meta.pool_size` = connected mailboxes warming each other.
  One mailbox: `GET /api/warmup/sender-emails/{id}` adds `stats_30d` and `daily` (sent/inbox/spam/received per day).
- Turn on: `PATCH /api/warmup/sender-emails/enable`; turn off: `PATCH /api/warmup/sender-emails/disable` — both `{ "sender_email_ids": [..] }`.
- Volume: `PATCH /api/warmup/sender-emails/update-daily-warmup-limits` `{ "sender_email_ids": [..], "daily_limit": 10, "daily_reply_limit": 35 }`.
  The daily volume ramps up from a small start; `daily_limit` is the ceiling. `daily_reply_limit` is the **percentage**
  of received warmup mails this mailbox replies to (default 35). Personal or low-volume inboxes (e.g. a
  Gmail used for real meetings) stay around 10.
- Timezone of the warmup sending window: `GET /api/warmup/settings`, `PUT /api/warmup/settings` `{ "timezone": "Europe/Dublin" }`.
  It also returns `filter_phrase` (in every warmup mail, so the user can filter them in their own mail client), the
  `folder` warmup mail is moved to and the sending `window` (08:00–20:00).

Reading health: a new mailbox needs about 2–3 weeks of warmup before cold sending. Inbox rate = landed_inbox ÷ (landed_inbox + landed_spam); treat ≥ 90% with no
bounces as healthy. If the inbox rate drops, lower the cold `daily_limit` (`mailbox-settings`) before anything else, and
check the domain's DNS (`sending-domains-and-mailboxes`). Keep warmup running alongside campaigns.

## Inbox placement tests
A placement test sends one campaign step from chosen mailboxes to seed inboxes the user owns and reports
inbox / spam / missing per provider.
- Seeds: `GET /api/seed-accounts`. Adding a seed needs its mailbox password, so the user adds it in the app
  (the agent can't call `POST /api/seed-accounts`). Remove with `DELETE /api/seed-accounts/{id}` (approval).
- Run: `POST /api/placement-tests` `{ "campaign_id": 12, "sequence_step_id": 40, "sender_email_ids": [1, 2], "seed_account_ids": [3, 4] }`
  (step and seeds optional: first step, all seeds). Results take a few minutes: poll `GET /api/placement-tests/{id}`.
- History: `GET /api/placement-tests?campaign_id=12`.
Run one before launching a new campaign or after changing copy heavily; a step that lands in spam needs fewer links,
no images/attachments, plainer wording, or a different sender.
