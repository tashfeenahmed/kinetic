-- Mailbox health score (0-100) with plain-English reasons, and the bounce/blocklist kill switch.
ALTER TABLE sender_emails ADD COLUMN health_score INTEGER;
ALTER TABLE sender_emails ADD COLUMN health_reasons TEXT NOT NULL DEFAULT '[]';   -- JSON array of strings
ALTER TABLE sender_emails ADD COLUMN health_checked_at TEXT;
ALTER TABLE sender_emails ADD COLUMN paused_reason TEXT;      -- set when Kinetic paused the mailbox itself
ALTER TABLE sender_emails ADD COLUMN resumed_at TEXT;         -- last manual resume: older bounces/listings no longer pause it

ALTER TABLE workspaces ADD COLUMN auto_pause_senders INTEGER NOT NULL DEFAULT 1;

-- DNS lookups for health (blocklists per domain/IP, SPF/DKIM/DMARC per domain), refreshed about every 12 hours.
CREATE TABLE health_dns_cache (
  key TEXT PRIMARY KEY,          -- 'bl:<domain or ip>' or 'auth:<domain>'
  value TEXT NOT NULL,           -- JSON
  listed_since TEXT,             -- blocklists: when a listing was first seen (kept while it lasts)
  checked_at TEXT NOT NULL
);
