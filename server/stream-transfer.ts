import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliCompress, createGzip, constants } from 'node:zlib';

/** Backpressure bounds buffers even if the client downloads slowly. Compression uses the thread pool. */
export async function sendStream(
  res: ServerResponse, chunks: AsyncIterable<string | Uint8Array>,
  headers: Record<string, string>, authorize: () => void, compress: boolean | 'archive-gzip' = false,
) {
  authorize();
  const allowed = String(res.req?.headers['accept-encoding'] || '').split(',').map(item => {
    const [name, ...params] = item.trim().split(';');
    return params.some(param => /^\s*q=0(?:\.0*)?\s*$/.test(param)) ? '' : name;
  });
  const encoding = compress === true ? ['br', 'gzip'].find(name => allowed.includes(name)) : undefined;
  if (compress === true) headers.Vary = 'Accept-Encoding';
  if (encoding) headers['Content-Encoding'] = encoding;
  res.writeHead(200, { 'Cache-Control': 'no-store', ...headers });
  const guarded = async function* () {
    for await (const chunk of chunks) {
      if (res.destroyed) return;
      authorize();
      yield chunk;
    }
  };
  const source = Readable.from(guarded(), { objectMode: false, highWaterMark: 64 * 1024 });
  const options = { signal: AbortSignal.timeout(compress === true ? 120000 : 30 * 60000) };
  if (compress === 'archive-gzip') await pipeline(source, createGzip({ level: 4 }), res, options);
  else if (encoding === 'br')
    await pipeline(source, createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }), res, options);
  else if (encoding === 'gzip') await pipeline(source, createGzip({ level: 4 }), res, options);
  else await pipeline(source, res, options);
}
