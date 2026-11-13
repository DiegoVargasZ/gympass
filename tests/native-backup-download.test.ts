import test from 'node:test';
import assert from 'node:assert/strict';
import { download } from '../src/api.ts';

test('los respaldos centrales se descargan directamente sin reservar un Blob en el navegador', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const anchors: { href: string; target: string; rel: string; click(): void }[] = [];
  let clicks = 0;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement(tag: string) {
      assert.equal(tag, 'a');
      const anchor = { href: '', target: '', rel: '', click() { clicks++; } };
      anchors.push(anchor); return anchor;
    },
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); });
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw Error('No debe leer el respaldo mediante fetch/Blob.'); });
  await download('platform/gyms/gym-a/backups/copy-a/export', 'copy-a.gympassbackup');
  await download('platform/backups/platform-a/export', 'platform-a.tar.gz');
  assert.equal(fetch.mock.calls.length, 0);
  assert.equal(clicks, 2);
  assert.deepEqual(anchors.map(anchor => anchor.href), ['/api/platform/gyms/gym-a/backups/copy-a/export', '/api/platform/backups/platform-a/export']);
  for (const anchor of anchors) { assert.equal(anchor.target, '_blank'); assert.equal(anchor.rel, 'noopener noreferrer'); }
});
