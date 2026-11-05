import { DatabaseSync } from 'node:sqlite';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PlatformStore } from '../server/platform-store.ts';
import { safeBackupDirectory } from '../server/backups.ts';
import { acquirePlatformLock } from '../server/platform-lock.ts';
import {
  assertDisjoint,
  assertOffline,
  assertSafeTree,
  checksum,
  validateSqlite,
  validateTenantResources,
  validateOperationalVersion,
} from './platform-import.ts';

export async function restorePlatform(input: { snapshotDirectory: string; dataDirectory: string }) {
  const source = safeBackupDirectory(resolve(input.snapshotDirectory)),
    destination = safeBackupDirectory(resolve(input.dataDirectory));
  assertDisjoint(source, destination);
  assertOffline(destination);
  if (existsSync(destination) && readdirSync(destination).length)
    throw Error('La restauración requiere un directorio nuevo y vacío.');
  const files = assertSafeTree(source),
    complete = JSON.parse(readFileSync(join(source, 'complete.json'), 'utf8'));
  if (complete.format !== 1 || !Number.isFinite(complete.created_at))
    throw Error('La copia completa de plataforma no es válida.');
  if (
    !complete.files ||
    typeof complete.files !== 'object' ||
    Array.isArray(complete.files) ||
    !complete.files['platform.sqlite']
  )
    throw Error('Falta el manifiesto de hashes de la copia completa.');
  if (complete.files) {
    const actual = files
      .map((file) => relative(source, file).split(sep).join('/'))
      .filter((file) => file !== 'complete.json')
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify(Object.keys(complete.files).sort()))
      throw Error('La copia de plataforma está incompleta o contiene archivos inesperados.');
    for (const file of actual)
      if (
        typeof complete.files[file] !== 'string' ||
        checksum(join(source, ...file.split('/'))) !== complete.files[file]
      )
        throw Error('Un archivo de la copia no coincide con su hash.');
  }
  const registry = new DatabaseSync(pathToFileURL(join(source, 'platform.sqlite')).href + '?immutable=1', {
    readOnly: true,
  });
  let gyms: { id: string; status: string }[];
  try {
    validateSqlite(registry);
    if (!registry.prepare("SELECT 1 FROM platform_users WHERE global_role='superadmin' AND active=1").get())
      throw Error('La copia no contiene un superadministrador activo.');
    gyms = registry.prepare('SELECT id,status FROM gyms').all() as unknown as { id: string; status: string }[];
    const expected = new Set(gyms.map((gym) => gym.id));
    const tenants = join(source, 'tenants');
    if (existsSync(tenants))
      for (const entry of readdirSync(tenants))
        if (!expected.has(entry)) throw Error('La copia contiene un gimnasio sin registro central.');
    for (const gym of gyms) {
      if (!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(gym.id))
        throw Error('La identidad de un gimnasio no es válida.');
      const directory = join(source, 'tenants', gym.id),
        dbPath = join(directory, 'gympass.sqlite');
      if (!existsSync(dbPath) && gym.status === 'provisioning') continue;
      if (!existsSync(dbPath)) throw Error('Faltan los datos de un gimnasio activo o suspendido.');
      if (
        gym.status !== 'provisioning' &&
        !registry
          .prepare(
            "SELECT 1 FROM gym_memberships m JOIN platform_users u ON u.id=m.user_id WHERE m.gym_id=? AND m.active=1 AND m.role='admin' AND u.active=1",
          )
          .get(gym.id)
      )
        throw Error('Un gimnasio no conserva un administrador activo.');
      const tenant = new DatabaseSync(pathToFileURL(dbPath).href + '?immutable=1', { readOnly: true });
      try {
        validateSqlite(tenant);
        validateOperationalVersion(tenant);
        validateTenantResources(tenant, directory);
        if (
          tenant.prepare('SELECT owner FROM settings WHERE id=1').get()?.owner !== gym.id ||
          JSON.parse(readFileSync(join(directory, 'tenant.json'), 'utf8')).gym_id !== gym.id
        )
          throw Error('La identidad del gimnasio no coincide con el registro central.');
        if (
          tenant.prepare('SELECT COUNT(*) n FROM members').get()?.n !== 0 ||
          tenant.prepare('SELECT COUNT(*) n FROM sessions').get()?.n !== 0
        )
          throw Error('La copia contiene autenticación local dentro de un gimnasio.');
      } finally {
        tenant.close();
      }
    }
  } finally {
    registry.close();
  }
  // Validation completes before creating any destination file.
  mkdirSync(destination, { recursive: true });
  const releaseLock = acquirePlatformLock(destination);
  let restored: PlatformStore | undefined;
  try {
    if (readdirSync(destination).some((file) => file !== '.platform-running.json'))
      throw Error('La restauración requiere un directorio nuevo y vacío.');
    cpSync(join(source, 'platform.sqlite'), join(destination, 'platform.sqlite'), { errorOnExist: true, force: false });
    if (existsSync(join(source, 'tenants')))
      cpSync(join(source, 'tenants'), join(destination, 'tenants'), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    restored = new PlatformStore(destination);
    restored.raw.exec('BEGIN IMMEDIATE');
    try {
      const now = Date.now();
      restored.raw.prepare('UPDATE platform_sessions SET revoked_at=? WHERE revoked_at IS NULL').run(now);
      restored.raw.prepare('UPDATE support_sessions SET revoked_at=? WHERE revoked_at IS NULL').run(now);
      restored.raw.prepare('UPDATE invitations SET consumed_at=? WHERE consumed_at IS NULL').run(now);
      restored.raw.prepare('UPDATE password_resets SET consumed_at=? WHERE consumed_at IS NULL').run(now);
      const actor = restored.raw
        .prepare(
          "SELECT id FROM platform_users WHERE global_role='superadmin' AND active=1 ORDER BY created_at LIMIT 1",
        )
        .get()!;
      restored.audit(String(actor.id), 'platform.restored');
      restored.raw.exec('COMMIT');
    } catch (error) {
      restored.raw.exec('ROLLBACK');
      throw error;
    }
    return { gyms: restored.listAllGyms() };
  } finally {
    restored?.close();
    releaseLock();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--snapshot' || args[2] !== '--data')
    throw Error('Uso: node scripts/platform-restore.ts --snapshot <copia-completa> --data <directorio-nuevo-vacío>.');
  const result = await restorePlatform({ snapshotDirectory: args[1], dataDirectory: args[3] });
  process.stdout.write(JSON.stringify({ restored: true, gyms: result.gyms.length }) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error: unknown) => {
    process.stderr.write(
      (error instanceof Error && error.name !== 'SyntaxError' ? error.message : 'La copia no es válida.') + '\n',
    );
    process.exitCode = 1;
  });
