import { readFileSync, writeFileSync } from 'node:fs';
import { collectWebAssets } from './web-assets.mjs';
import { createHash } from 'node:crypto';
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const release = JSON.parse(readFileSync('dist/release.json', 'utf8'));
if (release.version !== version) throw Error('Compila y verifica la versión actual antes de preparar la siguiente.');
const assets = release.assets;
for (const needed of collectWebAssets('dist'))
  if (!assets.some((asset) => asset.path === needed.path && asset.sha256 === needed.sha256)) throw Error('La compilación actual difiere de su manifiesto.');
for (const asset of assets) {
  if (!/^assets\/[A-Za-z0-9_.-]+$/.test(asset.path)) throw Error('Ruta de recurso inválida.');
  if (createHash('sha256').update(readFileSync('dist/' + asset.path)).digest('hex') !== asset.sha256) throw Error('Recurso modificado: ' + asset.path);
}
writeFileSync('web-releases/previous.json', JSON.stringify({ version, assets }, null, 2) + '\n');
console.log('Retenida la web ' + version + '. Actualiza la versión antes de compilar la siguiente entrega.');
