import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { startPlatform } from '../server/platform.ts';
import { staticAsset, staticBytes } from '../server/static-files.ts';

function temporary(t, beforeRemove = async () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'gympass-realtime-'));
  t.after(async () => {
    await beforeRemove();
    const target = relative(tmpdir(), directory);
    assert.ok(target.startsWith('gympass-realtime-') && !target.includes(sep));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

async function fixture(t) {
  let app;
  const directory = temporary(t, async () => { if (app?.server.listening) await app.close(); });
  app = await startPlatform({ dataDirectory: directory, port: 0, allowHttp: true });
  await app.store.bootstrap({ name: 'Owner', email: 'owner@example.test', password: 'Prueba1234' });
  const owner = await app.store.login({ email: 'owner@example.test', password: 'Prueba1234' });
  const gyms = [];
  for (const slug of ['uno', 'dos']) {
    const gym = app.store.createGym(owner.session.user, { name: slug, slug });
    app.tenants.provision(gym);
    app.store.markGymProvisioned(gym.id);
    const invite = app.store.invite(owner.session.user, gym.id, { name: slug, email: `${slug}@example.test`, role: 'admin' });
    await app.store.acceptInvitation({ token: invite.token, name: slug, password: 'Prueba1234' });
    const login = await app.store.login({ email: `${slug}@example.test`, password: 'Prueba1234' });
    gyms.push({ ...gym, login });
  }
  const ws = (gym, token, options = {}) => new WebSocket(
    app.url.replace('http:', 'ws:') + `/api/gyms/${gym}/realtime`,
    options.protocols || ['gympass.v1'],
    { headers: { Origin: options.origin || app.url, ...(token ? { Cookie: `gympass_platform=${token}` } : {}) } },
  );
  const connect = async (gym, token, options) => {
    const socket = ws(gym, token, options);
    t.after(() => socket.terminate());
    const [data] = await once(socket, 'message');
    assert.equal(JSON.parse(data).type, 'ready');
    return socket;
  };
  const rejected = (gym, token, options) => new Promise((resolve, reject) => {
    const socket = ws(gym, token, options);
    socket.on('open', () => { socket.terminate(); reject(Error('Se abrió una conexión prohibida')); });
    socket.on('error', () => {});
    socket.on('unexpected-response', (req, res) => { res.resume(); socket.terminate(); resolve(res.statusCode); });
  });
  const request = (gym, path, body, token = gyms[0].login.token) => fetch(`${app.url}/api/gyms/${gym}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: `gympass_platform=${token}`, Origin: app.url, 'X-Requested-With': 'GymPASS', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { app, owner, gyms, connect, rejected, request };
}

test('WebSocket exige sesión, origen, gimnasio y protocolo válidos', { timeout: 15000 }, async t => {
  const { gyms: [a, b], rejected } = await fixture(t);
  assert.equal(await rejected(a.id), 401);
  assert.equal(await rejected(a.id, a.login.token, { origin: 'https://otro.test' }), 403);
  assert.equal(await rejected(b.id, a.login.token), 401);
  assert.equal(await rejected(a.id, a.login.token, { protocols: ['otro'] }), 400);
});

test('cambios confirmados llegan a otros equipos, agrupan ráfagas y respetan cada gimnasio', { timeout: 15000 }, async t => {
  const { gyms: [a, b], connect, request } = await fixture(t);
  const first = await connect(a.id, a.login.token), second = await connect(a.id, a.login.token);
  const other = await connect(b.id, b.login.token);
  const firstEvents = [], secondEvents = [], otherEvents = [];
  first.on('message', data => firstEvents.push(JSON.parse(data)));
  second.on('message', data => secondEvents.push(JSON.parse(data)));
  other.on('message', data => otherEvents.push(JSON.parse(data)));
  assert.equal((await request(a.id, 'people', { name: 'Incompleto' })).status, 400);
  await delay(140);
  assert.equal(firstEvents.length, 0, 'Una escritura rechazada no dispara recargas');
  const writes = await Promise.all([1, 2, 3].map(i => request(a.id, 'people', {
    name: `Socio ${i}`, document: `DOC-${i}`, kind: 'member', status: 'active', phone: '59171234567',
  })));
  for (const response of writes) assert.equal(response.status, 201, await response.clone().text());
  await delay(200);
  assert.equal(firstEvents.length, 1);
  assert.deepEqual(firstEvents, secondEvents);
  assert.deepEqual(firstEvents[0].topics.sort(), ['alerts', 'people']);
  assert.deepEqual(Object.keys(firstEvents[0]).sort(), ['revision', 'topics', 'type']);
  assert.equal(otherEvents.length, 0);
  const closed = once(first, 'close');
  first.send(JSON.stringify({ type: 'checkout', amount: 100 }));
  assert.equal((await closed)[0], 1008, 'El canal no acepta operaciones ni cobros');
});

test('cerrar sesión revoca de inmediato el canal; cerrar el servidor no deja sockets abiertos', { timeout: 15000 }, async t => {
  const { app, gyms: [a, b], connect } = await fixture(t);
  const socket = await connect(a.id, a.login.token);
  const closed = once(socket, 'close');
  const response = await fetch(app.url + '/api/platform/logout', {
    method: 'POST', headers: { Cookie: `gympass_platform=${a.login.token}`, Origin: app.url, 'X-Requested-With': 'GymPASS' },
  });
  assert.equal(response.status, 200);
  assert.equal((await closed)[0], 4003);
  const remaining = await connect(b.id, b.login.token);
  const disconnected = once(remaining, 'close');
  await app.close();
  await disconnected;
  assert.equal(remaining.readyState, WebSocket.CLOSED);
});

test('revocar soporte o cambiar el rol invalida la conexión existente', { timeout: 15000 }, async t => {
  const { app, owner, gyms: [a], connect, rejected } = await fixture(t);
  assert.equal(await rejected(a.id, owner.token), 401);
  const grant = await app.store.createSupport(owner.token, a.id, 'Comprobar tiempo real');
  const support = await connect(a.id, owner.token, { protocols: ['gympass.v1', 'support.' + grant.support_token] });
  const revoked = once(support, 'close');
  let response = await fetch(app.url + '/api/platform/support/' + grant.support_token, {
    method: 'DELETE', headers: { Cookie: `gympass_platform=${owner.token}`, 'X-Requested-With': 'GymPASS' },
  });
  assert.equal(response.status, 200);
  assert.equal((await revoked)[0], 4003);
  const staff = await app.store.createMember(owner.session.user, a.id, { name: 'Caja', email: 'caja@example.test', role: 'operator', password: 'Prueba1234' });
  const login = await app.store.login({ email: 'caja@example.test', password: 'Prueba1234' });
  const socket = await connect(a.id, login.token);
  const changed = once(socket, 'close');
  response = await fetch(app.url + `/api/platform/gyms/${a.id}/members/${staff.id}`, {
    method: 'PATCH', headers: { Cookie: `gympass_platform=${a.login.token}`, 'X-Requested-With': 'GymPASS', 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'viewer' }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await changed)[0], 4003);
});

test('Inicio compacto conserva estadísticas y omite las series usadas solo en informes', { timeout: 15000 }, async t => {
  const { app, gyms: [a], request } = await fixture(t);
  await app.tenants.withTenant(a, async ctx => {
    const zone = randomUUID();
    ctx.db.raw.prepare('INSERT INTO zones(id,name) VALUES(?,?)').run(zone, 'Prueba');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz' }).format(new Date());
    const insert = ctx.db.raw.prepare(`INSERT INTO events(request_key,payload_hash,person_name,zone_id,zone_name,direction,method,allowed,reason,actor,occurred_at,local_date) VALUES(?,?,'Socio',?,'Prueba',?,'qr',?,'OK','test',?,?)`);
    for (const [direction, allowed] of [['entry', 1], ['exit', 1], ['entry', 0]])
      insert.run(randomUUID(), 'hash', zone, direction, allowed, Date.now(), today);
  });
  const full = await (await request(a.id, 'bootstrap')).json();
  const compact = await (await request(a.id, 'bootstrap?compact=1')).json();
  for (const key of ['installation_id', 'settings', 'stats', 'zones', 'schedules', 'events', 'today'])
    assert.deepEqual(compact[key], full[key], key);
  assert.deepEqual(compact.charts, { occupancy: [], zones: [], denied: [], heatmap: [] });
  assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length);
  assert.deepEqual([compact.stats.entries, compact.stats.exits, compact.stats.denied], [1, 1, 1]);
});

test('caché de archivos públicos respeta la versión y nunca reutiliza contenido privado', async t => {
  const directory = temporary(t);
  mkdirSync(join(directory, 'assets'));
  writeFileSync(join(directory, 'assets', 'app.js'), 'primera');
  let asset = await staticAsset(directory, '/assets/app.js');
  assert.equal((await staticBytes(asset)).toString(), 'primera');
  assert.strictEqual(await staticBytes(asset), await staticBytes(asset));
  writeFileSync(join(directory, 'assets', 'app.js'), 'segunda versión');
  asset = await staticAsset(directory, '/assets/app.js');
  assert.equal((await staticBytes(asset)).toString(), 'segunda versión');
  writeFileSync(join(directory, 'photo.png'), 'uno');
  const photo = await staticAsset(directory, '/photo.png');
  assert.notStrictEqual(await staticBytes(photo), await staticBytes(photo));
});
