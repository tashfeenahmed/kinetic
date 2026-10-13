-- UK share allotments (SH01) captured from the Companies House filing stream, for the
-- "recently funded companies" source. The REST API can't list filings across companies,
-- so a background job keeps the last ~90 days here. The stream position is the
-- `ch_stream_timepoint` setting.
CREATE TABLE funding_uk_filings (
  transaction_id TEXT PRIMARY KEY,
  company_number TEXT NOT NULL,
  filed TEXT,
  capital TEXT, -- JSON [{ figure, currency }] after the allotment
  published_at TEXT NOT NULL
);
CREATE INDEX funding_uk_filings_published ON funding_uk_filings (published_at);
