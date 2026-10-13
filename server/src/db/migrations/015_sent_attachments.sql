-- Files attached to emails sent from the inbox, kept so the conversation shows them.
-- JSON [{filename,size,content_type,path}], like replies.attachments.
ALTER TABLE sent_emails ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
