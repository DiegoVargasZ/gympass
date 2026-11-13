import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { SqliteDatabase, migrateDatabase } from '../server/database.ts';
import { Service } from '../lib/service.ts';
import { PosService } from '../lib/pos.ts';
import { legacyProductCostTable, upgradeManagementSnapshot, type SyncSnapshot } from '../lib/replication.ts';
import { replicaTables } from '../server/replication.ts';
import { reportCsv, reportPrintHtml, marginMoney } from '../src/pos-report-export.ts';

function fixture(t: { after(fn: () => void): void }) {
  const db = new SqliteDatabase(':memory:');
  t.after(() => db.close());
  db.raw.exec("INSERT INTO settings(id,owner,name,timezone) VALUES(1,'owner','Gym','America/La_Paz')");
  const service = new Service(db, { id: 'owner', email: 'owner@test.test', name: 'Admin', role: 'admin' });
  const pos = new PosService(service);
  const buy = (id: string, quantity = 1, request_id = crypto.randomUUID()) => pos.checkout({ request_id, payment_method: 'cash', lines: [{ kind: 'product', id, quantity }] });
  const report = async () => { const today = await pos.today(); return pos.report(new URLSearchParams({ from: today, to: today })); };
  return { db, service, pos, buy, report };
}

test('costos: guarda enteros, acepta cero y conserva costo y código antiguos cuando se omiten', async t => {
  const { pos } = fixture(t);
  const product = await pos.saveProduct({ name: 'Agua', price_cents: 500, cost_cents: 250, sku: 'ANTIGUO' });
  assert.equal(product.cost_cents, 250);
  const updated = await pos.saveProduct({ name: 'Agua nueva', price_cents: 600 }, product.id);
  assert.equal(updated.cost_cents, 250);
  assert.equal(updated.sku, 'ANTIGUO');
  assert.equal((await pos.saveProduct({ name: 'Gratis', price_cents: 100, cost_cents: 0 })).cost_cents, 0);
  assert.equal((await pos.saveProduct({ name: 'Anterior', price_cents: 100 })).cost_cents, null);
  for (const cost of [-1, 1.5, 1000000001, '2.50', NaN, Infinity])
    await assert.rejects(pos.saveProduct({ name: 'Inválido', price_cents: 500, cost_cents: cost }));
});

test('cada venta conserva su costo histórico, incluso después de editar, reintentar y anular', async t => {
  const { pos, buy, report } = fixture(t);
  const product = await pos.saveProduct({ name: 'Agua', price_cents: 500, cost_cents: 200, stock: 20 });
  const request = crypto.randomUUID();
  const first = await buy(product.id, 3, request);
  assert.equal(first.lines[0].cost_cents, 200);
  await pos.saveProduct({ name: 'Agua', price_cents: 600, cost_cents: 350 }, product.id);
  const retried = await buy(product.id, 3, request);
  assert.equal(retried.id, first.id);
  assert.equal(retried.lines[0].cost_cents, 200);
  const second = await buy(product.id, 2);
  let margin = (await report()).summary.product_margin!;
  assert.deepEqual({ ...margin }, { quantity: 5, revenue_cents: 2700, cost_cents: 1300, profit_cents: 1400, missing_cost_quantity: 0 });
  await pos.voidSale(second.id, { reason: 'Cobro equivocado' });
  margin = (await report()).summary.product_margin!;
  assert.deepEqual({ ...margin }, { quantity: 3, revenue_cents: 1500, cost_cents: 600, profit_cents: 900, missing_cost_quantity: 0 });
  assert.equal((await pos.sale(first.id)).lines[0].cost_cents, 200);
});

test('el costo se toma al registrar la venta, aunque cambie después de consultar el catálogo', async t => {
  const { db, service, pos, buy } = fixture(t);
  const product = await pos.saveProduct({ name: 'Agua', price_cents: 500, cost_cents: 200, stock: 5 });
  const original = service.one.bind(service);
  t.mock.method(service, 'one', async (sql: string, ...args: any[]) => {
    const row = await original(sql, ...args);
    if (sql === 'SELECT * FROM pos_products WHERE id=?')
      db.raw.prepare('UPDATE pos_products SET cost_cents=300 WHERE id=?').run(product.id);
    return row;
  });
  const sale = await buy(product.id);
  assert.equal(sale.lines[0].cost_cents, 300);
});

test('distingue costos desconocidos, costo cero y pérdidas sin alterar los ingresos', async t => {
  const { pos, buy, report } = fixture(t);
  const unknown = await pos.saveProduct({ name: 'Anterior', price_cents: 500, track_stock: 0 });
  const free = await pos.saveProduct({ name: 'Obsequio', price_cents: 100, cost_cents: 0, track_stock: 0 });
  const loss = await pos.saveProduct({ name: 'Liquidación', price_cents: 200, cost_cents: 300, track_stock: 0 });
  await buy(unknown.id, 2); await buy(free.id); await buy(loss.id);
  await pos.saveProduct({ name: 'Anterior', price_cents: 500, cost_cents: 250, track_stock: 0 }, unknown.id);
  const data = await report();
  assert.equal(data.summary.total_cents, 1300);
  assert.deepEqual({ ...data.summary.product_margin }, { quantity: 4, revenue_cents: 1300, cost_cents: 300, profit_cents: 0, missing_cost_quantity: 2 });
  const unknownMargin = data.products.find(row => row.item_id === unknown.id)!.margin!;
  assert.equal(marginMoney(unknownMargin, 'cost_cents'), 'Sin registrar');
  assert.equal(marginMoney(unknownMargin, 'profit_cents'), 'Sin registrar');
  assert.match(marginMoney(data.summary.product_margin, 'profit_cents'), /parcial/);
  assert.equal(data.products.find(row => row.item_id === loss.id)!.margin!.profit_cents, -100);
  assert.match(reportCsv(data), /unidades sin costo registrado/);
  assert.match(reportPrintHtml(data, 'Gym'), /Ganancia pendiente de calcular/);
});

test('la ganancia de productos excluye planes y suma también los productos fuera del ranking', async t => {
  const { pos, service, buy, report } = fixture(t);
  for (let i = 0; i < 22; i++) {
    const product = await pos.saveProduct({ name: 'Producto ' + i, price_cents: 500, cost_cents: 200, track_stock: 0 });
    await buy(product.id);
  }
  const person = await service.savePerson({ name: 'Socio', document: 'COST', phone: '59171234567', kind: 'member', status: 'active' });
  const plan = await pos.savePlan({ name: 'Mes', price_cents: 20000, unit: 'months', duration: 1 });
  const sale = await pos.checkout({ request_id: crypto.randomUUID(), person_id: person.id, payment_method: 'cash', lines: [{ kind: 'plan', id: plan.id, quantity: 1 }] });
  assert.equal(sale.lines[0].cost_cents, null);
  const data = await report();
  assert.equal(data.products.length, 20);
  assert.equal(data.summary.total_cents, 31000);
  assert.deepEqual({ ...data.summary.product_margin }, { quantity: 22, revenue_cents: 11000, cost_cents: 4400, profit_cents: 6600, missing_cost_quantity: 0 });
  assert.match(reportCsv(data), /"Productos · ganancia bruta","22","66\.00"/);
});

test('migración 25 conserva productos y ventas anteriores con costo desconocido', () => {
  const raw = new DatabaseSync(':memory:');
  try {
    const directory = new URL('../server/migrations/', import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name) && name < '025').sort()) {
      raw.exec(readFileSync(new URL(name, directory), 'utf8'));
      raw.prepare('INSERT OR IGNORE INTO schema_version VALUES(?)').run(Number(name.slice(0, 3)));
    }
    raw.exec("INSERT INTO pos_products(id,name,sku,price_cents,stock) VALUES('old','Agua','OLD',500,5)");
    raw.exec("INSERT INTO pos_sales(id,request_id,payload_hash,actor,created_at,local_date,start_date,payment_method,total_cents) VALUES('sale','request','hash','owner',1,'2026-11-13','2026-11-13','cash',500)");
    raw.exec("INSERT INTO pos_sale_lines(id,sale_id,kind,item_id,name,quantity,price_cents,total_cents,track_stock) VALUES('line','sale','product','old','Agua',1,500,500,1)");
    migrateDatabase(raw);
    assert.equal(raw.prepare('SELECT cost_cents FROM pos_products').get()!.cost_cents, null);
    assert.equal(raw.prepare('SELECT cost_cents FROM pos_sale_lines').get()!.cost_cents, null);
    assert.equal(raw.prepare('SELECT sku FROM pos_products').get()!.sku, 'OLD');
    assert.equal(raw.prepare('SELECT stock FROM pos_products').get()!.stock, 4);
    assert.equal(raw.prepare('SELECT total_cents FROM pos_sales').get()!.total_cents, 500);
  } finally { raw.close(); }
});

test('las copias antiguas se amplían con NULL; el formato compatible conserva el esquema anterior', t => {
  const { db } = fixture(t);
  const tables = replicaTables(db.raw, 'desktop').filter(table => table.name === 'pos_products' || table.name === 'pos_sale_lines');
  const legacy = tables.map(legacyProductCostTable);
  for (const table of legacy) {
    assert.ok(!table.columns.some(column => column.name === 'cost_cents'));
    assert.ok(!table.sql!.includes('cost_cents'));
    const check = new DatabaseSync(':memory:');
    try { check.exec(table.sql!); } finally { check.close(); }
  }
  const upgraded = upgradeManagementSnapshot({ tables: legacy } as SyncSnapshot);
  for (const table of upgraded.tables) {
    assert.ok(table.columns.some(column => column.name === 'cost_cents'));
    const check = new DatabaseSync(':memory:');
    try { check.exec(table.sql!); assert.ok(check.prepare(`PRAGMA table_info(${table.name})`).all().some(column => column.name === 'cost_cents')); } finally { check.close(); }
  }
  assert.deepEqual(upgradeManagementSnapshot(upgraded), upgraded);
});
