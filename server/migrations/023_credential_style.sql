ALTER TABLE settings ADD COLUMN credential_color TEXT DEFAULT NULL
  CHECK(credential_color IS NULL OR (length(credential_color)=7 AND credential_color LIKE '#%'));
ALTER TABLE settings ADD COLUMN credential_watermark_size INTEGER NOT NULL DEFAULT 70
  CHECK(credential_watermark_size BETWEEN 10 AND 100);
