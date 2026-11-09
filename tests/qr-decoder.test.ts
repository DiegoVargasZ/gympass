import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import qr from 'qrcode-generator';

test('los lectores QR publicados decodifican una credencial desde los píxeles de una imagen', async () => {
  const release = JSON.parse(readFileSync(new URL('../dist/release.json', import.meta.url), 'utf8'));
  const current = release.assets.filter((asset: { path: string }) => /\/jsQR-[^/]+\.js$/.test(asset.path));
  assert.ok(current.length, 'La compilación debe entregar el lector QR diferido.');
  const decoders = new Set<string>([...current, ...(release.compatibility_assets || [])].filter((asset: { path: string }) => /\/jsQR-[^/]+\.js$/.test(asset.path)).map((asset: { path: string }) => asset.path));
  const value = 'GYMPASS-CAMERA-REGRESSION-CHECK';
  const code = qr(0, 'M'); code.addData(value); code.make();
  const scale = 5, margin = 4, width = (code.getModuleCount() + margin * 2) * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let row = 0; row < code.getModuleCount(); row++) for (let column = 0; column < code.getModuleCount(); column++) {
    if (!code.isDark(row, column)) continue;
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const offset = (((row + margin) * scale + y) * width + (column + margin) * scale + x) * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
    }
  }
  for (const path of decoders) {
    const { default: decode } = await import(new URL('../dist/' + path, import.meta.url).href);
    assert.equal(decode(pixels, width, width)?.data, value, path);
  }
});
