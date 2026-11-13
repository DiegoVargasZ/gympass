import { DatabaseSync } from 'node:sqlite';
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  rmSync,
  renameSync,
} from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteDatabase } from './database.ts';
import { Backups, prepareDataStartup, safeBackupDirectory } from './backups.ts';
import { credentialVault } from './credential-vault.ts';
import { ApiError, Service, type CredentialCodec } from '../lib/service.ts';
import { backupJob } from './backup-jobs.ts';

type Tenant = { id: string; name: string };
export type TenantContext = {
  id: string;
  root: string;
  db: SqliteDatabase;
  codec: CredentialCodec;
  backups: Backups;
  reload: boolean;
  touched: number;
};
const migrations = fileURLToPath(new URL('./migrations', import.meta.url));
export class TenantManager {
  root: string;
  private contexts = new Map<string, TenantContext>();
  private queues = new Map<string, Promise<unknown>>();
  private maxOpen: number;
  private closed = false;
  private gate: Promise<void> = Promise.resolve();
  private heavyOperation = false;
  private heavyReleased: Promise<void> = Promise.resolve();
  private releaseHeavy: (() => void) | undefined;
  private heavyWaiters = 0;

  /** Reserve before reading a large body; one tenant cannot fill RAM with parallel transfers. */
  async withHeavyOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.heavyOperation && this.heavyWaiters < 4) {
      this.heavyWaiters++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.heavyReleased, new Promise<void>(done => { timer = setTimeout(done, 100); })]);
      } finally { if (timer) clearTimeout(timer); this.heavyWaiters--; }
    }
    if (this.heavyOperation) throw new ApiError(429, 'Hay una transferencia grande en curso. Reintenta en unos segundos.');
    this.heavyOperation = true;
    this.heavyReleased = new Promise<void>(done => { this.releaseHeavy = done; });
    try { return await operation(); } finally { this.heavyOperation = false; this.releaseHeavy?.(); }
  }

  constructor(root: string, options: { maxOpen?: number } = {}) {
    this.root = safeBackupDirectory(resolve(root), true);
    this.maxOpen = options.maxOpen ?? 32;
    if (!Number.isInteger(this.maxOpen) || this.maxOpen < 1) throw Error('Límite de gimnasios abiertos inválido.');
  }

  directory(id: string) {
    if (!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(id)) throw new ApiError(400, 'Gimnasio inválido.');
    return safeBackupDirectory(join(this.root, 'tenants', id));
  }

  private databasePath(gym: Tenant, allowNew = false) {
    const directory = this.directory(gym.id);
    const target = join(directory, 'gympass.sqlite');
    if (existsSync(target)) return target;
    const candidates = existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith('.sqlite')) : [];
    if (candidates.length > 1)
      throw new ApiError(
        503,
        'Hay varias bases anteriores para este gimnasio. Revisa el directorio de datos antes de actualizar.',
      );
    if (!candidates.length) {
      if (allowNew) return target;
      throw new ApiError(
        503,
        'No se encontró la base del gimnasio. Revisa GYMPASS_DATA_DIR y restaura sus datos si faltan.',
      );
    }
    const source = join(directory, candidates[0]);
    const info = lstatSync(source);
    if (!info.isFile() || info.isSymbolicLink())
      throw new ApiError(409, 'La base anterior debe ser un archivo local del gimnasio.');
    const temporary = join(directory, `.gympass-upgrade-${crypto.randomUUID()}.tmp`);
    const original = new DatabaseSync(source, { readOnly: true });
    try {
      if (original.prepare('SELECT owner FROM settings WHERE id=1').get()?.owner !== gym.id)
        throw new ApiError(409, 'La identidad de la base anterior no coincide con el gimnasio.');
      // VACUUM INTO includes committed WAL data and leaves the original available for recovery.
      original.prepare('VACUUM INTO ?').run(temporary);
      const snapshot = new DatabaseSync(temporary, { readOnly: true });
      try {
        if (snapshot.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
          throw new ApiError(409, 'La base anterior no superó la comprobación de integridad.');
      } finally {
        snapshot.close();
      }
      renameSync(temporary, target);
      return target;
    } finally {
      original.close();
      rmSync(temporary, { force: true });
    }
  }

  provision(gym: Tenant) {
    const directory = this.directory(gym.id);
    safeBackupDirectory(directory, true);
    const source = this.databasePath(gym, true);
    const db = new SqliteDatabase(source);
    try {
      const existing = db.raw.prepare('SELECT owner FROM settings WHERE id=1').get();
      if (existing && existing.owner !== gym.id) throw new ApiError(409, 'El directorio pertenece a otro gimnasio.');
      if (!existing) {
        db.raw.exec('BEGIN IMMEDIATE');
        try {
          db.raw
            .prepare("INSERT INTO settings(id,owner,name,brand_color) VALUES(1,?,?, '#2563eb')")
            .run(gym.id, gym.name);
          db.raw
            .prepare(
              "INSERT OR IGNORE INTO zones(id,name,description) VALUES('general','Acceso general','Entrada y salida del gimnasio')",
            )
            .run();
          db.raw.exec('COMMIT');
        } catch (error) {
          db.raw.exec('ROLLBACK');
          throw error;
        }
      }
      credentialVault(join(directory, 'credentials.key'));
      // These tables are never an authentication source in the platform.
      db.raw.exec('DELETE FROM sessions; DELETE FROM members;');
      writeFileSync(join(directory, 'tenant.json'), JSON.stringify({ gym_id: gym.id }), { mode: 0o600 });
    } finally {
      db.close();
    }
  }

  private open(gym: Tenant) {
    let ctx = this.contexts.get(gym.id);
    if (ctx) {
      ctx.touched = Date.now();
      return ctx;
    }
    if (this.contexts.size >= this.maxOpen) {
      const idle = [...this.contexts.values()]
        .filter((item) => !this.queues.has(item.id))
        .sort((a, b) => a.touched - b.touched)[0];
      if (!idle) throw new ApiError(503, 'El servidor está ocupado. Reintenta en unos segundos.');
      idle.db.close();
      this.contexts.delete(idle.id);
    }
    const directory = this.directory(gym.id);
    const source = this.databasePath(gym);
    prepareDataStartup(source, migrations);
    const db = new SqliteDatabase(source);
    const settings = db.raw.prepare('SELECT owner FROM settings WHERE id=1').get();
    if (settings?.owner !== gym.id) {
      db.close();
      throw new ApiError(409, 'La identidad del gimnasio no coincide.');
    }
    const backupDir = safeBackupDirectory(join(this.root, 'backups', gym.id), true);
    ctx = {
      id: gym.id,
      root: directory,
      db,
      codec: credentialVault(join(directory, 'credentials.key')),
      backups: new Backups(db.raw, source, backupDir),
      reload: false,
      touched: Date.now(),
    };
    this.contexts.set(gym.id, ctx);
    return ctx;
  }

  async withTenant<T>(gym: Tenant, operation: (context: TenantContext) => Promise<T>): Promise<T> {
    await this.gate;
    if (this.closed) throw new ApiError(503, 'El servidor se está cerrando.');
    this.directory(gym.id);
    const previous = this.queues.get(gym.id) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(async () => {
        const ctx = this.open(gym);
        try {
          return await operation(ctx);
        } finally {
          ctx.touched = Date.now();
          if (ctx.reload) {
            ctx.db.close();
            this.contexts.delete(gym.id);
          }
        }
      });
    this.queues.set(gym.id, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(gym.id) === current) this.queues.delete(gym.id);
    }
  }

  verifyBackup(ctx: TenantContext, id: string) {
    const summary = ctx.backups.inspect(id);
    const copy = new DatabaseSync(join(ctx.backups.directory, id, 'gympass.sqlite'), { readOnly: true });
    try {
      if (copy.prepare('SELECT owner FROM settings WHERE id=1').get()?.owner !== ctx.id)
        throw new ApiError(409, 'El respaldo pertenece a otro gimnasio.');
    } finally {
      copy.close();
    }
    return summary;
  }

  async maintain(gyms: Tenant[], at = new Date(), onChanged?: (gymId: string) => void) {
    for (const gym of gyms) {
      if (this.closed) break;
      await this.withTenant(gym, async (ctx) => {
        const before = ctx.db.raw.prepare('SELECT total_changes() n').get()!.n;
        const service = new Service(ctx.db, { id: 'system', email: 'system', name: 'Sistema', role: 'admin' });
        await service.closeStaleSessions(at);
        await service.closeExpiredVisits(at);
        // Platform snapshots already contain every gym. Do not duplicate the daily schedule.
        // Existing individual copies and explicit manual/pre-restore copies are preserved.
        if (ctx.db.raw.prepare('SELECT total_changes() n').get()!.n !== before) onChanged?.(gym.id);
      }).catch((error) => console.error('Mantenimiento de gimnasio:', gym.id, error.message));
    }
  }

  async snapshotPlatform(raw: DatabaseSync, authorize: () => void = () => {}) {
    let release!: () => void;
    const oldGate = this.gate;
    this.gate = new Promise<void>((done) => {
      release = done;
    });
    try {
      await oldGate;
      await Promise.allSettled([...this.queues.values()]);
      authorize();
      // Capture the central registry before yielding; tenant queues stay paused for a coherent capture.
      const directory = safeBackupDirectory(
        join(this.root, 'platform-backups', `platform-${Date.now()}-${crypto.randomUUID()}`),
        true,
      );
      raw.prepare('VACUUM INTO ?').run(join(directory, 'platform.sqlite'));
      const sourceRoot = join(this.root, 'tenants');
      const sources = existsSync(sourceRoot) ? readdirSync(sourceRoot).map(id => ({
        id, database: this.databasePath({ id, name: '' }),
      })) : [];
      try {
        return await backupJob<{ id: string; created_at: number }>('platform', { root: this.root, directory, sources });
      } catch (error) {
        if (resolve(directory).startsWith(resolve(this.root, 'platform-backups') + sep)) rmSync(directory, { recursive: true, force: true });
        throw error;
      }
    } finally {
      release();
    }
  }

  async automaticPlatformBackup(raw: DatabaseSync) {
    const directory = safeBackupDirectory(join(this.root, 'platform-backups'), true);
    const copies = readdirSync(directory)
      .filter((id) => /^platform-\d{13}-[a-f\d-]{36}$/.test(id))
      .flatMap((id) => {
        try {
          const manifest = JSON.parse(readFileSync(join(directory, id, 'complete.json'), 'utf8'));
          return [{ id, created_at: Number(manifest.created_at) || 0 }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.created_at - a.created_at);
    if (Date.now() - (copies[0]?.created_at || 0) < 24 * 3600000) return;
    await this.snapshotPlatform(raw);
    for (const copy of copies.slice(13)) {
      const path = safeBackupDirectory(join(directory, copy.id));
      if (resolve(path).startsWith(resolve(directory) + sep)) rmSync(path, { recursive: true, force: true });
    }
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.queues.values()]);
    for (const ctx of this.contexts.values()) ctx.db.close();
    this.contexts.clear();
  }
}
