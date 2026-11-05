-- Un socio solo puede tener un plan en curso. La regla amigable vive en lib/pos.ts; este
-- seguro impide solapes aunque dos cobros lleguen a la vez. No toca membresías ya vendidas.
ALTER TABLE pos_sales ADD COLUMN replace_reason TEXT;
CREATE TRIGGER pos_one_plan BEFORE INSERT ON pos_memberships BEGIN
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM pos_memberships m
  WHERE m.person_id=NEW.person_id AND m.status='active' AND m.id<>NEW.id
   AND ((m.unit<>'sessions' AND m.end_date>NEW.start_date) OR (m.unit='sessions' AND m.sessions_remaining>0))
 ) THEN RAISE(ABORT,'POS_ACTIVE_PLAN') END;
END;
