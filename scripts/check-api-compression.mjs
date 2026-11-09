import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { get } from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { startPlatform } from '../server/platform.ts';

async function fixture(t) {
  let app;
  const directory = mkdtempSync(join(tmpdir(), 'gympass-compression-'));
  t.after(async () => {
    if (app?.server.listening) await app.close();
    const target = relative(tmpdir(), directory);
    assert.ok(target.startsWith('gympass-compression-') && !target.includes(sep));
    rmSync(directory, { recursive: true, force: true });
  });
  app = await startPlatform({ dataDirectory: directory, port: 0, allowHttp: true });
  await app.store.bootstrap({ name: 'Owner', email: 'owner@example.test', password: 'Prueba1234' });
  const owner = await app.store.login({ email: 'owner@example.test', password: 'Prueba1234' });
  const gym = app.store.createGym(owner.session.user, { name: 'uno', slug: 'uno' });
  app.tenants.provision(gym);
  app.store.markGymProvisioned(gym.id);
  const invite = app.store.invite(owner.session.user, gym.id, { name: 'admin', email: 'admin@example.test', role: 'admin' });
  await app.store.acceptInvitation({ token: invite.token, name: 'admin', password: 'Prueba1234' });
  const login = await app.store.login({ email: 'admin@example.test', password: 'Prueba1234' });
  // Fichas suficientes para que el listado pase del umbral de compresion.
  await app.tenants.withTenant(gym, async (ctx) => {
    const insert = ctx.db.raw.prepare(
      'INSERT INTO people(id,name,document,kind,status,created_at,legacy_access) VALUES(?,?,?,?,?,?,1)',
    );
    for (let index = 0; index < 120; index++)
      insert.run('p' + index, 'Persona De Prueba ' + index, 'DOC' + index, 'member', 'active', Date.now());
  });
  // fetch() de Node fija su propio Accept-Encoding y descomprime por su cuenta, asi que
  // la peticion va por http para poder ver los bytes tal como salen del servidor.
  const request = (path, encoding) =>
    new Promise((resolve, reject) => {
      const target = new URL(app.url + `/api/gyms/${gym.id}/${path}`);
      const headers = { Cookie: `gympass_platform=${login.token}` };
      if (encoding) headers['Accept-Encoding'] = encoding;
      const call = get({ hostname: target.hostname, port: target.port, path: target.pathname, headers }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }),
        );
      });
      call.on('error', reject);
    });
  return { request };
}

test('una respuesta JSON grande viaja comprimida y conserva exactamente su contenido', async (t) => {
  const { request } = await fixture(t);
  const compressed = await request('people', 'br');
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers['content-encoding'], 'br');
  assert.equal(compressed.headers.vary, 'Accept-Encoding');
  assert.equal(Number(compressed.headers['content-length']), compressed.body.length);

  const plain = await request('people', 'identity');
  assert.equal(plain.headers['content-encoding'], undefined);
  // Descomprimir tiene que devolver exactamente los mismos bytes que la version sin comprimir.
  assert.deepEqual(brotliDecompressSync(compressed.body), plain.body);
  const people = JSON.parse(plain.body.toString('utf8'));
  assert.equal(people.rows.length, 50, 'el listado paginado debe traer una pagina completa');
  assert.ok(plain.body.length > 1400, 'la pagina debe pasar del umbral de compresion');

  assert.ok(
    compressed.body.length < plain.body.length / 2,
    `comprimido ${compressed.body.length} frente a ${plain.body.length} sin comprimir`,
  );
});

test('gzip sirve a los clientes que no aceptan brotli y las respuestas chicas no se comprimen', async (t) => {
  const { request } = await fixture(t);
  const gzipped = await request('people', 'gzip');
  assert.equal(gzipped.headers['content-encoding'], 'gzip');
  assert.equal(JSON.parse(gunzipSync(gzipped.body).toString('utf8')).rows.length, 50);

  // Un cliente que no acepta nada recibe el original, nunca un cuerpo que no sabe leer.
  const none = await request('people', 'br;q=0, gzip;q=0');
  assert.equal(none.headers['content-encoding'], undefined);

  // Por debajo del umbral comprimir solo gastaria CPU: la respuesta sale tal cual.
  const small = await request('alerts', 'br, gzip');
  assert.equal(small.status, 200);
  assert.equal(small.headers['content-encoding'], undefined);
  assert.equal(small.headers.vary, 'Accept-Encoding');
});
