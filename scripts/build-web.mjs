import { build } from 'vite';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync, unlinkSync, lstatSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { collectWebAssets } from './web-assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const dist = join(root, 'dist');
const output = join(root, 'output/web-build');
const previous = JSON.parse(readFileSync(join(root, 'web-releases/previous.json'), 'utf8'));
if (previous.version === version || !Array.isArray(previous.assets)) throw Error('La retención debe describir la versión anterior.');

// Build into staging first: a failed build leaves the published artifact intact.
await build({ root, build: { outDir: output, emptyOutDir: true } });
const current = collectWebAssets(output);
for (const asset of previous.assets) {
  if (!/^assets\/[A-Za-z0-9_.-]+\.(js|css)$/.test(asset.path)) throw Error('Ruta de retención inválida.');
  const source = join(dist, asset.path);
  if (!existsSync(source) || lstatSync(source).isSymbolicLink() || createHash('sha256').update(readFileSync(source)).digest('hex') !== asset.sha256)
    throw Error('No se conserva el recurso de la versión anterior: ' + asset.path);
  if (existsSync(join(output, asset.path))) continue;
  cpSync(source, join(output, asset.path));
}
const compression = spawnSync(process.execPath, [join(root, 'scripts/precompress.cjs'), output], { cwd: root, stdio: 'inherit' });
if (compression.status !== 0) process.exit(compression.status || 1);

const sourceHash = createHash('sha256');
function hashInput(name) {
  const path = join(root, name);
  if (lstatSync(path).isDirectory()) for (const child of readdirSync(path).sort()) hashInput(name + '/' + child);
  else {
    sourceHash.update(name + '\0');
    const bytes = readFileSync(path);
    sourceHash.update(/\.(ts|tsx|js|css|html|json|cjs|mjs|svg|md)$/.test(name) || name.endsWith('/LICENSE') ? bytes.toString('utf8').replaceAll('\r\n', '\n') : bytes);
  }
}
for (const name of ['src', 'public', 'lib', 'vendor', 'index.html', 'vite.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json', 'scripts/build-web.mjs', 'scripts/web-assets.mjs', 'scripts/precompress.cjs']) hashInput(name);
writeFileSync(join(output, 'release.json'), JSON.stringify({ version, source_sha256: sourceHash.digest('hex'), assets: current, previous_version: previous.version }, null, 2) + '\n');
mkdirSync(dist, { recursive: true });
cpSync(output, dist, { recursive: true });
const retained = new Set([...current, ...previous.assets].flatMap(({ path }) => [path, path + '.br', path + '.gz']));
for (const name of readdirSync(join(dist, 'assets'))) {
  const relative = 'assets/' + name;
  if (!retained.has(relative)) {
    const path = join(dist, relative);
    if (!lstatSync(path).isFile()) throw Error('Archivo inesperado en dist/assets: ' + name);
    unlinkSync(path);
  }
}
console.log(`Web ${version}: ${current.length} recursos actuales; se conserva ${previous.version} para las sesiones abiertas.`);
