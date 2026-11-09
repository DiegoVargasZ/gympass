import type { IncomingMessage, ServerResponse } from 'node:http';
import { brotliCompress, gzip, constants } from 'node:zlib';
import { ApiError } from '../lib/service.ts';

/**
 * Desde este tamano comprimir gana mas de lo que cuesta. Por debajo la respuesta ya
 * viaja en un solo paquete y comprimirla solo gastaria CPU del servidor.
 */
const compressionThreshold = 1400;

/**
 * De mejor a peor compresion. Las calidades son deliberadamente bajas: en un snapshot de
 * replica, brotli 4 comprime 48x en la mitad del tiempo que gzip 6, y el servidor suele ser
 * el recurso escaso. Ambas corren en el pool de hilos, no en el bucle de eventos.
 */
const encoders = [
  {
    encoding: 'br',
    compress: (body: Buffer, done: (error: Error | null, result: Buffer) => void) =>
      brotliCompress(
        body,
        { params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } },
        done,
      ),
  },
  { encoding: 'gzip', compress: (body: Buffer, done: (error: Error | null, result: Buffer) => void) => gzip(body, { level: 6 }, done) },
];

/** Codificaciones que el cliente acepta, descartando las marcadas con q=0. */
function accepted(header: string) {
  const names = new Set<string>();
  for (const part of header.split(',')) {
    const [name, ...parameters] = part.trim().split(';');
    const quality = parameters.map((value) => value.trim()).find((value) => value.startsWith('q='));
    if (quality && Number(quality.slice(2)) === 0) continue;
    names.add(name.trim().toLowerCase());
  }
  return names;
}

export function json(res: ServerResponse, data: unknown, status = 200) {
  const body = Buffer.from(JSON.stringify(data) ?? 'null');
  // Vary siempre: un proxy intermedio no debe reusar una respuesta sin comprimir
  // para el siguiente cliente que si acepte br.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
  };
  const send = (payload: Buffer, encoding?: string) => {
    if (res.writableEnded || res.destroyed) return;
    if (encoding) headers['Content-Encoding'] = encoding;
    headers['Content-Length'] = String(payload.length);
    res.writeHead(status, headers);
    res.end(payload);
  };
  if (body.length < compressionThreshold) return send(body);
  const allowed = accepted(String(res.req?.headers['accept-encoding'] ?? ''));
  const encoder = encoders.find((item) => allowed.has(item.encoding));
  if (!encoder) return send(body);
  // Si comprimir falla o el cliente se va, la respuesta sigue saliendo sin comprimir.
  encoder.compress(body, (error, result) =>
    send(error || result.length >= body.length ? body : result, error || result.length >= body.length ? undefined : encoder.encoding),
  );
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
