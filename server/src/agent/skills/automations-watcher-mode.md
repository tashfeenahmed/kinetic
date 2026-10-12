---
name: automations-watcher-mode
description: Schedule any Kinetic automation (LinkedIn/social/Reddit/GitHub scrape) to re-run hourly, daily or weekly and add only new results to its table, with Slack/webhook alerts; also covers limits, working hours, pausing and run history.
---
# Watcher mode, limits and run history

## Turn a scrape into a watcher
Any phantom with `watchable: true` in `GET /api/automations/phantoms` can be scheduled. Each run re-executes the job and appends **only results not seen before** (dedupe key per phantom, e.g. LinkedIn URL, post URL, username — also checked against the table's matching column).

Create with a schedule:
```
POST /api/automations/jobs
{"phantom": "linkedin.search_export", "name": "New CFOs in fintech",
 "params": {"search_url": "https://www.linkedin.com/search/results/people/?keywords=cfo%20fintech", "limit": 200},
 "schedule": {"every": "weekly"},
 "alerts": {"slack": true, "slack_channel": "#leads", "webhook_url": "https://hooks.example.com/kinetic"}}
```
Or schedule an existing job: `PATCH /api/automations/jobs/:id {"schedule": {"every": "daily"}}`; stop with `{"schedule": {"every": null}}`.

- `every`: `hourly` | `daily` | `weekly` (±10% jitter so runs don't look robotic). `next_run_at` on the job says when.
- Alerts fire only when a run found new rows: Slack (uses SLACK_WEBHOOK_URL, or SLACK_BOT_TOKEN + `slack_channel`) and/or a JSON POST to `webhook_url` with `{automation, new_results, records, table_url}`.
- Every run emits the `COMPANION_JOB_COMPLETED` webhook event (`{automation, run: {results, new_results}, table_id}`).
- Run immediately: `POST /api/automations/jobs/:id/run-now`.

## Run history and dashboard
- `GET /api/automations/jobs/:id` → `runs[]` with `results`, `new_results`, `actions`, `error`, timings.
- `GET /api/automations/stats` → limits used today/this week, jobs by status, 14-day runs/results/actions, recent runs, pending approvals.

## Limits, working hours, pacing
`GET /api/automations/settings` / `PUT /api/automations/settings`:
```
{"limits": {"linkedin.connect": {"daily": 20, "weekly": 100}, "linkedin.scrape": {"daily": 1000}},
 "working_hours": {"enabled": true, "timezone": "Europe/Berlin", "start": "08:30", "end": "18:30", "days": {"saturday": false, "sunday": false}},
 "delays": {"action_min_sec": 45, "action_max_sec": 180, "page_min_sec": 3, "page_max_sec": 9},
 "max_actions_per_hour": 25, "scrape_outside_hours": false}
```
Daily limits reset at midnight in the working-hours timezone; weekly limits are a rolling 7 days. Only raise limits when the user explicitly asks, and warn that higher LinkedIn volumes risk account restrictions.

## Pause / stop
- One job: `POST /api/automations/jobs/:id/pause|resume|cancel`.
- Everything (jobs and LinkedIn campaigns): `POST /api/companion/pause-all {"paused": true}`.
- One browser: `PATCH /api/companion/devices/:id {"paused": true}`; clear a safety stop after the user solved a challenge: `{"clear_site_pause": "linkedin"}`.

## Pitfalls
- Extension-based watchers only run while a paired browser is open and online; server-side ones (Reddit, GitHub) always run.
- Watchers keep consuming daily scrape limits; hourly + large limits can starve other jobs.
