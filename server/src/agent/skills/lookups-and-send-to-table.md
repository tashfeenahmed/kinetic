---
name: lookups-and-send-to-table
description: Link tables together — look up matching rows in another table (by domain, email, company name or exact value), or copy/upsert rows into another table, including exploding a list (e.g. a company's people) into one row per item. Use for "companies → people" tables, dedupe against an existing list, or "is this account already in table X".
---
# Lookups and send to table

Tables live in a workspace; all ids below come from `GET /api/gtm/tables` and `GET /api/gtm/tables/{id}/columns`.

## Match modes (used by lookups and dedupe)
- `exact` — trimmed text, case-sensitive.
- `case_insensitive` — ignores case and repeated spaces.
- `domain` — URLs and emails reduce to the bare domain (`https://www.acme.io/x` = `jane@acme.io` = `acme.io`).
- `email` — lowercased, `mailto:` and `+tags` removed.
- `company` — lowercased, punctuation and suffixes (Inc, LLC, Ltd, GmbH, Corp…) dropped; `acme.io` compares as `acme`.
Cells holding a list match on any item.

## 1. Quick one-off lookup (no column)
`POST /api/gtm/tables/{id}/lookup` → `{"column":"Company domain","value":"jane@acme.io","mode":"domain","fields":["Company","Industry"],"limit":20}`
Returns `{count, rows:[{rowId, ...fields}]}`. Use this to answer "is X already in table Y?".

## 2. Lookup column (re-runs automatically)
`POST /api/gtm/tables/{sourceId}/columns`
```json
{"name":"Account","type":"lookup","auto_run":true,
 "config":{"tableId":12,"matchColumn":"Company domain","value":"{{Email}}","mode":"domain",
           "return":"first","fields":["Company","Owner"],"autoRefresh":true}}
```
- `return`: `first` (cell = first chosen field; all chosen fields in `data`, plus `rowId`, `count`), `all` (cell = list; `data.rows`, `data.rowIds`, optional `limit`), `count` (cell = number of matches).
- `fields` empty = every column. `matchColumn: "_id"` matches a row id (e.g. ids recorded by send-to-table).
- Pull a field into its own column with an extract column: `{"type":"extract","config":{"source":"Account","path":"Owner"}}`, or reference `{{Account.Owner}}` in templates.
- Then run it: `POST /api/gtm/tables/{sourceId}/run` `{"columnIds":[<id>]}`. Lookups are local and free.
- When rows are added/removed in the target table, or a matched/returned column changes, the lookup cells turn `stale` and re-run after ~1.5 s. Refreshes never loop back through a table already on the chain, so two tables can look each other up safely.

## 3. Send to table — an action column
Writes each source row into another table. Missing target columns are created as text.
```json
{"name":"Send to Accounts","type":"action",
 "config":{"kind":"send_to_table","tableId":12,
           "fields":[{"name":"Company","value":"{{Company}}"},{"name":"Domain","value":"{{Company domain}}"}],
           "dedupeKey":"Domain","dedupeMode":"domain","onMatch":"update"}}
```
- `dedupeKey` (a target column) makes it an upsert: an existing row with the same normalised key is updated (`onMatch:"update"`, default) or left alone (`"skip"`). Without it every run creates rows.
- The cell records `data.rowIds`, `data.created`, `data.updated` for the target rows.
- New target rows run the target table's auto-run columns. A row that came from table A is never sent back into A (loop guard; cell is skipped with "Loop prevented").
- Run it like any column. **Confirm with the user before running on many rows** (it writes data).

### Companies → people (explode pattern)
1. Companies table has a column holding a list of people — e.g. an AI column with output `people` (list of `{name,title,linkedin}`), or an HTTP/enrichment result.
2. Create/choose a People table (`POST /api/gtm/tables {"name":"People","template":"people"}`).
3. Add to Companies:
```json
{"name":"People → table","type":"action",
 "config":{"kind":"send_to_table","tableId":<peopleId>,"explode":"{{People finder.people}}",
           "fields":[{"name":"Full name","value":"{{item.name}}"},{"name":"Title","value":"{{item.title}}"},
                     {"name":"LinkedIn URL","value":"{{item.linkedin}}"},{"name":"Company","value":"{{Company}}"},
                     {"name":"Company domain","value":"{{Company domain}}"}],
           "dedupeKey":"LinkedIn URL","dedupeMode":"case_insensitive","backRef":"Company row"}}
```
   - `explode` accepts a list cell, a JSON-array string, newline-separated text, or an enrichment/AI wrapper (its first list). Max 1000 items per row.
   - Inside fields, `{{item}}` is the item (`{{item.field}}` for objects) and `{{_index}}` its position; normal `{{Column}}` tokens still work.
   - `backRef` writes `{value: <company label>, tableId, rowId}` into that target column, so each person links back to its company.
4. In People, add enrichments (work email etc.) with `auto_run:true` — they fire for each new person automatically.
5. Optionally add a lookup in People back to Companies (`matchColumn:"Company domain"`, `mode:"domain"`) to pull firmographics.

## 4. One-shot send (no column)
`POST /api/gtm/tables/{sourceId}/send-to-table`
```json
{"targetTableId":12,"rowIds":[1,2,3],"fields":[{"name":"Domain","value":"{{Company domain}}"}],
 "dedupeKey":"Domain","dedupeMode":"domain","explode":"","backRef":""}
```
Omit `rowIds` to send every row (max 5000). Returns `{rows, created, updated, unchanged, skipped, errors, targetRowIds}`.

## Pitfalls
- Field `name` is the **target** column name; `value` is a template over the **source** row.
- Only text columns in the target are updated on upsert; computed target columns recompute from them.
- A lookup reading its own table never matches the row itself.
