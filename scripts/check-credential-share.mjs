import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { startPlatform } from '../server/platform.ts';
import { Service } from '../lib/service.ts';

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'gympass-share-'));
  t.after(() => {
    const target = relative(tmpdir(), directory);
    assert.ok(target.startsWith('gympass-share-') && !target.includes(sep));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** A valid 1x1 PNG. */
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('los enlaces de credencial son privados, vencen y dejan de servir al anular la credencial', async (t) => {
  const data = temporary(t);
  const app = await startPlatform({ dataDirectory: data, port: 0, allowHttp: true });
  try {
    const owner = await app.store.bootstrap({ name: 'Owner', email: 'owner@example.test', password: '123456' });
    const gym = app.store.createGym(owner, { name: 'Gym Prueba', slug: 'share' });
    app.tenants.provision(gym);
    app.store.markGymProvisioned(gym.id);
    for (const role of ['admin', 'viewer'])
      await app.store.createMember(owner, gym.id, { name: role, email: role + '@example.test', role, password: '123456' });
    const login = (role) => app.store.login({ email: role + '@example.test', password: '123456' });
    const admin = await login('admin'),
      viewer = await login('viewer');
    const request = (path, session, method = 'GET', body, headers = {}) =>
      fetch(app.url + path, {
        method,
        headers: session
          ? { Cookie: `gympass_platform=${session.token}`, 'X-Requested-With': 'GymPASS', ...headers }
          : headers,
        ...(body ? { body } : {}),
      });
    const credential = await app.tenants.withTenant(gym, async (ctx) => {
      const service = new Service(ctx.db, { ...admin.session.user, role: 'admin' }, ctx.codec);
      const person = await service.savePerson({ name: 'Ana <b>Pérez</b>', document: 'AP1', phone: '59171234567', kind: 'member', status: 'active' });
      return service.issueCredential(person.id, { kind: 'qr', label: 'Tarjeta' });
    });
    const upload = (session, body = png, type = 'image/png') =>
      request(`/api/gyms/${gym.id}/credentials/${credential.id}/share`, session, 'PUT', body, { 'Content-Type': type });

    // Only people who may download the card can create a link, and only PNG images.
    assert.equal((await upload(viewer)).status, 403);
    assert.ok([401, 403].includes((await upload(null)).status));
    assert.equal((await upload(admin, Buffer.from('not an image'))).status, 415);
    assert.equal((await upload(admin, png, 'text/html')).status, 415);
    const created = await upload(admin);
    assert.equal(created.status, 200);
    const { path, expires_at } = await created.json();
    assert.match(path, new RegExp(`^/c/${gym.id}/[A-Za-z0-9_-]{32}$`));
    assert.ok(expires_at > Date.now() + 6 * 24 * 3600 * 1000 && expires_at <= Date.now() + 7 * 24 * 3600 * 1000);

    // The link needs no session and serves a preview page and the exact image.
    const page = await request(path);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(page.headers.get('x-robots-tag'), /noindex/);
    const html = await page.text();
    assert.ok(html.includes(`og:image" content="${app.url}${path}.png"`));
    assert.ok(html.includes('Credencial de Ana &lt;b&gt;Pérez&lt;/b&gt;') && !html.includes('<b>Pérez'));
    const image = await request(path + '.png');
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);

    // Wrong token, wrong gym and malformed paths reveal nothing.
    const token = path.split('/').at(-1);
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    assert.equal((await request(`/c/${gym.id}/${flipped}`)).status, 404);
    assert.equal((await request(`/c/${randomUUID()}/${token}`)).status, 404);
    // A malformed token falls through to the application shell, never to a credential.
    assert.ok(!(await (await request(`/c/${gym.id}/${token}x`)).text()).includes('og:image'));
    assert.equal((await request(path, null, 'POST')).status, 404);

    // A new link for the same credential replaces the previous one.
    const second = await (await upload(admin)).json();
    assert.equal((await request(path)).status, 404);
    assert.equal((await request(second.path)).status, 200);
    const directory = join(data, 'tenants', gym.id, 'shares');
    assert.equal(readdirSync(directory).filter((name) => name.endsWith('.png')).length, 1);

    // Links expire.
    const sidecar = join(directory, readdirSync(directory).find((name) => name.endsWith('.json')));
    const saved = readFileSync(sidecar, 'utf8');
    writeFileSync(sidecar, JSON.stringify({ ...JSON.parse(saved), expires_at: Date.now() - 1 }));
    assert.equal((await request(second.path)).status, 404);
    assert.deepEqual(readdirSync(directory), []);

    // Revoking the credential invalidates its link.
    const third = await (await upload(admin)).json();
    assert.equal((await request(third.path)).status, 200);
    assert.equal((await request(`/api/gyms/${gym.id}/credentials/${credential.id}`, admin, 'PATCH', '{}', { 'Content-Type': 'application/json' })).status, 200);
    assert.equal((await request(third.path)).status, 404);
  } finally {
    await app.close();
  }
});
