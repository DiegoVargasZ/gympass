import { DatabaseSync } from 'node:sqlite';
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  cpSync,
  readdirSync,
  lstatSync,
  rmSync,
  renameSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteDatabase } from './database.ts';
import { Backups, prepareDataStartup, safeBackupDirectory } from './backups.ts';
import { credentialVault } from './credential-vault.ts';
import { ApiError, Service, type CredentialCodec } from '../lib/service.ts';

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
function treeFiles(directory: string, prefix = ''): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry),
      info = lstatSync(path),
      name = prefix + entry;
    if (info.isSymbolicLink()) throw new ApiError(409, 'No se admiten enlaces de archivos en una copia de plataforma.');
    if (info.isDirectory()) result.push(...treeFiles(path, name + '/'));
    else if (info.isFile()) result.push(name);
    else throw new ApiError(409, 'La copia contiene un archivo no compatible.');
  }
  return result;
}

export class TenantManager {
  root: string;
  private contexts = new Map<string, TenantContext>();
  private queues = new Map<string, Promise<unknown>>();
  private maxOpen: number;
  private closed = false;
  private gate: Promise<void> = Promise.resolve();

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
        ctx.backups.check();
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
      // All copying below is synchronous, so central writes cannot interleave.
      const directory = safeBackupDirectory(
        join(this.root, 'platform-backups', `platform-${Date.now()}-${crypto.randomUUID()}`),
        true,
      );
      raw.prepare('VACUUM INTO ?').run(join(directory, 'platform.sqlite'));
      const sources = join(this.root, 'tenants');
      if (existsSync(sources)) {
        for (const id of readdirSync(sources)) {
          const source = this.directory(id);
          const destination = join(directory, 'tenants', id);
          mkdirSync(destination, { recursive: true });
          const ctx = this.contexts.get(id);
          const db = ctx?.db.raw || new DatabaseSync(this.databasePath({ id, name: '' }), { readOnly: true });
          try {
            db.prepare('VACUUM INTO ?').run(join(destination, 'gympass.sqlite'));
          } finally {
            if (!ctx) db.close();
          }
          for (const asset of ['credentials.key', 'photos', 'branding', 'backgrounds', 'tenant.json']) {
            const path = join(source, asset);
            if (existsSync(path)) {
              const info = lstatSync(path);
              if (info.isSymbolicLink()) throw new ApiError(409, 'No se respaldan enlaces de archivos.');
              if (info.isDirectory()) treeFiles(path);
              cpSync(path, join(destination, asset), { recursive: true });
            }
          }
        }
      }
      const files = Object.fromEntries(
        treeFiles(directory).map((file) => [
          file,
          createHash('sha256')
            .update(readFileSync(join(directory, file)))
            .digest('hex'),
        ]),
      );
      writeFileSync(join(directory, 'complete.json'), JSON.stringify({ format: 1, created_at: Date.now(), files }), {
        flag: 'wx',
        mode: 0o600,
      });
      return { id: directory.split(/[\\/]/).at(-1)!, created_at: Date.now() };
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
