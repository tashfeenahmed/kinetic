-- Sending domains set up through Cloudflare (DNS for MX/SPF/DKIM/DMARC/tracking).
CREATE TABLE sending_domains (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain TEXT NOT NULL COLLATE NOCASE,
  zone_id TEXT,
  provider TEXT NOT NULL DEFAULT 'google' CHECK (provider IN ('google','microsoft','other')),
  setup TEXT NOT NULL DEFAULT '{}',      -- JSON DomainSetup (secrets none; DKIM keys are public)
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','configured','verified','attention')),
  last_result TEXT,                      -- JSON: applied actions
  report TEXT,                           -- JSON: last DNS check
  applied_at TEXT,
  checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (workspace_id, domain)
);
