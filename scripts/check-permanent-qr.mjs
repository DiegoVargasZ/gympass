import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { SqliteDatabase } from '../server/database.ts';
import { credentialVault } from '../server/credential-vault.ts';
import { Service } from '../lib/service.ts';
import { PosService } from '../lib/pos.ts';

async function fixture(t, existing = true) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T16:00:00Z') });
  const directory = mkdtempSync(join(tmpdir(), 'gympass-permanent-'));
  const db = new SqliteDatabase(':memory:');
  t.after(() => {
    db.close();
    const target = relative(tmpdir(), directory);
    assert.ok(target.startsWith('gympass-permanent-') && !target.includes(sep));
    rmSync(directory, { recursive: true, force: true });
  });
  db.raw.exec("INSERT INTO settings(id,owner,name,timezone) VALUES(1,'admin','Gym','America/La_Paz')");
  const actor = { id: 'admin', email: 'admin@example.test', name: 'Admin', role: 'admin' };
  const codec = credentialVault(join(directory, 'credentials.key'));
  const service = new Service(db, actor, codec), pos = new PosService(service);
  const person = await service.savePerson({ name: 'Socio permanente', document: 'QR-1', kind: 'member', status: 'active', phone: '59171234567' });
  const qr = existing ? await service.issueCredential(person.id, { kind: 'qr', label: 'Su tarjeta' }) : null;
  const plan = await pos.savePlan({ name: 'Mensual', unit: 'months', duration: 1, price_cents: 10000 });
  const sell = (extra = {}) => pos.checkout({ request_id: randomUUID(), person_id: person.id, payment_method: 'cash', lines: [{ kind: 'plan', id: plan.id, quantity: 1 }], ...extra });
  const scan = (code, at, direction = 'entry') => service.access({ code, request_id: randomUUID(), direction }, undefined, new Date(at));
  const count = () => db.raw.prepare("SELECT COUNT(*) n FROM credentials WHERE kind='qr'").get().n;
  return { db, service, pos, person, qr, plan, sell, scan, count, actor };
}

test('el mismo QR vence, permanece bloqueado dos semanas y vuelve a servir desde la fecha del nuevo pago', async t => {
  const { service, qr, sell, scan, count } = await fixture(t);
  const first = await sell();
  assert.equal(first.credential.id, qr.id);
  assert.equal((await scan(qr.code, '2026-02-01T03:59:59Z')).allowed, 1);
  await scan(qr.code, '2026-02-01T03:59:59Z', 'exit');
  assert.equal((await scan(qr.code, '2026-02-01T04:00:00Z')).reason, 'MEMBERSHIP_REQUIRED');
  t.mock.timers.setTime(Date.parse('2026-02-15T16:00:00Z'));
  const second = await sell();
  assert.equal(second.start_date, '2026-02-15');
  assert.equal(second.memberships[0].end_date, '2026-03-15');
  assert.equal(second.credential.id, qr.id);
  assert.equal((await service.credentialCard(qr.id)).code, qr.code);
  assert.equal((await scan(qr.code, '2026-02-15T03:59:59Z')).allowed, 0);
  assert.equal((await scan(qr.code, '2026-02-15T04:00:00Z')).allowed, 1);
  await scan(qr.code, '2026-02-15T04:00:00Z', 'exit');
  assert.equal((await scan(qr.code, '2026-03-15T03:59:59Z')).allowed, 1);
  await scan(qr.code, '2026-03-15T03:59:59Z', 'exit');
  assert.equal((await scan(qr.code, '2026-03-15T04:00:00Z')).allowed, 0);
  assert.equal(count(), 1);
});

test('renovar anticipadamente y cambiar de mensual a días conserva la clave y una sola credencial', async t => {
  const { db, service, pos, person, qr, sell, count } = await fixture(t);
  await sell();
  t.mock.timers.setTime(Date.parse('2026-01-27T16:00:00Z'));
  const renewal = await sell();
  assert.equal(renewal.start_date, '2026-02-01');
  assert.equal(renewal.credential.id, qr.id);
  const days = await pos.savePlan({ name: 'Semanal', unit: 'days', duration: 7, price_cents: 5000 });
  const changed = await sell({ replace_active: { reason: 'Cambia a semanal' }, lines: [{ kind: 'plan', id: days.id, quantity: 1 }] });
  assert.equal(changed.credential.id, qr.id);
  assert.equal((await service.issueCredential(person.id, { kind: 'qr', label: 'Otra descarga' })).code, qr.code);
  assert.equal(db.raw.prepare('SELECT active FROM credentials WHERE id=?').get(qr.id).active, 1);
  assert.equal(count(), 1);
});

test('primer pago concurrente y reintentos crean un solo QR y todos los cobros lo referencian', async t => {
  const { service, person, sell, count } = await fixture(t, false);
  const request_id = randomUUID();
  const sales = await Promise.all([sell({ request_id }), sell({ request_id })]);
  assert.equal(sales[0].id, sales[1].id);
  assert.equal(sales[0].credential.id, sales[1].credential.id);
  const [renewal, card] = await Promise.all([sell(), service.issueCredential(person.id, { kind: 'qr', label: 'Tarjeta' })]);
  assert.equal(renewal.credential.id, card.id);
  assert.equal(count(), 1);
});

test('un pago fallido no deja un QR huérfano y anular un pago futuro conserva el QR', async t => {
  const { pos, sell, count } = await fixture(t, false);
  const product = await pos.saveProduct({ name: 'Sin stock', price_cents: 500, stock: 0, track_stock: 1 });
  await assert.rejects(sell({ lines: [{ kind: 'product', id: product.id, quantity: 1 }, { kind: 'plan', id: (await pos.catalog()).plans[0].id, quantity: 1 }] }));
  assert.equal(count(), 0);
  const first = await sell();
  const future = await sell();
  await pos.voidSale(future.id, { reason: 'Pago cancelado' });
  assert.equal((await pos.sale(first.id)).credential.active, 1);
  assert.equal(count(), 1);
});

test('una tarjeta antigua sin imagen recuperable se conserva al pagar y no se sustituye silenciosamente', async t => {
  const { db, service, pos, person, actor, sell, scan, count } = await fixture(t, false);
  const oldService = new Service(db, actor);
  const old = await oldService.issueCredential(person.id, { kind: 'qr', label: 'Tarjeta antigua' });
  const sale = await sell();
  assert.equal(sale.credential.id, old.id);
  await assert.rejects(service.issueCredential(person.id, { kind: 'qr', label: 'Recuperar' }), /conserva su QR anterior/);
  assert.equal((await scan(old.code, '2026-01-01T16:00:00Z')).allowed, 1);
  assert.equal(count(), 1);
  assert.equal((await pos.sale(sale.id)).credential.active, 1);
});

test('revocar expresamente un QR no lo reactiva al renovar y el QR nuevo se conserva después', async t => {
  const { service, qr, sell, scan, count } = await fixture(t);
  await sell();
  await service.revokeCredential(qr.id);
  const renewal = await sell();
  assert.notEqual(renewal.credential.id, qr.id);
  assert.equal((await scan(qr.code, '2026-01-01T16:00:00Z')).reason, 'REVOKED');
  const current = await service.credentialCard(renewal.credential.id);
  assert.equal((await scan(current.code, '2026-01-01T16:00:00Z')).allowed, 1);
  assert.equal(count(), 2);
});
