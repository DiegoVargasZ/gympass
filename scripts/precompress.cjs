const { brotliCompressSync, gzipSync, constants } = require('node:zlib');
const { readdirSync, readFileSync, writeFileSync, rmSync, existsSync } = require('node:fs');
const { extname, join, resolve } = require('node:path');

// LiteSpeed sirve el servidor Node por proxy y no comprime su respuesta, asi que el paquete
// viaja con las variantes ya comprimidas y server/static-files.ts elige la que acepte el navegador.
const directory = process.argv[2] ? resolve(process.argv[2]) : resolve(__dirname, '..', 'dist');
const extensions = new Set(['.html', '.js', '.css', '.json', '.svg', '.webmanifest', '.wasm']);
// Debajo de este tamano la cabecera y el viaje extra se comen la ganancia.
const minimum = 1024;

function files(from) {
  return readdirSync(from, { withFileTypes: true }).flatMap((entry) => {
    const path = join(from, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

function write(path, suffix, compressed, original) {
  const target = path + suffix;
  if (compressed.length >= original.length) {
    if (existsSync(target)) rmSync(target);
    return 0;
  }
  writeFileSync(target, compressed);
  return compressed.length;
}

if (!existsSync(directory)) {
  console.error('No existe dist/. Ejecuta la compilacion antes de precomprimir.');
  process.exit(1);
}
let raw = 0;
let brotli = 0;
let count = 0;
for (const path of files(directory)) {
  if (!extensions.has(extname(path))) continue;
  const original = readFileSync(path);
  if (original.length < minimum) continue;
  const wasm = extname(path) === '.wasm';
  const size = write(
    path,
    '.br',
    brotliCompressSync(original, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: wasm ? 5 : constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: original.length,
      },
    }),
    original,
  );
  // gzip para los navegadores o proxies que no negocian brotli.
  write(path, '.gz', gzipSync(original, { level: wasm ? 6 : 9 }), original);
  raw += original.length;
  brotli += size || original.length;
  count++;
}
const kilobytes = (bytes) => (bytes / 1024).toFixed(0) + ' KB';
console.log(`Precomprimidos ${count} archivos: ${kilobytes(raw)} -> ${kilobytes(brotli)} con brotli.`);
