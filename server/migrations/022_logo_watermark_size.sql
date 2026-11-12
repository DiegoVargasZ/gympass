ALTER TABLE settings ADD COLUMN logo_watermark_size INTEGER NOT NULL DEFAULT 45
  CHECK(logo_watermark_size BETWEEN 10 AND 100);
