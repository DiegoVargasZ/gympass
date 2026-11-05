import type { IncomingMessage } from 'node:http';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError, type Service } from '../lib/service.ts';

export function validateImage(
  bytes: Buffer,
  type: string,
  photo = false,
  dimensions?: { width: number; height: number },
) {
  if (bytes.length > 1024 * 1024) throw new ApiError(413, 'La imagen supera 1 MB.');
  let width = 0,
    height = 0,
    extension = '';
  if (type === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.length < 30 || bytes.readUInt32LE(4) + 8 !== bytes.length) throw new ApiError(400, 'WebP inválido.');
    let image = false;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const chunk = bytes.toString('ascii', offset, offset + 4),
        size = bytes.readUInt32LE(offset + 4),
        start = offset + 8;
      if (start + size > bytes.length || chunk === 'ANIM' || chunk === 'ANMF')
        throw new ApiError(400, 'Usa una imagen estática válida.');
      if (chunk === 'VP8 ' && size >= 10 && bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 1, 0x2a]))) {
        width = bytes.readUInt16LE(start + 6) & 0x3fff;
        height = bytes.readUInt16LE(start + 8) & 0x3fff;
        image = true;
      } else if (chunk === 'VP8L' && size >= 5 && bytes[start] === 0x2f) {
        const dimensions = bytes.readUInt32LE(start + 1);
        width = (dimensions & 0x3fff) + 1;
        height = ((dimensions >>> 14) & 0x3fff) + 1;
        image = true;
      }
      offset = start + size + (size % 2);
    }
    if (!image) throw new ApiError(400, 'WebP inválido.');
    extension = 'webp';
  } else if (
    !photo &&
    type === 'image/png' &&
    bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  ) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
    extension = 'png';
  } else if (!photo && type === 'image/svg+xml') {
    const svg = bytes.toString('utf8');
    // Accept a static SVG subset only: no executable elements, CSS, links, URLs or entities.
    const tags = [...svg.matchAll(/<\/?([\w:-]+)/g)].map((match) => match[1]);
    const allowed = new Set([
      'svg',
      'g',
      'path',
      'rect',
      'circle',
      'ellipse',
      'line',
      'polyline',
      'polygon',
      'title',
      'desc',
      'defs',
      'clipPath',
    ]);
    if (
      !/^\s*<svg\s/i.test(svg) ||
      !/<\/svg>\s*$/i.test(svg) ||
      !tags.length ||
      tags.some((tag) => !allowed.has(tag)) ||
      /<!|<\?|\bon\w+\s*=|href\s*=|\bstyle\s*=|url\s*\(|javascript:|data:|&/i.test(svg)
    ) {
      throw new ApiError(400, 'El SVG debe ser estático, sin enlaces, estilos ni scripts. También puedes usar PNG.');
    }
    return 'svg';
  } else throw new ApiError(415, photo ? 'La foto debe ser WebP.' : 'Usa PNG, SVG estático o WebP.');
  if (
    !width ||
    !height ||
    width > (photo ? 512 : 2048) ||
    height > (photo ? 512 : 2048) ||
    (photo && width !== height)
  ) {
    throw new ApiError(
      400,
      photo ? 'La foto debe ser cuadrada, de hasta 512 px.' : 'El logo debe medir como máximo 2048 px.',
    );
  }
  if (dimensions) {
    dimensions.width = width;
    dimensions.height = height;
  }
  return extension;
}

export async function readImage(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 1024 * 1024) throw new ApiError(413, 'La imagen supera 1 MB.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function safeName(filename: string) {
  if (!/^[\da-f-]{36}\.(webp|png|svg)$/.test(filename)) throw new ApiError(404, 'Imagen no encontrada.');
  return filename;
}

export async function loadMedia(root: string, folder: 'photos' | 'branding' | 'backgrounds', filename: string) {
  try {
    return await readFile(join(root, folder, safeName(filename)));
  } catch {
    throw new ApiError(404, 'Imagen no encontrada.');
  }
}

export async function saveMedia(service: Service, root: string, req: IncomingMessage, personId?: string) {
  service.require('admin');
  const table = personId ? 'people' : 'settings',
    column = personId ? 'photo_path' : 'logo_path',
    id = personId || 1;
  const previous = await service.one(`SELECT ${column} path FROM ${table} WHERE id=?`, id);
  if (!previous) throw new ApiError(404, 'Registro no encontrado.');
  const bytes = await readImage(req),
    extension = validateImage(bytes, req.headers['content-type']?.split(';')[0] || '', !!personId);
  const folder = personId ? 'photos' : 'branding',
    filename = crypto.randomUUID() + '.' + extension;
  await mkdir(join(root, folder), { recursive: true });
  const target = join(root, folder, filename);
  await writeFile(target, bytes, { flag: 'wx' });
  try {
    await service.db.batch([
      service.stmt(`UPDATE ${table} SET ${column}=? WHERE id=?`, filename, id),
      service.audit(personId ? 'person.photo.updated' : 'branding.logo.updated', String(id)),
    ]);
  } catch (error) {
    await unlink(target).catch(() => {});
    throw error;
  }
  if (previous.path) await unlink(join(root, folder, safeName(previous.path))).catch(() => {});
  return { path: filename };
}
