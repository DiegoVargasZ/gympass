-- Only records already present during migration retain indefinite legacy access.
ALTER TABLE people ADD COLUMN legacy_access INTEGER NOT NULL DEFAULT 0 CHECK(legacy_access IN (0,1));
UPDATE people SET legacy_access=1 WHERE kind='member';
