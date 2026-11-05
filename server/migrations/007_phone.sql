-- Phone number in E.164-ish form (digits only, country code included), used to open a
-- WhatsApp conversation when a person's authorization is about to expire.
ALTER TABLE people ADD COLUMN phone TEXT NOT NULL DEFAULT '';
