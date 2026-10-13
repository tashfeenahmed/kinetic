---
name: lead-filters-by-email-stats
description: Find leads by email activity - opens, clicks, replies, bounces, unsubscribes, reply category, last contacted/opened/clicked, campaign membership, finished sequences (revive cold leads), sender mailbox or email provider (Google/Microsoft via MX) - then save the view, export CSV, tag, add to a campaign or open in a table.
---
# Filter leads by email stats

All filters are query parameters on `GET /api/leads` (combine with AND; add `per_page` up to 500, `page`).
The same parameters work on `GET /api/leads/ids`, `GET /api/leads/export` and in saved views.

| Filter | Parameters |
|---|---|
| Emails sent / opens / clicks / replies | `sent_min` `sent_max` `opens_min` `opens_max` `clicks_min` `clicks_max` `replies_min` `replies_max` |
| Replied / bounced / unsubscribed | `replied=true|false`, `bounced=true|false`, `unsubscribed=true|false` |
| Reply category | `reply_category=interested,meeting_request` (labels from the inbox-triage skill) |
| Dates | `last_contacted_before` / `_after`, `last_opened_before` / `_after`, `last_clicked_before` / `_after`, `last_replied_before` / `_after`: an ISO date (`2026-10-01`) or an age (`14d`, `12h`, `2w`, `3m`). `last_contacted_before=14d` = last emailed more than 14 days ago (never-contacted leads are excluded). |
| Campaigns | `in_campaign_ids=3,4`, `not_in_campaign_ids=3`, `without_campaign=true`, `campaign_id=3`, `sequence_finished=true|false` (completed every step of a campaign), `in_active_campaign=true|false` (still queued or mid-sequence in a draft/active/paused campaign) |
| Blacklist | `blacklisted=true|false` (email or domain on the blacklist, which also holds unsubscribes) |
| Mailbox | `sender_email_ids=7` (emailed by / assigned to that mailbox) |
| Email provider | `email_provider=google,microsoft` (also yahoo, zoho, icloud, proofpoint, mimecast, barracuda, other, none, unknown = not looked up yet) |
| Other | `search`, `status`, `lead_list_id`, `tag_id`, `sort=opens|clicks|replies|emails_sent|last_contacted|last_opened|last_replied|oldest` |

Each lead row has `overall_stats` and `email_stats` (`last_sent_at`, `last_opened_at`, `last_clicked_at`, `last_replied_at`, `bounced`).

## Recipes
- Presets: `GET /api/leads/filter-presets` (Opened 3+ times no reply = `opens_min=3&replied=false`; Clicked no reply =
  `clicks_min=1&replied=false`; Never opened = `sent_min=1&opens_max=0`; Bounced = `bounced=true`; Interested =
  `reply_category=interested,meeting_request`).
- Revive cold leads (preset `revive_quiet`, "Revive: went quiet 60–90 days ago"): `sequence_finished=true&last_contacted_before=60d&last_contacted_after=90d&replied=false&bounced=false&unsubscribed=false&blacklisted=false&in_active_campaign=false`.
  Change the two ages for another window, then `bulk-by-filter` with `add_to_campaign` into a fresh campaign (new angle, not the same copy).
- Count only: `GET /api/leads?...&per_page=1` and read `meta.total`.
- Email provider counts: `GET /api/leads/email-providers`. Providers are looked up in the background; to resolve now:
  `POST /api/leads/email-providers/refresh` `{"limit": 100}` (DNS lookups, free).

## Act on the result (confirm with the user first)
- Save a view: `POST /api/lead-views` `{"name": "Warm, no reply", "filters": {"opens_min": 3, "replied": false}}`;
  list with `GET /api/lead-views`; update `PUT /api/lead-views/:id`; delete `DELETE /api/lead-views/:id`.
- Tag / add to a campaign every match: `POST /api/leads/bulk-by-filter`
  `{"filters": {"opens_min": 3, "replied": false}, "action": "attach_tags", "tag_ids": [5]}` or
  `{"filters": {...}, "action": "add_to_campaign", "campaign_id": 12}` -> `{matched, attached|changed}`.
  Adding to an active campaign will send emails: say how many leads match and get approval first.
  Unsubscribed, bounced and blacklisted leads are attached as stopped.
- Export: `GET /api/leads/export?<filters>` returns CSV (email, name, company, status, stats, provider, custom variables).
- Open in a table: `GET /api/leads/ids?<filters>` -> `{ids, total}`, then `POST /api/gtm/tables/from-leads` `{"lead_ids": [...], "name": "Warm leads"}`.

## Pitfalls
- Opens are unreliable (Apple Mail privacy, scanners); prefer clicks or replies for "engaged".
- `replied` counts human replies only (auto-replies and bounces are excluded).
- Booleans are `true`/`false` strings in query parameters; lists are comma-separated.
