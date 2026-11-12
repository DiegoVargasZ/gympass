import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { startPlatform } from '../server/platform.ts';

function temporary(t, beforeRemove = async () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'gympass-avisos-'));
  t.after(async () => {
    await beforeRemove();
    const target = relative(tmpdir(), directory);
    assert.ok(target.startsWith('gympass-avisos-') && !target.includes(sep));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

async function fixture(t) {
  let app;
  const directory = temporary(t, async () => {
    if (app?.server.listening) await app.close();
  });
  app = await startPlatform({ dataDirectory: directory, port: 0, allowHttp: true });
  await app.store.bootstrap({ name: 'Dueño', email: 'owner@example.test', password: 'Prueba1234' });
  const owner = await app.store.login({ email: 'owner@example.test', password: 'Prueba1234' });
  const gyms = [];
  for (const slug of ['uno', 'dos']) {
    const gym = app.store.createGym(owner.session.user, { name: slug, slug });
    app.tenants.provision(gym);
    app.store.markGymProvisioned(gym.id);
    const invite = app.store.invite(owner.session.user, gym.id, {
      name: slug,
      email: `${slug}@example.test`,
      role: 'admin',
    });
    await app.store.acceptInvitation({ token: invite.token, name: slug, password: 'Prueba1234' });
    const login = await app.store.login({ email: `${slug}@example.test`, password: 'Prueba1234' });
    gyms.push({ ...gym, login });
  }
  const call = (path, token, method = 'GET', body) =>
    fetch(app.url + path, {
      method,
      headers: {
        Cookie: `gympass_platform=${token}`,
        Origin: app.url,
        'X-Requested-With': 'GymPASS',
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const alerts = async (gym) => (await (await call(`/api/gyms/${gym.id}/alerts`, gym.login.token)).json()).alerts;
  const connect = async (gym) => {
    const socket = new WebSocket(app.url.replace('http:', 'ws:') + `/api/gyms/${gym.id}/realtime`, ['gympass.v1'], {
      headers: { Origin: app.url, Cookie: `gympass_platform=${gym.login.token}` },
    });
    t.after(() => socket.terminate());
    const [ready] = await once(socket, 'message');
    assert.equal(JSON.parse(ready).type, 'ready');
    return socket;
  };
  return { app, owner, gyms, call, alerts, connect };
}

const message = { title: 'Mantenimiento el domingo', body: 'El servicio se detendrá de 02:00 a 04:00.', severity: 'warning' };

test('un aviso del superadministrador llega a las alertas de todos los gimnasios', { timeout: 20000 }, async (t) => {
  const { owner, gyms: [a, b], call, alerts } = await fixture(t);
  const created = await call('/api/platform/announcements', owner.token, 'POST', message);
  assert.equal(created.status, 201, await created.clone().text());
  const { announcement } = await created.json();
  assert.deepEqual(announcement.gym_ids, []);

  for (const gym of [a, b]) {
    const row = (await alerts(gym)).find((alert) => alert.kind === 'announcement');
    assert.ok(row, 'El aviso debe aparecer en el centro de alertas del gimnasio');
    assert.equal(row.title, message.title);
    assert.equal(row.severity, 'warning');
    assert.equal(row.read, false);
    assert.match(row.detail, /Dueño/);
  }

  // Marcar leído solo apaga el distintivo del usuario que lo leyó.
  const key = (await alerts(a)).find((alert) => alert.kind === 'announcement').key;
  assert.equal((await call(`/api/gyms/${a.id}/alerts/read`, a.login.token, 'POST', { keys: [key] })).status, 200);
  assert.equal((await alerts(a)).find((alert) => alert.key === key).read, true);
  assert.equal((await alerts(b)).find((alert) => alert.key === key).read, false);

  // Retirarlo lo quita de inmediato, sin tocar las alertas propias del gimnasio.
  const revoked = await call('/api/platform/announcements/' + announcement.id, owner.token, 'DELETE');
  assert.equal(revoked.status, 200, await revoked.clone().text());
  for (const gym of [a, b]) assert.equal((await alerts(gym)).some((alert) => alert.kind === 'announcement'), false);
});

test('un aviso dirigido solo lo ve el gimnasio elegido', { timeout: 20000 }, async (t) => {
  const { owner, gyms: [a, b], call, alerts } = await fixture(t);
  const created = await call('/api/platform/announcements', owner.token, 'POST', { ...message, gym_ids: [a.id] });
  assert.equal(created.status, 201, await created.clone().text());
  assert.deepEqual((await created.json()).announcement.gym_ids, [a.id]);
  assert.equal((await alerts(a)).some((alert) => alert.kind === 'announcement'), true);
  assert.equal((await alerts(b)).some((alert) => alert.kind === 'announcement'), false);
});

test('los avisos son exclusivos del superadministrador y validan su contenido', { timeout: 20000 }, async (t) => {
  const { owner, gyms: [a], call } = await fixture(t);
  assert.equal((await call('/api/platform/announcements', a.login.token, 'POST', message)).status, 403);
  assert.equal((await call('/api/platform/announcements', a.login.token)).status, 403);
  assert.equal((await call('/api/platform/announcements', owner.token, 'POST', { ...message, severity: 'otra' })).status, 400);
  assert.equal((await call('/api/platform/announcements', owner.token, 'POST', { ...message, body: '' })).status, 400);
  assert.equal((await call('/api/platform/announcements', owner.token, 'POST', { ...message, days: 400 })).status, 400);
  assert.equal(
    (await call('/api/platform/announcements', owner.token, 'POST', { ...message, gym_ids: ['no-existe'] })).status,
    404,
  );
  assert.equal((await call('/api/platform/announcements/no-existe', owner.token, 'DELETE')).status, 404);
  // El intento fallido no deja rastro: un gimnasio inexistente cancela todo el aviso.
  assert.deepEqual((await (await call('/api/platform/announcements', owner.token)).json()).announcements, []);
});

test('un aviso vencido deja de verse sin retirarlo', { timeout: 20000 }, async (t) => {
  const { app, owner, gyms: [a], call, alerts } = await fixture(t);
  const created = await call('/api/platform/announcements', owner.token, 'POST', { ...message, days: 1 });
  const { announcement } = await created.json();
  assert.equal((await alerts(a)).some((alert) => alert.kind === 'announcement'), true);
  app.store.raw
    .prepare('UPDATE announcements SET expires_at=? WHERE id=?')
    .run(Date.now() - 1000, announcement.id);
  assert.equal((await alerts(a)).some((alert) => alert.kind === 'announcement'), false);
});

test('enviar y retirar un aviso refresca las pantallas abiertas de los gimnasios que lo reciben', { timeout: 20000 }, async (t) => {
  const { owner, gyms: [a, b], call, connect } = await fixture(t);
  const first = await connect(a), second = await connect(b);
  const firstEvents = [], secondEvents = [];
  first.on('message', (data) => firstEvents.push(JSON.parse(data)));
  second.on('message', (data) => secondEvents.push(JSON.parse(data)));
  const created = await call('/api/platform/announcements', owner.token, 'POST', { ...message, gym_ids: [a.id] });
  const { announcement } = await created.json();
  await delay(200);
  assert.deepEqual(firstEvents.map((event) => event.topics), [['alerts']]);
  assert.equal(secondEvents.length, 0, 'El gimnasio que no recibe el aviso no recarga');
  assert.equal((await call('/api/platform/announcements/' + announcement.id, owner.token, 'DELETE')).status, 200);
  await delay(200);
  assert.equal(firstEvents.length, 2);
  assert.equal(secondEvents.length, 0);
});
