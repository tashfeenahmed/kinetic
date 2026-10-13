---
name: linkedin-outreach
description: LinkedIn actions and outreach campaigns through the Kinetic Companion extension — profile visits, connection requests with personalised/AI notes, messages to connections, follows, likes, withdrawing old invites, AI comment drafts, and multi-step LinkedIn campaigns (visit → connect → message → follow-ups). Always get explicit user approval before starting anything that acts on LinkedIn.
---
# LinkedIn outreach

Everything here **acts on the user's LinkedIn account** from their own browser (Kinetic Companion extension). Rules:
- **Never start an action job or campaign without the user's explicit approval** of: who is targeted (count + a few examples), the exact note/message templates (show a preview), daily caps, and start time. Create things as drafts, show the plan, then start only after a clear "yes".
- Respect limits; never raise them above LinkedIn-safe defaults without the user asking (connects 20/day & ~100/week, messages 50/day, visits 80/day).
- Check a browser is paired: `GET /api/companion/status` (see the `linkedin-scraping` skill).

## Templates
Variables: `{first_name} {last_name} {full_name} {company} {title} {location} {headline}`, any column of the source table as `{Column name}`, fallbacks `{first_name|there}`, spintax `{Hi|Hello|Hey}`, and `{ai_message}` — one AI-written personalised line (needs OPENROUTER_API_KEY or AI_BASE_URL; otherwise creation fails with 422). Connection notes max **300 characters**.

Preview before asking for approval:
```
POST /api/automations/preview-message
{"template": "{Hi|Hello} {first_name}, {ai_message}", "profile": {"fullName": "Jane Doe", "title": "VP Sales", "company": "Acme"}, "ai_instructions": "Mention their role; no pitch."}
→ {"data": {"text": "...", "missing": [], "ai_used": true}}
```

## One-off action phantoms (jobs)
`POST /api/automations/jobs` with `"start": false` (action phantoms default to draft anyway), show the user, then `POST /api/automations/jobs/:id/start`.

| phantom | params |
|---|---|
| `linkedin.profile_visitor` | `targets` |
| `linkedin.auto_connect` | `targets`, `note` (template, optional), `ai_instructions` |
| `linkedin.message_sender` | `targets`, `message` (template), `ai_instructions` — only 1st-degree connections; others are skipped |
| `linkedin.auto_follow` | `targets` |
| `linkedin.withdraw_invites` | `older_than_days` (default 21), `limit` |
| `linkedin.post_liker` | `targets` (posts or profiles), `reaction` (LIKE, PRAISE, EMPATHY, INTEREST, APPRECIATION), `posts_per_profile` |
| `linkedin.ai_post_responder` | `targets`, `instructions`, `posts_per_profile` — drafts comments with AI; **each comment must be approved** |

`targets`: URLs (newline-separated or array) or `{"table_id": 12, "column": "LinkedIn URL"}` (the row's other columns become template variables).
Each action writes a row (status sent/skipped/failed) into the job's table.

AI comment approvals: `GET /api/automations/approvals?status=pending` → show `context` (post) and `draft`; `POST /api/automations/approvals/:id/approve` with optional `{"text": "edited comment"}` (only after the user approves the wording), or `POST /api/automations/approvals/:id/reject`.

## LinkedIn campaigns (multi-step)
Flow per lead: visit profile → connection request with note → wait for acceptance → message 1 (delay counted from acceptance) → up to 3 follow-ups (0–15 days after the previous message). Stops on reply. Leads already connected skip straight to messaging. Invites not accepted after `withdraw_after_days` are marked not accepted.

1. Create (draft):
```
POST /api/linkedin/campaigns
{"name": "Founders Q4", "settings": {
  "visit_first": true,
  "connect_note": "{Hi|Hey} {first_name}, I follow {company}'s work — would love to connect.",
  "ai_instructions": "",
  "messages": [{"template": "Thanks for connecting, {first_name}! ...", "delay_days": 1},
               {"template": "Hi {first_name}, quick follow-up ...", "delay_days": 4}],
  "withdraw_after_days": 21, "daily_invites": 15, "daily_messages": 30, "stop_on_reply": true,
  "filters": {"titles": ["founder", "ceo"], "exclude_titles": ["intern"], "locations": [], "companies": []}}}
```
   Or from a table: `POST /api/linkedin/campaigns/from-table {"table_id": 12, "name": "...", "columns": {"profile_url": "LinkedIn URL", "full_name": "Full name", "title": "Title", "company": "Company"}}`.
2. Add leads: `POST /api/linkedin/campaigns/:id/leads {"profiles": [{"profile_url": "https://www.linkedin.com/in/jane/", "full_name": "Jane Doe", "title": "CEO"}]}` or `POST /api/linkedin/campaigns/:id/leads/import-table {"table_id": 12, "columns": {"profile_url": "LinkedIn URL"}}`.
3. Review gate: `POST /api/linkedin/campaigns/:id/review {"filters": {...}}` → `{included, excluded}`; list with `GET /api/linkedin/campaigns/:id/leads?excluded=false`; toggle one with `PATCH /api/linkedin/campaigns/:id/leads/:leadId {"excluded": true}`.
4. Show the user the plan (lead count, templates rendered for 2 leads, caps). **Only after approval:** `POST /api/linkedin/campaigns/:id/start {"confirm": true}`.
   Pause a running campaign with `POST /api/linkedin/campaigns/:id/pause`; `POST /api/linkedin/campaigns/:id/resume` restarts it (approval).
5. Monitor: `GET /api/linkedin/campaigns/:id` → `stats {invited, accepted, messaged, followups, replied, failed, not_accepted, acceptance_rate (0–1), reply_rate (0–1)}`; `GET /api/linkedin/campaigns/:id/activity`. Pause/resume: `POST .../pause`, `POST .../resume`.

Acceptances and replies are detected by periodic connection-list and inbox checks the extension runs (every ~3 hours while a campaign has open leads). They emit webhooks `LINKEDIN_CONNECTION_ACCEPTED` and `LINKEDIN_REPLY_RECEIVED`.

## Pitfalls
- LinkedIn campaigns are separate from email campaigns (`/api/campaigns`). Don't mix them.
- Free LinkedIn accounts get few personalised notes per month; if the note can't be added the invite fails rather than sending without it.
- Safety stops (captcha/challenge/restriction) pause LinkedIn for that browser for up to 24h. Tell the user; never suggest bypassing them.
