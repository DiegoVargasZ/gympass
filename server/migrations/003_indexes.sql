CREATE INDEX events_person_time ON events(person_id, occurred_at DESC);
CREATE INDEX events_zone_date ON events(zone_id, local_date);
CREATE INDEX events_allowed_date ON events(allowed, local_date);
CREATE INDEX people_name ON people(name);
CREATE INDEX audit_time ON audit(occurred_at DESC);
