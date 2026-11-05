-- Keep the old tables and labels for historical reports. New operations use one built-in entrance.
INSERT OR IGNORE INTO zones(id,name,description,capacity,active)
  VALUES('general','Acceso general','',0,1);
INSERT OR IGNORE INTO person_zones(person_id,zone_id) SELECT id,'general' FROM people;
UPDATE people SET schedule_id=NULL;
UPDATE devices SET zone_id='general';
-- Retain every historical movement and its original display label, with a single presence state.
UPDATE events SET zone_id='general';
UPDATE visits SET zone_id='general';

ALTER TABLE visits ADD COLUMN used_at INTEGER;
ALTER TABLE events ADD COLUMN credential_id TEXT REFERENCES credentials(id);
CREATE UNIQUE INDEX visits_credential ON visits(credential_id) WHERE credential_id IS NOT NULL;
CREATE INDEX events_credential ON events(credential_id) WHERE credential_id IS NOT NULL;
-- Old visits marked as arrived must never acquire a second admission after the upgrade.
UPDATE visits SET used_at=COALESCE(checked_in_at,created_at) WHERE status IN('checked_in','checked_out');

-- The scan and consumption commit together. Concurrent requests and retries cannot reuse a pass.
CREATE TRIGGER consume_invitation AFTER INSERT ON events
WHEN NEW.allowed=1 AND NEW.direction='entry' AND NEW.credential_id IS NOT NULL
BEGIN
  UPDATE visits SET used_at=NEW.occurred_at,checked_in_at=NEW.occurred_at,status='checked_in'
    WHERE credential_id=NEW.credential_id AND used_at IS NULL;
END;
