import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { startPlatform } from '../server/platform.ts';
import { SqliteDatabase } from '../server/database.ts';
import { Service } from '../lib/service.ts';
import { PosService } from '../lib/pos.ts';
import { authorizedDatabase } from '../server/authorized-database.ts';

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'gympass-policy-'));
  t.after(() => {
    const target = relative(tmpdir(), directory);
    assert.ok(target.startsWith('gympass-policy-') && !target.includes(sep));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('lectores, informes y sesión de acceso automático aplican permisos en el servidor', async t => {
  const app = await startPlatform({ dataDirectory: temporary(t), port: 0, allowHttp: true });
  try {
    const owner = await app.store.bootstrap({ name: 'Owner', email: 'owner@example.test', password: '123456' });
    const gym = app.store.createGym(owner, { name: 'Gym', slug: 'policy' });
    app.tenants.provision(gym);
    app.store.markGymProvisioned(gym.id);
    for (const role of ['admin', 'operator', 'viewer'])
      await app.store.createMember(owner, gym.id, { name: role, email: role + '@example.test', role, password: '123456' });
    const login = role => app.store.login({ email: role + '@example.test', password: '123456' });
    const sessions = Object.fromEntries(await Promise.all(['admin', 'operator', 'viewer'].map(async role => [role, await login(role)])));
    const request = (path, session, method = 'GET', body) => fetch(app.url + '/api/' + path, {
      method, headers: { Cookie: `gympass_platform=${session.token}`, 'X-Requested-With': 'GymPASS', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const api = (path, session = sessions.admin, method, body) => request(`gyms/${gym.id}/${path}`, session, method, body);
    const fixture = await app.tenants.withTenant(gym, async ctx => {
      const service = new Service(ctx.db, { ...sessions.admin.session.user, role: 'admin' }, ctx.codec);
      const person = await service.savePerson({ name: 'Nuevo sin pago', document: 'NEW', phone: '59171234567', kind: 'member', status: 'active' });
      const qr = await service.issueCredential(person.id, { kind: 'qr', label: 'Tarjeta' });
      const pos = new PosService(service);
      assert.equal((await pos.memberships(person.id)).legacy, false);
      assert.equal((await pos.memberships(person.id)).valid, false);
      assert.equal((await service.personSummary(person.id)).membership_managed, 1);
      assert.equal((await service.access({ code: qr.code, direction: 'entry', request_id: randomUUID() })).reason, 'MEMBERSHIP_REQUIRED');
      const plan = await pos.savePlan({ name: 'Mes', unit: 'months', duration: 1, price_cents: 1000 });
      const sale = await pos.checkout({ person_id: person.id, request_id: randomUUID(), payment_method: 'cash', lines: [{ kind: 'plan', id: plan.id, quantity: 1 }] });
      assert.equal(sale.credential.id, qr.id);
      return { person, qr, device: await service.createDevice({ name: 'Lector', kind: 'qr', direction: 'auto' }) };
    });
    for (const role of ['admin', 'operator', 'viewer']) {
      for (const path of ['events', 'events/export', 'gym-sessions', 'gym-sessions/export', 'attendance', 'attendance/export', 'workdays/export', 'payroll'])
        assert.equal((await api(path, sessions[role])).status, role === 'operator' ? 403 : 200, `${role} ${path}`);
    }
    // The movements search finds a member by the complete document, never by a fragment of it.
    const byDocument = await (await api('events?q=new')).json();
    assert.ok(byDocument.total > 0);
    assert.ok(byDocument.rows.every(row => row.person_id === fixture.person.id));
    assert.equal((await (await api('events?q=EW')).json()).total, 0);
    const mobile = await app.store.mobileLogin({ email: 'operator@example.test', password: '123456', gymId: gym.id });
    for (const path of ['mobile/bootstrap', 'mobile/people', 'mobile/events', 'mobile/gym-sessions', 'mobile/presence'])
      assert.equal((await fetch(app.url + `/api/gyms/${gym.id}/${path}`, { headers: { Authorization: `Bearer ${mobile.token}` } })).status, 200, path);
    assert.equal((await api('kiosk/start', sessions.viewer, 'POST', {})).status, 403);
    assert.equal((await api('kiosk/start', sessions.admin, 'POST', {})).status, 200);
    const status = await (await request('platform/status', sessions.admin)).json();
    assert.equal(status.user, null);
    assert.equal(status.kiosk.id, gym.id);
    assert.deepEqual(status.gyms, []);
    for (const path of ['bootstrap', 'people', 'events/export', 'pos/catalog', 'settings', 'audit', 'devices', 'mobile/people'])
      assert.equal((await api(path)).status, 403, path);
    assert.equal((await request('platform/gyms', sessions.admin)).status, 401);
    const boot = await (await api('kiosk/bootstrap')).json();
    assert.equal(boot.user.role, 'operator');
    assert.equal(boot.people, undefined);
    assert.equal(boot.events, undefined);
    assert.equal(boot.zones.length, 1);
    assert.equal((await api('access', sessions.admin, 'POST', { person_id: fixture.person.id, direction: 'auto', reason: 'Intento manual', request_id: randomUUID() })).status, 403);
    const entry = await (await api('access', sessions.admin, 'POST', { code: fixture.qr.code, direction: 'auto', zone_id: 'general', request_id: randomUUID() })).json();
    assert.equal(entry.allowed, 1);
    assert.equal(entry.actor, undefined);
    assert.equal(entry.payload_hash, undefined);
    // An already prepared administrative query also loses its grant after entering kiosk.
    await app.tenants.withTenant(gym, async ctx => {
      const db = authorizedDatabase(ctx.db, () => app.store.authorizeSync(sessions.admin.token, gym.id, undefined, true));
      await assert.rejects(db.prepare('SELECT * FROM people').all(), { status: 403 });
    });
    const otherGym = app.store.createGym(owner, { name: 'Otro', slug: 'other' });
    app.tenants.provision(otherGym); app.store.markGymProvisioned(otherGym.id);
    assert.equal((await request(`gyms/${otherGym.id}/kiosk/bootstrap`, sessions.admin)).status, 403);
    const reader = async method => {
      const response = await fetch(app.url + `/api/gyms/${gym.id}/device-${method === 'GET' ? 'check' : 'access'}`, {
        method, headers: { Authorization: `Bearer ${fixture.device.token}`, 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({ code: fixture.qr.code, request_id: randomUUID() }) } : {}),
      });
      return response;
    };
    assert.equal((await reader('GET')).status, 200);
    // Archive while the request waits for this gym's database queue.
    for (const method of ['GET', 'POST']) {
      let release, entered;
      const held = new Promise(resolve => { release = resolve; });
      const ready = new Promise(resolve => { entered = resolve; });
      const holding = app.tenants.withTenant(gym, async () => { entered(); await held; });
      await ready;
      const received = new Promise(resolve => app.server.once('request', resolve));
      const pending = reader(method);
      await received;
      app.store.updateGym(owner, gym.id, { archived: true });
      release();
      await holding;
      assert.equal((await pending).status, 403, `queued ${method}`);
      app.store.updateGym(owner, gym.id, { archived: false });
    }
    for (const change of [{ archived: true }, { status: 'suspended' }]) {
      app.store.updateGym(owner, gym.id, change);
      for (const method of ['GET', 'POST']) assert.equal((await reader(method)).status, 403);
      app.store.updateGym(owner, gym.id, { archived: false, status: 'active' });
    }
    app.store.deleteGym(owner, gym.id);
    for (const method of ['GET', 'POST']) assert.equal((await reader(method)).status, 403);
    await app.store.restoreGym(owner, gym.id);
    app.store.updateGym(owner, gym.id, { status: 'active' });
    // Leaving kiosk mode needs the account password and restores the same session.
    const desk = await login('operator');
    assert.equal((await api('kiosk/start', desk, 'POST', {})).status, 200);
    assert.equal((await request('platform/kiosk/stop', desk, 'POST', { password: 'wrong' })).status, 403);
    assert.equal((await (await request('platform/status', desk)).json()).user, null);
    assert.equal((await request('platform/kiosk/stop', desk, 'POST', { password: '123456' })).status, 200);
    assert.equal((await (await request('platform/status', desk)).json()).user.email, 'operator@example.test');
    assert.equal((await request('platform/kiosk/stop', desk, 'POST', { password: '123456' })).status, 401);
    const fresh = await login('admin');
    assert.equal((await api('people', fresh)).status, 200);
    assert.equal((await request('platform/logout', sessions.admin, 'POST', {})).status, 200);
    assert.equal((await api('kiosk/bootstrap')).status, 401);
  } finally { await app.close(); }
});

test('la migración conserva socios anteriores y no concede derechos heredados a altas nuevas', async t => {
  const file = join(temporary(t), 'gym.sqlite');
  let db = new SqliteDatabase(file);
  db.raw.exec(`DELETE FROM schema_version WHERE version>=20; ALTER TABLE settings DROP COLUMN ui_theme; ALTER TABLE settings DROP COLUMN ui_accent; ALTER TABLE settings DROP COLUMN ui_density; DROP INDEX events_chronological_presence; ALTER TABLE people DROP COLUMN legacy_access; ALTER TABLE settings DROP COLUMN logo_watermark_size; ALTER TABLE settings DROP COLUMN credential_color; ALTER TABLE settings DROP COLUMN credential_watermark_size;
    INSERT INTO settings(id,owner,name,timezone) VALUES(1,'admin','Gym','America/La_Paz');
    INSERT INTO people(id,name,document,kind,status,created_at) VALUES('old','Anterior','OLD','member','active',1)`);
  db.close();
  db = new SqliteDatabase(file);
  try {
    const s = new Service(db, { id: 'admin', email: 'admin@example.test', name: 'Admin', role: 'admin' });
    assert.equal(db.raw.prepare("SELECT legacy_access FROM people WHERE id='old'").get().legacy_access, 1);
    const old = await s.issueCredential('old', { kind: 'qr', label: 'Antigua' });
    assert.equal((await s.access({ code: old.code, direction: 'entry', request_id: randomUUID() })).allowed, 1);
    const person = await s.savePerson({ name: 'Nuevo', document: 'NEW', kind: 'member', status: 'active', phone: '59171234567', expires: '2099-01-01', legacy_access: 1 });
    const qr = await s.issueCredential(person.id, { kind: 'qr', label: 'Nueva' });
    assert.equal(db.raw.prepare('SELECT legacy_access FROM people WHERE id=?').get(person.id).legacy_access, 0);
    assert.equal((await s.access({ code: qr.code, direction: 'entry', request_id: randomUUID() })).reason, 'MEMBERSHIP_REQUIRED');
    assert.equal((await new PosService(s).memberships(person.id)).valid, false);
  } finally { db.close(); }
});
