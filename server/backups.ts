import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  cpSync,
  renameSync,
  rmSync,
  lstatSync,
  mkdtempSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { ApiError } from '../lib/service.ts';
import { replaceFileSync } from './atomic-file.ts';
import { exportBackupCopy, importBackupCopy, sameBackup } from './backup-transfer.ts';

export const applicationVersion: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
const assets = [
  'credentials.key',
  'photos',
  'branding',
  'backgrounds',
  'tls',
  'camera-link.json',
  'backup-settings.json',
  'network-host.json',
];
const idPattern = /^gympass-\d{13}-[a-f\d-]{36}$/;
type Kind = 'automatic' | 'manual' | 'before-update' | 'before-restore';
export type Manifest = {
  format: 1;
  id: string;
  created_at: number;
  version: string;
  schema: number;
  kind: Kind;
  files: Record<string, string>;
};
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function safeTree(root: string, relative = ''): string[] {
  if (!relative) safeBackupDirectory(root);
  const result: string[] = [];
  for (const name of readdirSync(join(root, relative))) {
    const child = join(relative, name),
      path = join(root, child),
      stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw Error('La copia contiene un enlace de archivos no permitido.');
    if (stat.isDirectory()) result.push(...safeTree(root, child));
    else if (stat.isFile()) result.push(child);
    else throw Error('La copia contiene un archivo no compatible.');
  }
  return result;
}
function confined(root: string, path: string) {
  const absolute = resolve(root, path);
  if (!absolute.startsWith(resolve(root) + sep)) throw Error('Ruta de respaldo inválida.');
  return absolute;
}
export function safeBackupDirectory(input: string, create = false) {
  if (typeof input !== 'string' || input.length > 4096 || !isAbsolute(input) || /[\x00-\x1f]/.test(input))
    throw new ApiError(400, 'Usa una ruta absoluta para la carpeta de respaldos.');
  const directory = resolve(input);
  if (directory === parse(directory).root) throw new ApiError(400, 'Elige una carpeta dentro del disco, no la raíz.');
  for (let path = directory; ; path = dirname(path)) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new ApiError(400, 'La ruta de respaldos no puede contener enlaces simbólicos.');
    if (dirname(path) === path) break;
  }
  if (create) mkdirSync(directory, { recursive: true });
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) throw new ApiError(400, 'La ubicación de respaldos debe ser una carpeta.');
  return directory;
}
export function canonicalBackupFile(input: string) {
  if (typeof input !== 'string' || input.length > 1024) throw new ApiError(400, 'Ruta de archivo inválida.');
  const path = input.replaceAll('\\', '/');
  const parts = path.split('/');
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[<>:"|?*\x00-\x1f]/.test(part) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part),
    )
  )
    throw new ApiError(400, 'El respaldo contiene una ruta de archivo no permitida.');
  const top = parts[0];
  if (!['photos', 'branding', 'backgrounds', 'tls'].includes(top)) {
    if (parts.length !== 1 || !['gympass.sqlite', ...assets].includes(top))
      throw new ApiError(400, 'El respaldo contiene un archivo ajeno a los datos de GymPASS.');
  } else if (parts.length < 2) throw new ApiError(400, 'Falta el nombre del archivo de recursos.');
  return path;
}
export function validateBackupManifest(input: unknown, id: string, maxSchema: number): Manifest {
  const manifest = input as Manifest;
  if (
    !idPattern.test(id) ||
    !manifest ||
    manifest.format !== 1 ||
    manifest.id !== id ||
    !Number.isInteger(manifest.schema) ||
    manifest.schema < 1 ||
    manifest.schema > maxSchema ||
    !Number.isFinite(manifest.created_at) ||
    typeof manifest.version !== 'string' ||
    !['automatic', 'manual', 'before-update', 'before-restore'].includes(manifest.kind) ||
    !manifest.files ||
    typeof manifest.files !== 'object' ||
    Array.isArray(manifest.files)
  )
    throw new ApiError(409, 'El respaldo no es compatible con esta versión de GymPASS.');
  const files: Record<string, string> = Object.create(null);
  const seen = new Set<string>();
  for (const [name, digest] of Object.entries(manifest.files)) {
    const path = canonicalBackupFile(name);
    if (seen.has(path.toLowerCase()) || typeof digest !== 'string' || !/^[a-f\d]{64}$/.test(digest))
      throw new ApiError(409, 'El manifiesto contiene archivos duplicados o hashes inválidos.');
    seen.add(path.toLowerCase());
    files[path] = digest;
  }
  if (!files['gympass.sqlite']) throw new ApiError(409, 'Falta la base de datos del respaldo.');
  return { ...manifest, files };
}
export function backupDirectory(source: string) {
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(join(dirname(source), 'restore-plan.json'), 'utf8')).directory;
  } catch {}
  if (typeof saved === 'string') return directoryForSource(saved, source);
  try {
    saved = JSON.parse(readFileSync(join(dirname(source), 'backup-settings.json'), 'utf8')).directory;
  } catch {}
  if (typeof saved === 'string') return directoryForSource(saved, source);
  return resolve(process.env.BACKUP_DIR || join(dirname(source), '..', 'backups'));
}
function directoryForSource(input: string, source: string) {
  const directory = safeBackupDirectory(input);
  const media = resolve(dirname(source));
  const above = relative(directory, media);
  if (above === '' || (!isAbsolute(above) && above !== '..' && !above.startsWith('..' + sep)))
    throw new ApiError(400, 'La carpeta de respaldos no puede contener los datos de la instalación.');
  const inside = relative(media, directory).split(sep);
  if (
    ['photos', 'branding', 'backgrounds', 'tls'].includes(inside[0]) ||
    inside[0].startsWith('restore-') ||
    directory.split(sep).some((part) => idPattern.test(part))
  )
    throw new ApiError(400, 'Elige una carpeta fuera de los recursos de la instalación.');
  return directory;
}
function atomicJson(path: string, value: unknown) {
  const temporary = path + '.tmp';
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  replaceFileSync(temporary, path);
}
export function prepareDataStartup(source: string, migrations: string) {
  const directory = backupDirectory(source),
    maxSchema = Math.max(
      ...readdirSync(migrations)
        .filter((f) => /^\d+_.*\.sql$/.test(f))
        .map((f) => Number(f.split('_')[0])),
    );
  applyPendingRestore(source, directory, maxSchema);
  if (!existsSync(source)) return;
  const db = new DatabaseSync(source);
  try {
    const hasVersion = db.prepare("SELECT name FROM sqlite_master WHERE name='schema_version'").get();
    const current = hasVersion ? Number(db.prepare('SELECT MAX(version) n FROM schema_version').get()?.n || 0) : 0;
    if (current > 0 && current < maxSchema) createBackup(db, source, directory, 'before-update');
  } finally {
    db.close();
  }
}
export function createBackup(raw: DatabaseSync, source: string, dir: string, kind: Kind): Manifest {
  safeBackupDirectory(dir, true);
  const id = `gympass-${Date.now()}-${crypto.randomUUID()}`,
    destination = confined(dir, id);
  mkdirSync(destination);
  try {
    // Synchronous snapshot + asset copy keeps image mutations from interleaving with the snapshot.
    raw.prepare('VACUUM INTO ?').run(join(destination, 'gympass.sqlite'));
    for (const item of assets) {
      const path = join(dirname(source), item);
      if (existsSync(path)) {
        safeTreeIfDirectory(path);
        cpSync(path, join(destination, item), { recursive: true, errorOnExist: true, force: false });
      }
    }
    const files = Object.fromEntries(safeTree(destination).map((file) => [file, digest(join(destination, file))]));
    const manifest: Manifest = {
      format: 1,
      id,
      created_at: Date.now(),
      version: applicationVersion,
      schema: Number(raw.prepare('SELECT MAX(version) n FROM schema_version').get()?.n || 0),
      kind,
      files,
    };
    writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    return manifest;
  } catch (error) {
    rmSync(confined(dir, id), { recursive: true, force: true });
    throw error;
  }
}
function safeTreeIfDirectory(path: string) {
  if (lstatSync(path).isSymbolicLink()) throw Error('No se respaldan enlaces de archivos.');
  if (statSync(path).isDirectory()) safeTree(path);
}
export function inspectBackup(dir: string, id: string, maxSchema: number) {
  if (!idPattern.test(id)) throw new ApiError(400, 'Respaldo inválido.');
  safeBackupDirectory(dir);
  const root = confined(dir, id);
  safeBackupDirectory(root);
  const manifestPath = join(root, 'manifest.json');
  const manifestStat = lstatSync(manifestPath, { throwIfNoEntry: false });
  if (
    manifestStat?.isSymbolicLink() ||
    (manifestStat && (!manifestStat.isFile() || manifestStat.size > 4 * 1024 * 1024))
  )
    throw new ApiError(400, 'El manifiesto del respaldo no es un archivo válido.');
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  } catch {
    throw new ApiError(404, 'No se encontró el respaldo completo.');
  }
  manifest = validateBackupManifest(manifest, id, maxSchema);
  const actual = safeTree(root)
    .filter((file) => file !== 'manifest.json')
    .map(canonicalBackupFile)
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(manifest.files).sort()))
    throw new ApiError(409, 'El respaldo está incompleto o fue modificado.');
  for (const file of actual)
    if (digest(confined(root, file)) !== manifest.files[file])
      throw new ApiError(409, 'El respaldo está dañado o fue modificado.');
  const db = new DatabaseSync(join(root, 'gympass.sqlite'), { readOnly: true });
  try {
    if (
      db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new ApiError(409, 'La base del respaldo no pasó la verificación.');
    const schema = Number(db.prepare('SELECT MAX(version) n FROM schema_version').get()?.n || 0);
    if (schema !== manifest.schema || schema > maxSchema)
      throw new ApiError(409, 'La versión de la base del respaldo no es compatible.');
    const hasCipher = db
      .prepare('PRAGMA table_info(credentials)')
      .all()
      .some((column) => column.name === 'code_cipher');
    const encrypted = hasCipher
      ? Number(db.prepare('SELECT COUNT(*) n FROM credentials WHERE code_cipher IS NOT NULL').get()?.n || 0)
      : 0;
    if (encrypted && (!manifest.files['credentials.key'] || readFileSync(join(root, 'credentials.key')).length !== 32))
      throw new ApiError(409, 'Falta la clave necesaria para recuperar los QR.');
    return {
      id,
      created_at: manifest.created_at,
      version: manifest.version,
      kind: manifest.kind,
      people: Number(db.prepare('SELECT COUNT(*) n FROM people').get()?.n),
      events: Number(db.prepare('SELECT COUNT(*) n FROM events').get()?.n),
      invitations: schema >= 6 ? Number(db.prepare('SELECT COUNT(*) n FROM visits').get()?.n) : 0,
      schema,
    };
  } finally {
    db.close();
  }
}

/** Applied before opening any live database or credential key. A journal makes interrupted restores recoverable. */
export function applyPendingRestore(source: string, dir: string, maxSchema: number) {
  const data = dirname(source),
    planPath = join(data, 'restore-plan.json');
  if (!existsSync(planPath)) return;
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as {
    id: string;
    transaction: string;
    phase?: string;
    directory?: string;
  };
  if (!/^[a-f\d-]{36}$/.test(plan.transaction)) throw Error('Plan de restauración inválido.');
  const rollback = confined(data, `restore-rollback-${plan.transaction}`),
    stage = confined(data, `restore-stage-${plan.transaction}`);
  const targets = [basename(source), ...assets];
  if (plan.phase === 'committed') {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    if (existsSync(rollback)) rmSync(rollback, { recursive: true, force: true });
    rmSync(planPath);
    return;
  }
  if (plan.phase === 'swapping') {
    // Roll back the partially completed attempt before trying again.
    for (const item of targets) {
      const previous = join(rollback, item),
        current = join(data, item);
      if (existsSync(previous)) {
        if (existsSync(current)) rmSync(confined(data, item), { recursive: true, force: true });
        renameSync(previous, current);
      } else if (existsSync(join(rollback, `.absent-${item}`)) && existsSync(current))
        rmSync(confined(data, item), { recursive: true, force: true });
    }
    for (const suffix of ['-wal', '-shm']) if (existsSync(source + suffix)) rmSync(source + suffix);
  }
  inspectBackup(dir, plan.id, maxSchema);
  if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  if (existsSync(rollback)) rmSync(rollback, { recursive: true, force: true });
  mkdirSync(stage);
  mkdirSync(rollback);
  const original = confined(dir, plan.id);
  cpSync(join(original, 'gympass.sqlite'), join(stage, basename(source)));
  for (const item of assets)
    if (existsSync(join(original, item))) cpSync(join(original, item), join(stage, item), { recursive: true });
  // The destination belongs to this installation; a portable copy must not select another machine's path.
  const stagedSettings = join(stage, 'backup-settings.json');
  let restoredSettings: Record<string, unknown> = {};
  try {
    restoredSettings = JSON.parse(readFileSync(stagedSettings, 'utf8'));
  } catch {}
  const pinnedDirectory = directoryForSource(plan.directory || dir, source);
  atomicJson(stagedSettings, { ...restoredSettings, directory: pinnedDirectory });
  atomicJson(planPath, { ...plan, phase: 'swapping' });
  for (const item of targets) {
    const current = join(data, item),
      old = join(rollback, item),
      replacement = join(stage, item);
    if (existsSync(current)) renameSync(current, old);
    else writeFileSync(join(rollback, `.absent-${item}`), '');
    if (existsSync(replacement)) renameSync(replacement, current);
  }
  for (const suffix of ['-wal', '-shm']) if (existsSync(source + suffix)) rmSync(source + suffix);
  atomicJson(planPath, { ...plan, phase: 'committed' });
  rmSync(stage, { recursive: true, force: true });
  rmSync(rollback, { recursive: true, force: true });
  rmSync(planPath);
}

export class Backups {
  raw: DatabaseSync;
  source: string;
  directory: string;
  error = '';
  timer: ReturnType<typeof setInterval> | undefined;
  constructor(raw: DatabaseSync, source: string, directory = backupDirectory(source)) {
    this.raw = raw;
    this.source = source;
    this.directory = directory;
  }
  settings() {
    try {
      const p = JSON.parse(readFileSync(join(dirname(this.source), 'backup-settings.json'), 'utf8'));
      return {
        enabled: p.enabled !== false,
        interval_hours: [6, 12, 24].includes(p.interval_hours) ? p.interval_hours : 24,
        keep: Math.min(60, Math.max(3, Number(p.keep) || 14)),
        directory: this.directory,
      };
    } catch {
      return { enabled: true, interval_hours: 24, keep: 14, directory: this.directory };
    }
  }
  configure(body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new ApiError(400, 'Configuración de respaldo inválida.');
    const p = body as Record<string, unknown>;
    const keys = Object.keys(p);
    if (!keys.length || keys.some((key) => !['enabled', 'interval_hours', 'keep', 'directory'].includes(key)))
      throw new ApiError(400, 'Configuración de respaldo inválida.');
    if (
      ('enabled' in p && typeof p.enabled !== 'boolean') ||
      ('interval_hours' in p && ![6, 12, 24].includes(p.interval_hours as number)) ||
      ('keep' in p && (!Number.isInteger(p.keep) || Number(p.keep) < 3 || Number(p.keep) > 60)) ||
      ('directory' in p && typeof p.directory !== 'string')
    )
      throw new ApiError(400, 'Configuración de respaldo inválida.');
    const directory = 'directory' in p ? directoryForSource(p.directory as string, this.source) : this.directory;
    const config = { ...this.settings(), ...p, directory };
    const added: string[] = [];
    let temporary: string | undefined;
    try {
      safeBackupDirectory(directory, true);
      const probe = join(directory, '.write-' + crypto.randomUUID());
      writeFileSync(probe, '', { flag: 'wx', mode: 0o600 });
      unlinkSync(probe);
      if (resolve(directory) !== resolve(this.directory) && existsSync(this.directory)) {
        safeBackupDirectory(this.directory);
        temporary = mkdtempSync(join(directory, '.relocate-'));
        for (const id of readdirSync(this.directory).filter((name) => idPattern.test(name))) {
          this.inspect(id);
          const original = join(this.directory, id);
          const destination = confined(directory, id);
          if (lstatSync(destination, { throwIfNoEntry: false })) {
            inspectBackup(directory, id, this.maxSchema());
            const left = validateBackupManifest(
              JSON.parse(readFileSync(join(original, 'manifest.json'), 'utf8')),
              id,
              this.maxSchema(),
            );
            const right = validateBackupManifest(
              JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8')),
              id,
              this.maxSchema(),
            );
            if (!sameBackup(left, right))
              throw new ApiError(409, 'La nueva ubicación contiene una copia diferente con el mismo identificador.');
            continue;
          }
          cpSync(original, join(temporary, id), { recursive: true, errorOnExist: true, force: false });
          inspectBackup(temporary, id, this.maxSchema());
          renameSync(join(temporary, id), destination);
          added.push(destination);
        }
      }
      if (temporary) {
        if (dirname(resolve(temporary)) !== resolve(directory)) throw new ApiError(400, 'Ruta temporal inválida.');
        rmSync(temporary, { recursive: true, force: true });
        temporary = undefined;
      }
      atomicJson(join(dirname(this.source), 'backup-settings.json'), config);
      this.directory = directory;
    } catch (error) {
      for (const path of added) {
        if (dirname(resolve(path)) !== resolve(directory)) throw new ApiError(400, 'Ruta de respaldo inválida.');
        rmSync(path, { recursive: true, force: true });
      }
      throw error;
    } finally {
      if (temporary) {
        if (dirname(resolve(temporary)) !== resolve(directory)) throw new ApiError(400, 'Ruta temporal inválida.');
        rmSync(temporary, { recursive: true, force: true });
      }
    }
    return this.settings();
  }
  list() {
    safeBackupDirectory(this.directory);
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory)
      .filter((id) => idPattern.test(id))
      .flatMap((id) => {
        try {
          const root = join(this.directory, id);
          safeTree(root);
          const manifest = validateBackupManifest(
            JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')),
            id,
            this.maxSchema(),
          );
          return [
            {
              id,
              created_at: manifest.created_at,
              kind: manifest.kind,
              version: manifest.version,
              bytes: Object.keys(manifest.files).reduce(
                (sum, file) => sum + statSync(confined(join(this.directory, id), file)).size,
                0,
              ),
            },
          ];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.created_at - a.created_at);
  }
  create(kind: Kind = 'manual') {
    try {
      const result = createBackup(this.raw, this.source, this.directory, kind);
      this.error = '';
      return result;
    } catch (error) {
      this.error = (error as Error).message;
      throw error;
    }
  }
  check() {
    const now = Date.now(),
      config = this.settings(),
      last = this.list().find((copy) => copy.kind === 'automatic' && copy.created_at <= now);
    if (
      !config.enabled ||
      now - (last?.created_at || 0) < config.interval_hours * 3600000 ||
      !this.raw.prepare('SELECT id FROM settings LIMIT 1').get()
    )
      return;
    this.create('automatic');
    for (const old of this.list()
      .filter((copy) => copy.kind === 'automatic')
      .slice(config.keep))
      rmSync(confined(this.directory, old.id), { recursive: true, force: true });
  }
  start() {
    try {
      this.check();
    } catch (error) {
      this.error = (error as Error).message;
    }
    this.timer = setInterval(() => {
      try {
        this.check();
      } catch (error) {
        this.error = (error as Error).message;
      }
    }, 60000);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  inspect(id: string) {
    return inspectBackup(
      this.directory,
      id,
      Number(this.raw.prepare('SELECT MAX(version) n FROM schema_version').get()?.n || 0),
    );
  }
  private maxSchema() {
    return Number(this.raw.prepare('SELECT MAX(version) n FROM schema_version').get()?.n || 0);
  }
  exportCopy(id: string) {
    return exportBackupCopy(this.directory, id, this.maxSchema());
  }
  importCopy(bytes: Uint8Array) {
    return importBackupCopy(this.directory, bytes, this.maxSchema());
  }
  restore(id: string) {
    const preview = this.inspect(id),
      safety = this.create('before-restore');
    atomicJson(join(dirname(this.source), 'restore-plan.json'), {
      id,
      transaction: crypto.randomUUID(),
      directory: this.directory,
    });
    return { preview, safety: safety.id };
  }
  status() {
    const copies = this.list();
    return { settings: this.settings(), directory: this.directory, copies, last: copies[0] ?? null, error: this.error };
  }
}
