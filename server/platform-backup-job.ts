import { DatabaseSync } from 'node:sqlite';
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { safeBackupDirectory, digestBackupFile } from './backups.ts';

function files(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix)).flatMap(name => {
    const file = prefix ? prefix + '/' + name : name;
    const info = lstatSync(join(root, file));
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw Error('No se respaldan enlaces ni archivos especiales.');
    return info.isDirectory() ? files(root, file) : [file];
  });
}

/** Runs off the HTTP thread. Only immutable backup copies are linked to each other, never live files. */
export function capturePlatformBackup(root: string, directory: string, sources: { id: string; database: string }[]) {
  const backupRoot = safeBackupDirectory(join(root, 'platform-backups'));
  directory = safeBackupDirectory(directory);
  if (!directory.startsWith(backupRoot + sep)) throw Error('Destino de respaldo inválido.');
  const previous = readdirSync(backupRoot).filter(name => /^platform-\d{13}-[a-f\d-]{36}$/.test(name))
    .filter(name => join(backupRoot, name) !== directory && existsSync(join(backupRoot, name, 'complete.json')))
    .sort().at(-1);
  let previousManifest: { files?: Record<string, string> } = {};
  if (previous) {
    try { previousManifest = JSON.parse(readFileSync(join(backupRoot, previous, 'complete.json'), 'utf8')); } catch { /* No reuse from an incomplete copy. */ }
  }
  const hashes: Record<string, string> = {};
  for (const source of sources) {
    if (!/^[a-f\d-]{36}$/.test(source.id)) throw Error('Gimnasio inválido.');
    const sourceRoot = safeBackupDirectory(join(root, 'tenants', source.id));
    if (resolve(source.database) !== join(sourceRoot, 'gympass.sqlite') &&
      (!resolve(source.database).startsWith(sourceRoot + sep) || !source.database.endsWith('.sqlite')))
      throw Error('Base fuera del gimnasio.');
    const destination = join(directory, 'tenants', source.id);
    mkdirSync(destination, { recursive: true });
    const raw = new DatabaseSync(source.database, { readOnly: true });
    try { raw.prepare('VACUUM INTO ?').run(join(destination, 'gympass.sqlite')); }
    finally { raw.close(); }
    for (const asset of ['credentials.key', 'photos', 'branding', 'backgrounds', 'tenant.json']) {
      const path = join(sourceRoot, asset);
      if (!existsSync(path)) continue;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw Error('No se respaldan enlaces.');
      const entries = info.isDirectory() ? files(sourceRoot, asset) : [asset];
      for (const entry of entries) {
        const name = 'tenants/' + source.id + '/' + entry;
        const hash = digestBackupFile(join(sourceRoot, entry));
        const target = join(directory, name);
        mkdirSync(resolve(target, '..'), { recursive: true });
        const old = previous ? join(backupRoot, previous, name) : '';
        let linked = false;
        if (old && previousManifest.files?.[name] === hash) {
          try {
            // Validate the old tree before following a candidate path.
            safeBackupDirectory(resolve(old, '..'));
            if (!lstatSync(old).isSymbolicLink() && digestBackupFile(old) === hash) {
              linkSync(old, target);
              linked = true;
            }
          } catch { /* Cross-device links or an unavailable old copy fall back to copying. */ }
        }
        if (!linked) cpSync(join(sourceRoot, entry), target, { errorOnExist: true, force: false });
        hashes[name] = hash;
      }
    }
  }
  for (const file of files(directory)) hashes[file] ??= digestBackupFile(join(directory, file));
  writeFileSync(join(directory, 'complete.json'), JSON.stringify({ format: 1, created_at: Date.now(), files: hashes }), { flag: 'wx', mode: 0o600 });
  return { id: relative(backupRoot, directory), created_at: Date.now() };
}
