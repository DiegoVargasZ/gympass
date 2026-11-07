import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname, sep } from "node:path";
import type { SqliteDatabase } from "./database.ts";
import { Backups } from "./backups.ts";
import { ApiError, hash } from "../lib/service.ts";
import {
  syncChanges,
  validSyncSnapshot,
  mappedSyncPatch,
  renewSyncSnapshot,
  type SyncUnchanged,
  type SyncSnapshot,
  type SyncPatch,
  type SyncTable,
} from "../lib/replication.ts";
import { replicaTables, replicaAssets } from "./replication.ts";
import { passwordHash } from "./auth.ts";

type Configuration = {
  server: string;
  gym_id: string;
  user_id: string;
  token: string;
  device_id: string;
};
type State = {
  base: SyncSnapshot;
  pending: SyncPatch | null;
  pending_tables?: SyncTable[];
  pending_assets?: Record<string, string>;
  event_ids?: Record<string, number>;
  conflict: string | null;
  revoked: boolean;
  last_success: number;
  last_error: string;
  last_clock: number;
};
export class ReplicaClient {
  private queue: Promise<unknown> = Promise.resolve();
  private configuration: Configuration | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private online = false;
  readonly db: SqliteDatabase;
  readonly root: string;
  readonly backups: Backups;
  readonly onInstalled: () => void;
  constructor(
    db: SqliteDatabase,
    root: string,
    backups: Backups,
    onInstalled: () => void,
  ) {
    this.db = db;
    this.root = root;
    this.backups = backups;
    this.onInstalled = onInstalled;
    db.raw.exec(
      "CREATE TABLE IF NOT EXISTS replica_state(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL)",
    );
    try {
      this.configuration = JSON.parse(
        readFileSync(join(root, "cloud-sync.json"), "utf8"),
      );
    } catch {}
  }
  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.queue.catch(() => {}).then(operation);
    this.queue = work;
    return work;
  }
  private state(): State | null {
    const row = this.db.raw
      .prepare("SELECT state FROM replica_state WHERE id=1")
      .get();
    return row ? JSON.parse(String(row.state)) : null;
  }
  private save(state: State) {
    this.db.raw
      .prepare(
        "INSERT INTO replica_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state",
      )
      .run(JSON.stringify(state));
  }
  get linked() {
    return !!this.configuration;
  }
  get required() {
    return !!process.env.GYMPASS_SYNC_SERVER && !this.linked;
  }
  status() {
    const state = this.state();
    let pending = 0;
    if (state)
      pending =
        state.pending?.changes.length ||
        syncChanges(state.base, replicaTables(this.db.raw, "desktop")).length;
    return {
      linked: this.linked,
      required: this.required,
      server:
        this.configuration?.server || process.env.GYMPASS_SYNC_SERVER || "",
      gym_id: this.configuration?.gym_id,
      gym_name: state?.base.tables.find((t) => t.name === "settings")?.rows[0]
        ?.name,
      pending,
      syncing: this.running,
      online: this.online,
      last_success: state?.last_success,
      expires_at: state?.base.expires_at,
      conflict: state?.conflict,
      error: state?.last_error,
      revoked: state?.revoked,
    };
  }
  requireWritable() {
    if (!this.linked) return;
    const state = this.state();
    if (!state || state.revoked)
      throw new ApiError(
        403,
        "La vinculación fue suspendida. Vuelve a vincular con un administrador autorizado.",
      );
    if (
      state.base.expires_at < Date.now() ||
      Date.now() < state.last_clock - 300000
    )
      throw new ApiError(
        409,
        "Reconecta para renovar la autorización sin conexión o corrige la hora de esta computadora. Los pendientes se conservaron.",
      );
    if (state.conflict)
      throw new ApiError(
        409,
        "Hay un conflicto de sincronización pendiente. Revisa la sección Conexión antes de seguir registrando cambios.",
      );
    state.last_clock = Date.now();
    this.save(state);
  }
  private async remote(
    server: string,
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    if (
      !/^https:\/\/[^/?#@\\]+$/.test(server) &&
      !(
        process.env.GYMPASS_SYNC_TEST === "1" &&
        /^http:\/\/127\.0\.0\.1:\d+$/.test(server)
      )
    )
      throw new ApiError(400, "Usa el origen HTTPS del servidor central.");
    let response: Response;
    try {
      response = await fetch(server + "/api/" + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(120000),
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "GymPASS",
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      this.online = false;
      throw new ApiError(
        503,
        "Sin Internet. La copia local sigue disponible; se reintentará automáticamente.",
      );
    }
    this.online = true;
    const data = await response.json().catch(() => null);
    if (!response.ok || !data)
      throw new ApiError(
        response.status || 503,
        data?.error || "La respuesta del servidor quedó incompleta.",
      );
    return { data, response };
  }
  async link(input: Record<string, any>, canReplace = false) {
    const server = String(input.server || process.env.GYMPASS_SYNC_SERVER || "")
      .trim()
      .replace(/\/$/, "");
    const login = await this.remote(server, "platform/login", "POST", {
      email: input.email,
      password: input.password,
    });
    const gyms = login.data.gyms.filter(
      (gym: any) =>
        gym.role === "admin" &&
        gym.status === "active" &&
        !gym.archived &&
        !gym.deleted,
    );
    if (!input.gym_id && gyms.length !== 1) return { gyms };
    const gym = gyms.find(
      (gym: any) => gym.id === (input.gym_id || gyms[0]?.id),
    );
    if (!gym) throw new ApiError(403, "Elige un gimnasio que administres.");
    if (
      this.configuration &&
      (this.configuration.gym_id !== gym.id ||
        this.configuration.server !== server)
    )
      throw new ApiError(
        409,
        "Esta copia ya está vinculada a otro gimnasio. Usa otra carpeta de datos para conservarla.",
      );
    const existing = Number(
      this.db.raw.prepare("SELECT COUNT(*) n FROM people").get()!.n,
    );
    if (existing && (!canReplace || input.confirm !== "REEMPLAZAR"))
      throw new ApiError(
        409,
        "Hay datos locales. Escribe REEMPLAZAR para guardar un respaldo previo y descargar el gimnasio central.",
      );
    if (existing || this.linked) this.backups.create("before-restore");
    const cookie = login.response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie)
      throw new ApiError(
        502,
        "El servidor no entregó una sesión de vinculación.",
      );
    const paired = await this.remote(
      server,
      `gyms/${gym.id}/sync/pair`,
      "POST",
      {
        name: String(input.name || "Computadora del gimnasio"),
        kind: "desktop",
      },
      { Cookie: cookie },
    );
    const configuration: Configuration = {
      server,
      gym_id: gym.id,
      user_id: login.data.user.id,
      token: paired.data.token,
      device_id: paired.data.id,
    };
    const snapshot = (
      await this.remote(
        server,
        `gyms/${gym.id}/sync/snapshot`,
        "GET",
        undefined,
        { Authorization: "Bearer " + configuration.token },
      )
    ).data as SyncSnapshot;
    validSyncSnapshot(snapshot, gym.id, configuration.user_id);
    const hashed = await passwordHash(String(input.password));
    this.install(snapshot, {
      base: snapshot,
      pending: null,
      conflict: null,
      revoked: false,
      last_success: Date.now(),
      last_error: "",
      last_clock: Date.now(),
    });
    this.db.raw
      .prepare(
        "INSERT INTO members(email,user_id,name,role,active,password_hash) VALUES(?,?,?,?,1,?) ON CONFLICT(email) DO UPDATE SET user_id=excluded.user_id,name=excluded.name,role=excluded.role,active=1,password_hash=excluded.password_hash",
      )
      .run(
        snapshot.user.email,
        snapshot.user.id,
        snapshot.user.name,
        "admin",
        hashed,
      );
    mkdirSync(this.root, { recursive: true });
    writeFileSync(
      join(this.root, "cloud-sync.json"),
      JSON.stringify(configuration),
      { mode: 0o600 },
    );
    this.configuration = configuration;
    // The temporary web login is only needed to establish the device grant.
    await this.remote(
      server,
      "platform/logout",
      "POST",
      {},
      { Cookie: cookie },
    ).catch(() => {});
    return { linked: true, user: snapshot.user };
  }
  private install(snapshot: SyncSnapshot, state: State) {
    validSyncSnapshot(snapshot, snapshot.gym_id, snapshot.user.id);
    const raw = this.db.raw;
    const triggers = raw
      .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'")
      .all() as any[];
    raw.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON");
    try {
      for (const trigger of triggers)
        raw.exec(`DROP TRIGGER "${trigger.name}"`);
      for (const table of [...snapshot.tables].reverse())
        raw.exec(`DELETE FROM "${table.name}"`);
      for (const table of snapshot.tables) {
        const names = table.columns.map((c) => c.name);
        const statement = raw.prepare(
          `INSERT INTO "${table.name}"(${names.map((n) => `"${n}"`).join(",")}) VALUES(${names.map(() => "?").join(",")})`,
        );
        for (const row of table.rows)
          statement.run(...names.map((n) => row[n]));
      }
      for (const trigger of triggers) raw.exec(trigger.sql);
      this.save(state);
      raw.exec("COMMIT");
    } catch (error) {
      raw.exec("ROLLBACK");
      throw error;
    }
    for (const [name, bytes] of Object.entries(snapshot.assets || {})) {
      if (
        !/^(credentials\.key|(photos|branding|backgrounds)\/[a-zA-Z0-9_.-]+)$/.test(
          name,
        )
      )
        throw new ApiError(409, "Recurso de sincronización inválido.");
      const target = resolve(this.root, name);
      if (!target.startsWith(resolve(this.root) + sep))
        throw new ApiError(409, "Ruta de recurso inválida.");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(bytes, "base64"), { mode: 0o600 });
    }
    this.onInstalled();
  }
  async synchronize() {
    if (!this.configuration || this.running) return this.status();
    this.running = true;
    try {
      await this.exclusive(async () => {
        const state = this.state();
        if (!state) return;
        const configuration = this.configuration!;
        const request = (path: string, method = "GET", body?: unknown) =>
          this.remote(
            configuration.server,
            `gyms/${configuration.gym_id}/sync/${path}`,
            method,
            body,
            { Authorization: "Bearer " + configuration.token },
          );
        if (!state.pending) {
          const changes = syncChanges(
            state.base,
            replicaTables(this.db.raw, "desktop"),
          );
          const current = replicaAssets(this.root),
            assets: NonNullable<SyncPatch["assets"]> = {};
          // Old unreferenced photos remain in local storage; only additions and changed files are sent.
          for (const [name, after] of Object.entries(current))
            if (
              name !== "credentials.key" &&
              state.base.assets?.[name] !== after
            )
              assets[name] = {
                before: state.base.assets?.[name] || null,
                after,
              };
          if (changes.length || Object.keys(assets).length) {
            state.pending = {
              id: crypto.randomUUID(),
              gym_id: configuration.gym_id,
              installation_id: state.base.installation_id,
              base_revision: state.base.revision,
              issued_at: state.base.issued_at,
              expires_at: state.base.expires_at,
              changes,
              assets,
            };
            state.pending_tables = replicaTables(this.db.raw, "desktop");
            state.pending_assets = current;
            this.save(state);
          }
        }
        while (state.pending) {
          const outgoing = await mappedSyncPatch(
            state.pending,
            state.event_ids || {},
            hash,
          );
          const { data } = await request("push", "POST", outgoing);
          state.revoked = false;
          if (data.status === "conflict") {
            state.conflict = data.conflict;
            state.last_error = "";
            this.save(state);
            return;
          }
          if (!["applied", "archived"].includes(data.status))
            throw new ApiError(
              502,
              "No se confirmó el lote de sincronización.",
            );
          const currentTables = replicaTables(this.db.raw, "desktop"),
            currentAssets = replicaAssets(this.root);
          const additional = syncChanges(
            { ...state.base, tables: state.pending_tables! },
            currentTables,
          );
          const assets: NonNullable<SyncPatch["assets"]> = {};
          for (const [name, after] of Object.entries(currentAssets))
            if (
              name !== "credentials.key" &&
              state.pending_assets?.[name] !== after
            )
              assets[name] = {
                before: state.pending_assets?.[name] || null,
                after,
              };
          if (
            data.status === "archived" &&
            (additional.length || Object.keys(assets).length)
          ) {
            state.conflict =
              "Hay cambios locales posteriores al lote revisado. Descarga un respaldo y revisa estos datos antes de reemplazarlos.";
            this.save(state);
            return;
          }
          if (additional.length || Object.keys(assets).length) {
            state.event_ids = { ...state.event_ids, ...data.event_ids };
            state.base.tables = state.pending_tables!;
            state.base.assets = state.pending_assets;
            state.pending = {
              ...state.pending,
              id: crypto.randomUUID(),
              changes: additional,
              assets,
            };
            state.pending_tables = currentTables;
            state.pending_assets = currentAssets;
            this.save(state);
          } else {
            const snapshot = data.snapshot as SyncSnapshot;
            validSyncSnapshot(
              snapshot,
              configuration.gym_id,
              configuration.user_id,
              state.base.installation_id,
            );
            if (data.status === "archived")
              this.backups.create("before-restore");
            this.install(snapshot, {
              base: snapshot,
              pending: null,
              conflict: null,
              revoked: false,
              last_success: Date.now(),
              last_error: "",
              last_clock: Date.now(),
            });
            return;
          }
        }
        const snapshot = (
          await request(
            "snapshot?revision=" + encodeURIComponent(state.base.revision),
          )
        ).data as SyncSnapshot | SyncUnchanged;
        if ("unchanged" in snapshot) {
          state.base = renewSyncSnapshot(state.base, snapshot);
          state.last_success = Date.now();
          state.last_error = "";
          state.revoked = false;
          state.last_clock = Math.max(state.last_clock, Date.now());
          this.save(state);
          return;
        }
        validSyncSnapshot(
          snapshot,
          configuration.gym_id,
          configuration.user_id,
          state.base.installation_id,
        );
        this.install(snapshot, {
          base: snapshot,
          pending: null,
          conflict: null,
          revoked: false,
          last_success: Date.now(),
          last_error: "",
          last_clock: Date.now(),
        });
      });
    } catch (error) {
      const state = this.state();
      if (state) {
        state.last_error = (error as Error).message;
        if (error instanceof ApiError && [401, 403].includes(error.status))
          state.revoked = true;
        this.save(state);
      }
    } finally {
      this.running = false;
    }
    return this.status();
  }
  start() {
    this.timer = setInterval(() => void this.synchronize(), 30000);
    this.timer.unref();
    if (this.linked) void this.synchronize();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.queue.catch(() => {});
  }
}
