-- Lead sourcing: exclusion lists, saved searches (watchers) and their run history.

-- Named workspace exclusion lists ("Customers", "Do not contact", "Competitors"…).
CREATE TABLE exclusion_lists (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX exclusion_lists_ws ON exclusion_lists (workspace_id);

-- One normalised value per row. kind: domain | email | company | linkedin | place.
-- workspace_id is denormalised so lookups never join (lists hold 300k+ entries).
CREATE TABLE exclusion_entries (
  list_id INTEGER NOT NULL REFERENCES exclusion_lists(id) ON DELETE CASCADE,
  workspace_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (list_id, kind, value)
) WITHOUT ROWID;
CREATE INDEX exclusion_entries_lookup ON exclusion_entries (workspace_id, kind, value);

-- A saved search: a source + params that can re-run on a schedule and add only new rows.
CREATE TABLE saved_searches (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  max_results INTEGER NOT NULL DEFAULT 100,
  table_id INTEGER REFERENCES gtm_tables(id) ON DELETE SET NULL,
  -- off | hourly | daily | weekly
  schedule TEXT NOT NULL DEFAULT 'off',
  apply_exclusions INTEGER NOT NULL DEFAULT 1,
  -- {"kind":"slack","channel":"#leads"} | {"kind":"webhook","url":"…"} | {}
  alert TEXT NOT NULL DEFAULT '{}',
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX saved_searches_due ON saved_searches (schedule, next_run_at);

-- Dedupe keys already delivered by a saved search (place id, domain, email, LinkedIn or name+city hash).
CREATE TABLE saved_search_seen (
  search_id INTEGER NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (search_id, key)
) WITHOUT ROWID;

CREATE TABLE saved_search_runs (
  id INTEGER PRIMARY KEY,
  search_id INTEGER NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
  -- manual | schedule | api
  trigger TEXT NOT NULL,
  -- running | done | error
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  found INTEGER NOT NULL DEFAULT 0,
  new_count INTEGER NOT NULL DEFAULT 0,
  excluded INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX saved_search_runs_search ON saved_search_runs (search_id, id DESC);
