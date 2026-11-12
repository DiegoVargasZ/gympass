import { build } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.argv[2] || resolve(root, 'mobile/offline-web'));
await build({
  root,
  base: './',
  plugins: [{ name: 'gympass-mobile-entry', enforce: 'pre',
    resolveId(source, importer) { if (source === './PlatformKiosk' && importer?.replaceAll('\\', '/').endsWith('/src/App.tsx')) return resolve(root, 'src/mobile-kiosk.tsx'); },
    transformIndexHtml: { order: 'pre', handler: html => html.replace('/src/main.tsx', '/src/mobile-main.tsx') } }],
  build: { outDir, emptyOutDir: true },
});
const html = readFileSync(resolve(outDir, 'index.html'));
writeFileSync(resolve(outDir, 'mobile-release.json'), JSON.stringify({ version: JSON.parse(readFileSync(resolve(root, 'package.json'))).version, html_sha256: createHash('sha256').update(html).digest('hex') }) + '\n');
console.log('Interfaz de gestión incluida para Android:', outDir);
