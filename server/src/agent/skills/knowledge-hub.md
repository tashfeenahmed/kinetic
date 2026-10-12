---
name: knowledge-hub
description: Use to read, write or reorganise the Knowledge Hub — markdown documents about what the business sells and to whom (company overview, offers, ICP, personas, positioning, competitors, case studies, tone of voice, do-not-target list) — including filling it from the user's website, and to apply it to targeting and copy.
---
# Knowledge Hub (documents)

The hub is a list of plain **markdown documents**, ordered by the user, optionally pinned. A compact version (pinned docs first, long docs cut) is in your system prompt; the `knowledge` tool gives more:
- `knowledge` with no arguments → list of docs (`#id title`) plus their combined text (~12k chars)
- `knowledge {"doc": "Tone of voice"}` (or `"12"`) → one doc's full markdown
- `knowledge {"query": "pricing hubspot"}` → matching lines across docs

AI research columns include it with `"useKnowledge": true`; AI reply drafts use it automatically.

## Read via the API
- `GET /api/knowledge/docs` (`?q=words` filters) → `{ data: [{ id, title, pinned, position, created_by, chars, excerpt, updated_at }] }`
- `GET /api/knowledge/docs/{id}` → `{ data: { …, content } }` (markdown)
- `GET /api/knowledge/context` → `{ data: { text, empty } }` — exactly what prompts get
- `GET /api/knowledge/templates` → starter docs: `company`, `icp`, `personas`, `positioning`, `competitors`, `proof`, `tone`, `exclusions`

## Fill from the website (best first step when the hub is empty)
`POST /api/knowledge/autofill` `{ "domain": "acme.com" }` → `{ data: { drafts: [{ key, title, content, exists }], pages, ai, summary } }`
- Crawls the home page plus about/product/pricing/customers pages and drafts up to 9 docs (Company overview, Products & offers, Ideal customer profile, Buyer personas, Positioning & messaging, Competitors, Case studies, Tone of voice, Do-not-target list). Without an AI key it only drafts a short Company overview.
- Nothing is saved unless you pass `"apply": true`, which creates every draft whose title doesn't exist yet (`exists: false`) — it never overwrites a doc. Either apply and tell the user which docs were created, or show the titles first (ask_user) and create the chosen ones with the bulk call below.
- `POST /api/knowledge/docs/bulk` `{ "docs": [{ "title": "Buyer personas", "content": "## Café owner\n\n**Pains:** …" }], "created_by": "autofill", "source_url": "https://acme.com" }`

## Write documents
- Create: `POST /api/knowledge/docs` `{ "title": "Ideal customer profile", "content": "## Firmographics\n\n- **Industries:** Hospitality\n- **Geographies:** Ireland, UK\n\n## Buying triggers\n\n- Opening a new site" }`
  - `{ "template": "icp" }` starts from a template (title and starter markdown; pass `content` to override).
  - `{ "url": "https://acme.com/customers" }` imports a page's text. `"pinned": true` pins it.
- Update: `PATCH /api/knowledge/docs/{id}` `{ "content": "…full new markdown…" }` — content **replaces** the doc, so GET it first and send the whole edited text. Also `{ "title": "…" }`, `{ "pinned": true }`.
- Duplicate: `POST /api/knowledge/docs/{id}/duplicate`. Reorder: `POST /api/knowledge/docs/reorder` `{ "ids": [5, 2, 9] }`.
- Delete: `DELETE /api/knowledge/docs/{id}` — needs the user's approval; confirm first.

Before creating, check the list: if a doc with that topic exists, update it instead of making a near-duplicate.

## Writing good docs
- Markdown only: `##` / `###` headings (no `#` title — the doc title is separate), `-` bullets, `1.` numbered lists, `- [ ]` task items, `**bold**` labels, `[links](https://…)`, `>` quotes. Keep each doc focused on one topic and short enough to scan (aim under ~3,000 chars; pinned docs are always in the prompt, so pin only the essentials such as the ICP and do-not-target list).
- Be factual: only write what the user said, the website says, or you verified; mark guesses as such.
- When the user says "write our ICP doc from what you know", draft from the chat, existing docs and their site, create it, then summarise what you wrote and ask what to change.

## Using it
- Targeting: turn the ICP (industries, geos, sizes, triggers) into find queries and signal choices; always honour the do-not-target list.
- Copy: use personas' pains, positioning and case studies; follow the tone of voice doc.
- If the hub is empty and the task depends on it, offer to fill it from the user's domain (one call).
