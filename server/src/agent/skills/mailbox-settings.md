---
name: mailbox-settings
description: Look after sender mailboxes once they exist — details, which campaigns use a mailbox, its replies, connection test, sync now, a plain test email, bulk daily limits and signatures, sending IP routes (proxies), custom open/click tracking domains, DNS health for all sending domains and a DNS check of any domain. Use for "raise all limits to 40", "set this signature on every mailbox", "is nathan@ working?", "add a tracking domain".
---
# Mailbox settings and deliverability plumbing

Domains, SPF/DKIM/DMARC and Cloudflare setup are in `sending-domains-and-mailboxes`; warmup is `warmup-and-placement`.

**Adding a mailbox or changing its password is for the user only** (credentials never go through the chat): send
them to Sender Emails → Add (Google/Microsoft sign-in, or IMAP/SMTP). The agent can't call
`/api/sender-emails/imap-smtp`, `/api/sender-emails/bulk` or `/reconnect`. `GET /api/sender-emails/presets` shows
the Google/Microsoft server settings if they ask.
The agent *can* start a Google or Microsoft sign-in for the user (no password involved):
`POST /api/oauth-sessions/google` or `POST /api/oauth-sessions/microsoft` → `data.url` to give the user to open, and
`redirect_uri`. If `redirect_uri` is on `localhost` and the user isn't on the Kinetic machine, they must open it through
the SSH tunnel to that port first (Microsoft only accepts the registered redirect). `"admin_consent_prompt": true` asks a
Microsoft 365 admin to approve the app for the whole organisation.

## Inspect
- `GET /api/sender-emails` (`search`, `status` Connected|Disconnected|Paused, `tag_id`) and `GET /api/sender-emails/{id}`.
- Which campaigns use it: `GET /api/sender-emails/{id}/campaigns`. Its replies: `GET /api/sender-emails/{id}/replies`.
- Is it working? `POST /api/sender-emails/{id}/test-connection` → SMTP and IMAP results with the server's error text.
  A "Login failed" usually means the password changed or the Microsoft/Google sign-in expired → the user reconnects it.
- Pull new mail now: `POST /api/sender-emails/{id}/sync-now`.
- Test send: `POST /api/sender-emails/{id}/send-test` `{ "to_email": "…" }` (approval; ask which address).

## Change
- One mailbox: `PATCH /api/sender-emails/{id}` `{ "name": "Sam Rivera", "daily_limit": 30, "email_signature": "<p>…</p>" }`.
- Bulk daily limits: `PATCH /api/sender-emails/daily-limits/bulk` `{ "sender_email_ids": [..], "daily_limit": 30 }`.
  Keep new mailboxes at 20–30 cold emails a day; raise slowly and only when warmup health is good.
- Bulk signatures: `PATCH /api/sender-emails/signatures/bulk` `{ "sender_email_ids": [..], "email_signature": "<p>{SENDER_NAME}</p>" }`.
- Pause a mailbox: `PATCH /api/sender-emails/{id}/pause`; resume it: `PATCH /api/sender-emails/{id}/resume`.
- Move mailboxes to another workspace: `POST /api/sender-emails/move-to-another-workspace-bulk` (approval).

## Sending IP routes (proxies)
`GET /api/egress-routes`; create `POST /api/egress-routes` `{ "name": "VPS Frankfurt", "proxy_url": "socks5://user:pass@host:1080" }`
(or `local_address` for a second IP on this machine); edit `PUT /api/egress-routes/{id}`; check the public IP it sends from
`POST /api/egress-routes/{id}/check`; delete `DELETE /api/egress-routes/{id}`. Assign: `PATCH /api/sender-emails/egress/bulk`
`{ "sender_email_ids": [..], "egress_route_id": 2 }` (`null` = send directly). Proxy URLs contain passwords — only use ones
the user typed themselves.

## Custom tracking domains
Opens/clicks are tracked through a link domain; using the sender's own subdomain (e.g. `track.yourdomain.com`) is better
for deliverability than the shared default.
1. `POST /api/custom-tracking-domain` `{ "domain": "track.yourdomain.com" }`. The CNAME must point at
   `meta.cname_target` from `GET /api/custom-tracking-domain` (Kinetic's public host). If that is `localhost`, Kinetic
   isn't on a public address yet, so tracking links can't work; tell the user before going further.
2. The user (or `sending-domains-and-mailboxes` via Cloudflare) adds the CNAME.
3. `POST /api/custom-tracking-domain/{id}/verify` → verified or what is missing.
4. Use it on a campaign: `PATCH /api/campaigns/{id}/update` `{ "custom_tracking_domain_id": <id> }`.
List `GET /api/custom-tracking-domain`, one `GET /api/custom-tracking-domain/{id}`, remove `DELETE /api/custom-tracking-domain/{id}`.

## DNS health
- Every sending domain at once: `GET /api/sender-emails/domains/health`.
- Any domain (a prospect's, or one the user plans to buy): `POST /api/tools/domain-check` `{ "domain": "acme.com" }`.
