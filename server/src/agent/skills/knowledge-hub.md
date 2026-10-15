---
name: knowledge-hub
description: Use to read, write or reorganise the Knowledge Hub — markdown documents in nested folders about what the business sells and to whom (company overview, offers, ICP, personas, positioning, competitors, proof, tone of voice, objections, do-not-target list) — including researching and filling it from the user's website (multi-step crawl + web research), asking the agent to write inside a doc, and applying it to targeting and copy.
---
# Knowledge Hub (documents)

The hub holds plain **markdown documents** inside nested **folders** (like Notion's sidebar), ordered by the user, optionally pinned. Docs in a folder are shown as `Folder / Sub / Title`. A compact version (pinned docs first, long docs cut) is in your system prompt; the `knowledge` tool gives more:
- `knowledge` with no arguments → the folders (`folder 3: Company / Research`), the docs (`#id Folder / Title`) plus their combined text (~12k chars)
- `knowledge {"doc": "Tone of voice"}` (or `"12"`, or a path like `"tillr.ie / Tone of voice"`) → one doc's full markdown
- `knowledge {"query": "pricing hubspot"}` → matching lines across docs

AI research columns include it with `"useKnowledge": true`; AI reply drafts use it automatically.

## Read via the API
- `GET /api/knowledge/docs` (`?q=words` filters) → `{ data: [{ id, title, folder_id, folder_path, pinned, position, created_by, chars, excerpt, updated_at }] }`
- `GET /api/knowledge/folders` → `{ data: [{ id, name, parent_id, path, position, doc_count }] }` (flat; `parent_id: null` = top level)
- `GET /api/knowledge/docs/{id}` → `{ data: { …, content } }` (markdown)
- `GET /api/knowledge/context` → `{ data: { text, empty } }` — exactly what prompts get
- `GET /api/knowledge/templates` → starter docs: `company`, `icp`, `personas`, `positioning`, `competitors`, `proof`, `tone`, `exclusions`

## Fill from the website (best first step when the hub is empty)
This is a multi-step research run, not a single page read. It:
1. crawls the site — home page, then up to ~20 important pages found in the menu, footer and sitemap.xml (about, product, pricing, solutions/industries, customers/case studies, a few recent blog posts, careers, contact, comparison pages);
2. web-searches competitors, alternatives, category leaders in their region, reviews, LinkedIn/company info, press, and the customers named in case studies;
3. picks the real competitors and reads each one's home page;
4. writes 9 detailed docs with tables: Company overview (key facts table), Products & offers, Ideal customer profile (firmographics + example customers tables, says what is inferred), Buyer personas (3-5, each with goals, pains, objections, messaging angle and an example opening line), Positioning & messaging, Competitors (comparison table + how to win), Proof & case studies, Tone of voice (do/don't, vocabulary, email guidelines), Objection handling.

It takes **1-3 minutes** and uses the default model (Haiku) with capped tokens — typically a few cents; `usage.cost_usd` says what it cost. Without an AI key it only crawls and drafts a short Company overview (`ai: false`, with a note); tell the user to add an OpenRouter key for the full research.

**One call (simplest for you):** `POST /api/knowledge/autofill` `{ "domain": "acme.com" }` waits for the whole run → `{ data: { drafts: [{ key, title, content, exists }], pages, searches, competitors, usage: { cost_usd }, notes, ai, summary } }`. Add `"apply": true` to save the drafts in a folder named after the site (or `folder`): docs already in that folder, or your own top-level docs with the same title, are skipped and listed in `skipped`; `"overwrite": true` replaces the site folder's docs with the new drafts (`updated`). `applied` is true only when something was saved.
- Nothing is saved unless you pass `"apply": true`, which creates every draft whose title doesn't exist yet (`exists: false`) — it never overwrites a doc — inside a folder named after the site (`"acme.com"`; reused if it exists). Pass `"folder": "Company"` (a name or path) or `"folder_id": 4` to file them elsewhere. The response has `created` and `folder`. Either apply and tell the user which docs were created and where (plus pages read, competitors found and the cost), or show the titles first (ask_user) and create the chosen ones with the bulk call below.
- `POST /api/knowledge/docs/bulk` `{ "docs": [{ "title": "Buyer personas", "content": "## Café owner\n\n**Pains:** …" }], "created_by": "autofill", "source_url": "https://acme.com", "folder": "acme.com" }`

**Background (what the UI uses):** `POST /api/knowledge/research` `{ "domain": "acme.com" }` → `{ data: { id, status: "running", steps } }`; then `GET /api/knowledge/research/{id}` → `status` (`running` | `done` | `failed` | `stopped`), `steps` (live labels such as "Reading /pricing…", "Searching competitors…", "Writing buyer personas…") and, when done, `result` (same shape as autofill: drafts, pages, searches, competitors, usage). `POST /api/knowledge/research/{id}/stop` stops it. Don't poll more than every ~20 seconds; prefer the one-call autofill.

## Write inside a document with the agent ("@Agent")
`POST /api/knowledge/docs/{id}/agent` `{ "instruction": "fill the comparison table with 5 competitors", "mode": "auto" }` → `{ data: { markdown, mode, note, steps, usage } }`
- It reads the whole doc, its folder, the rest of the hub, and can web-search and read pages. It returns markdown plus a placement: `insert` (at `cursor`, a character offset in the markdown; else at the end), `replace` (swaps the exact `selection` text you pass), `append` (new section at the end) or `rewrite` (whole doc). Pass `"mode"` to force one.
- `"apply": true` saves the edit to the doc (409 if `selection` is no longer in the doc). Without it nothing is saved — useful to preview. Confirm with the user before a `rewrite`.
- Use it to deepen a doc ("expand the personas with objections", "research their pricing and add a plans table") instead of rewriting the doc yourself.

## Write documents
- Create: `POST /api/knowledge/docs` `{ "title": "Ideal customer profile", "content": "## Firmographics\n\n- **Industries:** Hospitality\n- **Geographies:** Ireland, UK\n\n## Buying triggers\n\n- Opening a new site" }`
  - `{ "template": "icp" }` starts from a template (title and starter markdown; pass `content` to override).
  - `{ "url": "https://acme.com/customers" }` imports a page's text. `"pinned": true` pins it.
  - `"folder_id": 4` files it in a folder; `"folder": "Competitors / EU"` does the same by path and creates missing folders. Without either it goes to the top level.
- Update: `PATCH /api/knowledge/docs/{id}` `{ "content": "…full new markdown…" }` — content **replaces** the doc, so GET it first and send the whole edited text. Also `{ "title": "…" }`, `{ "pinned": true }`.
- Duplicate: `POST /api/knowledge/docs/{id}/duplicate` (lands right below the original).
- Delete: `DELETE /api/knowledge/docs/{id}` — needs the user's approval; confirm first.

Before creating, check the list: if a doc with that topic exists, update it instead of making a near-duplicate.

## Folders
- Create: `POST /api/knowledge/folders` `{ "name": "Competitors", "parent_id": null }` (`parent_id` of another folder nests it; any depth). New folders go to the top of their parent.
- Rename: `PATCH /api/knowledge/folders/{id}` `{ "name": "Competitor research" }`.
- Move and reorder (docs and folders, one call): `POST /api/knowledge/move` `{ "items": [{ "type": "doc", "id": 12 }, { "type": "doc", "id": 13 }], "folder_id": 4 }` — `folder_id: null` is the top level. Items go to the end unless you pass `"index": 0`, or `"before"` / `"after"`: `{ "type": "folder", "id": 7 }` (a sibling in the target folder). A folder can't go inside itself or its own subfolders (400). Moving one doc also works with `PATCH /api/knowledge/docs/{id}` `{ "folder_id": 4 }`.
- Reorder docs inside their folders only: `POST /api/knowledge/docs/reorder` `{ "ids": [13, 12, 15] }` (ids in the new order).
- Delete: `DELETE /api/knowledge/folders/{id}?contents=move_up` (default — its docs and subfolders move up a level) or `?contents=delete` (deletes every doc inside too). Needs the user's approval; say which mode and how many docs are inside (`doc_count`, plus subfolders) first.

Organising rules:
- When you write several related docs (e.g. three competitor teardowns, a set of personas, research on one account), put them in one folder: create it (or pass `"folder": "Competitors"` on each create) instead of leaving them loose at the top level.
- Reuse an existing folder when one fits (check `knowledge` or `GET /api/knowledge/folders` first); don't create near-duplicate folders.
- Keep it shallow (2–3 levels). Only reorganise the user's existing folders when they ask.

## Writing good docs
- Markdown only: `##` / `###` headings (no `#` title — the doc title is separate), `-` bullets, `1.` numbered lists, `- [ ]` task items, `**bold**` labels, `[links](https://…)`, `>` quotes, and GFM tables (`| A | B |` then `| --- | --- |`; the first row is the header) for comparisons such as competitors or personas at a glance. Keep each doc focused on one topic and short enough to scan (aim under ~3,000 chars; pinned docs are always in the prompt, so pin only the essentials such as the ICP and do-not-target list).
- Be factual: only write what the user said, the website says, or you verified; mark guesses as such.
- When the user says "write our ICP doc from what you know", draft from the chat, existing docs and their site, create it, then summarise what you wrote and ask what to change.

## Learnings (written by Kinetic)
A pinned doc titled **Learnings** is created and kept up to date automatically: one dated line per A/B test winner (which
subject or email beat which, on what metric, with numbers) and per won deal (company, value, campaign, step and variant).
Newest first, only the last 50 lines are kept. Text above the lines can be edited and is kept; don't rename the doc.

## Using it
- Copy: read Learnings first and reuse what won (subjects, angles, steps); avoid what lost.
- Targeting: turn the ICP (industries, geos, sizes, triggers) into find queries and signal choices; always honour the do-not-target list.
- Copy: use personas' pains, positioning and case studies; follow the tone of voice doc.
- If the hub is empty and the task depends on it, offer to fill it from the user's domain (one call).
