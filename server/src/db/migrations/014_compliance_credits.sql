-- Compliance layer and paid-credit metering.
--
-- Where each lead's email came from (enrichment provider, page, table), kept with the lead.
ALTER TABLE leads ADD COLUMN source TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN source_detail TEXT NOT NULL DEFAULT '{}';

-- The blacklist doubles as the permanent suppression list: unsubscribes land here with
-- their reason and stay even if the lead is deleted or imported again.
ALTER TABLE blacklisted_emails ADD COLUMN reason TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE blacklisted_emails ADD COLUMN source TEXT NOT NULL DEFAULT '';
INSERT OR IGNORE INTO blacklisted_emails (workspace_id, email, reason, source, created_at)
  SELECT workspace_id, email, 'unsubscribed', 'existing unsubscribe', updated_at FROM leads WHERE status = 'unsubscribed';

-- Credits spent per paid data vendor per calendar month (YYYY-MM).
CREATE TABLE provider_usage (
  provider TEXT NOT NULL,
  month TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  credits REAL NOT NULL DEFAULT 0,
  last_at TEXT,
  PRIMARY KEY (provider, month)
);
