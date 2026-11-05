-- Shift tolerance: minutes allowed after the start and before the end before a day counts
-- as late or as an early departure.
ALTER TABLE schedules ADD COLUMN grace_in INTEGER NOT NULL DEFAULT 10 CHECK(grace_in BETWEEN 0 AND 240);
ALTER TABLE schedules ADD COLUMN grace_out INTEGER NOT NULL DEFAULT 10 CHECK(grace_out BETWEEN 0 AND 240);

-- Days that must not count as an absence. person_id NULL applies to the whole organization.
CREATE TABLE IF NOT EXISTS calendar_exceptions(
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN('holiday','vacation','leave','rest')),
  label TEXT NOT NULL,
  person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_unique ON calendar_exceptions(date, COALESCE(person_id, ''));
CREATE INDEX IF NOT EXISTS calendar_date ON calendar_exceptions(date);

-- A closed month is frozen: the payroll figures it produced must not change afterwards.
CREATE TABLE IF NOT EXISTS attendance_periods(
  month TEXT PRIMARY KEY,
  closed_at INTEGER NOT NULL,
  closed_by TEXT NOT NULL
);
