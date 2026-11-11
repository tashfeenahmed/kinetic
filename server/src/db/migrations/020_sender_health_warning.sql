-- With auto-pause off, a mailbox whose bounce or blocklist trigger fires keeps sending and carries this warning instead.
-- Cleared once the trigger no longer holds. New workspaces now default to warnings (auto_pause_senders = 0).
ALTER TABLE sender_emails ADD COLUMN health_warning TEXT;
