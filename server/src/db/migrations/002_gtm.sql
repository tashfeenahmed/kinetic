-- Kinetic GTM tables: spreadsheet tables whose columns enrich, research, watch
-- signals and push rows into outreach campaigns. Scoped to a workspace.

CREATE TABLE gtm_tables (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  webhook_token TEXT NOT NULL UNIQUE,
  -- {"enabled":bool,"everyMinutes":n,"columnIds":[...],"lastRunAt":iso}
  schedule TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX gtm_tables_ws ON gtm_tables (workspace_id, updated_at);

CREATE TABLE gtm_columns (
  id INTEGER PRIMARY KEY,
  table_id INTEGER NOT NULL REFERENCES gtm_tables(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- text | formula | extract | enrich | ai | http | signal | action
  type TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  position REAL NOT NULL,
  width INTEGER,
  auto_run INTEGER NOT NULL DEFAULT 0,
  run_if TEXT,
  UNIQUE (table_id, name)
);

CREATE TABLE gtm_rows (
  id INTEGER PRIMARY KEY,
  table_id INTEGER NOT NULL REFERENCES gtm_tables(id) ON DELETE CASCADE,
  position REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX gtm_rows_table ON gtm_rows (table_id, position);

CREATE TABLE gtm_cells (
  row_id INTEGER NOT NULL REFERENCES gtm_rows(id) ON DELETE CASCADE,
  column_id INTEGER NOT NULL REFERENCES gtm_columns(id) ON DELETE CASCADE,
  value TEXT,
  prev_value TEXT,
  changed_at TEXT,
  -- idle | queued | running | done | empty | error | skipped
  status TEXT NOT NULL DEFAULT 'idle',
  error TEXT,
  meta TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (row_id, column_id)
);
CREATE INDEX gtm_cells_status ON gtm_cells (status);
CREATE INDEX gtm_cells_column ON gtm_cells (column_id);
-- Outreach events re-run status columns for the matching lead email.
CREATE INDEX gtm_cells_email ON gtm_cells (json_extract(meta, '$.email')) WHERE json_extract(meta, '$.email') IS NOT NULL;

CREATE TABLE gtm_logs (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  table_id INTEGER,
  row_id INTEGER,
  column_id INTEGER,
  source TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX gtm_logs_at ON gtm_logs (id DESC);
