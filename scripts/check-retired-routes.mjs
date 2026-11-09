import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPlatform } from '../server/platform.ts';

test('los módulos retirados conservan consulta histórica y rechazan cambios sin tocar sus tablas', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gympass-historical-'));
  const app = await startPlatform({ dataDirectory: directory, allowHttp: true, port: 0 });
  try {
    const owner = await app.store.bootstrap({ name: 'Owner', email: 'owner@example.test', password: 'owner-secret' });
    const gym = app.store.createGym(owner, { name: 'History', slug: 'history' });
    app.tenants.provision(gym); app.store.markGymProvisioned(gym.id);
    for (const role of ['admin', 'operator']) await app.store.createMember(owner, gym.id, { name: role, email: role + '@example.test', password: 'member-secret', role });
    const admin = await app.store.login({ email: 'admin@example.test', password: 'member-secret' });
    const operator = await app.store.login({ email: 'operator@example.test', password: 'member-secret' });
    const call = (route, method, token = admin.token) => fetch(app.url + '/api/gyms/' + gym.id + '/' + route, {
      method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'GymPASS', Cookie: 'gympass_platform=' + token }, ...(method === 'GET' ? {} : { body: '{}' }),
    });
    for (const route of ['visits', 'calendar', 'periods', 'saved-reports', 'invitation-batches', 'invitation-templates']) {
      for (const method of ['POST', 'PATCH', 'DELETE']) { const r = await call(route, method); assert.equal(r.status, 410, route); await r.text(); }
    }
    for (const route of ['visits', 'invitation-batches', 'calendar']) {
      const historic = await call(route, 'GET'); assert.equal(historic.status, 200, await historic.text());
      const denied = await call(route, 'GET', operator.token); assert.equal(denied.status, 403); await denied.text();
    }
    await app.tenants.withTenant(gym, async (ctx) => {
      for (const table of ['visits', 'invitation_batches', 'calendar_exceptions']) assert.equal(ctx.db.raw.prepare('SELECT COUNT(*) n FROM ' + table).get().n, 0);
      assert.ok(ctx.db.raw.prepare('SELECT MAX(version) n FROM schema_version').get().n >= 21);
    });
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
