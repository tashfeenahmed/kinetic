---
name: campaign-management
description: Run existing email campaigns day to day — list and inspect campaigns, stats and daily charts, the leads in a campaign (add from lists, remove, stop/resume future emails, move to another campaign), mailboxes on a campaign, sending schedules and schedule templates, scheduled/queued emails, pause/resume/archive/duplicate/delete, switching sequence variants on/off and sending a test of a step. Use for "how is campaign X doing", "move these leads", "pause it", "copy last month's campaign".
---
# Campaign management

Building a new campaign from a table is `campaign-from-table`; sequences/branching are `conditional-sequences`;
A/B tests are `campaigns-ab-testing`. This skill covers everything after that.

## Find and inspect
- `GET /api/campaigns` (`search`, `status`, `tag_id`, `page`, `per_page`) → `data[]` with id, name, status, counts.
- `GET /api/campaigns/{id}` → settings and totals. `GET /api/campaigns/{id}/launch-check` → what still blocks a launch.
- Stats: `POST /api/campaigns/{id}/stats` `{ "start_date": "2026-10-01", "end_date": "2026-10-13" }` (both optional) →
  sent, opens, clicks, replies, interested, bounces, unsubscribes with rates.
- Daily chart data: `GET /api/campaigns/{id}/line-area-chart-stats?days=30`.
- Replies to this campaign: `GET /api/campaigns/{id}/replies` (triage them with `inbox-triage`).
- Queue: `GET /api/campaigns/{id}/scheduled-emails`; across all campaigns `GET /api/scheduled-emails`
  (`status` scheduled|sending|sent|failed|cancelled, `date`, `tz`, `campaign_id`, `sender_email_id`),
  one email `GET /api/scheduled-emails/{id}`, today/upcoming totals `GET /api/scheduled-emails/summary`.
- Workspace-wide totals: `GET /api/workspaces/v1.1/stats?days=30` (includes the deal funnel: `meetings`, `won`, `won_value`, `open_deals`) and daily `GET /api/workspaces/v1.1/line-area-chart-stats?days=30`.

When reporting, give rates, not just counts, and compare to the campaign's own earlier period when asked "is it getting better".

## Leads in a campaign
- List: `GET /api/campaigns/{id}/leads` (`status`, `search`, paging).
- Add by id: `POST /api/campaigns/{id}/leads/attach-leads` `{ "lead_ids": [..] }`; a whole list:
  `POST /api/campaigns/{id}/leads/attach-lead-list` `{ "lead_list_id": 3 }`. `allow_parallel_sending: true` only if the
  user wants a lead in two campaigns at once.
- Remove: `DELETE /api/campaigns/{id}/leads` `{ "lead_ids": [..] }` (needs approval).
- Stop future emails for some leads (keeps them in the campaign): `POST /api/campaigns/{id}/leads/stop-future-emails` `{ "lead_ids": [..] }`.
  Undo with `POST /api/campaigns/{id}/leads/resume` (needs approval: it restarts emails).
- Move: `POST /api/campaigns/{id}/leads/move-to-another-campaign` `{ "target_campaign_id": 9, "lead_ids": [..] }`.
- One lead's route through the sequence: `GET /api/campaigns/{id}/leads/{leadId}/path`.
To act on "everyone who opened but didn't reply" use `lead-filters-by-email-stats` to get the ids first.

## Mailboxes on a campaign
`GET /api/campaigns/{id}/sender-emails`; add `POST /api/campaigns/{id}/attach-sender-emails` `{ "sender_email_ids": [..] }`;
remove `DELETE /api/campaigns/{id}/remove-sender-emails` `{ "sender_email_ids": [..] }`. Only attach mailboxes that are
Connected and warmed up (check `warmup-and-placement`).

## Schedule
- `GET /api/campaigns/{id}/schedule`; create `POST` / change `PUT /api/campaigns/{id}/schedule`
  `{ "monday": true, …, "sunday": false, "start_time": "08:00", "end_time": "17:00", "timezone": "Europe/Dublin", "save_as_template": false }`.
- Timezones: `GET /api/campaigns/schedule/available-timezones`. Templates: `GET /api/campaigns/schedule/templates`,
  apply one `POST /api/campaigns/{id}/create-schedule-from-template` `{ "schedule_id": 2 }`, delete
  `DELETE /api/campaigns/schedule/templates/{id}`.
- Use the leads' timezone, not the user's, when the list is in one region.

## Settings and lifecycle
- `PATCH /api/campaigns/{id}/update` — name, `max_emails_per_day`, `max_new_leads_per_day`,
  `daily_max_sends_per_receiving_domain`, `plain_text`, `open_tracking`, `click_tracking`, `stop_on_reply`,
  `can_unsubscribe`, `sequence_prioritization` (followups|new_leads)…
- Pause `PATCH /api/campaigns/{id}/pause` (safe, no approval). Resume `PATCH /api/campaigns/{id}/resume` and launch
  `POST /api/campaigns/{id}/launch` need approval because they send.
- Archive `PATCH /api/campaigns/{id}/archive`. Duplicate `POST /api/campaigns/{id}/duplicate` → new draft "<name> (copy)" with
  the same sequence, settings, schedule and mailboxes, but no leads.
- Delete `DELETE /api/campaigns/{id}` or several `DELETE /api/campaigns/bulk` `{ "campaign_ids": [..] }` — confirm with
  `ask_user` first; prefer archive.

## Sequence steps (quick changes)
- Turn a step variant on/off: `PATCH /api/campaigns/sequence-steps/{id}/activate-or-deactivate` `{ "active": false }`.
- Delete a step: `DELETE /api/campaigns/sequence-steps/{id}` (approval).
- Preview with a real lead: `POST /api/campaigns/{id}/preview` `{ "email_subject": "…", "email_body": "…", "lead_id": 5 }`.
- Send a test of a step: `POST /api/campaigns/sequence-steps/{id}/test-email` `{ "sender_email_id": 2, "to_email": "me@…" }`
  (approval; ask the user which address).
