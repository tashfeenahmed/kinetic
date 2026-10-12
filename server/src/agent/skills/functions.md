---
name: functions
description: Create, test, version and use Functions — saved, reusable enrichment recipes (named inputs → ordered steps → named outputs) that run as a `function` column in any table. Use when the user wants to reuse the same enrichment logic across tables, package columns into a recipe, test enrichment logic without touching a table, or check a function's fill rate / error rate.
---
# Functions

A function = `inputs` (names like `domain`, `full_name`) + `steps` (each a column config of type `enrich`, `ai`, `http`, `formula`, `extract` or `lookup`, run in order) + `outputs` (name → template over inputs and steps). Steps read inputs and earlier steps exactly like columns: `{{domain}}`, `{{Company info.industry}}`, `row["domain"]` in formulas, `source: "Company info"` in extract. Each step may have `run_if` (JavaScript over `row`); a skipped step yields null.

## List / inspect
- `GET /api/gtm/functions` (optional `?tag=company`) → each with `version`, `tags`, `definition`, `usage {columns, tables, outdated}`.
- `GET /api/gtm/functions/{id}` → plus `versions`, `columns` (where used, with each column's version) and `stats`.
- `GET /api/gtm/functions/{id}/stats?days=30` → `rowsProcessed`, `fillRate` (% per output), `avgMs`, `errorRate`, `emptyRate`, `byVersion`, `tables`.

## Create from scratch
`POST /api/gtm/functions`
```json
{"name":"Company basics","description":"Domain → firmographics + one-line summary","tags":["company"],
 "definition":{
  "inputs":[{"name":"domain","required":true}],
  "steps":[
    {"name":"Company info","type":"enrich","config":{"kind":"company_profile","inputs":{"domain":"{{domain}}"}}},
    {"name":"Size bucket","type":"formula","config":{"expression":"Number(get(raw['Company info'], 'employees') ?? 0) > 200 ? 'mid-market' : 'smb'"}},
    {"name":"Summary","type":"ai","run_if":"row['Company info']","config":{"prompt":"In one sentence, what does {{domain}} sell?","outputs":[{"name":"summary","type":"string"}],"webSearch":true}}
  ],
  "outputs":[{"name":"industry","value":"{{Company info.industry}}"},{"name":"size","value":"{{Size bucket}}"},{"name":"summary","value":"{{Summary}}"}]}}
```
Step configs are identical to column configs (see `GET /api/gtm/catalog` for enrichment kinds and their inputs; lookup config is described in the `lookups-and-send-to-table` skill). Names must be unique; a step may only read inputs and earlier steps (otherwise 400).

## Create from existing columns
`POST /api/gtm/functions/from-columns` `{"tableId":3,"columnIds":[10,11,12],"name":"Email finder","tags":["email"],"addColumn":false}`
- Selected columns become steps in dependency order; unselected columns they read become inputs (snake_case, e.g. "Company domain" → `company_domain`) and references are rewritten; columns nothing else selected reads become outputs.
- Returns `{id, definition, mapping}`; `mapping` is the input → `{{Column}}` map to use in a function column. `addColumn:true` also adds that column to the source table.

## Test (sandbox — writes nothing to tables, not counted in stats)
- Saved: `POST /api/gtm/functions/{id}/test` with `{"inputs":[{"domain":"stripe.com"}]}` or `{"tableId":3,"limit":5,"mapping":{"domain":"{{Company domain}}"}}` (optional `rowIds`, `version`).
- Draft: `POST /api/gtm/functions/test` with the same body plus `"definition": {...}`.
- Result per sample: `outputs`, `status` (done | empty | error), `ms`, and `steps` [{name, type, status, ms, value, error, provider}].
- Tests still call providers/AI: paid steps spend credits. Max 25 samples. Tell the user before testing paid steps on many rows.

## Use in a table
`POST /api/gtm/tables/{id}/columns`
```json
{"name":"Company basics","type":"function","auto_run":false,
 "config":{"functionId":7,"version":2,"inputs":{"domain":"{{Company domain}}"}}}
```
- A bare `{{Column}}` passes the whole cell (enrichment data intact); other templates pass rendered text.
- Cell value: `{value, data:{output: value…}}` (value is the single output, or the object when there are several). Pull an output out with an extract column `{"type":"extract","config":{"source":"Company basics","path":"industry"}}` or `{{Company basics.industry}}`.
- Per-step details are in the cell's `meta.functionSteps` (`GET /api/gtm/cells/{rowId}/{columnId}`).
- Run: `POST /api/gtm/tables/{id}/run` `{"columnIds":[<colId>]}`. Rows where every input is empty (or a required input is empty) are skipped.

## Edit and versions
- `PATCH /api/gtm/functions/{id}` with any of `name`, `description`, `tags`, `definition`. Only a changed `definition` creates a new version (`{version, bumped}`).
- Columns stay on the version they pinned (`config.version`). Upgrade: `POST /api/gtm/functions/{id}/upgrade-columns` (`{"columnIds":[...]}` optional; all columns otherwise), then re-run the columns if the user wants fresh values.
- `GET /api/gtm/functions/{id}/versions/{n}` returns an older definition.
- `DELETE /api/gtm/functions/{id}` — confirm first; columns using it will error.

## Tips
- Keep functions small and single-purpose (e.g. "Domain → work emails"), and test on 3–5 rows before running a whole table.
- Fill rate per output tells you which provider steps are worth paying for; error rate > 10% usually means a missing API key or a bad input mapping.
