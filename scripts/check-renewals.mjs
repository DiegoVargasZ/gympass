import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SqliteDatabase } from '../server/database.ts';
import { Service } from '../lib/service.ts';
import { PosService } from '../lib/pos.ts';

async function fixture(t, expires = null) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-06T16:00:00Z') });
  const db = new SqliteDatabase(':memory:');
  t.after(() => db.close());
  db.raw.exec("INSERT INTO settings(id,owner,name,timezone) VALUES(1,'owner','Pruebas','America/La_Paz')");
  const service = new Service(db, { id: 'owner', email: 'test@example.test', name: 'Admin', role: 'admin' });
  const pos = new PosService(service);
  const person = await service.savePerson({ name: 'Socio', document: 'CI-RENOVAR', kind: 'member', status: 'active', phone: '59171234567', expires });
  if (expires) db.raw.prepare('UPDATE people SET legacy_access=1 WHERE id=?').run(person.id);
  const plan = await pos.savePlan({ name: 'Mensual', unit: 'months', duration: 1, price_cents: 10000 });
  const sell = (extra = {}) => pos.checkout({ request_id: randomUUID(), person_id: person.id, payment_method: 'cash', lines: [{ kind: 'plan', id: plan.id, quantity: 1 }], ...extra });
  const scan = (at, direction = 'entry') => service.access({ request_id: randomUUID(), person_id: person.id, direction, reason: 'Prueba de continuidad' }, undefined, new Date(at));
  return { db, service, pos, person, sell, scan };
}

test('pagar cuando quedan cinco días conserva el mes actual y activa el siguiente sin corte', async t => {
  const { db, pos, person, sell, scan } = await fixture(t);
  const original = await sell({ start_date: '2026-10-11' });
  const before = db.raw.prepare('SELECT * FROM pos_memberships WHERE id=?').get(original.memberships[0].id);
  assert.equal(before.end_date, '2026-11-11');
  const request_id = randomUUID();
  const renewal = await sell({ request_id, start_date: '2026-11-06' });
  assert.equal(renewal.local_date, '2026-11-06');
  assert.equal(renewal.start_date, '2026-11-11');
  assert.equal(renewal.memberships[0].end_date, '2026-12-11');
  assert.equal(renewal.replace_reason, null);
  assert.deepEqual(db.raw.prepare('SELECT * FROM pos_memberships WHERE id=?').get(before.id), before);
  assert.equal((await pos.memberships(person.id)).valid, true);
  assert.equal((await sell({ request_id, start_date: '2026-11-06' })).id, renewal.id);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM pos_sales').get().n, 2);
  for (const at of ['2026-11-06T16:00:00Z', '2026-11-11T03:59:59Z', '2026-11-11T04:00:00Z', '2026-12-11T03:59:59Z']) {
    assert.equal((await scan(at)).allowed, 1, at);
    assert.equal((await scan(at, 'exit')).allowed, 1);
  }
  assert.equal((await scan('2026-12-11T04:00:00Z')).reason, 'MEMBERSHIP_REQUIRED');
});

test('una ficha antigua conserva sus cinco días al pagar el primer plan por adelantado', async t => {
  const { db, service, pos, person, sell, scan } = await fixture(t, '2026-11-10');
  const gate = await pos.planGate(person.id, '2026-11-06');
  assert.equal(gate.state, 'renewal');
  assert.equal(gate.start_date, '2026-11-11');
  const renewal = await sell();
  assert.equal(renewal.start_date, '2026-11-11');
  assert.equal(renewal.memberships[0].end_date, '2026-12-11');
  assert.equal(db.raw.prepare('SELECT expires FROM people WHERE id=?').get(person.id).expires, '2026-11-10');
  assert.equal((await service.personSummary(person.id)).expires, '2026-11-10');
  assert.equal((await pos.memberships(person.id)).valid, true);
  for (const at of ['2026-11-06T16:00:00Z', '2026-11-11T03:59:59Z', '2026-11-11T04:00:00Z']) {
    assert.equal((await scan(at)).allowed, 1, at);
    await scan(at, 'exit');
  }
  t.mock.timers.setTime(Date.parse('2026-11-11T16:00:00Z'));
  assert.equal((await pos.memberships(person.id)).managed, true);
  assert.equal((await pos.memberships(person.id)).valid_until, '2026-12-10');
  assert.equal((await service.personSummary(person.id)).expires, '2026-12-10');
});

test('anular una renovación futura conserva el acceso antiguo y permite cobrarla de nuevo', async t => {
  const { pos, person, sell, scan } = await fixture(t, '2026-11-10');
  const renewal = await sell();
  await pos.voidSale(renewal.id, { reason: 'Cobro cancelado' });
  assert.equal((await pos.memberships(person.id)).valid, true);
  assert.equal((await scan('2026-11-06T16:00:00Z')).allowed, 1);
  assert.equal((await sell()).start_date, '2026-11-11');
});

test('una ficha vencida permite comprar hoy y una ficha sin vencimiento no obtiene acceso antes de un plan futuro', async t => {
  const { service, pos, person, sell, scan } = await fixture(t, '2026-11-05');
  assert.equal((await pos.planGate(person.id, '2026-11-06')).state, 'free');
  const sale = await sell({ start_date: '2026-11-11' });
  assert.equal(sale.start_date, '2026-11-11');
  assert.equal((await scan('2026-11-06T16:00:00Z')).allowed, 0);
  await service.savePerson({ name: 'Socio', document: 'CI-RENOVAR', kind: 'member', status: 'active', phone: '59171234567', expires: null }, person.id);
  assert.equal((await scan('2026-11-06T16:00:00Z')).reason, 'MEMBERSHIP_REQUIRED');
});
