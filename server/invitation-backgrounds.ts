import type { IncomingMessage } from 'node:http';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError, type Service } from '../lib/service.ts';
import { loadMedia, readImage, validateImage } from './media.ts';

export async function invitationBackground(
  service: Service,
  root: string,
  resource: 'invitation-batches' | 'visits',
  id: string,
  req: IncomingMessage,
) {
  service.require('operator');
  const table = resource === 'invitation-batches' ? 'invitation_batches' : 'visits';
  const row = await service.one(`SELECT background_path,background_ratio FROM ${table} WHERE id=?`, id);
  if (!row) throw new ApiError(404, 'Invitación no encontrada.');
  if (req.method === 'GET') {
    if (!row.background_path) return { image: null, ratio: 638 / 1012 };
    const bytes = await loadMedia(root, 'backgrounds', row.background_path);
    const type = row.background_path.endsWith('.png') ? 'image/png' : 'image/webp';
    return { image: `data:${type};base64,${bytes.toString('base64')}`, ratio: row.background_ratio };
  }
  let filename: string | null = null;
  const dimensions = { width: 638, height: 1012 };
  if (req.method === 'PUT') {
    const bytes = await readImage(req);
    const type = req.headers['content-type']?.split(';')[0] || '';
    if (!['image/png', 'image/webp'].includes(type)) throw new ApiError(415, 'Usa una imagen PNG o WebP.');
    const extension = validateImage(bytes, type, false, dimensions);
    filename = `${crypto.randomUUID()}.${extension}`;
    await mkdir(join(root, 'backgrounds'), { recursive: true });
    await writeFile(join(root, 'backgrounds', filename), bytes, { flag: 'wx' });
  }
  try {
    await service.db.batch([
      service.stmt(
        `UPDATE ${table} SET background_path=?,background_ratio=? WHERE id=?`,
        filename,
        dimensions.width / dimensions.height,
        id,
      ),
      service.audit('invitation.background.updated', id),
    ]);
  } catch (error) {
    if (filename) await unlink(join(root, 'backgrounds', filename)).catch(() => {});
    throw error;
  }
  // Event copies and reusable templates may share the same immutable image.
  if (row.background_path && /^[\da-f-]{36}\.(png|webp)$/.test(row.background_path)) {
    const references = await service.one(
      `SELECT
      (SELECT COUNT(*) FROM invitation_batches WHERE background_path=?)+
      (SELECT COUNT(*) FROM visits WHERE background_path=?)+
      (SELECT COUNT(*) FROM invitation_templates WHERE background_path=?) n`,
      row.background_path,
      row.background_path,
      row.background_path,
    );
    if (!references?.n) await unlink(join(root, 'backgrounds', row.background_path)).catch(() => {});
  }
  return { path: filename, ratio: dimensions.width / dimensions.height };
}
