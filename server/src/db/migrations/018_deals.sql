-- Deal pipeline: one deal per lead, opened by positive replies (interested → meeting)
-- and moved by hand through proposal → won | lost. See engine/deals.ts.

CREATE TABLE deals (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  -- The reply that opened the deal.
  reply_id INTEGER REFERENCES replies(id) ON DELETE SET NULL,
  -- interested | meeting | proposal | won | lost
  stage TEXT NOT NULL DEFAULT 'interested',
  value REAL,
  currency TEXT,
  lost_reason TEXT,
  notes TEXT,
  -- First time the deal reached "meeting" or later (for meeting counts in stats).
  meeting_at TEXT,
  stage_changed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX deals_lead ON deals (workspace_id, lead_id);
CREATE INDEX deals_stage ON deals (workspace_id, stage);
