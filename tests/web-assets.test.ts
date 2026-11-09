import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error Build tooling is JavaScript.
import { collectWebAssets, emittedWebAssets } from '../scripts/web-assets.mjs';

test('el paquete conserva imports diferidos con comillas invertidas, dependencias transitivas y todos los archivos emitidos', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gympass-web-assets-'));
  try {
    mkdirSync(join(directory, 'assets'));
    writeFileSync(join(directory, 'index.html'), '<script src="/assets/main.js"></script>');
    writeFileSync(join(directory, 'assets/main.js'), 'const files=["assets/style.css"]; import(`./camera.js`);');
    writeFileSync(join(directory, 'assets/camera.js'), 'export const load=()=>import(`./jsQR.js`);');
    writeFileSync(join(directory, 'assets/jsQR.js'), 'export default function decode(){}');
    writeFileSync(join(directory, 'assets/style.css'), '.photo{background:url("./photo.png")}');
    writeFileSync(join(directory, 'assets/photo.png'), 'png');
    writeFileSync(join(directory, 'assets/optional.js'), 'export default 1');
    assert.deepEqual(collectWebAssets(directory).map((asset: { path: string }) => asset.path), ['assets/camera.js', 'assets/jsQR.js', 'assets/main.js', 'assets/photo.png', 'assets/style.css']);
    assert.ok(emittedWebAssets(directory).some((asset: { path: string }) => asset.path === 'assets/optional.js'));
    writeFileSync(join(directory, 'assets/camera.js'), 'export const load=()=>import(`./missing.js`);');
    assert.throws(() => collectWebAssets(directory), /missing\.js/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
