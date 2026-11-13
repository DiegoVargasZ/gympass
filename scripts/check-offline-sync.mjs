import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { startPlatform } from "../server/platform.ts";
import { SqliteDatabase } from "../server/database.ts";
import { Backups } from "../server/backups.ts";
import { ReplicaClient } from "../server/replica-client.ts";
import { credentialVault } from "../server/credential-vault.ts";
import { Service, presenceSql } from "../lib/service.ts";
import { PosService } from "../lib/pos.ts";
import { syncChanges, mappedSyncPatch } from "../lib/replication.ts";

function temp(t) {
  const directory = mkdtempSync(join(tmpdir(), "gympass-offline-"));
  t.after(() => {
    const child = relative(tmpdir(), directory);
    assert.ok(child.startsWith("gympass-offline-") && !child.includes(sep));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
async function fixture(t) {
  const app = await startPlatform({
    dataDirectory: temp(t),
    port: 0,
    allowHttp: true,
  });
  const owner = await app.store.bootstrap({
    name: "Owner",
    email: "owner@example.test",
    password: "123456",
  });
  const gym = app.store.createGym(owner, {
    name: "Gym sin red",
    slug: "offline",
  });
  app.tenants.provision(gym);
  app.store.markGymProvisioned(gym.id);
  const users = {};
  for (const role of ["admin", "operator", "viewer"]) {
    users[role] = await app.store.createMember(owner, gym.id, {
      name: role,
      email: role + "@example.test",
      role,
      password: "123456",
    });
  }
  const admin = await app.store.login({
    email: "admin@example.test",
    password: "123456",
  });
  const request = async (
    path,
    method = "GET",
    body,
    token = admin.token,
    bearer = false,
  ) => {
    const response = await fetch(app.url + "/api/" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "GymPASS",
        ...(bearer
          ? { Authorization: "Bearer " + token }
          : { Cookie: "gympass_platform=" + token }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      response,
      data: await response
        .clone()
        .json()
        .catch(() => null),
    };
  };
  const cloud = (operation) =>
    app.tenants.withTenant(gym, (ctx) =>
      operation(
        new Service(ctx.db, { ...users.admin, role: "admin" }, ctx.codec),
        ctx,
      ),
    );
  const local = async (name) => {
    const root = temp(t),
      db = new SqliteDatabase(join(root, "gympass.sqlite"));
    const backups = new Backups(
      db.raw,
      join(root, "gympass.sqlite"),
      join(root, "backups"),
    );
    const replica = new ReplicaClient(db, root, backups, () => {});
    process.env.GYMPASS_SYNC_TEST = "1";
    const linked = await replica.link({
      server: app.url,
      email: "admin@example.test",
      password: "123456",
      name,
    });
    assert.equal(linked.linked, true);
    const service = () =>
      new Service(
        db,
        { ...users.admin, role: "admin" },
        credentialVault(join(root, "credentials.key")),
      );
    return { db, replica, service, root, backups };
  };
  return { app, owner, gym, users, admin, request, cloud, local };
}
const person = (document, name = document) => ({
  name,
  document,
  kind: "member",
  status: "active",
  phone: "59171234567",
});
const sale = (person_id, plan) => ({
  request_id: crypto.randomUUID(),
  person_id,
  payment_method: "cash",
  lines: [{ kind: "plan", id: plan.id, quantity: 1 }],
});

test('un gimnasio recién creado permite entrar con su administrador y preparar la copia de escritorio', async t => {
  const f = await fixture(t);
  let copy;
  try {
    const owner = await f.app.store.login({ email: 'owner@example.test', password: '123456' });
    const created = await f.request('platform/gyms', 'POST', {
      name: 'Nuevo gimnasio', slug: 'recien-creado', admin_name: 'Nueva administradora',
      admin_email: 'nueva@example.test', admin_password: 'nueva-clave',
    }, owner.token);
    assert.equal(created.response.status, 201);
    const login = await f.request('platform/login', 'POST', { email: 'nueva@example.test', password: 'nueva-clave' }, '');
    assert.equal(login.response.status, 200);
    assert.equal(login.data.gyms.length, 1);
    assert.equal(login.data.gyms[0].id, created.data.gym.id);
    const root = temp(t), db = new SqliteDatabase(join(root, 'gympass.sqlite'));
    copy = new ReplicaClient(db, root, new Backups(db.raw, join(root, 'gympass.sqlite'), join(root, 'backups')), () => {});
    process.env.GYMPASS_SYNC_TEST = '1';
    const result = await copy.link({ server: f.app.url, email: 'nueva@example.test', password: 'nueva-clave', name: 'Recepción nueva' });
    assert.equal(result.linked, true);
    assert.equal(copy.status().gym_id, created.data.gym.id);
    const member = db.raw.prepare('SELECT * FROM members WHERE email=?').get('nueva@example.test');
    const { verifyPassword } = await import('../server/auth.ts');
    assert.equal(await verifyPassword('nueva-clave', member.password_hash), true);
    assert.equal(member.user_id, login.data.user.id);
  } finally {
    if (copy) { await copy.stop(); copy.db.close(); }
    await f.app.close();
  }
});

async function whileNetworkWaits(operation) {
  let timer;
  try {
    return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('La espera de Internet bloqueó la copia local.')), 1500); })]);
  } finally { clearTimeout(timer); }
}

test('una descarga lenta no bloquea recepción ni reemplaza las ediciones hechas durante la espera', async t => {
  const f = await fixture(t);
  let copy, synchronization, release;
  try {
    const member = await f.cloud(s => s.savePerson(person('RESPONSIVE', 'Original')));
    copy = await f.local('Recepción disponible');
    await f.cloud(s => s.savePerson(person('RESPONSIVE', 'Nombre central'), member.id));
    const originalFetch = globalThis.fetch;
    const gate = new Promise(done => { release = done; });
    let started;
    const waiting = new Promise(done => { started = done; });
    let first = true;
    t.mock.method(globalThis, 'fetch', async (...args) => {
      const response = await originalFetch(...args);
      if (first && String(args[0]).includes('/sync/snapshot?')) { first = false; started(); await gate; }
      return response;
    });
    synchronization = copy.replica.synchronize();
    await waiting;
    await whileNetworkWaits(() => copy.replica.exclusive(async () => {
      assert.equal((await copy.service().personDetail(member.id)).name, 'Original');
      await copy.service().savePerson({ ...person('RESPONSIVE', 'Original'), notes: 'Edición local durante la descarga' }, member.id);
    }));
    release(); await synchronization;
    assert.equal(copy.replica.status().conflict, null, copy.replica.status().error);
    assert.equal(copy.replica.status().pending, 0);
    const local = await copy.service().personDetail(member.id);
    assert.equal(local.name, 'Nombre central');
    assert.equal(local.notes, 'Edición local durante la descarga');
    await f.cloud(async s => assert.equal((await s.personDetail(member.id)).notes, local.notes));
  } finally { release?.(); await synchronization; if (copy) { await copy.replica.stop(); copy.db.close(); } await f.app.close(); }
});

test('cobrar mientras se confirma otro lote conserva ambos pagos y sus QR sin duplicarlos', async t => {
  const f = await fixture(t);
  let copy, synchronization, release;
  try {
    const plan = await f.cloud(s => new PosService(s).savePlan({ name: 'Mes', unit: 'months', duration: 1, price_cents: 10000 }));
    copy = await f.local('Caja disponible');
    const first = await copy.service().savePerson(person('DURING-PUSH-1'));
    await new PosService(copy.service()).checkout(sale(first.id, plan));
    const originalFetch = globalThis.fetch;
    const gate = new Promise(done => { release = done; });
    let started;
    const waiting = new Promise(done => { started = done; });
    let pause = true;
    t.mock.method(globalThis, 'fetch', async (...args) => {
      const response = await originalFetch(...args);
      if (pause && String(args[0]).endsWith('/sync/push')) { pause = false; started(); await gate; }
      return response;
    });
    synchronization = copy.replica.synchronize(); await waiting;
    await whileNetworkWaits(() => copy.replica.exclusive(async () => {
      const second = await copy.service().savePerson(person('DURING-PUSH-2'));
      await new PosService(copy.service()).checkout(sale(second.id, plan));
    }));
    release(); await synchronization; await copy.replica.synchronize();
    assert.equal(copy.replica.status().pending, 0, copy.replica.status().error);
    assert.equal(copy.replica.status().conflict, null);
    await f.cloud((_s, ctx) => {
      assert.equal(ctx.db.raw.prepare('SELECT COUNT(*) n FROM pos_sales').get().n, 2);
      assert.equal(ctx.db.raw.prepare("SELECT COUNT(*) n FROM credentials WHERE kind='qr' AND active=1").get().n, 2);
    });
  } finally { release?.(); await synchronization; if (copy) { await copy.replica.stop(); copy.db.close(); } await f.app.close(); }
});

test('cerrar con Internet detenido cancela la espera y conserva el lote para el siguiente arranque', async t => {
  const f = await fixture(t);
  let copy, reopened;
  try {
    copy = await f.local('Cierre seguro');
    await copy.service().savePerson(person('PRESERVED-ON-CLOSE'));
    let started;
    const waiting = new Promise(done => { started = done; });
    const mock = t.mock.method(globalThis, 'fetch', async (_url, options) => {
      started();
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }));
    });
    const synchronization = copy.replica.synchronize(); await waiting;
    await whileNetworkWaits(() => copy.replica.stop()); await synchronization;
    const before = JSON.parse(copy.db.raw.prepare('SELECT state FROM replica_state WHERE id=1').get().state);
    assert.ok(before.pending?.id);
    assert.equal(copy.db.raw.prepare('SELECT COUNT(*) n FROM people').get().n, 1);
    mock.mock.restore();
    reopened = new ReplicaClient(copy.db, copy.root, copy.backups, () => {});
    await reopened.synchronize();
    assert.equal(reopened.status().pending, 0, reopened.status().error);
    await f.cloud((_s, ctx) => assert.equal(ctx.db.raw.prepare('SELECT COUNT(*) n FROM people').get().n, 1));
  } finally { if (reopened) await reopened.stop(); if (copy) { await copy.replica.stop(); copy.db.close(); } await f.app.close(); }
});

test('la foto para la copia móvil exige vinculación vigente y permanece aislada por gimnasio', async t => {
  const f = await fixture(t);
  try {
    const bytes = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
    const filename = crypto.randomUUID() + '.webp';
    const member = await f.cloud(async (s, ctx) => {
      const member = await s.savePerson(person('PHOTO'));
      mkdirSync(join(ctx.root, 'photos'), { recursive: true });
      writeFileSync(join(ctx.root, 'photos', filename), bytes);
      ctx.db.raw.prepare('UPDATE people SET photo_path=? WHERE id=?').run(filename, member.id);
      return member;
    });
    const login = await f.app.store.mobileLogin({ email: 'operator@example.test', password: '123456', gymId: f.gym.id });
    const paired = await f.request(`gyms/${f.gym.id}/sync/pair`, 'POST', { kind: 'mobile', name: 'Fotos' }, login.token, true);
    assert.equal(paired.response.status, 201);
    const path = `gyms/${f.gym.id}/sync/photo?person=${member.id}`;
    const photo = () => f.request(path, 'GET', undefined, paired.data.token, true);
    const result = await photo();
    assert.equal(result.response.status, 200);
    assert.equal(result.data.photo_path, filename);
    assert.equal(result.data.data_uri, 'data:image/webp;base64,' + bytes.toString('base64'));
    assert.match(result.response.headers.get('cache-control'), /no-store/);
    assert.equal((await f.request(path)).response.status, 401);
    assert.equal((await f.request(path, 'GET', undefined, login.token, true)).response.status, 401);
    assert.equal((await f.request(`gyms/${f.gym.id}/sync/photo?person=inexistente`, 'GET', undefined, paired.data.token, true)).response.status, 404);
    const other = f.app.store.createGym(f.owner, { name: 'Otro gimnasio', slug: 'other-photo' });
    f.app.tenants.provision(other);
    f.app.store.markGymProvisioned(other.id);
    const foreign = await f.request(`gyms/${other.id}/sync/photo?person=${member.id}`, 'GET', undefined, paired.data.token, true);
    assert.ok([401, 403].includes(foreign.response.status), 'la vinculación nunca entrega fotos de otro gimnasio');
    await f.cloud((_s, ctx) => ctx.db.raw.prepare('UPDATE people SET deleted_at=? WHERE id=?').run(Date.now(), member.id));
    assert.equal((await photo()).response.status, 404);
    await f.cloud((_s, ctx) => ctx.db.raw.prepare('UPDATE people SET deleted_at=NULL WHERE id=?').run(member.id));
    assert.equal((await f.request(`gyms/${f.gym.id}/sync/devices/${paired.data.id}`, 'DELETE')).response.status, 200);
    assert.equal((await photo()).response.status, 401);
  } finally {
    await f.app.close();
  }
});

test('la primera conexión descarga socios, cobros y el mismo QR y la copia persiste al volver a abrir sin red', async t => {
  const f = await fixture(t);
  let copy;
  let reopened;
  try {
    const member = await f.cloud(s => s.savePerson(person('CENTRAL-ANTES', 'Socio del servidor')));
    const plan = await f.cloud(s => new PosService(s).savePlan({ name: 'Mes central', unit: 'months', duration: 1, price_cents: 15000 }));
    const payment = await f.cloud(s => new PosService(s).checkout(sale(member.id, plan)));
    const card = await f.cloud(s => s.credentialCard(payment.credential.id));
    copy = await f.local('Copia automática inicial');
    assert.equal((await copy.service().personDetail(member.id)).name, 'Socio del servidor');
    assert.equal(copy.db.raw.prepare('SELECT COUNT(*) n FROM pos_sales').get().n, 1);
    assert.equal((await copy.service().credentialCard(payment.credential.id)).code, card.code);
    await copy.replica.stop();
    copy.db.close();
    reopened = new SqliteDatabase(join(copy.root, 'gympass.sqlite'));
    const replica = new ReplicaClient(reopened, copy.root, new Backups(reopened.raw, join(copy.root, 'gympass.sqlite'), join(copy.root, 'backups')), () => {});
    assert.equal(replica.linked, true);
    assert.equal(replica.status().gym_id, f.gym.id);
    const offline = t.mock.method(globalThis, 'fetch', async () => { throw Error('Sin Internet'); });
    await replica.synchronize();
    replica.requireWritable();
    assert.equal(reopened.raw.prepare('SELECT name FROM people WHERE id=?').get(member.id).name, 'Socio del servidor');
    assert.equal(reopened.raw.prepare('SELECT COUNT(*) n FROM pos_sales').get().n, 1);
    offline.mock.restore();
    await f.cloud(s => s.savePerson(person('CENTRAL-DESPUES', 'Cambio desde otro equipo')));
    await replica.synchronize();
    assert.equal(reopened.raw.prepare('SELECT COUNT(*) n FROM people').get().n, 2);
    assert.equal(replica.status().pending, 0);
    await replica.stop();
  } finally {
    if (reopened) reopened.close();
    else if (copy) { await copy.replica.stop(); copy.db.close(); }
    await f.app.close();
  }
});

test("escritorio funciona sin red y combina dos lotes tras una respuesta perdida sin duplicar pagos ni QR", async (t) => {
  const f = await fixture(t),
    desktops = [];
  try {
    const plan = await f.cloud((s) =>
      new PosService(s).savePlan({
        name: "Mes",
        unit: "months",
        duration: 1,
        price_cents: 10000,
      }),
    );
    const a = await f.local("Recepción A");
    desktops.push(a);
    const originalFetch = globalThis.fetch;
    const mock = t.mock.method(globalThis, "fetch", async (...args) => {
      if (String(args[0]).endsWith("/sync/push")) {
        await originalFetch(...args);
        throw Error("Respuesta perdida después de confirmar");
      }
      throw Error("Sin red");
    });
    const first = await a.service().savePerson(person("LOCAL-1"));
    const payment = await new PosService(a.service()).checkout(
      sale(first.id, plan),
    );
    const card = await a.service().credentialCard(payment.credential.id);
    const entry = await a.service().access({
      code: card.code,
      direction: "entry",
      request_id: crypto.randomUUID(),
    });
    assert.equal(entry.allowed, 1);
    await a.replica.synchronize();
    assert.ok(a.replica.status().pending > 0);
    // More operations must remain possible while an earlier upload is unconfirmed.
    a.replica.requireWritable();
    const second = await a.service().savePerson(person("LOCAL-2"));
    await new PosService(a.service()).checkout(sale(second.id, plan));
    mock.mock.restore();
    await a.replica.synchronize();
    assert.equal(
      a.replica.status().conflict,
      null,
      a.replica.status().error || "",
    );
    assert.equal(a.replica.status().pending, 0, a.replica.status().error || "");
    await f.cloud(async (s, ctx) => {
      assert.equal(
        ctx.db.raw.prepare("SELECT COUNT(*) n FROM pos_sales").get().n,
        2,
      );
      assert.equal(
        ctx.db.raw.prepare("SELECT COUNT(*) n FROM people").get().n,
        2,
      );
      assert.equal(
        (await s.credentialCard(payment.credential.id)).code,
        card.code,
      );
      assert.equal(
        ctx.db.raw.prepare(`SELECT COUNT(*) n FROM (${presenceSql})`).get().n,
        1,
      );
    });
    assert.equal(
      a.db.raw.prepare("SELECT COUNT(*) n FROM pos_sales").get().n,
      2,
    );
  } finally {
    for (const a of desktops) {
      await a.replica.stop();
      a.db.close();
    }
    await f.app.close();
  }
});

test("los cambios distintos se combinan y el mismo campo exige revisión sin reemplazar la base local", async (t) => {
  const f = await fixture(t),
    desktops = [];
  try {
    const original = await f.cloud((s) =>
      s.savePerson(person("SHARED", "Nombre original")),
    );
    const a = await f.local("A"),
      b = await f.local("B");
    desktops.push(a, b);
    await a.service().savePerson(person("SHARED", "Nombre A"), original.id);
    await b
      .service()
      .savePerson(
        { ...person("SHARED"), name: "Nombre original", phone: "59179999999" },
        original.id,
      );
    await a.replica.synchronize();
    await b.replica.synchronize();
    assert.equal(b.replica.status().pending, 0, b.replica.status().error);
    await f.cloud(async (s) => {
      const p = await s.personDetail(original.id);
      assert.equal(p.name, "Nombre A");
      assert.equal(p.phone, "59179999999");
    });
    await a.replica.synchronize();
    await a
      .service()
      .savePerson(
        { ...person("SHARED", "Cambio A"), phone: "59179999999" },
        original.id,
      );
    await b
      .service()
      .savePerson(
        { ...person("SHARED", "Cambio B"), phone: "59179999999" },
        original.id,
      );
    await a.replica.synchronize();
    await b.replica.synchronize();
    assert.ok(b.replica.status().conflict);
    assert.equal(
      (await b.service().personDetail(original.id)).name,
      "Cambio B",
    );
    const conflicts = await f.request(`gyms/${f.gym.id}/sync/conflicts`);
    assert.equal(conflicts.data.length, 1);
    const conflict = conflicts.data[0];
    await f.request(
      `gyms/${f.gym.id}/sync/conflicts/${conflict.device_id}/${conflict.batch_id}`,
      "POST",
      { confirm: "CONSERVAR NUBE" },
    );
    await b.replica.synchronize();
    assert.equal(b.replica.status().pending, 0);
    assert.equal(
      (await b.service().personDetail(original.id)).name,
      "Cambio A",
    );
    assert.ok(b.backups.list().length > 0);
  } finally {
    for (const a of desktops) {
      await a.replica.stop();
      a.db.close();
    }
    await f.app.close();
  }
});

test("solo el superadministrador crea y descarga respaldos de cada gimnasio", async (t) => {
  const f = await fixture(t);
  try {
    const ownerSession = await f.app.store.login({ email: "owner@example.test", password: "123456" });
    const copy = await f.request(`platform/gyms/${f.gym.id}/backups`, "POST", {}, ownerSession.token);
    assert.equal(copy.response.status, 201);
    for (const path of [`gyms/${f.gym.id}/backups`, `platform/gyms/${f.gym.id}/backups`]) {
      assert.equal((await f.request(path)).response.status, 403);
      assert.equal((await f.request(path, "POST", {})).response.status, 403);
      for (const suffix of [`/${copy.data.id}/inspect`, `/${copy.data.id}/export`]) assert.equal((await f.request(path + suffix)).response.status, 403);
      assert.equal((await f.request(path + "/import", "POST", {})).response.status, 403);
    }
    const exported = await f.request(
      `platform/gyms/${f.gym.id}/backups/${copy.data.id}/export`, "GET", undefined, ownerSession.token,
    );
    assert.equal(exported.response.status, 200);
    assert.match(
      exported.response.headers.get("content-disposition"),
      /gympassbackup/,
    );
    const operator = await f.app.store.login({
      email: "operator@example.test",
      password: "123456",
    });
    assert.equal(
      (
        await f.request(
          `gyms/${f.gym.id}/backups`,
          "GET",
          undefined,
          operator.token,
        )
      ).response.status,
      403,
    );
    assert.equal(
      (
        await f.request(
          `gyms/${f.gym.id}/backups/${copy.data.id}/restore`,
          "POST",
          { confirm: "RESTAURAR", password: "123456" },
        )
      ).response.status,
      403,
    );
    const owner = await f.app.store.login({
      email: "owner@example.test",
      password: "123456",
    });
    const created = await f.request(
      "platform/backups",
      "POST",
      { password: "123456" },
      owner.token,
    );
    assert.equal(created.response.status, 201);
    const full = await f.request(
      `platform/backups/${created.data.id}/export`,
      "GET",
      undefined,
      owner.token,
    );
    assert.equal(full.response.status, 200);
    const tar = gunzipSync(Buffer.from(await full.response.arrayBuffer()));
    assert.ok(tar.includes(Buffer.from("platform.sqlite")));
    assert.ok(tar.includes(Buffer.from(f.gym.id)));
    assert.equal(
      (await f.request("platform/backups", "GET")).response.status,
      403,
    );
  } finally {
    await f.app.close();
  }
});

test("un respaldo descargado se verifica, se importa y se restaura con una copia previa", async (t) => {
  const f = await fixture(t);
  try {
    const owner = await f.app.store.login({ email: "owner@example.test", password: "123456" });
    const privileged = (path, method = "GET", body) => f.request(path, method, body, owner.token);
    const endpoint = `platform/gyms/${f.gym.id}/backups`;
    await f.cloud((s) => s.savePerson(person("ANTES")));
    const created = await privileged(endpoint, "POST", {});
    assert.equal(created.response.status, 201);
    const id = created.data.id;
    const exported = await privileged(`${endpoint}/${id}/export`);
    assert.equal(exported.response.status, 200);
    const archive = Buffer.from(await exported.response.arrayBuffer());
    await f.cloud(async (s, ctx) => {
      await s.savePerson(person("DESPUES"));
      const original = join(ctx.backups.directory, id);
      renameSync(original, original + "-fuera-de-lista");
    });
    const upload = (body, token = owner.token) => fetch(f.app.url + "/api/" + endpoint + "/import", {
      method: "POST", body,
      headers: {
        Origin: f.app.url, "Content-Type": "application/octet-stream", "X-Requested-With": "GymPASS",
        Cookie: "gympass_platform=" + token,
      },
    });
    const operator = await f.app.store.login({ email: "operator@example.test", password: "123456" });
    assert.equal((await upload(archive, operator.token)).status, 403);
    const other = f.app.store.createGym(f.owner, { name: "Otro gimnasio", slug: "otro-backup" });
    f.app.tenants.provision(other);
    f.app.store.markGymProvisioned(other.id);
    const foreign = await f.app.tenants.withTenant(other, async (ctx) => ctx.backups.exportCopy(ctx.backups.create().id));
    const rejected = await upload(foreign.bytes);
    assert.equal(rejected.status, 409);
    assert.match((await rejected.json()).error, /otro gimnasio/);
    assert.equal((await upload(archive.subarray(0, archive.length - 1))).status, 400);
    assert.equal((await privileged(endpoint)).data.copies.length, 0);
    assert.ok(readdirSync(f.app.tenants.root).every((name) => !name.startsWith(".backup-upload-")));
    const imported = await upload(archive);
    assert.equal(imported.status, 201);
    const preview = await imported.json();
    assert.equal(preview.id, id);
    assert.equal(preview.people, 1);
    assert.equal((await upload(archive)).status, 201);
    assert.equal((await privileged(endpoint)).data.copies.length, 1);
    assert.equal(await f.cloud(async (_s, ctx) => ctx.db.raw.prepare("SELECT COUNT(*) n FROM people").get().n), 2);
    const support = await f.app.store.createSupport(owner.token, f.gym.id, "Recuperación de prueba");
    const restore = (password) => fetch(f.app.url + "/api/" + endpoint + "/" + id + "/restore", {
      method: "POST", body: JSON.stringify({ confirm: "RESTAURAR", password }),
      headers: {
        Origin: f.app.url, "Content-Type": "application/json", "X-Requested-With": "GymPASS",
        Cookie: "gympass_platform=" + owner.token, "X-GymPASS-Support": support.support_token,
      },
    });
    assert.equal((await restore("incorrecta")).status, 403);
    const restored = await restore("123456");
    assert.equal(restored.status, 200);
    const { safety } = await restored.json();
    assert.ok(safety);
    assert.equal(await f.cloud(async (_s, ctx) => ctx.db.raw.prepare("SELECT COUNT(*) n FROM people").get().n), 1);
    assert.equal((await privileged(`${endpoint}/${safety}/inspect`)).data.people, 2);
  } finally {
    await f.app.close();
  }
});

test("dos dispositivos no consumen dos veces la última sesión y las vinculaciones respetan bajas y permisos", async (t) => {
  const f = await fixture(t),
    desktops = [];
  try {
    const seeded = await f.cloud(async (s) => {
      const p = await s.savePerson(person("LAST-SESSION"));
      const pos = new PosService(s),
        plan = await pos.savePlan({
          name: "Una sesión",
          unit: "sessions",
          duration: 1,
          price_cents: 1000,
        });
      const payment = await pos.checkout(sale(p.id, plan));
      return { person: p, card: await s.credentialCard(payment.credential.id) };
    });
    const a = await f.local("A"),
      b = await f.local("B");
    desktops.push(a, b);
    for (const client of [a, b])
      assert.equal(
        (
          await client.service().access({
            code: seeded.card.code,
            direction: "entry",
            request_id: crypto.randomUUID(),
          })
        ).allowed,
        1,
      );
    await a.replica.synchronize();
    await b.replica.synchronize();
    assert.ok(b.replica.status().conflict);
    await f.cloud(async (_s, ctx) => {
      assert.equal(
        ctx.db.raw
          .prepare("SELECT sessions_remaining FROM pos_memberships")
          .get().sessions_remaining,
        0,
      );
      assert.equal(
        ctx.db.raw.prepare("SELECT COUNT(*) n FROM pos_membership_uses").get()
          .n,
        1,
      );
    });
    const operator = await f.app.store.mobileLogin({
      email: "operator@example.test",
      password: "123456",
      gymId: f.gym.id,
    });
    assert.equal(
      (
        await f.request(
          `gyms/${f.gym.id}/sync/pair`,
          "POST",
          { kind: "desktop", name: "No permitido" },
          operator.token,
          true,
        )
      ).response.status,
      403,
    );
    const mobile = await f.request(
      `gyms/${f.gym.id}/sync/pair`,
      "POST",
      { kind: "mobile", name: "Teléfono" },
      operator.token,
      true,
    );
    assert.equal(mobile.response.status, 201);
    const snapshot = await f.request(
      `gyms/${f.gym.id}/sync/snapshot`,
      "GET",
      undefined,
      mobile.data.token,
      true,
    );
    assert.equal(snapshot.response.status, 200);
    assert.equal(snapshot.data.assets, undefined);
    const unchanged = await f.request(
      `gyms/${f.gym.id}/sync/snapshot?revision=${snapshot.data.revision}`,
      "GET",
      undefined,
      mobile.data.token,
      true,
    );
    assert.equal(unchanged.response.status, 200);
    assert.equal(unchanged.data.unchanged, true);
    assert.equal(unchanged.data.tables, undefined);
    assert.equal(unchanged.data.assets, undefined);
    assert.equal(unchanged.data.issued_at, snapshot.data.issued_at);
    assert.equal(unchanged.data.expires_at, snapshot.data.expires_at);
    assert.ok(
      snapshot.data.tables
        .find((t) => t.name === "credentials")
        .rows.every((row) => row.code_cipher === null),
    );
    assert.equal(
      snapshot.data.tables.find((t) => t.name === "pos_sales"),
      undefined,
    );
    const malicious = {
      id: crypto.randomUUID(),
      gym_id: f.gym.id,
      installation_id: snapshot.data.installation_id,
      base_revision: snapshot.data.revision,
      issued_at: snapshot.data.issued_at,
      expires_at: snapshot.data.expires_at,
      changes: [{ table: "people", before: null, after: person("FAKE") }],
    };
    assert.equal(
      (
        await f.request(
          `gyms/${f.gym.id}/sync/push`,
          "POST",
          malicious,
          mobile.data.token,
          true,
        )
      ).response.status,
      403,
    );
    f.app.store.updateGym(f.owner, f.gym.id, { archived: true });
    assert.equal(
      (
        await f.request(
          `gyms/${f.gym.id}/sync/snapshot`,
          "GET",
          undefined,
          mobile.data.token,
          true,
        )
      ).response.status,
      403,
    );
  } finally {
    for (const a of desktops) {
      await a.replica.stop();
      a.db.close();
    }
    await f.app.close();
  }
});


test('apariencia del gimnasio se comparte entre copias y la reconexión automática se intenta cada diez segundos', async t => {
  const f = await fixture(t), copies = [];
  let connected = true;
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (...args) => {
    if (!connected && String(args[0]).startsWith(f.app.url)) throw Error('Sin Internet');
    return originalFetch(...args);
  });
  const settle = async copy => {
    for (let i = 0; i < 1000 && copy.replica.status().syncing; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(copy.replica.status().syncing, false);
  };
  try {
    const first = await f.local('Apariencia A'), second = await f.local('Apariencia B'); copies.push(first, second);
    connected = false;
    await first.service().updateSettings({ ui_theme: 'dark', ui_accent: '#2455a4', ui_density: 'compact' });
    await first.replica.synchronize();
    assert.ok(first.replica.status().pending > 0);
    assert.equal((await f.cloud(s => s.one('SELECT ui_theme FROM settings'))).ui_theme, 'light');
    t.mock.timers.enable({ apis: ['setInterval'] });
    first.replica.start(); second.replica.start(); await settle(first); await settle(second);
    connected = true;
    t.mock.timers.tick(9999); await new Promise(resolve => setImmediate(resolve));
    assert.equal(first.replica.status().online, false);
    t.mock.timers.tick(1); await settle(first); await settle(second);
    assert.equal(first.replica.status().pending, 0);
    t.mock.timers.tick(10000); await settle(second); await settle(first);
    const appearance = db => db.raw.prepare('SELECT ui_theme,ui_accent,ui_density FROM settings').get();
    assert.deepEqual({ ...appearance(second.db) }, { ui_theme: 'dark', ui_accent: '#2455a4', ui_density: 'compact' });
    assert.deepEqual({ ...appearance(first.db) }, { ...appearance(second.db) });
  } finally { for (const copy of copies) { await copy.replica.stop(); copy.db.close(); } await f.app.close(); }
});
