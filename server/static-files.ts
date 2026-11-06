import { stat, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

/** Extensiones con variante precomprimida. PNG, WebP y WOFF2 ya vienen comprimidos. */
export const compressible = new Set(['.html', '.js', '.css', '.json', '.svg', '.webmanifest']);

/** De mejor a peor compresión; `npm run build` deja las dos variantes junto al original. */
const variants = [
  { encoding: 'br', suffix: '.br' },
  { encoding: 'gzip', suffix: '.gz' },
];
const fileCache = new Map<string, { etag: string; bytes: Buffer }>();
let cacheBytes = 0;
/** Solo archivos públicos de compilación; nunca respuestas ni fotos privadas. */
export async function staticBytes(asset: StaticAsset) {
  const cacheable = asset.filename.includes(sep + 'assets' + sep);
  const cached = cacheable ? fileCache.get(asset.filename) : undefined;
  if (cached?.etag === asset.etag) {
    fileCache.delete(asset.filename);
    fileCache.set(asset.filename, cached);
    return cached.bytes;
  }
  const bytes = await readFile(asset.filename);
  if (cacheable && bytes.length <= 2 * 1024 * 1024) {
    if (cached) {
      cacheBytes -= cached.bytes.length;
      fileCache.delete(asset.filename);
    }
    while (cacheBytes + bytes.length > 16 * 1024 * 1024 && fileCache.size) {
      const key = fileCache.keys().next().value!;
      cacheBytes -= fileCache.get(key)!.bytes.length;
      fileCache.delete(key);
    }
    fileCache.set(asset.filename, { etag: asset.etag, bytes });
    cacheBytes += bytes.length;
  }
  return bytes;
}

export type StaticAsset = {
  /** Archivo que hay que leer: el original o la variante precomprimida elegida. */
  filename: string;
  headers: Record<string, string>;
  etag: string;
};

/** Cabeceras de un 304: solo las que el navegador necesita para volver a validar su copia. */
export function revalidation(asset: StaticAsset) {
  const headers: Record<string, string> = { ETag: asset.etag, 'Cache-Control': asset.headers['Cache-Control'] };
  if (asset.headers.Vary) headers.Vary = asset.headers.Vary;
  return headers;
}

function accepts(header: string) {
  const names = new Set<string>();
  for (const part of header.split(',')) {
    const [name, ...parameters] = part.trim().split(';');
    const quality = parameters.map((value) => value.trim()).find((value) => value.startsWith('q='));
    if (quality && Number(quality.slice(2)) === 0) continue;
    names.add(name.trim().toLowerCase());
  }
  return names;
}

/**
 * Resuelve `pathname` dentro de `directory`, cae a `index.html` en las rutas de la interfaz y
 * entrega la variante precomprimida que el navegador acepte. Devuelve `null` cuando la ruta se
 * sale del directorio o cuando un archivo con extensión no existe.
 */
export async function staticAsset(
  directory: string,
  pathname: string,
  acceptEncoding = '',
): Promise<StaticAsset | null> {
  let filename = resolve(directory, '.' + pathname);
  if (!filename.startsWith(directory + sep) && filename !== directory) return null;
  try {
    if (!(await stat(filename)).isFile()) filename = resolve(directory, 'index.html');
  } catch {
    if (extname(filename)) return null;
    filename = resolve(directory, 'index.html');
  }
  const extension = extname(filename);
  const headers: Record<string, string> = {
    'Content-Type': mime[extension] || 'application/octet-stream',
    'Cache-Control': filename.includes(sep + 'assets' + sep) ? 'public,max-age=31536000,immutable' : 'no-cache',
  };
  let served = filename;
  if (compressible.has(extension)) {
    // Vary siempre, aunque esta petición no acepte nada: un proxy intermedio no debe reusar
    // la respuesta sin comprimir para el siguiente navegador que sí acepte br.
    headers.Vary = 'Accept-Encoding';
    const accepted = accepts(acceptEncoding);
    for (const { encoding, suffix } of variants) {
      if (!accepted.has(encoding)) continue;
      try {
        if (!(await stat(filename + suffix)).isFile()) continue;
      } catch {
        continue;
      }
      served = filename + suffix;
      headers['Content-Encoding'] = encoding;
      break;
    }
  }
  const info = await stat(served);
  // Sin validador un navegador puede seguir sirviendo un index.html viejo tras recompilar.
  // Sale del archivo servido, así que cada codificación tiene su propio ETag.
  const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
  headers.ETag = etag;
  headers['Content-Length'] = String(info.size);
  return { filename: served, headers, etag };
}
