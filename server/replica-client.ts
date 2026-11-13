import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname, sep } from "node:path";
import type { SqliteDatabase } from "./database.ts";
import { Backups } from "./backups.ts";
import { ApiError, hash } from "../lib/service.ts";
import {
  upgradeManagementSnapshot,
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
  private stopped = false;
  private syncAbort = new AbortController();
  private syncDone: Promise<void> | null = null;
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
    if (!row) return null;
    const state = JSON.parse(String(row.state)) as State;
    state.base = upgradeManagementSnapshot(state.base);
    return state;
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
    const firstRun =
      process.env.GYMPASS_STANDALONE !== "1" &&
      !this.db.raw.prepare("SELECT id FROM settings WHERE id=1").get();
    return !this.linked && (!!process.env.GYMPASS_SYNC_SERVER || firstRun);
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
        this.configuration?.server ||
        process.env.GYMPASS_SYNC_SERVER ||
        "https://gympass.site",
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
    const connectionAbort = new AbortController();
    const connectionDeadline = setTimeout(() => connectionAbort.abort(), 8000);
    try {
      response = await fetch(server + "/api/" + path, {
        method,
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(120000),
          this.syncAbort.signal,
          connectionAbort.signal,
        ]),
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "GymPASS",
          "X-GymPASS-Product-Costs": "1",
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
    } finally { clearTimeout(connectionDeadline); }
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
    const server = String(
      input.server || process.env.GYMPASS_SYNC_SERVER || "https://gympass.site",
    )
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
    snapshot = upgradeManagementSnapshot(snapshot);
    state = { ...state, base: upgradeManagementSnapshot(state.base) };
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
  private localChanges(state: State) {
    const tables = replicaTables(this.db.raw, "desktop");
    const currentAssets = replicaAssets(this.root);
    const assets: NonNullable<SyncPatch["assets"]> = {};
    for (const [name, after] of Object.entries(currentAssets))
      if (name !== "credentials.key" && state.base.assets?.[name] !== after)
        assets[name] = { before: state.base.assets?.[name] || null, after };
    return {
      tables,
      currentAssets,
      changes: syncChanges(state.base, tables),
      assets,
    };
  }

  private preparePending(state: State, configuration: Configuration) {
    if (state.pending) return;
    const local = this.localChanges(state);
    if (!local.changes.length && !Object.keys(local.assets).length) return;
    state.pending = {
      id: crypto.randomUUID(),
      gym_id: configuration.gym_id,
      installation_id: state.base.installation_id,
      base_revision: state.base.revision,
      issued_at: state.base.issued_at,
      expires_at: state.base.expires_at,
      changes: local.changes,
      assets: local.assets,
    };
    state.pending_tables = local.tables;
    state.pending_assets = local.currentAssets;
    this.save(state);
  }

  async synchronize() {
    if (!this.configuration || this.running || this.stopped)
      return this.status();
    const configuration = this.configuration;
    this.running = true;
    let finish!: () => void;
    this.syncDone = new Promise<void>((done) => {
      finish = done;
    });
    try {
      while (!this.stopped && this.configuration === configuration) {
        // Only capture/install local state under the lock. Internet must never hold it.
        const outgoing = await this.exclusive(async () => {
          if (this.stopped || this.configuration !== configuration) return null;
          const state = this.state();
          if (!state) return null;
          this.preparePending(state, configuration);
          if (!state.pending)
            return { kind: "pull" as const, revision: state.base.revision };
          return {
            kind: "push" as const,
            batch: state.pending.id,
            body: await mappedSyncPatch(
              state.pending,
              state.event_ids || {},
              hash,
            ),
          };
        });
        if (!outgoing) break;
        const { data } = await this.remote(
          configuration.server,
          `gyms/${configuration.gym_id}/sync/` +
            (outgoing.kind === "push"
              ? "push"
              : "snapshot?revision=" + encodeURIComponent(outgoing.revision)),
          outgoing.kind === "push" ? "POST" : "GET",
          outgoing.kind === "push" ? outgoing.body : undefined,
          { Authorization: "Bearer " + configuration.token },
        );
        const again = await this.exclusive(async () => {
          if (this.stopped || this.configuration !== configuration)
            return false;
          const state = this.state();
          if (!state) return false;
          if (outgoing.kind === "pull") {
            if (state.pending || state.base.revision !== outgoing.revision)
              return true;
            // An edit/cobro may have completed while the snapshot was downloading.
            // Push it against its original base instead of replacing it with the response.
            this.preparePending(state, configuration);
            if (state.pending) return true;
            if ("unchanged" in data) {
              state.base = renewSyncSnapshot(state.base, data as SyncUnchanged);
              state.last_success = Date.now();
              state.last_error = "";
              state.revoked = false;
              state.last_clock = Math.max(state.last_clock, Date.now());
              this.save(state);
            } else {
              const snapshot = data as SyncSnapshot;
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
            }
            return false;
          }
          if (state.pending?.id !== outgoing.batch) return false;
          state.revoked = false;
          if (data.status === "conflict") {
            state.conflict = data.conflict;
            state.last_error = "";
            this.save(state);
            return false;
          }
          if (!["applied", "archived"].includes(data.status))
            throw new ApiError(
              502,
              "No se confirmó el lote de sincronización.",
            );
          const tables = replicaTables(this.db.raw, "desktop"),
            currentAssets = replicaAssets(this.root);
          const additional = syncChanges(
            { ...state.base, tables: state.pending_tables! },
            tables,
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
          const changed =
            additional.length > 0 || Object.keys(assets).length > 0;
          if (data.status === "archived" && changed) {
            state.conflict =
              "Hay cambios locales posteriores al lote revisado. Descarga un respaldo y revisa estos datos antes de reemplazarlos.";
            this.save(state);
            return false;
          }
          if (changed) {
            state.event_ids = { ...state.event_ids, ...data.event_ids };
            state.base.tables = state.pending_tables!;
            state.base.assets = state.pending_assets;
            state.pending = {
              ...state.pending,
              id: crypto.randomUUID(),
              changes: additional,
              assets,
            };
            state.pending_tables = tables;
            state.pending_assets = currentAssets;
            this.save(state);
            return true;
          }
          const snapshot = data.snapshot as SyncSnapshot;
          validSyncSnapshot(
            snapshot,
            configuration.gym_id,
            configuration.user_id,
            state.base.installation_id,
          );
          if (data.status === "archived") this.backups.create("before-restore");
          this.install(snapshot, {
            base: snapshot,
            pending: null,
            conflict: null,
            revoked: false,
            last_success: Date.now(),
            last_error: "",
            last_clock: Date.now(),
          });
          return false;
        });
        if (!again) break;
      }
    } catch (error) {
      await this.exclusive(async () => {
        if (this.stopped || this.configuration !== configuration) return;
        const state = this.state();
        if (!state) return;
        state.last_error = (error as Error).message;
        if (error instanceof ApiError && [401, 403].includes(error.status))
          state.revoked = true;
        this.save(state);
      });
    } finally {
      this.running = false;
      this.syncDone = null;
      finish();
    }
    return this.status();
  }

  start() {
    if (this.stopped) {
      this.stopped = false;
      this.syncAbort = new AbortController();
    }
    this.timer = setInterval(() => void this.synchronize(), 10000);
    this.timer.unref();
    if (this.linked) void this.synchronize();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.syncAbort.abort();
    await this.syncDone;
    await this.queue.catch(() => {});
  }
}
