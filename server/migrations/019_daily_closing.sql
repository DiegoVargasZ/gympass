ALTER TABLE settings ADD COLUMN closing_time TEXT DEFAULT NULL
  CHECK(closing_time IS NULL OR (
    length(closing_time)=5 AND closing_time GLOB '[0-2][0-9]:[0-5][0-9]'
    AND CAST(substr(closing_time,1,2) AS INTEGER) <= 23
  ));
