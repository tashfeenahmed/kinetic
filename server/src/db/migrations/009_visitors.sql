-- Website visitor identification: tracked sites, sessions, raw events (pruned by
-- retention), per-company and per-person aggregates (kept), and IP → org caches.

CREATE TABLE visitor_settings (
  workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  respect_dnt INTEGER NOT NULL DEFAULT 1,
  retention_days INTEGER NOT NULL DEFAULT 180,
  alert_threshold INTEGER NOT NULL DEFAULT 60,
  alert_on TEXT NOT NULL DEFAULT 'targets' CHECK (alert_on IN ('targets','all','off')),
  alert_slack INTEGER NOT NULL DEFAULT 0,
  alert_webhook_url TEXT,
  target_domains TEXT NOT NULL DEFAULT '[]',     -- JSON array of company domains to watch
  auto_push_table_id INTEGER,
  auto_push_score INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE visitor_sites (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  site_key TEXT NOT NULL UNIQUE,
  key_pages TEXT NOT NULL DEFAULT '["/pricing","/demo","/contact"]',
  last_hit_at TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (workspace_id, domain)
);

-- One row per company (by domain) or unmatched organisation (by name). Counters are
-- cumulative and survive retention; score is recomputed from recent sessions.
CREATE TABLE visitor_companies (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  domain TEXT,
  name TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  visits INTEGER NOT NULL DEFAULT 0,
  pageviews INTEGER NOT NULL DEFAULT 0,
  key_pageviews INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  profile TEXT,                                  -- JSON from the company_profile waterfall
  enriched_at TEXT,
  alerted_at TEXT,
  pushed_table_id INTEGER,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (workspace_id, key)
);
CREATE INDEX visitor_companies_seen ON visitor_companies (workspace_id, last_seen_at);

CREATE TABLE visitor_people (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  company_id INTEGER REFERENCES visitor_companies(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT '',               -- email_click | identify
  visits INTEGER NOT NULL DEFAULT 0,
  pageviews INTEGER NOT NULL DEFAULT 0,
  pages TEXT NOT NULL DEFAULT '{}',              -- JSON path -> views
  score INTEGER NOT NULL DEFAULT 0,
  alerted_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (workspace_id, email)
);

-- Anonymous browser id (first-party storage) → person, once known.
CREATE TABLE visitor_identities (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES visitor_people(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, visitor_id)
);

CREATE TABLE visitor_sessions (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES visitor_sites(id) ON DELETE CASCADE,
  session_key TEXT NOT NULL,
  visitor_id TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  org_status TEXT NOT NULL DEFAULT 'pending',    -- pending | company | isp | hosting | mobile | vpn | private | unknown
  org_name TEXT,
  company_id INTEGER REFERENCES visitor_companies(id) ON DELETE SET NULL,
  person_id INTEGER REFERENCES visitor_people(id) ON DELETE SET NULL,
  landing_url TEXT NOT NULL DEFAULT '',
  referrer TEXT NOT NULL DEFAULT '',
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
  pageviews INTEGER NOT NULL DEFAULT 0,
  key_pages INTEGER NOT NULL DEFAULT 0,
  duration_s INTEGER NOT NULL DEFAULT 0,
  paths TEXT NOT NULL DEFAULT '{}',              -- JSON path -> views (survives event pruning)
  score INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (site_id, session_key)
);
CREATE INDEX visitor_sessions_company ON visitor_sessions (company_id, started_at);
CREATE INDEX visitor_sessions_person ON visitor_sessions (person_id, started_at);
CREATE INDEX visitor_sessions_ws ON visitor_sessions (workspace_id, last_seen_at);
CREATE INDEX visitor_sessions_pending ON visitor_sessions (org_status);

CREATE TABLE visitor_events (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES visitor_sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                            -- pageview | click | identify
  url TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  duration_s INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX visitor_events_session ON visitor_events (session_id, id);
CREATE INDEX visitor_events_ws ON visitor_events (workspace_id, id);
CREATE INDEX visitor_events_time ON visitor_events (created_at);

-- IP intelligence caches (install-wide; public data).
CREATE TABLE visitor_networks (
  id INTEGER PRIMARY KEY,
  cidr TEXT NOT NULL UNIQUE,
  family INTEGER NOT NULL,
  start_hex TEXT NOT NULL,                       -- zero-padded hex, comparable as text
  end_hex TEXT NOT NULL,
  org_name TEXT,
  domain TEXT,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  resolved_at TEXT NOT NULL
);
CREATE INDEX visitor_networks_range ON visitor_networks (family, start_hex, end_hex);

CREATE TABLE visitor_ip_cache (
  ip TEXT PRIMARY KEY,
  org_name TEXT,
  domain TEXT,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  resolved_at TEXT NOT NULL
);
