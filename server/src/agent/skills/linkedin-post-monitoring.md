---
name: linkedin-post-monitoring
description: Watch LinkedIn posts, or the new posts of profiles/company pages (e.g. competitors, influencers), and collect new reactors and commenters into a table on a schedule, with Slack/webhook alerts and LINKEDIN_POST_ENGAGER events.
---
# LinkedIn post monitoring

A post monitor is an automation using the `linkedin.post_monitor` phantom, scheduled in watcher mode. Each run the Companion extension (in the user's browser) reads the watched posts — or the recent posts of watched profiles/company pages — and collects reactors and/or commenters. Only **new** engagements are added to the table.

## Create a monitor
Check a browser is paired first (`GET /api/companion/status`).
```
POST /api/automations/jobs
{"phantom": "linkedin.post_monitor", "name": "Competitor posts",
 "params": {
   "targets": "https://www.linkedin.com/company/acme/\nhttps://www.linkedin.com/in/some-influencer/\nhttps://www.linkedin.com/feed/update/urn:li:activity:7300000000000000001/",
   "collect": "both",            // both | reactors | commenters
   "posts_per_profile": 3,       // recent posts to watch per profile/company
   "max_post_age_days": 14},
 "schedule": {"every": "daily"}, // hourly | daily | weekly
 "alerts": {"slack": true, "slack_channel": "#signals", "webhook_url": ""},
 "table_name": "Engagers · competitors"}
```
- Targets can also come from a table column: `"targets": {"table_id": 12, "column": "LinkedIn URL"}`.
- Columns: Full name, Headline, LinkedIn URL, Degree, Engagement (reaction/comment), Reaction, Comment, Post URL, Post author.
- A person who both reacts and comments appears twice (one row per engagement); repeats across runs are dropped.

## What happens on new engagers
- Rows are appended to the table (enrichment columns with auto-run then fill in — e.g. add a work-email column).
- Each new engager emits the webhook event `LINKEDIN_POST_ENGAGER` (`{automation, post_url, engager}`); subscribe at Developers → Webhooks or `POST /api/webhook-url`.
- After each run with new rows: Slack message (SLACK_WEBHOOK_URL or bot token + channel) and/or a POST to `alerts.webhook_url` with the new records. Every run also emits `COMPANION_JOB_COMPLETED`.

## Manage
- List monitors: `GET /api/automations/jobs?phantom=linkedin.post_monitor`.
- Change schedule/alerts: `PATCH /api/automations/jobs/:id {"schedule": {"every": "hourly"}, "alerts": {...}}`; stop scheduling with `{"schedule": {"every": null}}`.
- Run now: `POST /api/automations/jobs/:id/run-now`. Pause/cancel as for other jobs.

## Limits
Engagers count toward the daily LinkedIn scrape limit (default 1,000/day). Hourly schedules on many profiles burn it quickly — prefer daily unless the user needs near-real-time.

## Pitfalls
- Engager lists are only visible as LinkedIn shows them to the user (some reactors may be hidden on very large posts).
- To act on engagers (connect/message), feed the table into a LinkedIn campaign — see `linkedin-outreach`, and get approval first.
