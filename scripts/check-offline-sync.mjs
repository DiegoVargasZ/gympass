import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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

test("administradores descargan sus respaldos; cajeros y otros gimnasios no reciben copias", async (t) => {
  const f = await fixture(t);
  try {
    const copy = await f.request(`gyms/${f.gym.id}/backups`, "POST", {});
    assert.equal(copy.response.status, 201);
    const exported = await f.request(
      `gyms/${f.gym.id}/backups/${copy.data.id}/export`,
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
