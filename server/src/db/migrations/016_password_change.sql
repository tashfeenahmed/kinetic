-- People added by an admin (or whose password an admin reset) choose their own password at next sign-in.
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
