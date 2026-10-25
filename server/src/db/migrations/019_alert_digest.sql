-- Signal alerts that fall back to email wait here for the morning digest (gtm/alertDigest.ts).

CREATE TABLE alert_digest_items (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- JSON: { title, text, tableId, rowId, company, domain, changes: [{ name, kind, from, to }] }
  item TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Set when a digest run took the item, whether or not an email went out.
  digest_day TEXT
);
CREATE INDEX alert_digest_items_pending ON alert_digest_items (workspace_id, digest_day);

-- One row per workspace per local day the digest ran.
CREATE TABLE alert_digest_runs (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  -- sent | quiet (nothing worth a look) | failed
  status TEXT NOT NULL,
  subject TEXT,
  items INTEGER NOT NULL DEFAULT 0,
  worth_a_look INTEGER NOT NULL DEFAULT 0,
  also_changed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, day)
);
