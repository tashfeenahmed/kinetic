---
name: knowledge-hub
description: Use to read or fill in the Knowledge Hub (what the business sells, ICP, personas, positioning, competitors, proof, tone, exclusions) — including drafting it from the user's website or pasted docs — and to apply it to targeting and copy.
---
# Knowledge Hub

The hub describes what the user's business sells and to whom. It's included (summarised) in your system prompt; the `knowledge` tool returns the fuller text. AI research columns can include it with `"useKnowledge": true`.

## Read
- `GET /api/knowledge` → `{ data: { company, offers, icp, personas, positioning, competitors, proof, tone, exclusions, updated_at }, docs: [...] }`
- `GET /api/knowledge/context` → `{ data: { text, empty } }` (compact summary)

## Fill from the website (best first step when the hub is empty)
`POST /api/knowledge/autofill` `{ "domain": "acme.com", "apply": false }` → `{ data: { draft, pages, ai } }`
- Crawls the home page plus about/product/pricing/customers pages and drafts every section with AI (without an AI key it only fills name, website and overview).
- `apply: true` fills **empty** sections only — it never overwrites what the user wrote. Prefer showing the user the draft (ask_user) before applying, or apply and tell them what was filled.
- The crawl is saved as a doc ("Website: acme.com").

## Edit sections
`PUT /api/knowledge` with only the sections to replace (others are kept; `company` and `icp` merge by field):
```json
{ "company": { "name": "Acme", "website": "acme.com", "overview": "…" },
  "offers": [{ "name": "Acme POS", "description": "…", "pricing": "€49/mo" }],
  "icp": { "industries": ["Hospitality"], "sizes": ["1-50"], "geos": ["Ireland"], "tech": ["Square"], "triggers": ["opening a new site"], "notes": "" },
  "personas": [{ "title": "Owner / GM", "pains": "…", "goals": "…", "objections": "…" }],
  "positioning": "…", "competitors": [{ "name": "Square", "domain": "squareup.com", "notes": "…" }],
  "proof": [{ "title": "Café X cut queues 30%", "summary": "…", "url": "" }],
  "tone": "Friendly, short, no jargon. Max 90 words, one CTA.", "exclusions": "No chains with 50+ sites; no existing customers." }
```
Arrays replace the whole list — GET first and send the full list when adding one item.

## Docs (source material)
- `POST /api/knowledge/docs` `{ "title": "Sales deck", "content": "…pasted text…" }` or `{ "url": "https://acme.com/case-studies" }` (fetched)
- `POST /api/knowledge/docs/{id}/draft` `{ "apply": false }` → AI summary + drafted sections from that doc (`apply: true` fills empty sections).
- `GET /api/knowledge/docs`, `GET /api/knowledge/docs/{id}`, `PATCH /api/knowledge/docs/{id}`, `DELETE /api/knowledge/docs/{id}` (approval).

## Using it
- Targeting: turn ICP industries/geos/sizes/triggers into find queries and signal choices; always honour exclusions.
- Copy: use personas' pains, positioning and proof; follow tone/email guidelines.
- If the hub is empty and the task depends on it, suggest filling it (autofill from their domain takes one call).
