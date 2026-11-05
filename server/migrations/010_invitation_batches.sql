CREATE TABLE invitation_batches(
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  expected_date TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 1000),
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL
);
ALTER TABLE visits ADD COLUMN batch_id TEXT REFERENCES invitation_batches(id);
ALTER TABLE visits ADD COLUMN ticket_number INTEGER;
CREATE UNIQUE INDEX visits_batch_ticket ON visits(batch_id,ticket_number) WHERE batch_id IS NOT NULL;
CREATE INDEX invitation_batches_date ON invitation_batches(expected_date,created_at);
