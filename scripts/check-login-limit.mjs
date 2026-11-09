import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPlatform } from '../server/platform.ts';
import { createLoginLimiter, clientAddressResolver } from '../server/auth-rate-limit.ts';
import { ApiError } from '../lib/service.ts';

const request = (ip, forwarded) => ({ socket: { remoteAddress: ip }, headers: { 'x-forwarded-for': forwarded } });
const response = () => ({ headers: {}, setHeader(key, value) { this.headers[key] = value; } });

test('solo los proxies configurados pueden identificar al cliente; la cadena se recorre desde el servidor', () => {
  assert.equal(clientAddressResolver()(request('127.0.0.1', '198.51.100.2')), '127.0.0.1');
  const address = clientAddressResolver('127.0.0.1/32,::1,10.0.0.0/8');
  assert.equal(address(request('::ffff:127.0.0.1', '198.51.100.2')), '198.51.100.2');
  assert.equal(address(request('127.0.0.1', '1.2.3.4,198.51.100.2,10.2.3.4')), '198.51.100.2');
  assert.equal(address(request('203.0.113.9', '198.51.100.2')), '203.0.113.9');
  assert.equal(address(request('127.0.0.1', 'garbage')), '127.0.0.1');
  for (const value of ['*', '127.0.0.1/33', '::1/129', '10.0.0.1/', 'localhost']) assert.throws(() => clientAddressResolver(value));
});

test('los éxitos no agotan el cupo, los fallos normalizan la cuenta y el bloqueo caduca', async () => {
  let now = 100;
  const limit = createLoginLimiter('', () => now), req = request('127.0.0.1'), res = response();
  for (let i = 0; i < 40; i++) assert.equal(await limit(req, res, 'valid@example.test', async () => 'ok'), 'ok');
  for (let i = 0; i < 30; i++) await assert.rejects(() => limit(req, res, ' Bad@Example.test ', async () => { throw new ApiError(401, 'incorrecto'); }), { status: 401 });
  await assert.rejects(() => limit(req, res, 'bad@example.test', async () => 'unexpected'), { status: 429 });
  assert.equal(res.headers['Retry-After'], '900');
  assert.equal(await limit(req, res, 'valid@example.test', async () => 'ok'), 'ok');
  now += 15 * 60_000;
  assert.equal(await limit(req, res, 'bad@example.test', async () => 'ok'), 'ok');
});

test('los intentos simultáneos no evaden el límite de cuenta', async () => {
  const limit = createLoginLimiter(), req = request('127.0.0.1'), res = response();
  let release;
  const gate = new Promise((done) => { release = done; });
  const pending = Array.from({ length: 30 }, () => limit(req, res, 'busy@example.test', async () => { await gate; throw new ApiError(401, 'incorrecto'); }).catch((error) => error.status));
  await assert.rejects(() => limit(req, res, 'busy@example.test', async () => 'unexpected'), { status: 429 });
  release();
  assert.deepEqual(await Promise.all(pending), Array(30).fill(401));
});

test('HTTP: fallos detrás del mismo proxy no bloquean otra cuenta y web/móvil comparten protección', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gympass-login-'));
  const app = await startPlatform({ dataDirectory: directory, allowHttp: true, port: 0 });
  try {
    await app.store.bootstrap({ name: 'Owner', email: 'owner@example.test', password: 'owner-secret' });
    const login = (email, password, mobile = false) => fetch(app.url + '/api/platform/' + (mobile ? 'mobile-login' : 'login'), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'GymPASS', 'X-Forwarded-For': '203.0.113.50' }, body: JSON.stringify({ email, password }),
    });
    for (let i = 0; i < 31; i++) {
      const failed = await login('missing' + i + '@example.test', 'incorrect');
      assert.equal(failed.status, 401); await failed.text();
    }
    const valid = await login('owner@example.test', 'owner-secret');
    assert.equal(valid.status, 200); await valid.text();
    for (let i = 0; i < 30; i++) {
      const failed = await login('bad@example.test', 'incorrect', i % 2 === 0);
      assert.equal(failed.status, 401); await failed.text();
    }
    const blocked = await login(' BAD@EXAMPLE.TEST ', 'incorrect', true);
    assert.equal(blocked.status, 429); assert.ok(Number(blocked.headers.get('retry-after')) > 0); await blocked.text();
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
