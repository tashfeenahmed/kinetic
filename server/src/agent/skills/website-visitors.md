---
name: website-visitors
description: Website visitor identification (RB2B / Clay web-intent style). Use to set up tracking on the user's website, see which companies and leads visited (pages, score, last seen), resolve an IP to a company, configure high-intent alerts, or send visiting companies to a table.
---
# Website visitors

Kinetic tracks visits to the user's own websites with a small first-party snippet, then:
- **Companies**: visitor IP → organisation via reverse DNS, RDAP (regional registries) and optional IPinfo Lite. Home ISPs, mobile carriers, VPNs and cloud/hosting networks are filtered out, so only company networks count.
- **People**: a lead who clicks a tracked link in a Kinetic email that points to a tracked site gets a signed `k_vid` parameter. The snippet stores it and strips it from the URL, so later visits are tied to that lead. Sites can also call `kinetic.identify(email)`.
- **Intent score** 0–100 over the last 30 days: pages viewed, key pages (default /pricing, /demo, /contact), repeat visits, time on site, recency.

## 1. Set up a site
1. `GET /api/visitors/overview`. If `tracking.reachable` is false, Kinetic is only on the LAN (`PUBLIC_URL` is localhost or a private IP). Tell the user the snippet cannot work until Kinetic is public. The usual fix is a Cloudflare Tunnel; then set the `TRACKING_PUBLIC_URL` key with `PUT /api/gtm/keys {"TRACKING_PUBLIC_URL":"https://kinetic.example.com"}`. Confirm the URL with the user first.
2. Add the site: `POST /api/visitors/sites {"domain":"acme.com","key_pages":["/pricing","/demo","/contact"]}`. The response has a `snippet` for the `<head>` of every page. Give it to the user.
3. After they install it: `POST /api/visitors/sites/:id/verify`. This returns `{ok, method, detail}` and checks for a recent event or the snippet in the page HTML.
4. Edit or remove a site with `PATCH /api/visitors/sites/:id` / `DELETE /api/visitors/sites/:id`. Deleting removes its sessions, so confirm first.

## 2. Read visitors
- Companies, highest intent first: `GET /api/visitors/companies?days=7&min_score=40&search=acme`. Each row has `name, domain, visits, pageviews, key_pageviews, score, visits_30d, last_seen_at, top_pages[], people[]`.
- One company, with its session timeline: `GET /api/visitors/companies/:id` (`sessions[].events[]` hold the pages and clicks in order).
- Identified people: `GET /api/visitors/people`. Each row has a ready-made `summary`, e.g. "Jane Doe (Acme) viewed /pricing 3 times".
- Live events: `GET /api/visitors/feed?after_id=<last id>`.
- Stats for one domain or email (last visit, visits in 30 days, pages, score): `GET /api/visitors/lookup?domain=acme.com` or `?email=jane@acme.com`.
- Debug an IP: `POST /api/visitors/resolve-ip {"ip":"203.0.113.7"}` returns `{kind: company|isp|mobile|hosting|vpn|private|unknown, orgName, domain, source}`.

## 3. Act on it
- Send companies to a table: `POST /api/visitors/push`.
  - New table: `{"min_score":50,"days":30,"table_name":"Hot visitors"}`.
  - Existing table: `{"company_ids":[1,2],"table_id":12}`.
  - Domains already in the table are skipped. New tables get a live **Website visits** signal column. Only companies with a known domain are pushed.
- Use the **Website visits** signal (`kind: "website_visits"`, inputs `domain` and/or `email`) in any table: `POST /api/gtm/tables/:id/columns {"name":"Website visits","type":"signal","auto_run":true,"config":{"kind":"website_visits","inputs":{"domain":"{{Company domain}}"}}}`. Its value is the number of visits in the last 30 days.
- Personal tracked link for one lead (e.g. for a manual email): `POST /api/visitors/lead-link {"lead_id":42,"url":"https://acme.com/pricing"}`.

## 4. Alerts, auto-push, privacy
`GET/PUT /api/visitors/settings`:
```json
{"alert_on":"targets","alert_threshold":60,"alert_slack":true,"alert_webhook_url":"https://hooks.example.com/x",
 "target_domains":["bigco.com"],"auto_push_table_id":12,"auto_push_score":60,"respect_dnt":true,"retention_days":180}
```
- `alert_on`:
  - `targets` alerts for known leads and for target companies (listed domains, or any domain where the workspace already has leads);
  - `all` alerts for any identified company;
  - `off` disables alerts.
- Each company or person gets at most one alert a day. Alerts are also the `HIGH_INTENT_VISIT` webhook event. `WEBSITE_VISIT` fires once per identified session.
- Slack alerts use `SLACK_WEBHOOK_URL` from the Integrations keys.
- Raw events and sessions older than `retention_days` (minimum 30) are deleted. Company and person totals are kept.

## Pitfalls
- Confirm with the user before changing alert targets, webhooks or auto-push. Those settings send data to third parties and write to tables.
- Expect many visits to stay anonymous (home, mobile or VPN connections). This is normal, and it is why the email click-through matters.
- Identification by click only works when the email link points to a domain registered as a site, and link tracking is on for the campaign.
- The snippet respects Do Not Track / Global Privacy Control by default. Mention that the user may need a cookie/consent notice (GDPR/ePrivacy).
- The public endpoints are `GET /v.js?k=<site key>` and `POST /api/v/collect`. They are rate-limited per IP and site, and they ignore bots and headless browsers. Don't call them yourself.
