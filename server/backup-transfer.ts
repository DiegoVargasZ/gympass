import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { mkdtemp, open, rm, statfs } from 'node:fs/promises';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { ApiError } from '../lib/service.ts';
import { maxBackupTransferBytes, maxBufferedBackupBytes, backupTransferLimitLabel } from '../lib/backup-limits.ts';
import { fileChunks } from './file-chunks.ts';
import {
  canonicalBackupFile,
  inspectBackup,
  safeBackupDirectory,
  validateBackupManifest,
  type Manifest,
} from './backups.ts';

export { maxBackupTransferBytes };
const magic = Buffer.from('GYMPASSBACKUP1\n');
const maxHeaderBytes = 4 * 1024 * 1024;
type Entry = { path: string; size: number };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function readManifest(directory: string, id: string, maxSchema: number) {
  inspectBackup(directory, id, maxSchema);
  return validateBackupManifest(JSON.parse(readFileSync(join(directory, id, 'manifest.json'), 'utf8')), id, maxSchema);
}

export function sameBackup(left: Manifest, right: Manifest) {
  return (
    left.id === right.id &&
    left.schema === right.schema &&
    JSON.stringify(Object.entries(left.files).sort()) === JSON.stringify(Object.entries(right.files).sort())
  );
}

export function exportBackupCopy(
  directory: string,
  id: string,
  maxSchema: number,
): { bytes: Buffer; filename: string } {
  const manifest = readManifest(directory, id, maxSchema);
  const entries: Entry[] = Object.keys(manifest.files)
    .sort()
    .map((path) => ({
      path,
      size: lstatSync(join(directory, id, ...path.split('/'))).size,
    }));
  const header = Buffer.from(JSON.stringify({ format: 1, manifest, entries }));
  const size = magic.length + 4 + header.length + entries.reduce((sum, entry) => sum + entry.size, 0);
  if (header.length > maxHeaderBytes || size > maxBufferedBackupBytes)
    throw new ApiError(413, 'La copia supera el límite de exportación de 256 MiB.');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  const chunks = [magic, length, header];
  for (const entry of entries) {
    const file = join(directory, id, ...entry.path.split('/'));
    if (lstatSync(file).isSymbolicLink()) throw new ApiError(400, 'No se exportan enlaces simbólicos.');
    const bytes = readFileSync(file);
    if (bytes.length !== entry.size || digest(bytes) !== manifest.files[entry.path])
      throw new ApiError(409, 'La copia cambió durante la exportación. Inténtalo otra vez.');
    chunks.push(bytes);
  }
  return { bytes: Buffer.concat(chunks, size), filename: id + '.gympassbackup' };
}

/** The caller verifies the immutable copy in a worker before preparing this bounded stream. */
export function streamBackupCopy(directory: string, id: string, maxSchema: number) {
  const root = safeBackupDirectory(join(directory, id));
  const manifest = validateBackupManifest(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')), id, maxSchema);
  const entries = Object.keys(manifest.files).sort().map(path => {
    const info = lstatSync(join(root, ...canonicalBackupFile(path).split('/')));
    if (!info.isFile() || info.isSymbolicLink()) throw new ApiError(409, 'El respaldo contiene un archivo inválido.');
    return { path, size: info.size };
  });
  const header = Buffer.from(JSON.stringify({ format: 1, manifest, entries }));
  const size = magic.length + 4 + header.length + entries.reduce((sum, entry) => sum + entry.size, 0);
  if (header.length > maxHeaderBytes || size > maxBackupTransferBytes)
    throw new ApiError(413, 'La copia supera el límite de transferencia de ' + backupTransferLimitLabel + '.');
  const chunks = async function* () {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    yield magic; yield length; yield header;
    for (const entry of entries) {
      yield* fileChunks(join(root, ...entry.path.split('/')), entry.size, manifest.files[entry.path]);
    }
  };
  return { chunks: chunks(), size, filename: id + '.gympassbackup' };
}

export function importBackupCopy(
  directory: string,
  input: Uint8Array,
  maxSchema: number,
): ReturnType<typeof inspectBackup> {
  if (!(input instanceof Uint8Array) || input.byteLength > maxBufferedBackupBytes)
    throw new ApiError(413, 'La copia supera el límite de importación de 256 MiB.');
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return importBackup(directory, bytes.length, (start, length) => bytes.subarray(start, start + length), maxSchema);
}

export function importBackupFile(directory: string, file: string, maxSchema: number, owner: string) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBackupTransferBytes)
    throw new ApiError(413, 'El archivo no es un respaldo de hasta ' + backupTransferLimitLabel + '.');
  const source = openSync(file, 'r');
  try {
    return importBackup(directory, info.size, (position, length) => {
      const bytes = Buffer.allocUnsafe(length);
      let offset = 0;
      while (offset < length) {
        const read = readSync(source, bytes, offset, length - offset, position + offset);
        if (!read) throw new ApiError(400, 'El respaldo está truncado.');
        offset += read;
      }
      return bytes;
    }, maxSchema, owner);
  } finally {
    closeSync(source);
  }
}

function importBackup(
  directory: string, size: number, read: (start: number, length: number) => Buffer, maxSchema: number, owner?: string,
) {
  const prefixLength = magic.length + 4;
  const prefix = read(0, Math.min(size, prefixLength));
  if (prefix.length < prefixLength || !prefix.subarray(0, magic.length).equals(magic))
    throw new ApiError(400, 'Selecciona un archivo .gympassbackup exportado desde GymPASS.');
  const headerSize = prefix.readUInt32BE(magic.length);
  const start = prefixLength + headerSize;
  if (headerSize < 2 || headerSize > maxHeaderBytes || start > size)
    throw new ApiError(400, 'La cabecera del respaldo está incompleta o excede el límite.');
  let header: { format: number; manifest: Manifest; entries: Entry[] };
  try {
    header = JSON.parse(read(prefixLength, headerSize).toString('utf8'));
  } catch {
    throw new ApiError(400, 'La cabecera del respaldo no es válida.');
  }
  if (!header || header.format !== 1 || !Array.isArray(header.entries) || header.entries.length > 20000)
    throw new ApiError(400, 'Formato de respaldo no compatible.');
  const manifest = validateBackupManifest(header.manifest, header.manifest?.id, maxSchema);
  const entries: Entry[] = [];
  const seen = new Set<string>();
  let offset = start;
  for (const entry of header.entries) {
    if (!entry || typeof entry.path !== 'string' || !Number.isSafeInteger(entry.size) || entry.size < 0)
      throw new ApiError(400, 'El índice del respaldo contiene tamaños inválidos.');
    const path = canonicalBackupFile(entry.path);
    if (path !== entry.path || seen.has(path.toLowerCase()) || !Object.hasOwn(manifest.files, path))
      throw new ApiError(400, 'El índice del respaldo contiene rutas duplicadas o inválidas.');
    seen.add(path.toLowerCase());
    if (entry.size > size - offset) throw new ApiError(400, 'El respaldo está truncado.');
    offset += entry.size;
    entries.push({ path, size: entry.size });
  }
  if (offset !== size || entries.length !== Object.keys(manifest.files).length)
    throw new ApiError(400, 'El respaldo contiene archivos faltantes o datos adicionales.');
  const sorted = entries.map(({ path }) => path.toLowerCase()).sort();
  if (sorted.some((path, index) => index > 0 && path.startsWith(sorted[index - 1] + '/')))
    throw new ApiError(400, 'Una ruta del respaldo se usa como archivo y carpeta.');
  const root = safeBackupDirectory(directory, true);
  const destination = join(root, manifest.id);
  const temporary = mkdtempSync(join(root, '.import-'));
  const staged = join(temporary, manifest.id);
  try {
    mkdirSync(staged);
    let position = start;
    for (const entry of entries) {
      const file = resolve(staged, ...entry.path.split('/'));
      if (!file.startsWith(resolve(staged) + sep)) throw new ApiError(400, 'Ruta fuera del respaldo.');
      mkdirSync(dirname(file), { recursive: true });
      const target = openSync(file, 'wx', 0o600);
      const hash = createHash('sha256');
      try {
        for (let offset = 0; offset < entry.size; offset += 1024 * 1024) {
          const bytes = read(position + offset, Math.min(entry.size - offset, 1024 * 1024));
          hash.update(bytes);
          writeFileSync(target, bytes);
        }
      } finally {
        closeSync(target);
      }
      if (hash.digest('hex') !== manifest.files[entry.path])
        throw new ApiError(409, 'El respaldo está dañado: un archivo no coincide con su hash.');
      position += entry.size;
    }
    writeFileSync(join(staged, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    const preview = inspectBackup(temporary, manifest.id, maxSchema, owner);
    safeBackupDirectory(root);
    if (lstatSync(destination, { throwIfNoEntry: false })) {
      const existing = readManifest(root, manifest.id, maxSchema);
      if (!sameBackup(existing, manifest))
        throw new ApiError(409, 'Ya existe una copia diferente con este identificador.');
      return inspectBackup(root, manifest.id, maxSchema, owner);
    }
    renameSync(staged, destination);
    return preview;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'No se pudo importar una copia válida: ' + (error as Error).message);
  } finally {
    if (dirname(resolve(temporary)) !== root) throw new ApiError(400, 'Ruta temporal inválida.');
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Receive the archive outside the gym's database queue and clean up even on disconnect. */
export async function withBackupUpload<T>(req: IncomingMessage, directory: string, consume: (file: string) => Promise<T>) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/octet-stream')
    throw new ApiError(415, 'Selecciona un archivo .gympassbackup.');
  const declared = req.headers['content-length'];
  if (declared && (Number(declared) > maxBackupTransferBytes || Number(declared) <= 0))
    throw new ApiError(413, 'El archivo debe contener un respaldo de hasta ' + backupTransferLimitLabel + '.');
  const root = safeBackupDirectory(directory);
  const ensureSpace = async (bytes: number) => {
    const disk = await statfs(root);
    if (disk.bavail * disk.bsize < bytes + 64 * 1024 * 1024)
      throw new ApiError(507, 'No hay espacio suficiente para recibir y verificar el respaldo.');
  };
  await ensureSpace(declared ? Number(declared) * 2 : 64 * 1024 * 1024);
  const temp = await mkdtemp(join(root, '.backup-upload-'));
  try {
    const path = join(temp, 'archive');
    const file = await open(path, 'wx', 0o600);
    let size = 0;
    try {
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > maxBackupTransferBytes) throw new ApiError(413, 'La copia supera el límite de ' + backupTransferLimitLabel + '.');
        if (Math.floor(size / (16 * 1024 * 1024)) !== Math.floor((size - chunk.length) / (16 * 1024 * 1024))) await ensureSpace(size);
        await file.writeFile(chunk);
      }
    } finally {
      await file.close();
    }
    if (!size || !req.complete || (declared && size !== Number(declared)))
      throw new ApiError(400, 'El respaldo no se recibió completo.');
    await ensureSpace(size);
    return await consume(path);
  } finally {
    if (dirname(resolve(temp)) === root) await rm(temp, { recursive: true, force: true });
  }
}
