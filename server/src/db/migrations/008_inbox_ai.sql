-- AI reply sorting (fine-grained reply labels, background classification queue)
-- and lead filters by email stats (a lead_stats table kept current by triggers).

-- ---- master inbox AI settings ----
ALTER TABLE workspaces ADD COLUMN ai_reply_sorting INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workspaces ADD COLUMN ai_reply_model TEXT;             -- NULL = AI_MODEL setting / Haiku
ALTER TABLE workspaces ADD COLUMN ai_auto_unsubscribe INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workspaces ADD COLUMN ai_pause_on_ooo INTEGER NOT NULL DEFAULT 1;

-- ---- reply labels ----
-- `category` keeps the coarse EmailBison-compatible value (interested, not_interested, unsubscribe, ...);
-- `label` is the fine-grained one (meeting_request, objection, out_of_office, ...).
ALTER TABLE replies ADD COLUMN label TEXT;
ALTER TABLE replies ADD COLUMN label_source TEXT NOT NULL DEFAULT 'rules';  -- rules | ai | manual
ALTER TABLE replies ADD COLUMN ai_status TEXT;          -- pending | refresh | done | failed (NULL = not queued)
ALTER TABLE replies ADD COLUMN ai_confidence REAL;
ALTER TABLE replies ADD COLUMN ai_summary TEXT;
ALTER TABLE replies ADD COLUMN ai_next_action TEXT;
ALTER TABLE replies ADD COLUMN ai_details TEXT;         -- JSON {objection_type, referral, return_date}
ALTER TABLE replies ADD COLUMN ai_model TEXT;
ALTER TABLE replies ADD COLUMN ai_error TEXT;
ALTER TABLE replies ADD COLUMN ai_classified_at TEXT;
UPDATE replies SET label = category;
CREATE INDEX replies_label ON replies (workspace_id, label);
CREATE INDEX replies_ai_queue ON replies (ai_status) WHERE ai_status IN ('pending', 'refresh');
CREATE INDEX replies_lead ON replies (lead_id);

-- Classification results by message content + model, so the same text is never paid for twice.
CREATE TABLE reply_ai_cache (
  key TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---- per-lead email stats ----
CREATE TABLE lead_stats (
  lead_id INTEGER PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  workspace_id INTEGER NOT NULL,
  emails_sent INTEGER NOT NULL DEFAULT 0,
  opens INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,       -- human replies (not automated, not bounces)
  bounced INTEGER NOT NULL DEFAULT 0,
  last_sent_at TEXT,
  last_opened_at TEXT,
  last_clicked_at TEXT,
  last_replied_at TEXT
);
CREATE INDEX lead_stats_ws_sent ON lead_stats (workspace_id, last_sent_at);

INSERT INTO lead_stats (lead_id, workspace_id, emails_sent, opens, clicks, bounced, last_sent_at, last_opened_at, last_clicked_at, replies, last_replied_at)
SELECT l.id, l.workspace_id, COALESCE(s.n, 0), COALESCE(s.o, 0), COALESCE(s.c, 0), COALESCE(s.b, 0), s.last, s.lo, ev.lc, COALESCE(r.n, 0), r.last
FROM leads l
LEFT JOIN (SELECT lead_id, COUNT(*) n, SUM(opens) o, SUM(clicks) c, MAX(bounced) b, MAX(sent_at) last, MAX(first_opened_at) lo
           FROM sent_emails WHERE lead_id IS NOT NULL AND kind != 'test' GROUP BY lead_id) s ON s.lead_id = l.id
LEFT JOIN (SELECT lead_id, COUNT(*) n, MAX(received_at) last FROM replies
           WHERE lead_id IS NOT NULL AND automated = 0 AND folder != 'bounced' GROUP BY lead_id) r ON r.lead_id = l.id
LEFT JOIN (SELECT lead_id, MAX(created_at) lc FROM events WHERE type = 'LINK_CLICKED' AND lead_id IS NOT NULL GROUP BY lead_id) ev ON ev.lead_id = l.id;

CREATE TRIGGER lead_stats_lead_insert AFTER INSERT ON leads BEGIN
  INSERT OR IGNORE INTO lead_stats (lead_id, workspace_id) VALUES (NEW.id, NEW.workspace_id);
END;

CREATE TRIGGER lead_stats_sent_insert AFTER INSERT ON sent_emails WHEN NEW.lead_id IS NOT NULL AND NEW.kind != 'test' BEGIN
  UPDATE lead_stats SET emails_sent = emails_sent + 1, opens = opens + NEW.opens, clicks = clicks + NEW.clicks,
    bounced = MAX(bounced, NEW.bounced), last_sent_at = MAX(COALESCE(last_sent_at, ''), NEW.sent_at)
  WHERE lead_id = NEW.lead_id;
END;

CREATE TRIGGER lead_stats_sent_update AFTER UPDATE OF opens, clicks, bounced, lead_id, kind, sent_at ON sent_emails BEGIN
  UPDATE lead_stats SET (emails_sent, opens, clicks, bounced, last_sent_at) = (
    SELECT COUNT(*), COALESCE(SUM(s.opens), 0), COALESCE(SUM(s.clicks), 0), COALESCE(MAX(s.bounced), 0), MAX(s.sent_at)
    FROM sent_emails s WHERE s.lead_id = lead_stats.lead_id AND s.kind != 'test')
  WHERE lead_id IN (OLD.lead_id, NEW.lead_id);
END;

CREATE TRIGGER lead_stats_sent_opened AFTER UPDATE OF opens ON sent_emails WHEN NEW.opens > OLD.opens AND NEW.lead_id IS NOT NULL BEGIN
  UPDATE lead_stats SET last_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE lead_id = NEW.lead_id;
END;

CREATE TRIGGER lead_stats_sent_clicked AFTER UPDATE OF clicks ON sent_emails WHEN NEW.clicks > OLD.clicks AND NEW.lead_id IS NOT NULL BEGIN
  UPDATE lead_stats SET last_clicked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE lead_id = NEW.lead_id;
END;

CREATE TRIGGER lead_stats_sent_delete AFTER DELETE ON sent_emails WHEN OLD.lead_id IS NOT NULL BEGIN
  UPDATE lead_stats SET (emails_sent, opens, clicks, bounced, last_sent_at) = (
    SELECT COUNT(*), COALESCE(SUM(s.opens), 0), COALESCE(SUM(s.clicks), 0), COALESCE(MAX(s.bounced), 0), MAX(s.sent_at)
    FROM sent_emails s WHERE s.lead_id = lead_stats.lead_id AND s.kind != 'test')
  WHERE lead_id = OLD.lead_id;
END;

CREATE TRIGGER lead_stats_reply_insert AFTER INSERT ON replies WHEN NEW.lead_id IS NOT NULL BEGIN
  UPDATE lead_stats SET (replies, last_replied_at) = (
    SELECT COUNT(*), MAX(r.received_at) FROM replies r WHERE r.lead_id = lead_stats.lead_id AND r.automated = 0 AND r.folder != 'bounced')
  WHERE lead_id = NEW.lead_id;
END;

CREATE TRIGGER lead_stats_reply_update AFTER UPDATE OF lead_id, automated, folder ON replies BEGIN
  UPDATE lead_stats SET (replies, last_replied_at) = (
    SELECT COUNT(*), MAX(r.received_at) FROM replies r WHERE r.lead_id = lead_stats.lead_id AND r.automated = 0 AND r.folder != 'bounced')
  WHERE lead_id IN (OLD.lead_id, NEW.lead_id);
END;

CREATE TRIGGER lead_stats_reply_delete AFTER DELETE ON replies WHEN OLD.lead_id IS NOT NULL BEGIN
  UPDATE lead_stats SET (replies, last_replied_at) = (
    SELECT COUNT(*), MAX(r.received_at) FROM replies r WHERE r.lead_id = lead_stats.lead_id AND r.automated = 0 AND r.folder != 'bounced')
  WHERE lead_id = OLD.lead_id;
END;

-- Mailbox provider of each recipient domain, from its MX records (shared cache).
CREATE TABLE email_domains (
  domain TEXT PRIMARY KEY COLLATE NOCASE,
  provider TEXT NOT NULL,          -- google | microsoft | yahoo | zoho | proofpoint | mimecast | other | none
  mx TEXT,
  checked_at TEXT NOT NULL
);

-- Saved lead filters ("views") on the Leads page.
CREATE TABLE lead_views (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  filters TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX lead_views_ws ON lead_views (workspace_id);
