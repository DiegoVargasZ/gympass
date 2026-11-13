import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ApiError } from '../lib/service.ts';
import { maxBackupTransferBytes, backupTransferLimitLabel } from '../lib/backup-limits.ts';
import { safeBackupDirectory, digestBackupFile } from './backups.ts';
import { backupJob } from './backup-jobs.ts';
import { fileChunks } from './file-chunks.ts';

const pattern = /^platform-\d{13}-[a-f\d-]{36}$/;
export function platformCopies(root: string) {
  const directory = safeBackupDirectory(join(root, 'platform-backups'));
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(id => pattern.test(id)).flatMap(id => {
    try {
      const path = safeBackupDirectory(join(directory, id));
      const manifest = JSON.parse(readFileSync(join(path, 'complete.json'), 'utf8'));
      return manifest.format === 1 && Number.isFinite(manifest.created_at) ? [{ id, created_at: manifest.created_at }] : [];
    } catch { return []; }
  }).sort((a, b) => b.created_at - a.created_at);
}

type Archive = { directory: string; filename: string; created_at: number; entries: { file: string; size: number; hash: string }[] };

/** Verification runs in the backup worker before sending any archive bytes. */
export function inspectPlatformExport(root: string, id: string): Archive {
  if (!pattern.test(id)) throw new ApiError(400, 'Respaldo de plataforma inválido.');
  const directory = safeBackupDirectory(join(root, 'platform-backups', id));
  if (!existsSync(directory)) throw new ApiError(404, 'No se encontró el respaldo.');
  const manifestPath = join(directory, 'complete.json');
  const info = lstatSync(manifestPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new ApiError(409, 'Manifiesto de respaldo inválido.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.format !== 1 || !manifest.files?.['platform.sqlite'] || !Number.isFinite(manifest.created_at))
    throw new ApiError(409, 'La copia está incompleta.');
  let total = 1024;
  const entries = [...Object.keys(manifest.files), 'complete.json'].map(file => {
    if (file.includes('\\') || file.startsWith('/') || file.split('/').some(p => !p || p === '.' || p === '..') || Buffer.byteLength(file) > 255)
      throw new ApiError(409, 'El respaldo contiene una ruta inválida.');
    const target = resolve(directory, file);
    if (!target.startsWith(directory + sep)) throw new ApiError(409, 'Ruta fuera del respaldo.');
    safeBackupDirectory(resolve(target, '..'));
    const info = lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new ApiError(409, 'No se exportan enlaces ni archivos especiales.');
    total += 512 + Math.ceil(info.size / 512) * 512;
    if (total > maxBackupTransferBytes) throw new ApiError(413, 'La copia supera el límite de ' + backupTransferLimitLabel + '.');
    const split = Buffer.byteLength(file) > 100 ? file.lastIndexOf('/') : -1;
    if (Buffer.byteLength(split < 0 ? file : file.slice(split + 1)) > 100 || Buffer.byteLength(split < 0 ? '' : file.slice(0, split)) > 155)
      throw new ApiError(409, 'Nombre de archivo demasiado largo.');
    const hash = digestBackupFile(target);
    if (file !== 'complete.json' && hash !== manifest.files[file]) throw new ApiError(409, 'La copia está dañada o cambió durante la descarga.');
    return { file, size: info.size, hash };
  });
  return { directory, filename: id + '.tar.gz', created_at: manifest.created_at, entries };
}

function tarHeader(file: string, size: number, created: number) {
  const header = Buffer.alloc(512);
  const split = Buffer.byteLength(file) > 100 ? file.lastIndexOf('/') : -1;
  header.write(split < 0 ? file : file.slice(split + 1));
  header.write('0000600\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(size.toString(8).padStart(11, '0') + '\0', 124);
  header.write(Math.floor(created / 1000).toString(8).padStart(11, '0') + '\0', 136);
  header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
  header.write(split < 0 ? '' : file.slice(0, split), 345);
  header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return header;
}

/** Standard tar chunks; the HTTP sender applies streaming gzip without buffering the archive. */
export async function exportPlatformCopy(root: string, id: string) {
  const archive = await backupJob<Archive>('inspect-platform', { root, id });
  const chunks = async function* () {
    for (const entry of archive.entries) {
      yield tarHeader(entry.file, entry.size, archive.created_at);
      yield* fileChunks(join(archive.directory, entry.file), entry.size, entry.hash);
      yield Buffer.alloc((512 - entry.size % 512) % 512);
    }
    yield Buffer.alloc(1024);
  };
  return { filename: archive.filename, chunks: chunks() };
}
