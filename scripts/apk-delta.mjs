import { createHash } from 'node:crypto';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Recreates the exact signed APK bytes; it never edits or signs the result. */
export function restoreSignedApk(base, literal, patch) {
  if (hash(base) !== patch.base_sha256) throw Error('La base Android no coincide.');
  if (!Number.isSafeInteger(patch.size) || patch.size < 1 || patch.size > 256 * 1024 * 1024 || !Array.isArray(patch.operations) || patch.operations.length > 10000)
    throw Error('Delta Android inválido.');
  const chunks = [];
  let length = 0;
  for (const operation of patch.operations) {
    if (!Array.isArray(operation) || operation.length !== 3) throw Error('Operación Android inválida.');
    const [kind, offset, size] = operation;
    const source = kind === 'copy' ? base : kind === 'insert' ? literal : null;
    if (!source || !Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > source.length - size || length > patch.size - size)
      throw Error('Rango Android inválido.');
    chunks.push(source.subarray(offset, offset + size));
    length += size;
  }
  if (length !== patch.size) throw Error('Tamaño Android incorrecto.');
  const result = Buffer.concat(chunks, length);
  if (hash(result) !== patch.sha256) throw Error('El APK reconstruido no coincide con el firmado.');
  return result;
}
