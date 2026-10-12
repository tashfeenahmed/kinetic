-- Kinetic Companion: a browser extension runs LinkedIn/social automations ("phantoms")
-- inside the user's own logged-in browser; the server queues tasks, enforces limits,
-- working hours and pacing, and writes results into GTM tables.

-- Short-lived codes shown in the UI; the extension trades one for an API token.
CREATE TABLE companion_pairing_codes (
  code TEXT PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- One row per browser. Identity is the API token it authenticates with.
CREATE TABLE companion_devices (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_token_id INTEGER UNIQUE REFERENCES api_tokens(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  version TEXT,
  user_agent TEXT,
  -- {"linkedin":true,"instagram":false,...} — which sites the browser is logged in to
  accounts TEXT NOT NULL DEFAULT '{}',
  paused INTEGER NOT NULL DEFAULT 0,
  -- safety stop: {"linkedin":"2026-01-01T00:00:00Z"} site → paused until
  site_pauses TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  current_task_id INTEGER,
  next_action_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX companion_devices_ws ON companion_devices (workspace_id);

-- Limits, working hours, pacing and the global pause switch, per workspace.
CREATE TABLE companion_settings (
  workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  data TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

-- A configured automation: one phantom with its inputs, output table and schedule.
CREATE TABLE companion_jobs (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  phantom TEXT NOT NULL,
  name TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  -- draft | queued | running | paused | completed | failed | cancelled
  status TEXT NOT NULL DEFAULT 'draft',
  table_id INTEGER REFERENCES gtm_tables(id) ON DELETE SET NULL,
  -- {"fieldKey":"Column name"}
  column_map TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT,
  -- {"every":"hourly"|"daily"|"weekly"} or {}
  schedule TEXT NOT NULL DEFAULT '{}',
  watcher INTEGER NOT NULL DEFAULT 0,
  -- {"slack":true,"slack_channel":"#x","webhook_url":"https://..."}
  alerts TEXT NOT NULL DEFAULT '{}',
  progress TEXT NOT NULL DEFAULT '{}',
  results_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  next_run_at TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX companion_jobs_ws ON companion_jobs (workspace_id, status);
CREATE INDEX companion_jobs_due ON companion_jobs (next_run_at) WHERE next_run_at IS NOT NULL;

-- One execution of a job (a scheduled watcher run creates a new one each time).
CREATE TABLE companion_runs (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES companion_jobs(id) ON DELETE CASCADE,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- running | completed | failed | cancelled
  status TEXT NOT NULL DEFAULT 'running',
  results INTEGER NOT NULL DEFAULT 0,
  new_results INTEGER NOT NULL DEFAULT 0,
  actions INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  -- first new records of this run (for alerts and the run detail)
  sample TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX companion_runs_job ON companion_runs (job_id, id DESC);

-- LinkedIn outreach campaigns (visit → connect → message → follow-ups).
CREATE TABLE li_campaigns (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- draft | active | paused | completed
  status TEXT NOT NULL DEFAULT 'draft',
  settings TEXT NOT NULL DEFAULT '{}',
  table_id INTEGER REFERENCES gtm_tables(id) ON DELETE SET NULL,
  approved_at TEXT,
  last_check_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX li_campaigns_ws ON li_campaigns (workspace_id);

CREATE TABLE li_campaign_leads (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES li_campaigns(id) ON DELETE CASCADE,
  profile_url TEXT NOT NULL,
  public_id TEXT,
  member_urn TEXT,
  full_name TEXT,
  first_name TEXT,
  last_name TEXT,
  title TEXT,
  company TEXT,
  location TEXT,
  headline TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  excluded INTEGER NOT NULL DEFAULT 0,
  -- pending | visited | invited | accepted | messaged | replied | done | not_accepted | failed
  state TEXT NOT NULL DEFAULT 'pending',
  -- number of messages sent (1 = first message, 2+ = follow-ups)
  messages_sent INTEGER NOT NULL DEFAULT 0,
  next_action_at TEXT,
  visited_at TEXT,
  invited_at TEXT,
  accepted_at TEXT,
  last_message_at TEXT,
  replied_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (campaign_id, profile_url)
);
CREATE INDEX li_campaign_leads_state ON li_campaign_leads (campaign_id, state);

-- Units of work for the extension (or the server, for Reddit/GitHub). One scrape,
-- one profile visit, one invite… Limits are checked per task when it is leased.
CREATE TABLE companion_tasks (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES companion_jobs(id) ON DELETE CASCADE,
  run_id INTEGER REFERENCES companion_runs(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES li_campaigns(id) ON DELETE CASCADE,
  campaign_lead_id INTEGER REFERENCES li_campaign_leads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  site TEXT NOT NULL,
  -- extension | server
  runner TEXT NOT NULL DEFAULT 'extension',
  -- limit bucket this task spends, e.g. linkedin.connect
  action TEXT,
  target TEXT NOT NULL DEFAULT '{}',
  params TEXT NOT NULL DEFAULT '{}',
  cursor TEXT,
  -- pending | leased | done | failed | skipped | cancelled
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before TEXT,
  device_id INTEGER REFERENCES companion_devices(id) ON DELETE SET NULL,
  lease_expires_at TEXT,
  result TEXT,
  error TEXT,
  results_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX companion_tasks_queue ON companion_tasks (workspace_id, status, runner, priority DESC, id);
CREATE INDEX companion_tasks_job ON companion_tasks (job_id, status);
CREATE INDEX companion_tasks_campaign ON companion_tasks (campaign_id, status);

-- Every action/scrape the extension performed; limits are counted from here.
CREATE TABLE companion_actions (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  device_id INTEGER,
  task_id INTEGER,
  job_id INTEGER,
  action TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  at TEXT NOT NULL
);
CREATE INDEX companion_actions_ws ON companion_actions (workspace_id, action, at);

-- Watcher mode: keys already delivered for a job, so re-runs add only new results.
CREATE TABLE companion_seen (
  job_id INTEGER NOT NULL REFERENCES companion_jobs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (job_id, key)
);

-- Things a person must approve before the extension acts (AI-drafted comments).
CREATE TABLE companion_approvals (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES companion_jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '{}',
  context TEXT,
  draft TEXT NOT NULL,
  -- pending | approved | rejected | posted | failed
  status TEXT NOT NULL DEFAULT 'pending',
  task_id INTEGER,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX companion_approvals_ws ON companion_approvals (workspace_id, status);
