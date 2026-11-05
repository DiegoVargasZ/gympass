CREATE TABLE pos_products(
 id TEXT PRIMARY KEY,name TEXT NOT NULL,sku TEXT NOT NULL DEFAULT '',category TEXT NOT NULL DEFAULT '',
 price_cents INTEGER NOT NULL CHECK(price_cents>=0),stock INTEGER NOT NULL DEFAULT 0 CHECK(stock>=0),
 track_stock INTEGER NOT NULL DEFAULT 1 CHECK(track_stock IN(0,1)),active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1))
);
CREATE UNIQUE INDEX pos_product_sku ON pos_products(sku) WHERE sku<>'';
CREATE TABLE pos_plans(
 id TEXT PRIMARY KEY,name TEXT NOT NULL,unit TEXT NOT NULL CHECK(unit IN('days','months','sessions')),
 duration INTEGER NOT NULL CHECK(duration>0),price_cents INTEGER NOT NULL CHECK(price_cents>=0),active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1))
);
CREATE TABLE pos_sales(
 id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,payload_hash TEXT NOT NULL,person_id TEXT REFERENCES people(id),person_name TEXT,
 actor TEXT NOT NULL,created_at INTEGER NOT NULL,local_date TEXT NOT NULL,start_date TEXT NOT NULL,
 payment_method TEXT NOT NULL CHECK(payment_method IN('cash','transfer','card')),currency TEXT NOT NULL DEFAULT 'BOB',
 total_cents INTEGER NOT NULL CHECK(total_cents>=0),status TEXT NOT NULL DEFAULT 'paid' CHECK(status IN('paid','void')),
 void_reason TEXT,void_at INTEGER,void_by TEXT,void_local_date TEXT
);
CREATE INDEX pos_sales_date ON pos_sales(local_date,created_at);
CREATE INDEX pos_sales_person ON pos_sales(person_id,created_at);
CREATE TABLE pos_sale_lines(
 id TEXT PRIMARY KEY,sale_id TEXT NOT NULL REFERENCES pos_sales(id),kind TEXT NOT NULL CHECK(kind IN('product','plan')),
 item_id TEXT NOT NULL,name TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity>0),price_cents INTEGER NOT NULL CHECK(price_cents>=0),
 total_cents INTEGER NOT NULL CHECK(total_cents=quantity*price_cents),track_stock INTEGER NOT NULL DEFAULT 0,unit TEXT,duration INTEGER
);
CREATE INDEX pos_lines_sale ON pos_sale_lines(sale_id);
CREATE TABLE pos_stock_movements(
 id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES pos_products(id),quantity INTEGER NOT NULL,
 reason TEXT NOT NULL,actor TEXT NOT NULL,created_at INTEGER NOT NULL,sale_id TEXT REFERENCES pos_sales(id)
);
CREATE TABLE pos_memberships(
 id TEXT PRIMARY KEY,sale_id TEXT NOT NULL REFERENCES pos_sales(id),line_id TEXT NOT NULL REFERENCES pos_sale_lines(id),
 person_id TEXT NOT NULL REFERENCES people(id),name TEXT NOT NULL,unit TEXT NOT NULL,duration INTEGER NOT NULL,price_cents INTEGER NOT NULL,
 start_date TEXT NOT NULL,end_date TEXT,sessions_total INTEGER,sessions_remaining INTEGER CHECK(sessions_remaining>=0),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','void')),created_at INTEGER NOT NULL
);
CREATE INDEX pos_memberships_person ON pos_memberships(person_id,status,start_date,end_date);
CREATE TABLE pos_membership_uses(event_id INTEGER PRIMARY KEY REFERENCES events(id),membership_id TEXT NOT NULL REFERENCES pos_memberships(id));
CREATE INDEX pos_membership_use_membership ON pos_membership_uses(membership_id);

CREATE TRIGGER pos_validate_line BEFORE INSERT ON pos_sale_lines BEGIN
 SELECT CASE WHEN NEW.kind='product' AND NOT EXISTS(
  SELECT 1 FROM pos_products WHERE id=NEW.item_id AND active=1 AND price_cents=NEW.price_cents AND track_stock=NEW.track_stock
 ) THEN RAISE(ABORT,'POS_CATALOG_CHANGED') END;
 SELECT CASE WHEN NEW.kind='plan' AND NOT EXISTS(
  SELECT 1 FROM pos_plans WHERE id=NEW.item_id AND active=1 AND price_cents=NEW.price_cents AND unit=NEW.unit AND duration=NEW.duration
 ) THEN RAISE(ABORT,'POS_CATALOG_CHANGED') END;
 SELECT CASE WHEN NEW.kind='plan' AND NOT EXISTS(
  SELECT 1 FROM pos_sales s JOIN people p ON p.id=s.person_id WHERE s.id=NEW.sale_id AND p.kind='member' AND p.status='active'
 ) THEN RAISE(ABORT,'POS_MEMBER_REQUIRED') END;
 SELECT CASE WHEN NEW.kind='product' AND NEW.track_stock=1 AND (
  SELECT stock FROM pos_products WHERE id=NEW.item_id
 )<NEW.quantity THEN RAISE(ABORT,'POS_STOCK') END;
END;
CREATE TRIGGER pos_product_sale AFTER INSERT ON pos_sale_lines WHEN NEW.kind='product' AND NEW.track_stock=1 BEGIN
 UPDATE pos_products SET stock=stock-NEW.quantity WHERE id=NEW.item_id;
 INSERT INTO pos_stock_movements(id,product_id,quantity,reason,actor,created_at,sale_id)
 SELECT NEW.id,NEW.item_id,-NEW.quantity,'Venta',actor,created_at,id FROM pos_sales WHERE id=NEW.sale_id;
END;
CREATE TRIGGER pos_validate_void BEFORE UPDATE OF status ON pos_sales WHEN OLD.status='paid' AND NEW.status='void' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pos_memberships m WHERE m.sale_id=OLD.id AND (
  (m.unit<>'sessions' AND m.start_date<=NEW.void_local_date)
  OR m.sessions_remaining<m.sessions_total OR EXISTS(SELECT 1 FROM pos_membership_uses u WHERE u.membership_id=m.id)
 )) THEN RAISE(ABORT,'POS_STARTED') END;
END;
CREATE TRIGGER pos_void_sale AFTER UPDATE OF status ON pos_sales WHEN OLD.status='paid' AND NEW.status='void' BEGIN
 UPDATE pos_products SET stock=stock+COALESCE((SELECT SUM(l.quantity) FROM pos_sale_lines l WHERE l.sale_id=NEW.id AND l.kind='product' AND l.track_stock=1 AND l.item_id=pos_products.id),0)
 WHERE id IN(SELECT item_id FROM pos_sale_lines WHERE sale_id=NEW.id AND kind='product' AND track_stock=1);
 INSERT INTO pos_stock_movements(id,product_id,quantity,reason,actor,created_at,sale_id)
 SELECT 'void:'||id,item_id,quantity,NEW.void_reason,NEW.void_by,NEW.void_at,NEW.id FROM pos_sale_lines WHERE sale_id=NEW.id AND kind='product' AND track_stock=1;
 UPDATE pos_memberships SET status='void' WHERE sale_id=NEW.id;
END;
CREATE TRIGGER pos_access_use AFTER INSERT ON events
WHEN NEW.allowed=1 AND NEW.direction='entry' AND NEW.zone_id='general' AND EXISTS(SELECT 1 FROM people WHERE id=NEW.person_id AND kind='member') BEGIN
 INSERT INTO pos_membership_uses(event_id,membership_id)
 SELECT NEW.id,id FROM pos_memberships WHERE person_id=NEW.person_id AND status='active' AND start_date<=NEW.local_date
  AND ((unit<>'sessions' AND end_date>NEW.local_date) OR (unit='sessions' AND sessions_remaining>0))
 ORDER BY CASE WHEN unit='sessions' THEN 1 ELSE 0 END,created_at,rowid LIMIT 1;
 UPDATE pos_memberships SET sessions_remaining=sessions_remaining-1 WHERE unit='sessions' AND id=(SELECT membership_id FROM pos_membership_uses WHERE event_id=NEW.id);
END;
