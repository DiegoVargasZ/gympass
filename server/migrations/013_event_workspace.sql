ALTER TABLE invitation_batches ADD COLUMN archived_at INTEGER;
ALTER TABLE invitation_batches ADD COLUMN background_x REAL NOT NULL DEFAULT 50;
ALTER TABLE invitation_batches ADD COLUMN background_y REAL NOT NULL DEFAULT 50;
ALTER TABLE invitation_batches ADD COLUMN background_zoom REAL NOT NULL DEFAULT 1;
ALTER TABLE invitation_batches ADD COLUMN background_shade REAL NOT NULL DEFAULT 0.85;
ALTER TABLE invitation_batches ADD COLUMN logo_data TEXT NOT NULL DEFAULT '';
ALTER TABLE invitation_batches ADD COLUMN background_ratio REAL NOT NULL DEFAULT 0.6304347826086957;
ALTER TABLE visits ADD COLUMN background_ratio REAL NOT NULL DEFAULT 0.6304347826086957;
ALTER TABLE visits ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK(delivery_status IN('pending','sent','delivered'));
CREATE TABLE invitation_operations(
  id TEXT PRIMARY KEY,request_key TEXT NOT NULL UNIQUE,batch_id TEXT NOT NULL REFERENCES invitation_batches(id),
  payload_hash TEXT NOT NULL,created_at INTEGER NOT NULL
);
CREATE TABLE invitation_templates(
  id TEXT PRIMARY KEY,name TEXT NOT NULL,design TEXT NOT NULL,background_path TEXT,
  created_at INTEGER NOT NULL,created_by TEXT NOT NULL
);
CREATE INDEX invitation_event_dates ON invitation_batches(archived_at,expected_date);

-- Manual movements and automatic closures carry person_id, without a credential_id.
DROP TRIGGER exit_reentry_invitation;
CREATE TRIGGER exit_reentry_invitation AFTER INSERT ON events
WHEN NEW.allowed=1 AND NEW.direction='exit'
BEGIN
  UPDATE visits SET checked_out_at=NEW.occurred_at,status=CASE WHEN access_mode='reentry' THEN 'expected' ELSE 'checked_out' END
    WHERE person_id=NEW.person_id AND zone_id=NEW.zone_id
      AND status='checked_in';
END;

UPDATE visits SET
  checked_out_at=(SELECT occurred_at FROM events e WHERE e.person_id=visits.person_id AND e.zone_id=visits.zone_id AND e.allowed=1 ORDER BY e.id DESC LIMIT 1),
  status=CASE WHEN access_mode='reentry' THEN 'expected' ELSE 'checked_out' END
WHERE status='checked_in' AND (SELECT direction FROM events e WHERE e.person_id=visits.person_id AND e.zone_id=visits.zone_id AND e.allowed=1 ORDER BY e.id DESC LIMIT 1)='exit';
CREATE TRIGGER manual_invitation_entry AFTER INSERT ON events
WHEN NEW.allowed=1 AND NEW.direction='entry' AND NEW.credential_id IS NULL
BEGIN
  UPDATE visits SET used_at=COALESCE(used_at,NEW.occurred_at),checked_in_at=NEW.occurred_at,
    checked_out_at=NULL,status='checked_in'
    WHERE person_id=NEW.person_id AND zone_id=NEW.zone_id AND expected_date=NEW.local_date
      AND status='expected' AND (used_at IS NULL OR access_mode='reentry');
END;
