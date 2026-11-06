import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  existsSync,
  lstatSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { startPlatform } from "../server/platform.ts";
import { TenantManager } from "../server/tenant-manager.ts";
import { Service } from "../lib/service.ts";
import { PosService } from "../lib/pos.ts";

test("WhatsApp obligatorio y QR mensual atómico e idempotente", async (t) => {
  const directory = temporary(t),
    manager = new TenantManager(directory);
  const gym = { id: randomUUID(), name: "Cobro mensual" };
  try {
    manager.provision(gym);
    await manager.withTenant(gym, async (ctx) => {
      const s = new Service(
        ctx.db,
        {
          id: gym.id,
          email: "admin@example.test",
          name: "Admin",
          role: "admin",
        },
        ctx.codec,
      );
      await assert.rejects(
        () =>
          s.savePerson({
            name: "Sin teléfono",
            document: "NO",
            kind: "member",
            status: "active",
          }),
        /WhatsApp/,
      );
      const person = await s.savePerson({
        name: "Socio",
        document: "MONTH",
        kind: "member",
        status: "active",
        phone: "59171234567",
      });
      const old = await s.issueCredential(person.id, {
        kind: "qr",
        label: "Anterior",
      });
      const pos = new PosService(s),
        plan = await pos.savePlan({
          name: "Mes",
          unit: "months",
          duration: 1,
          price_cents: 10000,
        });
      const body = {
        request_id: randomUUID(),
        person_id: person.id,
        payment_method: "cash",
        lines: [{ kind: "plan", id: plan.id, quantity: 1 }],
      };
      const [a, b] = await Promise.all([
        pos.checkout(body),
        pos.checkout(body),
      ]);
      assert.equal(a.credential.id, b.credential.id);
      assert.notEqual(a.credential.id, old.id);
      assert.notEqual((await s.credentialCard(a.credential.id)).code, old.code);
      assert.equal(
        ctx.db.raw
          .prepare("SELECT active FROM credentials WHERE id=?")
          .get(old.id).active,
        0,
      );
      assert.equal(
        ctx.db.raw.prepare("SELECT COUNT(*) n FROM credentials").get().n,
        2,
      );
      const operator = new Service(
        ctx.db,
        {
          id: "cashier",
          email: "cashier@example.test",
          name: "Caja",
          role: "operator",
        },
        ctx.codec,
      );
      assert.equal(
        (await operator.credentialCard(a.credential.id)).id,
        a.credential.id,
      );
      ctx.db.raw
        .prepare("UPDATE people SET phone='' WHERE id=?")
        .run(person.id);
      await assert.rejects(
        () => pos.checkout({ ...body, request_id: randomUUID() }),
        /WhatsApp/,
      );
      ctx.db.raw
        .prepare("UPDATE people SET phone=? WHERE id=?")
        .run("59171234567", person.id);
      const product = await pos.saveProduct({
        name: "Sin stock",
        price_cents: 500,
        stock: 0,
        track_stock: 1,
        active: 1,
      });
      await assert.rejects(() =>
        pos.checkout({
          ...body,
          request_id: randomUUID(),
          replace_active: { reason: "Intento de renovación" },
          lines: [
            ...body.lines,
            { kind: "product", id: product.id, quantity: 1 },
          ],
        }),
      );
      assert.equal(
        (await s.credentialCard(a.credential.id)).id,
        a.credential.id,
      );
      assert.equal(
        ctx.db.raw.prepare("SELECT COUNT(*) n FROM pos_sales").get().n,
        1,
      );
      await assert.rejects(
        () =>
          pos.checkout({
            ...body,
            request_id: randomUUID(),
            expected_total_cents: 1,
          }),
        /plan|precio|curso/i,
      );
      assert.equal(
        ctx.db.raw.prepare("SELECT COUNT(*) n FROM credentials").get().n,
        2,
      );
      const renewal = await pos.checkout({
        ...body,
        request_id: randomUUID(),
      });
      assert.notEqual(renewal.credential.id, a.credential.id);
      assert.equal((await pos.sale(a.id)).credential.active, 0);
      assert.equal((await pos.sale(renewal.id)).credential.active, 1);
      assert.equal((await pos.checkout(body)).credential.id, a.credential.id);
      assert.equal(
        ctx.db.raw.prepare("SELECT COUNT(*) n FROM credentials").get().n,
        3,
      );
      await pos.voidSale(renewal.id, { reason: "Renovación cancelada" });
      assert.equal(
        (await operator.credentialCard(renewal.credential.id)).id,
        renewal.credential.id,
      );
      await assert.rejects(
        () => operator.credentialCard(a.credential.id),
        /QR activa/i,
      );
      const cashierPos = new PosService(operator);
      const registration = {
        request_id: randomUUID(),
        new_member: {
          name: "Alta desde Caja",
          document: "CAJA-NEW",
          phone: "59171234567",
          kind: "member",
          status: "active",
        },
        payment_method: "cash",
        lines: [{ kind: "plan", id: plan.id, quantity: 1 }],
      };
      await assert.rejects(() => operator.savePerson(registration.new_member), {
        status: 403,
      });
      await assert.rejects(
        () =>
          cashierPos.checkout({
            ...registration,
            new_member: { ...registration.new_member, kind: "employee" },
          }),
        { status: 403 },
      );
      await assert.rejects(
        () =>
          cashierPos.checkout({
            ...registration,
            new_member: {
              ...registration.new_member,
              zone_ids: ["restricted"],
            },
          }),
        { status: 403 },
      );
      await assert.rejects(() =>
        cashierPos.checkout({
          ...registration,
          lines: [
            ...registration.lines,
            { kind: "product", id: product.id, quantity: 1 },
          ],
        }),
      );
      assert.equal(
        ctx.db.raw
          .prepare("SELECT COUNT(*) n FROM people WHERE document='CAJA-NEW'")
          .get().n,
        0,
      );
      assert.equal(
        ctx.db.raw.prepare("SELECT COUNT(*) n FROM credentials").get().n,
        3,
      );
      const registeredSale = await cashierPos.checkout(registration);
      assert.equal(
        (await cashierPos.checkout(registration)).id,
        registeredSale.id,
      );
      assert.equal(
        (await operator.credentialCard(registeredSale.credential.id)).person_id,
        registeredSale.person_id,
      );
      assert.equal(
        ctx.db.raw
          .prepare("SELECT COUNT(*) n FROM people WHERE document='CAJA-NEW'")
          .get().n,
        1,
      );
    });
  } finally {
    await manager.close();
  }
});

const root = resolve(import.meta.dirname, "..");

test("lectores: comprobar la clave no registra accesos y respeta gimnasio y revocación", async (t) => {
  const app = await startPlatform({
    dataDirectory: temporary(t),
    host: "127.0.0.1",
    port: 0,
    allowHttp: true,
  });
  try {
    await app.store.bootstrap({
      name: "Owner",
      email: "reader@example.test",
      password: "Reader-Test-430",
    });
    const owner = await app.store.login({
      email: "reader@example.test",
      password: "Reader-Test-430",
    });
    const gyms = ["a", "b"].map((suffix) => {
      const gym = app.store.createGym(owner.session.user, {
        name: "Lector " + suffix,
        slug: "reader-" + suffix,
      });
      app.tenants.provision(gym);
      app.store.markGymProvisioned(gym.id);
      return gym;
    });
    for (const [index, gym] of gyms.entries()) {
      const invitation = app.store.invite(owner.session.user, gym.id, {
        email: "reader-admin-" + index + "@example.test",
        name: "Admin",
        role: "admin",
      });
      await app.store.acceptInvitation({
        token: invitation.token,
        name: "Admin",
        password: "Reader-Test-430",
      });
    }
    let device;
    await app.tenants.withTenant(gyms[0], async (ctx) => {
      const service = new Service(
        ctx.db,
        {
          id: owner.session.user.id,
          email: "reader@example.test",
          name: "Owner",
          role: "admin",
        },
        ctx.codec,
      );
      device = await service.createDevice({
        name: "Huella recepción",
        kind: "biometric",
        direction: "entry",
      });
    });
    const check = (gym, token = device.token) =>
      fetch(app.url + "/api/gyms/" + gym.id + "/device-check", {
        headers: { Authorization: "Bearer " + token },
      });
    const response = await check(gyms[0]);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.device.id, device.id);
    assert.equal(result.device.kind, "biometric");
    assert.ok(!JSON.stringify(result).includes(device.token));
    assert.equal((await check(gyms[0], "wrong_key")).status, 401);
    assert.equal((await check(gyms[1])).status, 401);
    app.store.updateGym(owner.session.user, gyms[0].id, {
      status: "suspended",
    });
    assert.equal((await check(gyms[0])).status, 403);
    app.store.updateGym(owner.session.user, gyms[0].id, { status: "active" });
    await app.tenants.withTenant(gyms[0], async (ctx) => {
      assert.equal(
        ctx.db.raw.prepare("SELECT COUNT(*) n FROM events").get().n,
        0,
      );
      assert.equal(
        ctx.db.raw
          .prepare("SELECT last_seen FROM devices WHERE id=?")
          .get(device.id).last_seen,
        null,
      );
      const service = new Service(
        ctx.db,
        {
          id: owner.session.user.id,
          email: "reader@example.test",
          name: "Owner",
          role: "admin",
        },
        ctx.codec,
      );
      await service.revokeDevice(device.id);
    });
    assert.equal((await check(gyms[0])).status, 401);
  } finally {
    await app.close();
  }
});

test("compartir recupera el QR activo y el teléfono del socio sin emitir otra credencial", async (t) => {
  const directory = temporary(t),
    manager = new TenantManager(directory);
  const gym = { id: randomUUID(), name: "Gimnasio de prueba" };
  try {
    manager.provision(gym);
    await manager.withTenant(gym, async (context) => {
      const service = new Service(
        context.db,
        {
          id: gym.id,
          email: "admin@example.test",
          name: "Admin",
          role: "admin",
        },
        context.codec,
      );
      const person = await service.savePerson({
        name: "Socio de prueba",
        document: "CI-QR",
        phone: "+591 71234567",
        kind: "member",
        status: "active",
      });
      const issued = await service.issueCredential(person.id, {
        kind: "qr",
        label: "Principal",
      });
      const card = await service.credentialCard(issued.id);
      assert.equal(card.code, issued.code);
      const row = (
        await service.credentialList(new URLSearchParams())
      ).rows.find((item) => item.id === issued.id);
      assert.equal(row.phone, "59171234567");
      assert.equal(
        context.db.raw
          .prepare("SELECT COUNT(*) n FROM credentials WHERE person_id=?")
          .get(person.id).n,
        1,
      );
      const operator = new Service(
        context.db,
        {
          id: "operator",
          email: "operator@example.test",
          name: "Cajero",
          role: "operator",
        },
        context.codec,
      );
      await assert.rejects(() => operator.credentialCard(issued.id), {
        status: 403,
      });
      await service.revokeCredential(issued.id);
      await assert.rejects(() => service.credentialCard(issued.id), {
        status: 409,
      });
    });
  } finally {
    await manager.close();
  }
});
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "gympass-ci-"));
  t.after(() => {
    const path = relative(resolve(tmpdir()), directory);
    assert.ok(path.startsWith("gympass-ci-") && !path.includes(sep));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test("el despliegue contiene interfaz y migraciones y excluye datos, enlaces y secretos", () => {
  const html = readFileSync(join(root, "dist/index.html"), "utf8");
  for (const [, asset] of html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g))
    assert.ok(existsSync(join(root, "dist", asset)), asset);
  assert.ok(
    existsSync(join(root, "server/migrations/017_one_plan_per_member.sql")),
  );
  const forbidden =
    /^(?:node_modules|data|platform-data|backups|platform-backups|\.env(?:\..*)?|activation-secret\..*|credentials\.json)$|\.(?:sqlite(?:-wal|-shm)?|db|key|pem|pfx|p12|jks|keystore)$/i;
  function inspect(directory) {
    for (const entry of readdirSync(directory)) {
      assert.ok(!forbidden.test(entry), `Archivo privado: ${entry}`);
      const path = join(directory, entry),
        info = lstatSync(path);
      assert.ok(!info.isSymbolicLink(), `Enlace en la entrega: ${path}`);
      if (info.isDirectory()) inspect(path);
    }
  }
  for (const directory of ["server", "lib", "scripts", "dist"])
    inspect(join(root, directory));
});

test("la plataforma inicia, sirve la interfaz y conserva la protección de origen", async (t) => {
  const directory = temporary(t);
  const origin = "https://gympass.site";
  const app = await startPlatform({
    dataDirectory: directory,
    host: "127.0.0.1",
    port: 0,
    publicOrigin: origin,
  });
  try {
    const health = await fetch(app.url + "/api/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      mode: "platform",
      protocol: 1,
    });
    const html = await fetch(app.url + "/");
    assert.equal(html.status, 200);
    assert.equal(
      await html.text(),
      readFileSync(join(root, "dist/index.html"), "utf8"),
    );
    const logout = (requestOrigin) =>
      fetch(app.url + "/api/platform/logout", {
        method: "POST",
        headers: {
          Origin: requestOrigin,
          "X-Requested-With": "GymPASS",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
    assert.equal((await logout(origin)).status, 401);
    assert.equal((await logout("https://otro.example")).status, 403);
  } finally {
    await app.close();
  }
});

test("el cierre diario respeta zonas horarias y mantiene aislados los gimnasios", async (t) => {
  const manager = new TenantManager(temporary(t));
  const gyms = [
    { id: randomUUID(), name: "Bolivia", timezone: "America/La_Paz" },
    { id: randomUUID(), name: "Tokio", timezone: "Asia/Tokyo" },
  ];
  try {
    for (const gym of gyms) {
      manager.provision(gym);
      await manager.withTenant(gym, async (ctx) => {
        const service = new Service(ctx.db, {
          id: gym.id,
          email: "admin@example.test",
          name: "Admin",
          role: "admin",
        });
        await service.updateSettings({
          timezone: gym.timezone,
          closing_time: "23:00",
          auto_close_hours: 0,
        });
        const person = await service.savePerson({
          name: "Socio",
          document: gym.name,
          kind: "employee",
          status: "active",
          zone_ids: ["general"],
        });
        await service.access(
          {
            person_id: person.id,
            reason: "Registro de prueba",
            zone_id: "general",
            direction: "auto",
            request_id: randomUUID(),
          },
          undefined,
          new Date("2026-11-05T10:00:00Z"),
        );
      });
    }
    await manager.maintain(gyms, new Date("2026-11-05T15:00:00Z"));
    for (const [index, gym] of gyms.entries()) {
      await manager.withTenant(gym, async (ctx) => {
        const rows = ctx.db.raw
          .prepare("SELECT * FROM events WHERE reason='AUTO_CLOSE'")
          .all();
        assert.equal(rows.length, index === 0 ? 0 : 1);
        if (rows.length)
          assert.equal(rows[0].occurred_at, Date.parse("2026-11-05T14:00:00Z"));
      });
    }
    await manager.maintain(gyms, new Date("2026-11-06T03:00:00Z"));
    await manager.withTenant(gyms[0], async (ctx) => {
      const row = ctx.db.raw
        .prepare("SELECT * FROM events WHERE reason='AUTO_CLOSE'")
        .get();
      assert.equal(row.occurred_at, Date.parse("2026-11-06T03:00:00Z"));
      assert.equal(row.local_date, "2026-11-05");
    });
  } finally {
    await manager.close();
  }
});

test("el administrador crea personal sin invitación y gestiona sólo su gimnasio", async (t) => {
  const app = await startPlatform({
    dataDirectory: temporary(t),
    port: 0,
    allowHttp: true,
  });
  try {
    const owner = await app.store.bootstrap({
      name: "Owner",
      email: "owner@staff.test",
      password: "owner-secret",
    });
    const ownerLogin = await app.store.login({
      email: owner.email,
      password: "owner-secret",
    });
    const post = async (path, input, token) => {
      const response = await fetch(app.url + "/api/platform/" + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: app.url,
          "X-Requested-With": "GymPASS",
          Cookie: "gympass_platform=" + token,
        },
        body: JSON.stringify(input),
      });
      return { status: response.status, data: await response.json() };
    };
    const first = await post(
      "gyms",
      {
        name: "Independiente",
        slug: "independiente",
        admin_name: "Ana",
        admin_email: "admin@staff.test",
        admin_password: "admin-secret",
      },
      ownerLogin.token,
    );
    assert.equal(first.status, 201, JSON.stringify(first.data));
    assert.equal(first.data.gym.status, "active");
    assert.equal("invitation" in first.data, false);
    const gymId = first.data.gym.id;
    const admin = await app.store.login({
      email: "admin@staff.test",
      password: "admin-secret",
    });
    const created = await post(
      "gyms/" + gymId + "/members",
      {
        name: "Cajero",
        email: "cashier@staff.test",
        role: "operator",
        password: "staff-secret",
      },
      admin.token,
    );
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.member.role, "operator");
    assert.equal("password" in created.data.member, false);
    const staff = await app.store.login({
      email: "cashier@staff.test",
      password: "staff-secret",
    });
    assert.equal(
      (
        await post(
          "gyms/" + gymId + "/members",
          {
            name: "No",
            email: "no@staff.test",
            role: "admin",
            password: "new-secret",
          },
          staff.token,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          "gyms/" + gymId + "/members",
          {
            name: "No",
            email: "admin@staff.test",
            role: "operator",
            password: "new-secret",
          },
          admin.token,
        )
      ).status,
      409,
    );
    assert.throws(
      () =>
        app.store.updateMembership(
          admin.session.user,
          gymId,
          first.data.member.id,
          { active: false },
        ),
      { status: 409 },
    );
    const foreign = app.store.createGym(owner, {
      name: "Ajeno",
      slug: "ajeno",
    });
    assert.equal(
      (
        await post(
          "gyms/" + foreign.id + "/members",
          {
            name: "No",
            email: "no@staff.test",
            role: "admin",
            password: "new-secret",
          },
          admin.token,
        )
      ).status,
      403,
    );
    const path =
      "gyms/" + gymId + "/members/" + created.data.member.id + "/password";
    assert.equal(
      (await post(path, { password: "new-staff-secret" }, admin.token)).status,
      200,
    );
    assert.equal(await app.store.authenticate(staff.token), null);
    await assert.rejects(
      app.store.login({
        email: "cashier@staff.test",
        password: "staff-secret",
      }),
      { status: 401 },
    );
    assert.equal(
      (
        await app.store.login({
          email: "cashier@staff.test",
          password: "new-staff-secret",
        })
      ).session.user.id,
      created.data.member.id,
    );
    app.store.raw
      .prepare(
        "INSERT INTO gym_memberships(user_id,gym_id,role,active) VALUES(?,?,?,0)",
      )
      .run(created.data.member.id, foreign.id, "viewer");
    assert.equal(
      (await post(path, { password: "other-secret" }, admin.token)).status,
      403,
    );
  } finally {
    await app.close();
  }
});

test("una base anterior vuelve a abrir sin perder registros y queda conservada para recuperación", async (t) => {
  const directory = temporary(t),
    manager = new TenantManager(directory);
  const gym = { id: randomUUID(), name: "Comprobación de despliegue" };
  try {
    manager.provision(gym);
    const data = manager.directory(gym.id);
    renameSync(join(data, "gympass.sqlite"), join(data, "previous.sqlite"));
    await manager.withTenant(gym, async (context) => {
      assert.equal(
        context.db.raw.prepare("SELECT owner FROM settings WHERE id=1").get()
          .owner,
        gym.id,
      );
      assert.equal(
        context.db.raw.prepare("PRAGMA integrity_check").get().integrity_check,
        "ok",
      );
    });
    assert.ok(existsSync(join(data, "previous.sqlite")));
    assert.ok(existsSync(join(data, "gympass.sqlite")));
  } finally {
    await manager.close();
  }
});
