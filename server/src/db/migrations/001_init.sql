-- Kinetic schema. All timestamps are ISO-8601 UTC strings.

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  current_workspace_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE workspaces (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  -- master inbox settings
  sync_all_emails INTEGER NOT NULL DEFAULT 1,
  smart_warmup_filter INTEGER NOT NULL DEFAULT 1,
  auto_interested_categorization INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE workspace_members (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','editor','viewer')),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'api-user' CHECK (type IN ('api-user','super-admin')),
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Outbound network routes: static IPs (local bind address) or proxies.
CREATE TABLE egress_routes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  proxy_url TEXT,            -- socks5://user:pass@host:port or http://host:port
  local_address TEXT,        -- bind address for SMTP when the host has several IPs
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (workspace_id, name)
);

-- taggable_type: lead | campaign | sender_email
CREATE TABLE taggables (
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  taggable_type TEXT NOT NULL,
  taggable_id INTEGER NOT NULL,
  PRIMARY KEY (tag_id, taggable_type, taggable_id)
);
CREATE INDEX taggables_target ON taggables (taggable_type, taggable_id);

CREATE TABLE sender_emails (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  provider TEXT NOT NULL DEFAULT 'custom' CHECK (provider IN ('google','microsoft','custom')),
  auth_type TEXT NOT NULL DEFAULT 'password' CHECK (auth_type IN ('password','oauth')),
  imap_server TEXT,
  imap_port INTEGER,
  imap_secure INTEGER NOT NULL DEFAULT 1,
  smtp_server TEXT,
  smtp_port INTEGER,
  smtp_secure INTEGER NOT NULL DEFAULT 1,
  username TEXT,
  secret_enc TEXT,            -- encrypted password or OAuth refresh token
  oauth_access_token_enc TEXT,
  oauth_expires_at TEXT,
  email_signature TEXT NOT NULL DEFAULT '',
  daily_limit INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'Connected' CHECK (status IN ('Connected','Disconnected','Paused')),
  last_error TEXT,
  egress_route_id INTEGER REFERENCES egress_routes(id) ON DELETE SET NULL,
  -- warmup
  warmup_enabled INTEGER NOT NULL DEFAULT 0,
  warmup_daily_limit INTEGER NOT NULL DEFAULT 20,
  warmup_reply_rate INTEGER NOT NULL DEFAULT 35,   -- percent
  warmup_started_at TEXT,
  -- sync cursors
  last_synced_at TEXT,
  next_send_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (workspace_id, email)
);

CREATE TABLE imap_cursors (
  sender_email_id INTEGER NOT NULL REFERENCES sender_emails(id) ON DELETE CASCADE,
  folder TEXT NOT NULL,
  uid_validity TEXT NOT NULL,
  last_uid INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sender_email_id, folder)
);

CREATE TABLE custom_variables (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE TABLE lead_lists (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE leads (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  custom_variables TEXT NOT NULL DEFAULT '{}',   -- JSON object name -> value
  status TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('verified','unverified','unknown','unsubscribed','risky','inactive','bounced')),
  lead_list_id INTEGER REFERENCES lead_lists(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (workspace_id, email)
);
CREATE INDEX leads_list ON leads (lead_list_id);

CREATE TABLE blacklisted_emails (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (workspace_id, email)
);

CREATE TABLE blacklisted_domains (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (workspace_id, domain)
);

CREATE TABLE ignore_phrases (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  phrase TEXT NOT NULL
);

CREATE TABLE custom_tracking_domains (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE schedule_templates (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  days TEXT NOT NULL,        -- JSON {monday:true,...}
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  timezone TEXT NOT NULL
);

CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'outbound' CHECK (type IN ('outbound','reply_followup')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','completed','archived')),
  -- settings
  max_emails_per_day INTEGER NOT NULL DEFAULT 1000,
  max_new_leads_per_day INTEGER NOT NULL DEFAULT 100,
  daily_max_sends_per_receiving_domain INTEGER NOT NULL DEFAULT 0,  -- 0 = unlimited
  plain_text INTEGER NOT NULL DEFAULT 1,
  open_tracking INTEGER NOT NULL DEFAULT 0,
  click_tracking INTEGER NOT NULL DEFAULT 0,
  can_unsubscribe INTEGER NOT NULL DEFAULT 1,
  include_auto_replies_in_stats INTEGER NOT NULL DEFAULT 0,
  sequence_prioritization TEXT NOT NULL DEFAULT 'followups' CHECK (sequence_prioritization IN ('followups','new_leads')),
  stop_on_reply INTEGER NOT NULL DEFAULT 1,
  custom_tracking_domain_id INTEGER REFERENCES custom_tracking_domains(id) ON DELETE SET NULL,
  -- schedule
  schedule_days TEXT NOT NULL DEFAULT '{"monday":true,"tuesday":true,"wednesday":true,"thursday":true,"friday":true,"saturday":false,"sunday":false}',
  schedule_start_time TEXT NOT NULL DEFAULT '09:00',
  schedule_end_time TEXT NOT NULL DEFAULT '17:00',
  schedule_timezone TEXT NOT NULL DEFAULT 'America/New_York',
  sequence_title TEXT NOT NULL DEFAULT '',
  launched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE sequence_steps (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,          -- 1-based position in the sequence
  variant_of_step_id INTEGER REFERENCES sequence_steps(id) ON DELETE CASCADE,  -- NULL = main step
  email_subject TEXT NOT NULL DEFAULT '',
  email_body TEXT NOT NULL DEFAULT '',
  wait_in_days INTEGER NOT NULL DEFAULT 1,  -- wait before this step (ignored for step 1)
  thread_reply INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX sequence_steps_campaign ON sequence_steps (campaign_id, step_order);

CREATE TABLE campaign_sender_emails (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  sender_email_id INTEGER NOT NULL REFERENCES sender_emails(id) ON DELETE CASCADE,
  PRIMARY KEY (campaign_id, sender_email_id)
);

-- Per-lead progress in a campaign.
CREATE TABLE campaign_leads (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_sequence','completed','replied','interested','unsubscribed','bounced','stopped','paused')),
  current_step INTEGER NOT NULL DEFAULT 0,   -- last step order sent (0 = none)
  sender_email_id INTEGER REFERENCES sender_emails(id) ON DELETE SET NULL,
  anchor_reply_id INTEGER,          -- reply-followup campaigns answer this inbound message
  last_sent_at TEXT,
  next_due_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (campaign_id, lead_id)
);
CREATE INDEX campaign_leads_due ON campaign_leads (campaign_id, status, next_due_at);

CREATE TABLE scheduled_emails (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  campaign_lead_id INTEGER NOT NULL REFERENCES campaign_leads(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  sequence_step_id INTEGER NOT NULL REFERENCES sequence_steps(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  sender_email_id INTEGER NOT NULL REFERENCES sender_emails(id) ON DELETE CASCADE,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','sending','sent','failed','cancelled')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX scheduled_emails_due ON scheduled_emails (status, scheduled_at);
CREATE INDEX scheduled_emails_campaign ON scheduled_emails (campaign_id, status);

-- Every outbound message (campaign, manual, reply).
CREATE TABLE sent_emails (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'campaign' CHECK (kind IN ('campaign','manual','reply','test')),
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  campaign_lead_id INTEGER REFERENCES campaign_leads(id) ON DELETE SET NULL,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  sequence_step_id INTEGER REFERENCES sequence_steps(id) ON DELETE SET NULL,
  step_order INTEGER,
  sender_email_id INTEGER REFERENCES sender_emails(id) ON DELETE SET NULL,
  thread_id INTEGER,                 -- conversation grouping (threads.id)
  message_id TEXT NOT NULL,          -- RFC 5322 Message-ID without brackets
  in_reply_to TEXT,
  to_email TEXT NOT NULL,
  cc TEXT NOT NULL DEFAULT '',
  bcc TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  tracking_token TEXT UNIQUE,
  opens INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  first_opened_at TEXT,
  bounced INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX sent_emails_message_id ON sent_emails (message_id);
CREATE INDEX sent_emails_campaign ON sent_emails (campaign_id, sent_at);
CREATE INDEX sent_emails_sender_day ON sent_emails (sender_email_id, sent_at);
CREATE INDEX sent_emails_lead ON sent_emails (lead_id);

CREATE TABLE threads (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sender_email_id INTEGER REFERENCES sender_emails(id) ON DELETE SET NULL,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  subject TEXT NOT NULL DEFAULT '',
  last_message_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Inbound messages shown in the master inbox.
CREATE TABLE replies (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sender_email_id INTEGER REFERENCES sender_emails(id) ON DELETE SET NULL,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  sent_email_id INTEGER REFERENCES sent_emails(id) ON DELETE SET NULL,
  thread_id INTEGER REFERENCES threads(id) ON DELETE SET NULL,
  folder TEXT NOT NULL DEFAULT 'inbox' CHECK (folder IN ('inbox','spam','bounced')),
  message_id TEXT NOT NULL,
  in_reply_to TEXT,
  from_name TEXT NOT NULL DEFAULT '',
  from_email TEXT NOT NULL,
  to_email TEXT NOT NULL DEFAULT '',
  cc TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  attachments TEXT NOT NULL DEFAULT '[]',   -- JSON [{filename,size,content_type,path}]
  interested INTEGER NOT NULL DEFAULT 0,
  automated INTEGER NOT NULL DEFAULT 0,
  read INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'reply' CHECK (category IN ('reply','interested','not_interested','unsubscribe','auto_reply','bounce','other')),
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (sender_email_id, message_id)
);
CREATE INDEX replies_inbox ON replies (workspace_id, folder, received_at);
CREATE INDEX replies_thread ON replies (thread_id);

CREATE TABLE reply_templates (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Tracking/analytics event log (opens, clicks, unsubscribes, ...).
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  campaign_id INTEGER,
  lead_id INTEGER,
  sender_email_id INTEGER,
  sent_email_id INTEGER,
  reply_id INTEGER,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX events_ws_time ON events (workspace_id, created_at);
CREATE INDEX events_campaign ON events (campaign_id, type, created_at);

-- Warmup
CREATE TABLE warmup_emails (
  id INTEGER PRIMARY KEY,
  from_sender_id INTEGER NOT NULL REFERENCES sender_emails(id) ON DELETE CASCADE,
  to_sender_id INTEGER NOT NULL REFERENCES sender_emails(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE,
  in_reply_to TEXT,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL DEFAULT '',
  is_reply INTEGER NOT NULL DEFAULT 0,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','sent','failed','cancelled')),
  sent_at TEXT,
  landed_folder TEXT CHECK (landed_folder IN ('inbox','spam')),
  received_at TEXT,
  rescued INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX warmup_emails_due ON warmup_emails (status, scheduled_at);
CREATE INDEX warmup_emails_from ON warmup_emails (from_sender_id, scheduled_at);
CREATE INDEX warmup_emails_to ON warmup_emails (to_sender_id, received_at);

-- Inbox placement tests
CREATE TABLE seed_accounts (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,          -- gmail, outlook, yahoo, other
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  imap_server TEXT NOT NULL,
  imap_port INTEGER NOT NULL DEFAULT 993,
  imap_secure INTEGER NOT NULL DEFAULT 1,
  username TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE placement_tests (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  sequence_step_id INTEGER REFERENCES sequence_steps(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','waiting','completed','failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);

CREATE TABLE placement_results (
  id INTEGER PRIMARY KEY,
  placement_test_id INTEGER NOT NULL REFERENCES placement_tests(id) ON DELETE CASCADE,
  sender_email_id INTEGER REFERENCES sender_emails(id) ON DELETE CASCADE,
  seed_account_id INTEGER REFERENCES seed_accounts(id) ON DELETE CASCADE,
  message_id TEXT,
  result TEXT NOT NULL DEFAULT 'pending' CHECK (result IN ('pending','inbox','spam','missing','send_failed')),
  checked_at TEXT,
  error TEXT
);

-- Webhooks
CREATE TABLE webhooks (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]',     -- JSON array of event types
  secret TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE webhook_deliveries (
  id INTEGER PRIMARY KEY,
  webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (status, next_attempt_at);

CREATE TABLE webhook_attempts (
  id INTEGER PRIMARY KEY,
  webhook_delivery_id INTEGER NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  response_status INTEGER,
  response_body TEXT,
  error TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
