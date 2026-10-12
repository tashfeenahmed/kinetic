-- Functions: reusable enrichment recipes (inputs → ordered steps → outputs) used by
-- `function` columns in any table. Lookup and send-to-table columns need no schema:
-- they live in gtm_columns.config.

CREATE TABLE gtm_functions (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- JSON array of lowercase tags
  tags TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  -- current {"inputs":[...],"steps":[...],"outputs":[...]}
  definition TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX gtm_functions_ws ON gtm_functions (workspace_id, updated_at);

-- Every definition a function has had; columns pin one of these.
CREATE TABLE gtm_function_versions (
  function_id INTEGER NOT NULL REFERENCES gtm_functions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (function_id, version)
);

-- One row per function cell run (not test runs): feeds fill rate, run time and error rate.
CREATE TABLE gtm_function_runs (
  id INTEGER PRIMARY KEY,
  function_id INTEGER NOT NULL REFERENCES gtm_functions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  table_id INTEGER,
  column_id INTEGER,
  row_id INTEGER,
  -- done | empty | error
  status TEXT NOT NULL,
  ms INTEGER NOT NULL,
  -- JSON array of output names that had a value
  filled TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  at TEXT NOT NULL
);
CREATE INDEX gtm_function_runs_fn ON gtm_function_runs (function_id, at);
