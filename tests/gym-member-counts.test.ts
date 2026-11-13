import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { startPlatform } from '../server/platform.ts';

async function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'gympass-member-counts-'));
  const app = await startPlatform({ dataDirectory: directory, port: 0, allowHttp: true });
  t.after(async () => {
    await app.close();
    const child = relative(tmpdir(), directory);
    assert.ok(child.startsWith('gympass-member-counts-') && !child.includes(sep));
    rmSync(directory, { recursive: true, force: true });
  });
  const owner = await app.store.bootstrap({ name: 'Owner', email: 'owner@example.test', password: 'Prueba123456' });
  const login = await app.store.login({ email: 'owner@example.test', password: 'Prueba123456' });
  const gyms = ['uno', 'dos', 'vacio'].map(slug => {
    const gym = app.store.createGym(owner, { name: slug, slug });
    app.tenants.provision(gym); app.store.markGymProvisioned(gym.id);
    return gym;
  });
  const request = (suffix = '', token = login.token) => fetch(app.url + '/api/platform/gym-member-counts' + suffix, {
    headers: { Cookie: 'gympass_platform=' + token },
  });
  return { app, owner, login, gyms, request };
}

test('el superadministrador obtiene socios por sede, incluidos inactivos/vencidos y excluyendo personal y eliminados', async t => {
  const f = await fixture(t);
  await f.app.tenants.withTenant(f.gyms[0], async ctx => {
    const insert = ctx.db.raw.prepare('INSERT INTO people(id,name,document,kind,status,created_at,expires,deleted_at) VALUES(?,?,?,?,?,?,?,?)');
    for (const [name, kind, status, expires, deleted] of [
      ['activo', 'member', 'active', null, null],
      ['inactivo', 'member', 'inactive', null, null],
      ['vencido', 'member', 'active', '2020-01-01', null],
      ['personal', 'employee', 'active', null, null],
      ['eliminado', 'member', 'active', null, Date.now()],
    ]) insert.run(crypto.randomUUID(), String(name), String(name), String(kind), String(status), Date.now(), expires, deleted);
  });
  await f.app.tenants.withTenant(f.gyms[1], async ctx => {
    ctx.db.raw.prepare("INSERT INTO people(id,name,document,kind,status,created_at) VALUES('otro','Otro','otro','member','active',?)").run(Date.now());
  });
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).counts, { [f.gyms[0].id]: 3, [f.gyms[1].id]: 1, [f.gyms[2].id]: 0 });
  f.app.store.raw.prepare('UPDATE gyms SET archived_at=? WHERE id=?').run(Date.now(), f.gyms[1].id);
  assert.deepEqual((await (await f.request('?scope=archived')).json()).counts, { [f.gyms[1].id]: 1 });
  f.app.store.deleteGym(f.owner, f.gyms[0].id);
  assert.deepEqual((await (await f.request('?scope=deleted')).json()).counts, { [f.gyms[0].id]: 3 });
  const missing = f.app.store.createGym(f.owner, { name: 'Sin base', slug: 'sin-base' });
  const remaining = (await (await f.request()).json()).counts;
  assert.equal(remaining[missing.id], null);
  assert.equal(remaining[f.gyms[2].id], 0);
  await f.app.tenants.withTenant(f.gyms[2], async ctx => {
    ctx.db.raw.prepare('UPDATE settings SET owner=? WHERE id=1').run(f.gyms[0].id);
  });
  assert.equal((await (await f.request()).json()).counts[f.gyms[2].id], null);
});

test('los totales requieren superadministrador y vuelven a verificar el permiso al terminar la consulta', async t => {
  const f = await fixture(t);
  await f.app.store.createMember(f.owner, f.gyms[0].id, { name: 'Admin', email: 'admin@example.test', password: 'Prueba123456', role: 'admin' });
  const admin = await f.app.store.login({ email: 'admin@example.test', password: 'Prueba123456' });
  assert.equal((await f.request('', admin.token)).status, 403);
  assert.equal((await f.request('', '')).status, 401);
  let started!: () => void;
  const entered = new Promise<void>(done => { started = done; });
  const original = f.app.store.listGyms.bind(f.app.store);
  t.mock.method(f.app.store, 'listGyms', (...args: Parameters<typeof original>) => { const result = original(...args); started(); return result; });
  const pending = f.request();
  await entered;
  f.app.store.raw.prepare("UPDATE platform_users SET global_role='user' WHERE id=?").run(f.owner.id);
  assert.equal((await pending).status, 403);
});
