import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  readdirSync,
  lstatSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ApiError, hash } from "../lib/service.ts";
import { localParts, withinSchedule } from "../lib/domain.ts";
import {
  syncTables,
  mobileSyncTables,
  sameValue,
  legacyProductCostTable,
  syncKey,
  type SyncSnapshot,
  type SyncTable,
  type SyncRow,
  type SyncPatch,
  type SyncChange,
} from "../lib/replication.ts";
import type { TenantContext } from "./tenant-manager.ts";
import type { PlatformStore, GymAuthorization } from "./platform-store.ts";

type Device = {
  id: string;
  user_id: string;
  kind: "desktop" | "mobile";
  management?: number;
  token_hash: string;
  password_revision: string;
  expires_at: number;
  revoked_at: number | null;
};
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const lease = 7 * 86400000;
export function initializeReplication(raw: DatabaseSync) {
  raw.exec(`CREATE TABLE IF NOT EXISTS sync_devices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('desktop','mobile')),token_hash TEXT NOT NULL UNIQUE,password_revision TEXT,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,last_sync_at INTEGER,revoked_at INTEGER);
    CREATE TABLE IF NOT EXISTS sync_batches(device_id TEXT NOT NULL,batch_id TEXT NOT NULL,payload_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('applied','conflict','archived')),conflict TEXT,patch_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(device_id,batch_id));
    CREATE TABLE IF NOT EXISTS sync_leases(device_id TEXT NOT NULL,revision TEXT NOT NULL,issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(device_id,revision,issued_at));`);
  if (
    !(raw.prepare("PRAGMA table_info(sync_devices)").all() as any[]).some(
      (column) => column.name === "password_revision",
    )
  )
    raw.exec("ALTER TABLE sync_devices ADD COLUMN password_revision TEXT");
  if (!(raw.prepare("PRAGMA table_info(sync_devices)").all() as any[]).some(column => column.name === "management"))
    raw.exec("ALTER TABLE sync_devices ADD COLUMN management INTEGER NOT NULL DEFAULT 0 CHECK(management IN(0,1))");
}
export function authorizeReplica(
  store: PlatformStore,
  ctx: TenantContext,
  token: string,
): { device: Device; auth: GymAuthorization } {
  initializeReplication(ctx.db.raw);
  const device = ctx.db.raw
    .prepare(
      "SELECT * FROM sync_devices WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?",
    )
    .get(digest(token), Date.now()) as Device | undefined;
  if (!device)
    throw new ApiError(
      401,
      "La vinculación venció o fue revocada. Vuelve a vincular el dispositivo.",
    );
  if (
    device.password_revision !== store.linkedCredentialRevision(device.user_id)
  )
    throw new ApiError(
      401,
      "La contraseña de la cuenta cambió. Vuelve a vincular el dispositivo.",
    );
  const auth = store.authorizeLinkedUser(device.user_id, ctx.id);
  if ((device.kind === "desktop" || device.management) && auth.actor.role !== "admin")
    throw new ApiError(
      403,
      "La copia de escritorio requiere un administrador activo.",
    );
  if (auth.actor.role === "viewer")
    throw new ApiError(403, "Esta cuenta ya no puede trabajar sin conexión.");
  return { device, auth };
}
export function pairReplica(
  ctx: TenantContext,
  auth: GymAuthorization,
  input: Record<string, unknown>,
  passwordRevision: string,
) {
  initializeReplication(ctx.db.raw);
  const kind = input.kind;
  const management = input.management === true;
  if (
    !["desktop", "mobile"].includes(String(kind)) ||
    auth.support ||
    auth.readOnly ||
    (kind === "desktop" && auth.actor.role !== "admin")
    || (management && (kind !== "mobile" || auth.actor.role !== "admin"))
  )
    throw new ApiError(
      403,
      "Vincula el dispositivo con una cuenta autorizada del gimnasio.",
    );
  const name =
    typeof input.name === "string" ? input.name.trim().slice(0, 100) : "";
  if (!name)
    throw new ApiError(
      400,
      "Escribe un nombre para reconocer este dispositivo.",
    );
  const count = ctx.db.raw
    .prepare(
      "SELECT COUNT(*) n FROM sync_devices WHERE revoked_at IS NULL AND user_id=?",
    )
    .get(auth.actor.id)!.n;
  if (Number(count) >= 25)
    throw new ApiError(
      409,
      "Revoca una vinculación anterior antes de añadir otra.",
    );
  const id = crypto.randomUUID(),
    token = "s_" + randomBytes(32).toString("hex");
  ctx.db.raw
    .prepare(
      "INSERT INTO sync_devices(id,user_id,name,kind,token_hash,password_revision,created_at,expires_at,management) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(
      id,
      auth.actor.id,
      name,
      String(kind),
      digest(token),
      passwordRevision,
      Date.now(),
      Date.now() + 90 * 86400000,
      management ? 1 : 0,
    );
  return { id, token, gym_id: ctx.id, user: auth.actor, kind, management, offline_days: 7 };
}
export function replicaTables(
  raw: DatabaseSync,
  kind: "desktop" | "mobile",
): SyncTable[] {
  return syncTables
    .filter((name) => kind === "desktop" || mobileSyncTables.has(name))
    .map((name) => {
      const columns = (
        raw.prepare(`PRAGMA table_info("${name}")`).all() as any[]
      ).map(({ name, type, pk }) => ({ name, type, pk }));
      let rows = raw
        .prepare(`SELECT * FROM "${name}" ORDER BY rowid`)
        .all() as SyncRow[];
      if (kind === "mobile") {
        rows = rows.map((row) => {
          const copy = { ...row };
          if (name === "settings") {
            copy.recovery_hash = "";
          }
          if (name === "credentials") copy.code_cipher = null;
          if (name === "pos_memberships") copy.price_cents = 0;
          return copy;
        });
        if (name === "events" && rows.length > 10000) {
          const last = new Map<string, SyncRow>();
          for (const row of rows
            .filter((r) => r.allowed === 1)
            .sort(
              (a, b) =>
                Number(a.occurred_at) - Number(b.occurred_at) ||
                Number(a.id) - Number(b.id),
            ))
            last.set(JSON.stringify([row.person_id, row.zone_id]), row);
          const selected = new Map(rows.slice(-10000).map((r) => [r.id, r]));
          for (const row of last.values())
            if (row.direction === "entry") selected.set(row.id, row);
          rows = [...selected.values()];
        }
      }
      return { name, columns, rows, ...(kind === "desktop" ? { sql: String(raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)!.sql) } : {}) };
    });
}
export function replicaAssets(root: string) {
  const assets: Record<string, string> = {};
  const walk = (name: string) => {
    const path = resolve(root, name);
    if (!path.startsWith(resolve(root) + sep))
      throw new ApiError(400, "Ruta de recursos inválida.");
    if (!existsSync(path)) return;
    const info = lstatSync(path);
    if (info.isSymbolicLink())
      throw new ApiError(409, "No se sincronizan enlaces de archivos.");
    if (info.isDirectory())
      for (const child of readdirSync(path)) walk(name + "/" + child);
    else assets[name] = readFileSync(path).toString("base64");
  };
  for (const name of ["credentials.key", "photos", "branding", "backgrounds"])
    walk(name);
  return assets;
}
export async function replicaSnapshot(
  ctx: TenantContext,
  device: Device,
  auth: GymAuthorization,
  productCosts = true,
): Promise<SyncSnapshot> {
  const currentTables = replicaTables(ctx.db.raw, device.management ? "desktop" : device.kind);
  const tables = productCosts ? currentTables : currentTables.map(legacyProductCostTable);
  const assets =
    device.kind === "desktop" || device.management ? replicaAssets(ctx.root) : undefined;
  const triggers = (
    ctx.db.raw
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name NOT LIKE 'sync_%' ORDER BY name",
      )
      .all() as any[]
  ).map((row) => String(row.sql));
  const revision = digest(JSON.stringify([tables, assets]));
  const now = Date.now();
  const previous = ctx.db.raw
    .prepare(
      "SELECT issued_at FROM sync_leases WHERE device_id=? AND revision=? AND expires_at>? ORDER BY issued_at DESC LIMIT 1",
    )
    .get(device.id, revision, now + 6 * 86400000) as
    { issued_at: number } | undefined;
  const issued = previous ? Number(previous.issued_at) : now;
  ctx.db.raw
    .prepare("UPDATE sync_devices SET last_sync_at=?,expires_at=? WHERE id=?")
    .run(now, now + 90 * 86400000, device.id);
  ctx.db.raw
    .prepare("INSERT OR REPLACE INTO sync_leases VALUES(?,?,?,?)")
    .run(device.id, revision, issued, issued + lease);
  ctx.db.raw.prepare("DELETE FROM sync_leases WHERE expires_at<?").run(now);
  return {
    protocol: 1,
    gym_id: ctx.id,
    installation_id: await hash(ctx.id),
    revision,
    issued_at: issued,
    expires_at: issued + lease,
    kind: device.kind,
    ...(device.management ? { scope: "management" as const } : {}),
    user: { ...auth.actor, role: auth.actor.role as "admin" | "operator" },
    tables,
    triggers,
    ...(assets ? { assets } : {}),
  };
}

function conflict(message: string): never {
  throw new ApiError(409, message);
}
function keyColumns(table: SyncTable) {
  return table.name === "events"
    ? ["request_key"]
    : table.columns
        .filter((c) => c.pk)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
}
function mobileChange(change: SyncChange, actor: string) {
  const { table, before, after } = change;
  if (
    table === "events" &&
    !before &&
    after &&
    (String(after.request_key).startsWith(actor + ":") ||
      String(after.request_key).startsWith("auto-close:")) &&
    !["manual", "biometric"].includes(String(after.method))
  )
    return;
  if (table === "pos_membership_uses" && !before && after) return;
  const allowed =
    table === "pos_memberships"
      ? ["sessions_remaining"]
      : table === "visits"
        ? ["used_at", "checked_in_at", "checked_out_at", "status"]
        : [];
  if (
    before &&
    after &&
    allowed.length &&
    Object.keys(after).every(
      (key) => allowed.includes(key) || sameValue(before[key], after[key]),
    )
  )
    return;
  throw new ApiError(
    403,
    "El móvil solo puede sincronizar lecturas y el consumo de sus sesiones.",
  );
}
export function mergeReplica(
  ctx: TenantContext,
  device: Device,
  auth: GymAuthorization,
  patch: SyncPatch,
) {
  if (
    !patch ||
    !/^[a-f\d-]{36}$/.test(patch.id) ||
    patch.gym_id !== ctx.id ||
    patch.installation_id !== digest(ctx.id) ||
    !Array.isArray(patch.changes) ||
    patch.changes.length > 100000
  )
    throw new ApiError(
      400,
      "El lote no pertenece a este gimnasio o está incompleto.",
    );
  const raw = ctx.db.raw,
    payloadHash = digest(JSON.stringify(patch));
  const old = raw
    .prepare("SELECT * FROM sync_batches WHERE device_id=? AND batch_id=?")
    .get(device.id, patch.id) as any;
  if (old) {
    if (old.payload_hash !== payloadHash)
      throw new ApiError(
        409,
        "El identificador del lote ya se usó con otros cambios.",
      );
    return { status: old.status, conflict: old.conflict };
  }
  const authorization = raw
    .prepare(
      "SELECT 1 FROM sync_leases WHERE device_id=? AND revision=? AND issued_at=? AND expires_at=? AND expires_at>?",
    )
    .get(
      device.id,
      patch.base_revision,
      patch.issued_at,
      patch.expires_at,
      Date.now(),
    );
  if (!authorization) {
    const message =
      "La autorización de la copia sin conexión venció. Los pendientes se conservaron para revisión del administrador.";
    raw
      .prepare("INSERT INTO sync_batches VALUES(?,?,?,?,?,?,?)")
      .run(
        device.id,
        patch.id,
        payloadHash,
        "conflict",
        message,
        JSON.stringify(patch),
        Date.now(),
      );
    return { status: "conflict", conflict: message };
  }
  const schema = replicaTables(raw, device.management ? "desktop" : device.kind);
  const seen = new Set<string>();
  for (const change of patch.changes) {
    const table = schema.find((t) => t.name === change.table),
      row = change.after || change.before;
    if (
      !table ||
      !row ||
      Object.keys(row).some(
        (key) => !table.columns.some((c) => c.name === key),
      ) ||
      Object.values(row).some(
        (value) =>
          value !== null && !["string", "number"].includes(typeof value),
      )
    )
      throw new ApiError(400, "El lote contiene datos no compatibles.");
    const key = table.name + ":" + syncKey(table, row);
    if (seen.has(key)) throw new ApiError(400, "El lote repite un registro.");
    seen.add(key);
    if (
      change.before &&
      change.after &&
      syncKey(table, change.before) !== syncKey(table, change.after)
    )
      throw new ApiError(
        400,
        "No se puede cambiar la identidad de un registro.",
      );
    if (device.kind === "mobile" && !device.management) mobileChange(change, auth.actor.id);
    if (
      change.table === "settings" &&
      change.after &&
      (!change.before ||
        change.after.owner !== change.before.owner ||
        change.after.id !== 1 ||
        change.after.recovery_hash !== change.before.recovery_hash)
    )
      throw new ApiError(
        403,
        "La sincronización no cambia la identidad ni la recuperación del gimnasio.",
      );
  }
  if (device.kind === "mobile" && !device.management && Object.keys(patch.assets || {}).length)
    throw new ApiError(403, "El móvil no modifica los archivos del gimnasio.");
  const triggers = raw
    .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'")
    .all() as any[];
  const eventIds = new Map<number, number>();
  let status = "applied",
    message: string | null = null;
  const assets: {
    path: string;
    bytes: Buffer | null;
    previous: Buffer | null;
  }[] = [];
  for (const [name, file] of Object.entries(patch.assets || {})) {
    if (!/^(photos|branding|backgrounds)\/[a-zA-Z0-9_.-]+$/.test(name))
      throw new ApiError(
        403,
        "La sincronización no cambia claves ni archivos internos.",
      );
    const path = resolve(ctx.root, name);
    if (
      !path.startsWith(resolve(ctx.root) + sep) ||
      (existsSync(path) && lstatSync(path).isSymbolicLink())
    )
      throw new ApiError(400, "Recurso inválido.");
    const previous = existsSync(path) ? readFileSync(path) : null;
    const bytes =
      file.after === null ? null : Buffer.from(file.after, "base64");
    if (bytes && bytes.length > 10 * 1024 * 1024)
      throw new ApiError(413, "La imagen supera 10 MiB.");
    if (
      !sameValue(previous?.toString("base64") ?? null, file.before) &&
      !sameValue(previous?.toString("base64") ?? null, file.after)
    ) {
      const message = "Una foto o recurso cambió también en la nube: " + name;
      raw
        .prepare("INSERT INTO sync_batches VALUES(?,?,?,?,?,?,?)")
        .run(
          device.id,
          patch.id,
          payloadHash,
          "conflict",
          message,
          JSON.stringify(patch),
          Date.now(),
        );
      return { status: "conflict", conflict: message };
    }
    assets.push({ path, bytes, previous });
  }
  raw.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON;");
  try {
    for (const trigger of triggers) raw.exec(`DROP TRIGGER "${trigger.name}"`);
    const ordered = [...patch.changes].sort((a, b) => {
      if (!a.after && b.after) return -1;
      if (a.after && !b.after) return 1;
      const order =
        syncTables.indexOf(a.table as any) - syncTables.indexOf(b.table as any);
      return a.after ? order : -order;
    });
    for (const change of ordered) {
      const table = schema.find((t) => t.name === change.table)!;
      const before = change.before ? { ...change.before } : null,
        after = change.after ? { ...change.after } : null;
      if (table.name === "pos_membership_uses")
        for (const row of [before, after])
          if (row && eventIds.has(Number(row.event_id)))
            row.event_id = eventIds.get(Number(row.event_id))!;
      const key = keyColumns(table),
        row = before || after!;
      const where = key.map((key) => `"${key}" IS ?`).join(" AND "),
        args = key.map((key) => row[key]);
      const current =
        table.name === "audit" && !before
          ? undefined
          : (raw
              .prepare(`SELECT * FROM "${table.name}" WHERE ${where}`)
              .get(...args) as SyncRow | undefined);
      // Older clients never read these columns. Their edits must preserve the cloud cost.
      if (table.name === 'pos_products' || table.name === 'pos_sale_lines')
        for (const value of [before, after])
          if (value && !Object.prototype.hasOwnProperty.call(value, 'cost_cents'))
            value.cost_cents = current?.cost_cents ?? null;
      if (!after) {
        if (!current) continue;
        if (
          table.columns.some(
            (c) => !sameValue(current[c.name], before![c.name]),
          )
        )
          conflict(
            "El registro que se quiso borrar cambió en la nube: " + table.name,
          );
        raw.prepare(`DELETE FROM "${table.name}" WHERE ${where}`).run(...args);
        continue;
      }
      if (!before) {
        const autoId = table.name === "events" || table.name === "audit";
        if (current) {
          if (
            table.columns.some(
              (c) =>
                !(autoId && c.name === "id") &&
                !sameValue(current[c.name], after[c.name]),
            )
          )
            conflict(
              "Ya existe otro registro con la misma identidad: " + table.name,
            );
          if (table.name === "events")
            eventIds.set(Number(after.id), Number(current.id));
          continue;
        }
        const keys = table.columns
          .map((c) => c.name)
          .filter((name) => !(autoId && name === "id"));
        const result = raw
          .prepare(
            `INSERT INTO "${table.name}"(${keys.map((k) => `"${k}"`).join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
          )
          .run(...keys.map((k) => after[k] ?? null));
        if (table.name === "events")
          eventIds.set(Number(after.id), Number(result.lastInsertRowid));
        continue;
      }
      if (!current)
        conflict("Un registro editado fue eliminado en la nube: " + table.name);
      const updates: SyncRow = {};
      for (const column of table.columns.map((c) => c.name)) {
        if (sameValue(before[column], after[column])) continue;
        if (
          (table.name === "pos_products" && column === "stock") ||
          (table.name === "pos_memberships" && column === "sessions_remaining")
        ) {
          const next =
            Number(current[column]) +
            Number(after[column]) -
            Number(before[column]);
          if (!Number.isInteger(next) || next < 0)
            conflict(
              "El stock o las sesiones disponibles fueron utilizados por otro dispositivo.",
            );
          updates[column] = next;
        } else if (sameValue(current[column], after[column])) continue;
        else if (sameValue(current[column], before[column]))
          updates[column] = after[column];
        else if (table.name === "devices" && column === "last_seen")
          updates[column] = Math.max(
            Number(current[column]),
            Number(after[column]),
          );
        else
          conflict(
            "El mismo dato cambió en dos dispositivos: " +
              table.name +
              "." +
              column,
          );
      }
      const keys = Object.keys(updates);
      if (keys.length)
        raw
          .prepare(
            `UPDATE "${table.name}" SET ${keys.map((k) => `"${k}"=?`).join(",")} WHERE ${where}`,
          )
          .run(...keys.map((k) => updates[k]), ...args);
    }
    validateMergedReplica(raw, patch, device, eventIds);
    for (const trigger of triggers) raw.exec(trigger.sql);
    if (raw.prepare("PRAGMA foreign_key_check").all().length)
      conflict("Los cambios contienen referencias que ya no existen.");
    for (const asset of assets) {
      if (asset.bytes) {
        mkdirSync(dirname(asset.path), { recursive: true });
        writeFileSync(asset.path, asset.bytes);
      } else if (existsSync(asset.path)) unlinkSync(asset.path);
    }
    raw
      .prepare("INSERT INTO sync_batches VALUES(?,?,?,?,?,?,?)")
      .run(
        device.id,
        patch.id,
        payloadHash,
        "applied",
        null,
        JSON.stringify(patch),
        Date.now(),
      );
    raw.exec("COMMIT");
  } catch (error) {
    raw.exec("ROLLBACK");
    for (const asset of assets) {
      if (asset.previous) writeFileSync(asset.path, asset.previous);
      else if (existsSync(asset.path)) unlinkSync(asset.path);
    }
    if (
      !(error instanceof ApiError && error.status === 409) &&
      !(error instanceof Error && /constraint|POS_/.test(error.message))
    )
      throw error;
    status = "conflict";
    message =
      error instanceof ApiError
        ? error.message
        : "Los cambios entran en conflicto con los datos actuales. Revisa cobros, planes y existencias.";
    raw
      .prepare("INSERT INTO sync_batches VALUES(?,?,?,?,?,?,?)")
      .run(
        device.id,
        patch.id,
        payloadHash,
        status,
        message,
        JSON.stringify(patch),
        Date.now(),
      );
  }
  return { status, conflict: message };
}

function validateMergedReplica(
  raw: DatabaseSync,
  patch: SyncPatch,
  device: Device,
  eventIds: Map<number, number>,
) {
  const newEvents = patch.changes
    .filter((c) => c.table === "events" && !c.before && c.after)
    .map((c) => c.after!);
  for (const event of newEvents) {
    if (
      (event.reason !== "AUTO_CLOSE" &&
        Number(event.occurred_at) < patch.issued_at - 300000) ||
      Number(event.occurred_at) > Date.now() + 300000 ||
      Number(event.occurred_at) > patch.expires_at
    )
      conflict(
        "Una lectura está fuera del periodo autorizado de la copia local.",
      );
    if (event.allowed !== 1) continue;
    if (event.direction === "entry") {
      const person = raw
        .prepare("SELECT * FROM people WHERE id=?")
        .get(event.person_id) as SyncRow | undefined;
      if (!person || person.status !== "active" || person.deleted_at)
        conflict("El socio fue suspendido o dado de baja en otro dispositivo.");
      if (
        event.device_id &&
        !raw
          .prepare("SELECT 1 FROM devices WHERE id=? AND active=1")
          .get(event.device_id)
      )
        conflict("El lector externo fue revocado en otro dispositivo.");
      const settings = raw
        .prepare("SELECT timezone FROM settings WHERE id=1")
        .get()!;
      const local = localParts(
        new Date(Number(event.occurred_at)),
        String(settings.timezone),
      );
      if (event.local_date !== local.date)
        conflict(
          "La fecha de la lectura no coincide con la zona horaria del gimnasio.",
        );
      const zone = raw
        .prepare("SELECT active,capacity FROM zones WHERE id=?")
        .get(event.zone_id);
      if (!zone || zone.active !== 1)
        conflict("La zona fue desactivada en otro dispositivo.");
      if (
        raw
          .prepare("SELECT 1 FROM blocklist WHERE document=?")
          .get(person.document)
      )
        conflict("El documento fue bloqueado en otro dispositivo.");
      if (
        person.kind !== "member" &&
        person.expires &&
        String(person.expires) < local.date
      )
        conflict("La autorización de la persona venció antes de esta lectura.");
      if (event.zone_id !== "general") {
        if (
          !raw
            .prepare(
              "SELECT 1 FROM person_zones WHERE person_id=? AND zone_id=?",
            )
            .get(person.id, event.zone_id)
        )
          conflict("La persona ya no tiene permiso para esa zona.");
        const schedule = person.schedule_id
          ? raw
              .prepare("SELECT days,start,end FROM schedules WHERE id=?")
              .get(person.schedule_id)
          : null;
        if (
          schedule &&
          !withinSchedule(
            JSON.parse(String(schedule.days)),
            String(schedule.start),
            String(schedule.end),
            local.time,
            local.day,
          )
        )
          conflict(
            "El horario cambió en otro dispositivo y la lectura requiere revisión.",
          );
      }
      if (Number(zone.capacity) > 0) {
        const id = eventIds.get(Number(event.id))!;
        const inside = raw
          .prepare(
            `SELECT COUNT(*) n FROM events e WHERE e.zone_id=? AND e.allowed=1 AND e.direction='entry' AND (e.occurred_at,e.id)<=(?,?) AND NOT EXISTS(SELECT 1 FROM events later WHERE later.person_id=e.person_id AND later.zone_id=e.zone_id AND later.allowed=1 AND (later.occurred_at,later.id)>(e.occurred_at,e.id) AND (later.occurred_at,later.id)<=(?,?))`,
          )
          .get(event.zone_id, event.occurred_at, id, event.occurred_at, id)!.n;
        if (Number(inside) > Number(zone.capacity))
          conflict(
            "Las lecturas de varios dispositivos superaron el aforo. Revisa los movimientos.",
          );
      }
      if (event.credential_id) {
        const credential = raw
          .prepare(
            "SELECT * FROM credentials WHERE id=? AND active=1 AND person_id=?",
          )
          .get(event.credential_id, event.person_id);
        if (!credential)
          conflict("La credencial fue revocada en otro dispositivo.");
      }
      if (person.kind === "member") {
        const membership = raw
          .prepare(
            "SELECT 1 FROM pos_memberships WHERE person_id=? AND status='active' AND start_date<=? AND ((unit<>'sessions' AND end_date>?) OR unit='sessions' AND (sessions_remaining>0 OR EXISTS(SELECT 1 FROM pos_membership_uses u WHERE u.membership_id=pos_memberships.id AND u.event_id=?)))",
          )
          .get(
            person.id,
            event.local_date,
            event.local_date,
            eventIds.get(Number(event.id))!,
          );
        const legacy =
          person.legacy_access === 1 &&
          (!person.expires ||
            String(person.expires) >= String(event.local_date)) &&
          !raw
            .prepare(
              "SELECT 1 FROM pos_memberships WHERE person_id=? AND start_date<=?",
            )
            .get(person.id, event.local_date);
        if (!membership && !legacy)
          conflict(
            "La lectura no tiene un plan vigente o sus sesiones ya se consumieron.",
          );
      }
    }
  }
  for (const membership of patch.changes
    .filter((c) => c.table === "pos_memberships" && c.after && !c.before)
    .map((c) => c.after!)) {
    if (membership.status !== "active") continue;
    const overlap = raw
      .prepare(
        "SELECT 1 FROM pos_memberships WHERE person_id=? AND id<>? AND status='active' AND ((unit='sessions' AND sessions_remaining>0) OR (?='sessions' AND ?>0) OR (start_date<? AND end_date>?)) LIMIT 1",
      )
      .get(
        membership.person_id,
        membership.id,
        membership.unit,
        membership.sessions_remaining || 0,
        membership.end_date || "9999-12-31",
        membership.start_date,
      );
    if (overlap)
      conflict(
        "El socio recibió otro plan mientras este dispositivo estaba sin conexión.",
      );
  }
  for (const sale of patch.changes
    .filter((c) => c.table === "pos_sales" && c.after)
    .map((c) => c.after!)) {
    const total = raw
      .prepare("SELECT SUM(total_cents) n FROM pos_sale_lines WHERE sale_id=?")
      .get(sale.id)?.n;
    if (Number(total) !== sale.total_cents)
      conflict("El total del cobro no coincide con sus artículos.");
  }
  if (device.kind === "mobile") {
    for (const change of patch.changes.filter(
      (c) => c.table === "pos_memberships" && c.before && c.after,
    )) {
      const consumed =
        Number(change.before!.sessions_remaining) -
        Number(change.after!.sessions_remaining);
      const uses = patch.changes.filter(
        (c) =>
          c.table === "pos_membership_uses" &&
          !c.before &&
          c.after?.membership_id === change.after!.id,
      ).length;
      if (consumed !== uses || consumed < 0)
        throw new ApiError(
          403,
          "El consumo de sesiones no corresponde a las lecturas.",
        );
    }
  }
  const affected = new Map(
    newEvents
      .filter((e) => e.allowed === 1)
      .map((e) => [JSON.stringify([e.person_id, e.zone_id]), e]),
  );
  const inserted = new Set([...eventIds.values()]);
  for (const event of affected.values()) {
    const history = raw
      .prepare(
        "SELECT id,direction FROM events WHERE person_id=? AND zone_id=? AND allowed=1 ORDER BY occurred_at,id",
      )
      .all(event.person_id, event.zone_id) as any[];
    for (let index = 1; index < history.length; index++)
      if (
        history[index - 1].direction === history[index].direction &&
        (inserted.has(Number(history[index - 1].id)) ||
          inserted.has(Number(history[index].id)))
      )
        conflict(
          "Dos dispositivos registraron un movimiento incompatible para el mismo socio. Revisa el historial antes de combinarlo.",
        );
  }
}
