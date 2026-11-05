ALTER TABLE invitation_batches ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'single' CHECK(access_mode IN('single','reentry'));
ALTER TABLE invitation_batches ADD COLUMN card_theme TEXT NOT NULL DEFAULT 'midnight' CHECK(card_theme IN('midnight','minimal','celebration'));
ALTER TABLE invitation_batches ADD COLUMN card_color TEXT NOT NULL DEFAULT '';
ALTER TABLE invitation_batches ADD COLUMN location TEXT NOT NULL DEFAULT '';
ALTER TABLE invitation_batches ADD COLUMN event_time TEXT NOT NULL DEFAULT '';
ALTER TABLE invitation_batches ADD COLUMN message TEXT NOT NULL DEFAULT '';
ALTER TABLE visits ADD COLUMN guest_name TEXT NOT NULL DEFAULT '';
ALTER TABLE visits ADD COLUMN invitation_note TEXT NOT NULL DEFAULT '';
ALTER TABLE visits ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'single' CHECK(access_mode IN('single','reentry'));

DROP TRIGGER consume_invitation;
CREATE TRIGGER consume_invitation AFTER INSERT ON events
WHEN NEW.allowed=1 AND NEW.direction='entry' AND NEW.credential_id IS NOT NULL
BEGIN
  UPDATE visits SET used_at=COALESCE(used_at,NEW.occurred_at),checked_in_at=NEW.occurred_at,checked_out_at=NULL,status='checked_in'
    WHERE credential_id=NEW.credential_id AND status NOT IN('cancelled','checked_out')
      AND (used_at IS NULL OR access_mode='reentry');
END;
CREATE TRIGGER exit_reentry_invitation AFTER INSERT ON events
WHEN NEW.allowed=1 AND NEW.direction='exit' AND NEW.credential_id IS NOT NULL
BEGIN
  UPDATE visits SET checked_out_at=NEW.occurred_at,status='expected'
    WHERE credential_id=NEW.credential_id AND access_mode='reentry' AND status='checked_in';
END;
