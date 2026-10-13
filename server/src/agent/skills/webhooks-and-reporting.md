---
name: webhooks-and-reporting
description: Workspace-level reporting and plumbing — overall sending stats and daily charts, the activity log, webhooks that push events (sent, replied, interested, bounced, unsubscribed…) to Zapier/n8n/CRMs with delivery history and retries, the list of workspaces, and system/integration status. Use for "how did we do this month", "send interested replies to my CRM", "why didn't the webhook fire?", "what happened today?".
---
# Webhooks, activity and reporting

## Reporting
- Whole workspace: `GET /api/workspaces/v1.1/stats?days=30` (totals and rates) and
  `GET /api/workspaces/v1.1/line-area-chart-stats?days=30` (per day). Per campaign: `campaign-management`.
- Sending today and coming up: `GET /api/scheduled-emails/summary`.
- Activity log (last 10 days: sends, replies, bounces, mailbox events…): `GET /api/events`. Tables/enrichment log:
  `GET /api/gtm/activity`.
Report the numbers that matter for cold email: sent, reply rate, interested/positive replies, bounce rate (keep < 2%),
unsubscribes. Point out any mailbox or campaign that is clearly worse than the rest.

## Webhooks
Push events to another tool. Event types: `GET /api/webhook-events/event-types` (EMAIL_SENT, LEAD_FIRST_CONTACTED,
LEAD_REPLIED, LEAD_INTERESTED, LEAD_UNSUBSCRIBED, EMAIL_OPENED, LINK_CLICKED, EMAIL_BOUNCED, MANUAL_EMAIL_SENT, email
account and tag events, CAMPAIGN_COMPLETED…). Example payload: `GET /api/webhook-events/sample-payload?event_type=LEAD_INTERESTED`.
- List `GET /api/webhook-url`; create `POST /api/webhook-url` `{ "name": "CRM – interested", "url": "https://hooks.zapier.com/…", "events": ["LEAD_INTERESTED"] }`;
  view `GET /api/webhook-url/{id}`; change `PUT /api/webhook-url/{id}` (same body); delete `DELETE /api/webhook-url/{id}`.
- Test: `POST /api/webhook-events/test-event` `{ "event_type": "LEAD_INTERESTED", "url": "…" }` (sends data out → approval).
- Deliveries: `GET /api/webhook-deliveries` (`webhook_id`, `status` pending|succeeded|failed), one with every attempt
  `GET /api/webhook-deliveries/{id}`, retry now `POST /api/webhook-deliveries/{id}/retry` (approval).
A failing delivery shows the receiver's status code and body — a 4xx means the URL or payload is wrong on their side,
a 5xx or timeout usually fixes itself with retries.

## Workspaces and system
- `GET /api/workspaces` (the user's workspaces), create one `POST /api/workspaces` `{ "name": "…" }`. The agent always
  works in the chat's workspace and can't switch or manage members.
- `GET /api/system` → version, public URL (localhost means not reachable from the internet), workers and data folder; `GET /api/settings/integrations` → which OAuth apps
  (Google/Microsoft) are configured. Keys and OAuth secrets are entered by the user on Integrations, never by the agent.
- Which data/AI keys are set (masked): `GET /api/gtm/keys`; test one `POST /api/gtm/keys/test/{openrouter|search|smtp|hubspot}`.
