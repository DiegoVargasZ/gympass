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

const root = resolve(import.meta.dirname, "..");
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
