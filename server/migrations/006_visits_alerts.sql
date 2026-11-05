-- Visits are pre-registered by a host and become a real movement only at check-in.
CREATE TABLE IF NOT EXISTS visits(
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id),
  host_email TEXT NOT NULL,
  host_name TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  expected_date TEXT NOT NULL,
  expected_from TEXT NOT NULL,
  expected_to TEXT NOT NULL,
  zone_id TEXT NOT NULL REFERENCES zones(id),
  status TEXT NOT NULL DEFAULT 'expected' CHECK(status IN('expected','checked_in','checked_out','cancelled')),
  credential_id TEXT REFERENCES credentials(id),
  consent_at INTEGER,
  checked_in_at INTEGER,
  checked_out_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS visits_date ON visits(expected_date, status);
CREATE INDEX IF NOT EXISTS visits_person ON visits(person_id);

-- Documents that must never be granted access, checked at the moment of the decision.
CREATE TABLE IF NOT EXISTS blocklist(
  document TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL
);

-- Alerts are derived from live state; only the per-user "seen" mark is stored.
CREATE TABLE IF NOT EXISTS alert_reads(
  user_id TEXT NOT NULL,
  alert_key TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, alert_key)
);

-- A named set of report filters, private to the user who saved it.
CREATE TABLE IF NOT EXISTS saved_reports(
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  query TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS saved_reports_owner ON saved_reports(owner, kind);
