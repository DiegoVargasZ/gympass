import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError, type Service } from '../lib/service.ts';
import type { TenantContext } from './tenant-manager.ts';

/** Un enlace de credencial deja de funcionar a los siete días. */
export const shareLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const maxBytes = 3 * 1024 * 1024;
const tokenPattern = /^[A-Za-z\d_-]{32}$/;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

type Share = { credential_id: string; expires_at: number; name: string };
const keyOf = (token: string) => createHash('sha256').update(token).digest('hex');

async function readPng(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > maxBytes) throw new ApiError(413, 'La imagen de la credencial es demasiado grande.');
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (
    req.headers['content-type']?.split(';')[0] !== 'image/png' ||
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(pngSignature) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw new ApiError(415, 'Envía la credencial como una imagen PNG.');
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (!width || !height || width > 2400 || height > 2400)
    throw new ApiError(400, 'La imagen de la credencial tiene un tamaño inválido.');
  return bytes;
}

async function readShare(directory: string, key: string): Promise<Share | null> {
  try {
    const share = JSON.parse(await readFile(join(directory, key + '.json'), 'utf8')) as Share;
    return typeof share.credential_id === 'string' && typeof share.expires_at === 'number' ? share : null;
  } catch {
    return null;
  }
}

async function removeShare(directory: string, key: string) {
  await Promise.all(
    [unlink(join(directory, key + '.png')), unlink(join(directory, key + '.json'))].map((work) => work.catch(() => {})),
  );
}

/** Quita los enlaces vencidos y los anteriores de la misma credencial: solo queda uno vigente. */
async function purge(directory: string, credentialId: string) {
  const now = Date.now();
  for (const file of await readdir(directory).catch(() => [])) {
    if (!/^[a-f\d]{64}\.json$/.test(file)) continue;
    const key = file.slice(0, -5);
    const share = await readShare(directory, key);
    if (!share || share.expires_at <= now || share.credential_id === credentialId) await removeShare(directory, key);
  }
}

/**
 * Guarda la imagen de una credencial y devuelve una dirección privada para compartirla. Exige el mismo
 * permiso que descargar la tarjeta; el enlace solo sirve mientras la credencial siga activa.
 */
export async function createCredentialShare(
  service: Service,
  root: string,
  gymId: string,
  credentialId: string,
  req: IncomingMessage,
) {
  const card = await service.credentialCard(credentialId);
  const bytes = await readPng(req);
  const directory = join(root, 'shares');
  await mkdir(directory, { recursive: true });
  await purge(directory, credentialId);
  const token = randomBytes(24).toString('base64url');
  const key = keyOf(token);
  const expires_at = Date.now() + shareLifetimeMs;
  await writeFile(join(directory, key + '.png'), bytes, { flag: 'wx' });
  try {
    await writeFile(
      join(directory, key + '.json'),
      JSON.stringify({
        credential_id: credentialId,
        expires_at,
        name: String((card as Record<string, unknown>).name ?? ''),
      } satisfies Share),
      { flag: 'wx' },
    );
    await service.db.batch([service.audit('credential.shared', credentialId)]);
  } catch (error) {
    await removeShare(directory, key);
    throw error;
  }
  return { path: `/c/${gymId}/${token}`, expires_at };
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );

function unavailable(res: ServerResponse, page: boolean) {
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
  if (!page) {
    res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('No disponible.');
  }
  res.writeHead(404, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta name="robots" content="noindex,nofollow"><title>Enlace no disponible</title>' +
      '<body style="font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh;margin:0;padding:24px;text-align:center">' +
      '<p>Este enlace ya no está disponible. Pide a recepción que te envíe tu credencial de nuevo.</p></body></html>',
  );
}

/**
 * Entrega la credencial a quien tenga el enlace, sin iniciar sesión. La página incluye las etiquetas que
 * WhatsApp usa para mostrar la tarjeta como vista previa dentro del chat.
 */
export async function serveCredentialShare(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: TenantContext,
  gymId: string,
  token: string,
  image: boolean,
  origin: string,
) {
  if (!tokenPattern.test(token)) return unavailable(res, !image);
  const directory = join(ctx.root, 'shares');
  const key = keyOf(token);
  const share = await readShare(directory, key);
  if (!share) return unavailable(res, !image);
  const active =
    share.expires_at > Date.now() &&
    (await ctx.db.prepare('SELECT 1 FROM credentials WHERE id=? AND active=1').bind(share.credential_id).first());
  if (!active) {
    if (share.expires_at <= Date.now()) await removeShare(directory, key);
    return unavailable(res, !image);
  }
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
  if (image) {
    const bytes = await readFile(join(directory, key + '.png')).catch(() => null);
    if (!bytes) return unavailable(res, false);
    res.writeHead(200, { ...headers, 'Content-Type': 'image/png', 'Content-Length': bytes.length });
    return res.end(req.method === 'HEAD' ? undefined : bytes);
  }
  const organization = String(
    (await ctx.db.prepare('SELECT name FROM settings WHERE id=1').first<{ name: string }>())?.name ?? '',
  );
  const picture = `${origin}/c/${gymId}/${token}.png`;
  const title = 'Credencial de ' + share.name;
  const description = 'Preséntala en recepción' + (organization ? ' de ' + organization : '') + '.';
  const html =
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title>` +
    `<meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(title)}">` +
    `<meta property="og:description" content="${escapeHtml(description)}"><meta property="og:image" content="${escapeHtml(picture)}">` +
    `<meta property="og:image:type" content="image/png"><meta name="twitter:card" content="summary_large_image">` +
    `<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#14181d;color:#e6eaef;font:16px system-ui,sans-serif}` +
    `main{padding:16px;text-align:center}img{display:block;width:min(92vw,400px);height:auto;border-radius:20px;margin:0 auto 16px}` +
    `p{margin:0;color:#c5ccd5}</style></head><body><main><img src="${escapeHtml(picture)}" alt="${escapeHtml(title)}">` +
    `<p>${escapeHtml(description)}</p></main></body></html>`;
  res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
  res.end(req.method === 'HEAD' ? undefined : html);
}
