-- Baja lógica de fichas: la persona desaparece del directorio y deja de autorizar
-- accesos, pero conserva su historial de eventos, asistencia, planes y cobros.
ALTER TABLE people ADD COLUMN deleted_at INTEGER;
ALTER TABLE people ADD COLUMN deleted_by TEXT;
CREATE INDEX IF NOT EXISTS people_deleted ON people(deleted_at);

-- Los planes se venden a socios y al personal, nunca a una ficha dada de baja.
-- Un trigger no se puede modificar: se recrea igual salvo esa condición.
DROP TRIGGER IF EXISTS pos_validate_line;
CREATE TRIGGER pos_validate_line BEFORE INSERT ON pos_sale_lines BEGIN
 SELECT CASE WHEN NEW.kind='product' AND NOT EXISTS(
  SELECT 1 FROM pos_products WHERE id=NEW.item_id AND active=1 AND price_cents=NEW.price_cents AND track_stock=NEW.track_stock
 ) THEN RAISE(ABORT,'POS_CATALOG_CHANGED') END;
 SELECT CASE WHEN NEW.kind='plan' AND NOT EXISTS(
  SELECT 1 FROM pos_plans WHERE id=NEW.item_id AND active=1 AND price_cents=NEW.price_cents AND unit=NEW.unit AND duration=NEW.duration
 ) THEN RAISE(ABORT,'POS_CATALOG_CHANGED') END;
 SELECT CASE WHEN NEW.kind='plan' AND NOT EXISTS(
  SELECT 1 FROM pos_sales s JOIN people p ON p.id=s.person_id
  WHERE s.id=NEW.sale_id AND p.kind IN('member','employee') AND p.status='active' AND p.deleted_at IS NULL
 ) THEN RAISE(ABORT,'POS_MEMBER_REQUIRED') END;
 SELECT CASE WHEN NEW.kind='product' AND NEW.track_stock=1 AND (
  SELECT stock FROM pos_products WHERE id=NEW.item_id
 )<NEW.quantity THEN RAISE(ABORT,'POS_STOCK') END;
END;
