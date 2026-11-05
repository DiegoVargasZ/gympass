import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stderr, stdout } from 'node:process';
import { PlatformStore, type PlatformUser } from '../server/platform-store.ts';
import { SqliteDatabase } from '../server/database.ts';
import { verifyPassword } from '../server/auth.ts';
import { credentialVault } from '../server/credential-vault.ts';
import { safeBackupDirectory } from '../server/backups.ts';
import { privatePassword } from './platform-admin.ts';
import { acquirePlatformLock } from '../server/platform-lock.ts';

type LegacyMember = {
  user_id: string;
  email: string;
  name: string;
  role: 'admin' | 'operator' | 'viewer';
  active: number;
  password_hash: string;
};
export type LegacyImportInput = {
  sourceDirectory: string;
  dataDirectory: string;
  email: string;
  password: string;
  name: string;
  slug: string;
  linkOwner?: boolean;
};
export const tenantAssets = ['credentials.key', 'photos', 'branding', 'backgrounds'] as const;
export const checksum = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const quote = (identifier: string) => '"' + identifier.replaceAll('"', '""') + '"';

export function assertOffline(directory: string) {
  safeBackupDirectory(resolve(directory));
  const marker = join(directory, '.platform-running.json');
  if (!existsSync(marker)) return;
  assertSafeTree(marker);
  let pid: unknown;
  try {
    pid = JSON.parse(readFileSync(marker, 'utf8')).pid;
  } catch {
    throw Error('No se pudo verificar que la plataforma esté apagada.');
  }
  if (!Number.isInteger(pid) || Number(pid) < 1) throw Error('No se pudo verificar que la plataforma esté apagada.');
  try {
    process.kill(Number(pid), 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw Error('No se pudo verificar que la plataforma esté apagada.');
  }
  throw Error('Apaga la plataforma antes de importar o restaurar datos.');
}

export function assertDisjoint(first: string, second: string) {
  const a = resolve(first),
    b = resolve(second),
    ab = relative(a, b),
    ba = relative(b, a);
  const inside = (value: string) =>
    value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith('..' + sep));
  if (inside(ab) || inside(ba)) throw Error('El origen y el destino deben estar en carpetas separadas.');
}

export function assertSafeTree(path: string): string[] {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw Error('No se permiten enlaces simbólicos en los datos.');
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) throw Error('Los datos contienen un archivo no compatible.');
  return readdirSync(path).flatMap((entry) => assertSafeTree(join(path, entry)));
}

export function validateSqlite(db: DatabaseSync) {
  if (
    db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' ||
    db.prepare('PRAGMA foreign_key_check').all().length
  )
    throw Error('La base de datos no pasó la comprobación de integridad.');
}

export function validateOperationalVersion(db: DatabaseSync) {
  const latest = Math.max(
    ...readdirSync(fileURLToPath(new URL('../server/migrations/', import.meta.url))).map((file) =>
      Number(/^(\d+)_.*\.sql$/.exec(file)?.[1] ?? 0),
    ),
  );
  const current = Number(db.prepare('SELECT MAX(version) AS version FROM schema_version').get()?.version);
  if (!Number.isInteger(current) || current < 1 || current > latest)
    throw Error('La versión de la base del gimnasio no es compatible.');
}

export function validateTenantResources(db: DatabaseSync, directory: string) {
  for (const asset of tenantAssets) if (existsSync(join(directory, asset))) assertSafeTree(join(directory, asset));
  const encrypted = db.prepare('SELECT id,hash,code_cipher FROM credentials WHERE code_cipher IS NOT NULL').all();
  const key = join(directory, 'credentials.key');
  if (encrypted.length && (!existsSync(key) || readFileSync(key).length !== 32))
    throw Error('Falta la clave necesaria para conservar los QR.');
  if (existsSync(key) && readFileSync(key).length !== 32) throw Error('La clave de credenciales no es válida.');
  if (encrypted.length) {
    const vault = credentialVault(key);
    for (const row of encrypted) {
      const code = vault.open(String(row.code_cipher), String(row.id));
      if (createHash('sha256').update(code).digest('hex') !== row.hash)
        throw Error('Un QR no coincide con su hash almacenado.');
    }
  }
  const references = [
    ['people', 'photo_path', 'photos'],
    ['settings', 'logo_path', 'branding'],
    ['visits', 'background_path', 'backgrounds'],
    ['invitation_batches', 'background_path', 'backgrounds'],
    ['invitation_templates', 'background_path', 'backgrounds'],
  ];
  for (const [table, column, assetDirectory] of references) {
    for (const row of db
      .prepare(
        `SELECT ${quote(column)} AS path FROM ${quote(table)} WHERE ${quote(column)} IS NOT NULL AND ${quote(column)}<>''`,
      )
      .all()) {
      if (
        typeof row.path !== 'string' ||
        basename(row.path) !== row.path ||
        /[\\/\x00-\x1f]/.test(row.path) ||
        !existsSync(join(directory, assetDirectory, row.path))
      )
        throw Error('Falta un recurso o contiene una ruta no válida.');
    }
  }
}

function validateMembers(members: LegacyMember[], ownerId: string) {
  const emails = new Set<string>();
  for (const member of members) {
    member.email = member.email.trim().toLowerCase();
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(member.email) ||
      member.email.length > 254 ||
      !member.name.trim() ||
      member.name.length > 120 ||
      typeof member.user_id !== 'string' ||
      !member.user_id ||
      member.user_id.length > 128 ||
      !['admin', 'operator', 'viewer'].includes(member.role) ||
      ![0, 1].includes(member.active) ||
      !/^[a-f\d]{32}:[a-f\d]{128}$/i.test(member.password_hash)
    )
      throw Error('Una cuenta de origen no es válida para la plataforma.');
    if (emails.has(member.email)) throw Error('Colisión de correos entre cuentas del origen.');
    emails.add(member.email);
  }
  if (!members.some((member) => member.user_id === ownerId && member.role === 'admin' && member.active))
    throw Error('El propietario del origen debe ser un administrador activo.');
}

function accountMapping(
  store: PlatformStore,
  members: LegacyMember[],
  ownerId: string,
  admin: PlatformUser,
  linkOwner: boolean,
) {
  const mapping = new Map<string, string>();
  let linkedOwner = false;
  for (const member of members) {
    const byEmail = store.raw.prepare('SELECT id,email FROM platform_users WHERE email=?').get(member.email);
    const byId = store.raw.prepare('SELECT id,email FROM platform_users WHERE id=?').get(member.user_id);
    const link = member.user_id === ownerId && byEmail?.id === admin.id && admin.email === member.email && linkOwner;
    if (link && (!byId || byId.id === admin.id)) {
      mapping.set(member.user_id, admin.id);
      linkedOwner = true;
    } else if (byEmail || byId)
      throw Error(
        'Colisión de identidad. Solo el propietario coincidente puede vincularse mediante confirmación explícita.',
      );
    else mapping.set(member.user_id, member.user_id);
  }
  return { mapping, linkedOwner };
}

export async function importLegacy(input: LegacyImportInput) {
  const source = safeBackupDirectory(resolve(input.sourceDirectory)),
    root = safeBackupDirectory(resolve(input.dataDirectory));
  assertDisjoint(source, root);
  assertOffline(root);
  if (!existsSync(join(root, 'platform.sqlite')))
    throw Error('Crea primero el propietario de la plataforma de destino.');
  assertSafeTree(join(source, 'gympass.sqlite'));
  for (const suffix of ['-wal', '-journal']) {
    const journal = join(source, 'gympass.sqlite' + suffix);
    if (existsSync(journal) && lstatSync(journal).size > 0)
      throw Error(
        'El origen tiene transacciones pendientes. Abre y cierra correctamente el servidor local antes de importar.',
      );
  }
  const releaseLock = acquirePlatformLock(root);
  let store: PlatformStore | undefined;
  let staging: string | undefined;
  try {
    store = new PlatformStore(root);
    const row = store.raw
      .prepare("SELECT * FROM platform_users WHERE email=? AND global_role='superadmin' AND active=1")
      .get(input.email.trim().toLowerCase());
    if (
      !row ||
      typeof input.password !== 'string' ||
      input.password.length > 200 ||
      !(await verifyPassword(input.password, String(row.password_hash)))
    )
      throw Error('Credenciales del superadministrador incorrectas.');
    if (
      !store.raw
        .prepare(
          "SELECT 1 FROM platform_users WHERE id=? AND password_hash=? AND global_role='superadmin' AND active=1",
        )
        .get(row.id, row.password_hash)
    )
      throw Error('Las credenciales del superadministrador cambiaron.');
    const admin: PlatformUser = {
      id: String(row.id),
      email: String(row.email),
      name: String(row.name),
      global_role: 'superadmin',
      active: true,
    };
    const gyms = store.listAllGyms();
    if (
      gyms.length &&
      !(
        gyms.length === 1 &&
        gyms[0].status === 'provisioning' &&
        gyms[0].slug === input.slug &&
        gyms[0].name === input.name.trim()
      )
    )
      throw Error('Esta utilidad solo importa la primera instalación. No fusiona gimnasios existentes.');
    const gym = store.createGym(admin, { name: input.name, slug: input.slug });
    staging = mkdtempSync(join(tmpdir(), 'gympass-import-stage-'));
    const sourceDb = new DatabaseSync(pathToFileURL(join(source, 'gympass.sqlite')).href + '?immutable=1', {
      readOnly: true,
    });
    try {
      validateSqlite(sourceDb);
      sourceDb.prepare('VACUUM INTO ?').run(join(staging, 'gympass.sqlite'));
    } finally {
      sourceDb.close();
    }
    for (const asset of tenantAssets) {
      const from = join(source, asset);
      if (existsSync(from)) {
        assertSafeTree(from);
        cpSync(from, join(staging, asset), { recursive: true, errorOnExist: true, force: false });
      }
    }
    const db = new SqliteDatabase(join(staging, 'gympass.sqlite'));
    let members: LegacyMember[],
      ownerId: string,
      linkedOwner = false,
      mapping: Map<string, string>;
    try {
      validateSqlite(db.raw);
      validateTenantResources(db.raw, staging);
      const settings = db.raw.prepare('SELECT owner FROM settings WHERE id=1').get();
      if (!settings) throw Error('No se encontró la configuración del origen.');
      ownerId = String(settings.owner);
      members = db.raw.prepare('SELECT * FROM members').all() as unknown as LegacyMember[];
      validateMembers(members, ownerId);
      ({ mapping, linkedOwner } = accountMapping(store, members, ownerId, admin, input.linkOwner === true));
      db.raw.exec('BEGIN IMMEDIATE');
      try {
        if (linkedOwner && ownerId !== admin.id) {
          const tables = db.raw
            .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            .all();
          for (const table of tables) {
            if (['settings', 'members', 'sessions'].includes(String(table.name))) continue;
            const columns = db.raw.prepare(`PRAGMA table_info(${quote(String(table.name))})`).all();
            for (const column of columns)
              if (['actor', 'closed_by', 'created_by', 'user_id', 'owner'].includes(String(column.name)))
                db.raw
                  .prepare(
                    `UPDATE ${quote(String(table.name))} SET ${quote(String(column.name))}=? WHERE ${quote(String(column.name))}=?`,
                  )
                  .run(admin.id, ownerId);
          }
          db.raw
            .prepare(
              "INSERT INTO audit(actor,action,entity_id,occurred_at) VALUES(?,'platform.legacy_owner_linked',?,?)",
            )
            .run(admin.id, ownerId, Date.now());
        }
        db.raw.prepare('UPDATE settings SET owner=?,name=?,recovery_hash=? WHERE id=1').run(gym.id, gym.name, '');
        db.raw.exec('DELETE FROM sessions; DELETE FROM members; UPDATE devices SET active=0;');
        db.raw.exec('COMMIT');
      } catch (error) {
        db.raw.exec('ROLLBACK');
        throw error;
      }
      validateSqlite(db.raw);
    } finally {
      db.close();
    }
    credentialVault(join(staging, 'credentials.key'));
    writeFileSync(join(staging, 'tenant.json'), JSON.stringify({ gym_id: gym.id }), { mode: 0o600, flag: 'wx' });
    const destination = join(root, 'tenants', gym.id);
    safeBackupDirectory(destination);
    if (existsSync(destination))
      throw Error('El destino del gimnasio ya contiene archivos. No se sobrescriben importaciones parciales.');
    mkdirSync(join(root, 'tenants'), { recursive: true });
    cpSync(staging, destination, { recursive: true, errorOnExist: true, force: false });
    store.raw.exec('BEGIN IMMEDIATE');
    try {
      if (
        !store.raw
          .prepare(
            "SELECT 1 FROM platform_users WHERE id=? AND password_hash=? AND global_role='superadmin' AND active=1",
          )
          .get(admin.id, row.password_hash)
      )
        throw Error('Las credenciales del superadministrador cambiaron.');
      const fresh = accountMapping(store, members!, ownerId!, admin, input.linkOwner === true);
      for (const member of members!) {
        const id = fresh.mapping.get(member.user_id)!;
        if (id !== admin.id)
          store.raw
            .prepare(
              "INSERT INTO platform_users(id,email,name,password_hash,global_role,active,created_at) VALUES(?,?,?,?,'user',1,?)",
            )
            .run(id, member.email, member.name, member.password_hash, Date.now());
        store.raw
          .prepare('INSERT INTO gym_memberships(user_id,gym_id,role,active) VALUES(?,?,?,?)')
          .run(id, gym.id, member.role, member.active);
      }
      store.markGymProvisioned(gym.id);
      store.updateGym(admin, gym.id, { status: 'active' });
      store.audit(admin.id, 'gym.legacy_imported', gym.id, gym.id);
      if (linkedOwner) store.audit(admin.id, 'user.legacy_owner_linked', gym.id, ownerId!);
      store.raw.exec('COMMIT');
    } catch (error) {
      store.raw.exec('ROLLBACK');
      throw error;
    }
    return { gym: store.getGym(gym.id)!, users: members!.length, linkedOwner };
  } finally {
    try {
      store?.close();
    } finally {
      releaseLock();
    }
    if (staging) {
      const relativeTemp = relative(tmpdir(), staging);
      if (relativeTemp.startsWith('gympass-import-stage-') && !relativeTemp.includes(sep))
        rmSync(staging, { recursive: true, force: true });
    }
  }
}

async function cliInput(): Promise<Record<string, unknown>> {
  if (!stdin.isTTY) {
    let value = '';
    for await (const chunk of stdin) {
      value += chunk;
      if (Buffer.byteLength(value) > 16 * 1024) throw Error('Entrada demasiado grande.');
    }
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('Se requiere un objeto JSON.');
    return parsed as Record<string, unknown>;
  }
  const reader = createInterface({ input: stdin, output: stderr });
  const email = await reader.question('Correo del superadministrador: '),
    name = await reader.question('Nombre del gimnasio: '),
    slug = await reader.question('Identificador del gimnasio: ');
  const linkOwner =
    (await reader.question(
      '¿Vincular el propietario local si coincide con esta cuenta? Escribe VINCULAR para confirmarlo: ',
    )) === 'VINCULAR';
  reader.close();
  return { email, name, slug, linkOwner, password: await privatePassword() };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--source' || args[2] !== '--data')
    throw Error(
      'Uso: node scripts/platform-import.ts --source <datos-locales> --data <datos-plataforma>. Apaga ambos servidores; las credenciales se leen por stdin.',
    );
  const input = await cliInput();
  if (['email', 'password', 'name', 'slug'].some((key) => typeof input[key] !== 'string'))
    throw Error('Faltan email, password, name o slug en la entrada.');
  const result = await importLegacy({
    sourceDirectory: args[1],
    dataDirectory: args[3],
    email: input.email as string,
    password: input.password as string,
    name: input.name as string,
    slug: input.slug as string,
    linkOwner: input.linkOwner === true,
  });
  stdout.write(JSON.stringify({ gym: result.gym, users: result.users, linkedOwner: result.linkedOwner }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error: unknown) => {
    stderr.write(
      (error instanceof Error && error.name !== 'SyntaxError' ? error.message : 'Entrada JSON inválida.') + '\n',
    );
    process.exitCode = 1;
  });
