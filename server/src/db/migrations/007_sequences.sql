-- A/B testing with auto-winner, and conditional (branching) sequences.

-- Branching rules and A/B test config live on the main step row (variant_of_step_id IS NULL).
-- branching: {"rules":[{"when":[condition...],"match":"all"|"any","then":action}],"else":action,"check_after_days":3,"max_visits":3}
-- ab_test:   {"enabled":true,"metric":"reply_rate",...}; NULL = defaults (auto-winner on reply rate).
ALTER TABLE sequence_steps ADD COLUMN branching TEXT;
ALTER TABLE sequence_steps ADD COLUMN ab_test TEXT;
ALTER TABLE sequence_steps ADD COLUMN ab_winner_step_id INTEGER;
ALTER TABLE sequence_steps ADD COLUMN ab_decided_at TEXT;

-- Branch state per lead. next_step NULL = current_step + 1 (the linear default).
ALTER TABLE campaign_leads ADD COLUMN next_step INTEGER;
-- {"visits":{"2":1},"resolved":"<step>@<last_sent_at>"}
ALTER TABLE campaign_leads ADD COLUMN seq_state TEXT NOT NULL DEFAULT '{}';

-- Every branch decision taken for a lead: which rule matched and what happened.
CREATE TABLE sequence_path_events (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  campaign_lead_id INTEGER REFERENCES campaign_leads(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL,
  from_step INTEGER NOT NULL,        -- step whose rules were evaluated
  rule_index INTEGER,                -- NULL = the "else" branch / a guard
  action TEXT NOT NULL,              -- JSON action that was applied
  target_step INTEGER,               -- step that goes out next (NULL = none)
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX sequence_path_lead ON sequence_path_events (campaign_lead_id, id);

-- A/B test decisions (auto or manual) with the stats they were based on.
CREATE TABLE ab_test_decisions (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step_id INTEGER NOT NULL,          -- main step row
  step_order INTEGER NOT NULL,
  winner_step_id INTEGER NOT NULL,
  decided_by TEXT NOT NULL CHECK (decided_by IN ('auto','manual')),
  metric TEXT NOT NULL,
  p_value REAL,
  confidence REAL,
  stats TEXT NOT NULL DEFAULT '[]',          -- JSON per-variant stats at decision time
  deactivated_ids TEXT NOT NULL DEFAULT '[]', -- variants switched off by this decision (restored on reset)
  note TEXT NOT NULL DEFAULT '',
  reset_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ab_test_decisions_campaign ON ab_test_decisions (campaign_id, step_id);

-- Mailbox provider of recipient domains, from MX records. provider NULL = lookup pending.
CREATE TABLE email_provider_cache (
  domain TEXT PRIMARY KEY COLLATE NOCASE,
  provider TEXT CHECK (provider IN ('google','microsoft','other')),
  mx TEXT,
  checked_at TEXT
);
