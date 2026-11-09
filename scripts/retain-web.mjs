import { readFileSync, writeFileSync } from 'node:fs';
import { collectWebAssets } from './web-assets.mjs';
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const release = JSON.parse(readFileSync('dist/release.json', 'utf8'));
if (release.version !== version) throw Error('Compila y verifica la versión actual antes de preparar la siguiente.');
const assets = collectWebAssets('dist');
if (JSON.stringify(assets) !== JSON.stringify(release.assets)) throw Error('La compilación actual difiere de su manifiesto.');
writeFileSync('web-releases/previous.json', JSON.stringify({ version, assets }, null, 2) + '\n');
console.log('Retenida la web ' + version + '. Actualiza la versión antes de compilar la siguiente entrega.');
