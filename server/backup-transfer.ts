import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { ApiError } from '../lib/service.ts';
import {
  canonicalBackupFile,
  inspectBackup,
  safeBackupDirectory,
  validateBackupManifest,
  type Manifest,
} from './backups.ts';

export const maxBackupTransferBytes = 256 * 1024 * 1024;
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
  if (header.length > maxHeaderBytes || size > maxBackupTransferBytes)
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

export function importBackupCopy(
  directory: string,
  input: Uint8Array,
  maxSchema: number,
): ReturnType<typeof inspectBackup> {
  if (!(input instanceof Uint8Array) || input.byteLength > maxBackupTransferBytes)
    throw new ApiError(413, 'La copia supera el límite de importación de 256 MiB.');
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < magic.length + 4 || !bytes.subarray(0, magic.length).equals(magic))
    throw new ApiError(400, 'Selecciona un archivo .gympassbackup exportado desde GymPASS.');
  const headerSize = bytes.readUInt32BE(magic.length);
  const start = magic.length + 4 + headerSize;
  if (headerSize < 2 || headerSize > maxHeaderBytes || start > bytes.length)
    throw new ApiError(400, 'La cabecera del respaldo está incompleta o excede el límite.');
  let header: { format: number; manifest: Manifest; entries: Entry[] };
  try {
    header = JSON.parse(bytes.subarray(magic.length + 4, start).toString('utf8'));
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
    if (entry.size > bytes.length - offset) throw new ApiError(400, 'El respaldo está truncado.');
    if (digest(bytes.subarray(offset, offset + entry.size)) !== manifest.files[path])
      throw new ApiError(409, 'El respaldo está dañado: un archivo no coincide con su hash.');
    offset += entry.size;
    entries.push({ path, size: entry.size });
  }
  if (offset !== bytes.length || entries.length !== Object.keys(manifest.files).length)
    throw new ApiError(400, 'El respaldo contiene archivos faltantes o datos adicionales.');
  const sorted = entries.map(({ path }) => path.toLowerCase()).sort();
  if (sorted.some((path, index) => index > 0 && path.startsWith(sorted[index - 1] + '/')))
    throw new ApiError(400, 'Una ruta del respaldo se usa como archivo y carpeta.');
  const root = safeBackupDirectory(directory, true);
  const destination = join(root, manifest.id);
  if (lstatSync(destination, { throwIfNoEntry: false })) {
    const existing = readManifest(root, manifest.id, maxSchema);
    if (!sameBackup(existing, manifest))
      throw new ApiError(409, 'Ya existe una copia diferente con este identificador.');
    return inspectBackup(root, manifest.id, maxSchema);
  }
  const temporary = mkdtempSync(join(root, '.import-'));
  const staged = join(temporary, manifest.id);
  try {
    mkdirSync(staged);
    let position = start;
    for (const entry of entries) {
      const file = resolve(staged, ...entry.path.split('/'));
      if (!file.startsWith(resolve(staged) + sep)) throw new ApiError(400, 'Ruta fuera del respaldo.');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes.subarray(position, position + entry.size), { flag: 'wx', mode: 0o600 });
      position += entry.size;
    }
    writeFileSync(join(staged, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    const preview = inspectBackup(temporary, manifest.id, maxSchema);
    safeBackupDirectory(root);
    if (existsSync(destination)) throw new ApiError(409, 'La copia ya existe. Vuelve a consultar los respaldos.');
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
