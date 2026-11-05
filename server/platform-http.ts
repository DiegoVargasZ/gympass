import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '../lib/service.ts';

export function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export async function readJson(req: IncomingMessage, limit = 650000): Promise<Record<string, any>> {
  if (!req.headers['content-type']?.includes('application/json')) throw new ApiError(415, 'Se requiere JSON.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, 'La solicitud es demasiado grande.');
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch {
    throw new ApiError(400, 'JSON inválido.');
  }
}

export function cookieValue(req: IncomingMessage, key: string) {
  return (
    req.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(key + '='))
      ?.slice(key.length + 1) || ''
  );
}

export function requestToken(req: IncomingMessage) {
  const bearer = req.headers.authorization?.match(/^Bearer (m_[a-f\d]{64})$/)?.[1];
  const web = cookieValue(req, 'gympass_platform');
  if (web.startsWith('m_')) throw new ApiError(401, 'La sesión móvil requiere la aplicación lectora.');
  return bearer || web;
}
