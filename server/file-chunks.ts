import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ApiError } from '../lib/service.ts';

/** Close and verify a file before yielding its final chunk, so a completed download holds no file handles. */
export async function* fileChunks(path: string, expectedSize?: number, expectedHash?: string) {
  const source = await open(path, 'r');
  const hash = expectedHash ? createHash('sha256') : undefined;
  let pending: Buffer | undefined;
  try {
    const info = await source.stat();
    const size = expectedSize ?? info.size;
    if (!info.isFile() || info.size !== size) throw new ApiError(409, 'La copia cambió durante la descarga.');
    for (let position = 0; position < size;) {
      const bytes = Buffer.allocUnsafe(Math.min(64 * 1024, size - position));
      const { bytesRead } = await source.read(bytes, 0, bytes.length, position);
      if (!bytesRead) throw new ApiError(409, 'La copia está incompleta.');
      position += bytesRead;
      const chunk = bytes.subarray(0, bytesRead);
      hash?.update(chunk);
      if (pending) yield pending;
      pending = chunk;
    }
    if ((await source.stat()).size !== size || (hash && hash.digest('hex') !== expectedHash))
      throw new ApiError(409, 'La copia cambió durante la descarga.');
  } finally { await source.close(); }
  if (pending) yield pending;
}
