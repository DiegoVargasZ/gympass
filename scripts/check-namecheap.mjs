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
