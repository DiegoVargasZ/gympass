ALTER TABLE credentials ADD COLUMN code_cipher TEXT;

CREATE TABLE renewal_contacts (
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  expires TEXT NOT NULL,
  notified_at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  PRIMARY KEY(person_id, expires)
);

UPDATE settings SET brand_color='#2563eb' WHERE brand_color='#1b654b';
