-- An ambiguous login refusal (Outlook's bare "Login failed.") is only treated as a disconnect when it repeats.
ALTER TABLE sender_emails ADD COLUMN auth_failed_at TEXT;
-- Failed AI reply sorting is retried a few times with a pause between tries.
ALTER TABLE replies ADD COLUMN ai_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE replies ADD COLUMN ai_failed_at TEXT;
-- A failed alert digest is retried (other mailboxes, later in the day) instead of dropping the day's alerts.
ALTER TABLE alert_digest_runs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
