---
name: sending-domains-and-mailboxes
description: See sender mailboxes grouped by their sending domain, check SPF/DKIM/DMARC/MX health, and set up a domain's DNS through Cloudflare. Use when the user asks about their mailboxes, domains, deliverability records or adding a sending domain.
---
# Sending domains and mailboxes

In the app both live on one page, **Sender Emails** (`/sender-emails`; `/domains` redirects there):
mailboxes are listed under their domain, each domain row shows SPF / DKIM / DMARC / MX health, and
**Add domain** runs the Cloudflare DNS setup. The API keeps two route families.

## Read: mailboxes grouped by domain
1. `GET /api/domains` → `data[]`: one row per sending domain, with `id` (null when Kinetic doesn't
   manage its DNS), `domain`, `provider`, `status` (`verified` = Ready, `configured` = waiting for DNS,
   `attention`, `draft`, `unmanaged`), `report.checks[]` (`name` MX/SPF/DKIM/DMARC, `status`
   pass/warn/fail, `value`, `advice`), `checked_at`, `mailboxes`, `connected_mailboxes`.
   It lists every domain set up here (even with no mailboxes yet) plus every domain a mailbox uses.
   `meta.cloudflare_connected` says whether DNS can be written.
2. `GET /api/sender-emails` (optional `search`, `status` Connected/Disconnected/Paused, `tag_id`) →
   mailboxes. Group them yourself by the part after `@`.
Answer email-first: "yourdomain.com: sam@, alex@, jo@ (all connected), SPF/DKIM/DMARC pass".

## Check DNS (read-only, safe)
- Managed domain: `POST /api/domains/{id}/check` → refreshed row (stores the report).
- Any domain: `POST /api/domains/check` `{ "domain": "acme.com" }` → `{ checks, ok }` (nothing stored).
- One mailbox's domain: `POST /api/sender-emails/{id}/check-mx-records`.
Explain each non-pass check with its `advice`. Personal mailbox domains (gmail.com, outlook.com…)
have nothing to set up; skip them.

## Set up a domain's DNS (writes live DNS: confirm first)
1. `GET /api/domains/cloudflare` → `{ connected, zones[] }`. Not connected → tell the user to add a
   Cloudflare API token (Integrations, or Add domain on Sender Emails). Don't ask for the token in chat.
2. Domain not in Cloudflare yet: `POST /api/domains/cloudflare/zones` `{ "domain": "getacme.com" }` →
   zone with `name_servers`; the user must switch nameservers at their registrar.
3. Preview: `POST /api/domains/plan` with the setup body:
   `{ "domain": "getacme.com", "provider": "google" | "microsoft" | "other", "dmarcPolicy": "none",
   "replaceMx": true, "verification": "…", "dkimValue": "…", "msDkim1": "…", "msDkim2": "…" }`
   (DKIM/verification values come from the provider's admin console; they can be added later).
   → `actions[]` (`op` create/update/delete/keep, `type`, `name`, `content`) and `notes[]`.
   Show the user the non-`keep` actions.
4. Only after the user confirms: `POST /api/domains/apply` with the same body → `results[]`
   (each `ok`/`error`), `report` and the saved domain row.
5. `DELETE /api/domains/{id}` stops managing a domain (DNS records stay; mailboxes keep working). Confirm first.

## Pitfalls
- Never add, reconnect or delete mailboxes yourself; Microsoft/Google sign-ins need the user in the browser.
- `replaceMx: true` removes other MX records: wrong for a domain that already receives company mail.
- Applying with an empty DKIM value is fine; re-apply once the user has the key.
