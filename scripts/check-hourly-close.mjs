import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../server/database.ts';
import { Service, presenceSql } from '../lib/service.ts';
import { sessionMaintenance } from '../server/maintenance.ts';
import { startPlatform } from '../server/platform.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hour = 3600000;

test('el panel ya en la cola puede comprobar cierres aunque el temporizador esté esperando detrás', async () => {
  const db = new SqliteDatabase(':memory:');
  db.raw.exec("INSERT INTO settings(id,owner,name,timezone) VALUES(1,'owner','Gym','America/La_Paz')");
  let tail = Promise.resolve();
  const exclusive = operation => { const work = tail.catch(() => {}).then(operation); tail = work; return work; };
  const maintenance = sessionMaintenance(db, () => new Date('2026-11-09T12:00:00Z'), exclusive);
  let queued, timer;
  try {
    await exclusive(async () => {
      queued = maintenance.check();
      const result = await Promise.race([maintenance.check(true), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('El cierre automático esperó a su propia cola.')), 1000); })]);
      assert.equal(result.closed, 0);
      assert.equal(maintenance.check(), queued);
    });
    assert.equal((await queued).closed, 0);
  } finally { clearTimeout(timer); await queued; maintenance.stop(); db.close(); }
});
async function fixture(t, hours = 2) {
  const db = new SqliteDatabase(':memory:');
  t.after(() => db.close());
  db.raw.exec("INSERT INTO settings(id,owner,name,timezone) VALUES(1,'owner','Gym','America/La_Paz')");
  const service = new Service(db, { id: 'owner', email: 'admin@example.test', name: 'Admin', role: 'admin' });
  await service.updateSettings({ auto_close_hours: hours, closing_time: null });
  const person = await service.savePerson({ name: 'Ana', document: 'HOURLY', kind: 'employee', status: 'active', zone_ids: ['general'] });
  const operator = new Service(db, { ...service.actor, role: 'operator' });
  const scan = (at, request_id = crypto.randomUUID()) => operator.access({ person_id: person.id, zone_id: 'general', direction: 'auto', reason: 'Prueba de cierre', request_id }, undefined, new Date(at));
  const exits = () => service.all("SELECT * FROM events WHERE reason='AUTO_CLOSE' ORDER BY id");
  return { db, service, operator, scan, exits };
}

test('el mantenimiento por horas vuelve a comprobar durante el mismo día y cierra en el límite exacto', async t => {
  const { db, scan, exits } = await fixture(t);
  const entry = Date.parse('2026-11-08T12:00:00Z');
  await scan(entry);
  let now = entry + hour;
  const maintenance = sessionMaintenance(db, () => new Date(now));
  t.after(() => maintenance.stop());
  assert.equal((await maintenance.check()).closed, 0);
  now = entry + 2 * hour;
  assert.equal((await maintenance.check()).closed, 1);
  assert.equal((await exits())[0].occurred_at, now);
  assert.equal((await maintenance.check()).closed, 0);
});

test('una lectura automática aplica el cierre por horas antes de decidir el movimiento y conserva reintentos', async t => {
  const { scan, exits } = await fixture(t);
  const entry = Date.parse('2026-11-08T12:00:00Z');
  assert.equal((await scan(entry)).direction, 'entry');
  const id = crypto.randomUUID();
  const next = await scan(entry + 3 * hour, id);
  assert.equal(next.direction, 'entry');
  assert.equal((await scan(entry + 3 * hour + 60000, id)).id, next.id);
  assert.equal((await exits()).length, 1);
  assert.equal((await exits())[0].occurred_at, entry + 2 * hour);
});

test('abrir recepción recupera las visitas olvidadas aunque el temporizador no haya corrido', async t => {
  const { operator, scan, exits } = await fixture(t);
  const entry = Date.now() - 3 * hour;
  await scan(entry);
  const boot = await operator.bootstrap({ compact: true, maintain: true });
  assert.equal(boot.stats.inside, 0);
  assert.equal((await exits())[0].occurred_at, entry + 2 * hour);
  assert.equal((await operator.bootstrap({ compact: true, maintain: true })).stats.inside, 0);
  assert.equal((await exits()).length, 1);
});

test('el cierre por horas recupera visitas de ayer, respeta salidas reales y puede desactivarse', async t => {
  const { service, scan, exits } = await fixture(t);
  const entry = Date.parse('2026-11-07T12:00:00Z');
  await scan(entry);
  await service.updateSettings({ auto_close_hours: 0 });
  assert.equal((await service.closeStaleSessions(new Date(entry + 24 * hour))).closed, 0);
  await service.updateSettings({ auto_close_hours: 2 });
  assert.equal((await service.closeStaleSessions(new Date(entry + 24 * hour))).closed, 1);
  assert.equal((await exits())[0].occurred_at, entry + 2 * hour);
  await scan(entry + 24 * hour);
  await scan(entry + 25 * hour);
  assert.equal((await service.closeStaleSessions(new Date(entry + 48 * hour))).closed, 0);
  assert.equal((await service.all(presenceSql)).length, 0);
});

test('el bootstrap HTTP actualiza los presentes sin esperar al temporizador del servidor', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gympass-hourly-http-'));
  const app = await startPlatform({ dataDirectory: directory, port: 0, allowHttp: true });
  try {
    const owner = await app.store.bootstrap({ name: 'Owner', email: 'owner@example.test', password: '123456' });
    const gym = app.store.createGym(owner, { name: 'Cierre por horas', slug: 'hourly' });
    app.tenants.provision(gym);
    app.store.markGymProvisioned(gym.id);
    const member = await app.store.createMember(owner, gym.id, { name: 'Recepción', email: 'admin@example.test', password: '123456', role: 'admin' });
    const login = await app.store.login({ email: 'admin@example.test', password: '123456' });
    await app.tenants.withTenant(gym, async ctx => {
      const service = new Service(ctx.db, member, ctx.codec);
      const person = await service.savePerson({ name: 'Visita de ayer', document: 'HTTP', kind: 'employee', status: 'active', zone_ids: ['general'] });
      await service.updateSettings({ auto_close_hours: 2, closing_time: null });
      await service.access({ person_id: person.id, zone_id: 'general', direction: 'entry', reason: 'Visita olvidada', request_id: crypto.randomUUID() }, undefined, new Date(Date.now() - 24 * hour));
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(app.url + `/api/gyms/${gym.id}/bootstrap?compact=1`, { headers: { Cookie: `gympass_platform=${login.token}` } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).stats.inside, 0);
    }
    await app.tenants.withTenant(gym, async ctx => {
      assert.equal(ctx.db.raw.prepare("SELECT COUNT(*) n FROM events WHERE reason='AUTO_CLOSE'").get().n, 1);
    });
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
