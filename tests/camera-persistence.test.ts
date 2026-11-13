import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness, componentStubs, findElement } from './component-harness.ts';

test('el lector conserva la cámara al ocultar la pestaña y la libera al apagar o cerrar sesión', async (t) => {
  const listeners = new Map<string, () => void>();
  let requests = 0, stops = 0, plays = 0;
  const track = { readyState: 'live', stop() { stops++; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const document = {
    hidden: false,
    addEventListener(name: string, callback: () => void) { listeners.set(name, callback); },
    removeEventListener(name: string) { listeners.delete(name); },
    createElement: () => ({ getContext: () => ({}) }),
  };
  const h = componentHarness({ document,
    window: { isSecureContext: true, addEventListener() {}, removeEventListener() {} },
    navigator: { mediaDevices: { getUserMedia: async () => { requests++; return stream; }, enumerateDevices: async () => [] } },
    setTimeout: () => 1, clearTimeout() {},
  });
  t.after(() => h.cleanup());
  const { default: Scanner } = h.load('../src/CameraScanner.tsx', {
    'lucide-react': componentStubs,
    './scan-cooldown': { scanSeconds: () => 0, useScanCooldown: () => 0 },
    '../lib/camera-frame': { cameraFrame() {} },
    '../vendor/jsqr/jsQR.js': { default: () => null },
  });
  let tree = h.render(() => Scanner({ onScan: async () => {}, onClear() {} }));
  const video = { srcObject: null, paused: false, readyState: 0, play: async () => { plays++; } };
  findElement(tree, (el) => el.type === 'video').props.ref.current = video;
  findElement(tree, (el) => el.type === 'button').props.onClick();
  tree = await h.settle();
  assert.equal(requests, 1);
  assert.equal(video.srcObject, stream);
  document.hidden = true;
  listeners.get('visibilitychange')!();
  tree = await h.settle();
  assert.equal(stops, 0);
  assert.equal(requests, 1);
  document.hidden = false;
  video.paused = true;
  listeners.get('visibilitychange')!();
  await h.settle();
  assert.equal(plays, 2);
  assert.equal(requests, 1);
  findElement(tree, (el) => el.type === 'button').props.onClick();
  await h.settle();
  assert.equal(stops, 1);
  assert.equal(video.srcObject, null);
  tree = h.render(() => Scanner({ onScan: async () => {}, onClear() {} }));
  findElement(tree, (el) => el.type === 'button').props.onClick();
  await h.settle();
  h.cleanup();
  assert.equal(stops, 2);
});

test('recepción permanece montada al navegar y no inicia el lector antes de abrirla', async (t) => {
  const h = componentHarness();
  t.after(() => h.cleanup());
  const { default: PersistentAccess } = h.load('../src/PersistentAccess.tsx', { './Access': { default: 'Access' } });
  let active = false;
  const props = { data: {}, reload: async () => {} };
  assert.equal(h.render(() => PersistentAccess({ ...props, active })), null);
  active = true;
  const shown = h.render(() => PersistentAccess({ ...props, active }));
  await h.settle();
  active = false;
  const hidden = h.render(() => PersistentAccess({ ...props, active }));
  assert.equal(findElement(hidden, (el) => el.type === 'div').props.hidden, true);
  assert.equal(findElement(shown, (el) => el.type === 'Access').type, findElement(hidden, (el) => el.type === 'Access').type);
  assert.equal(findElement(hidden, (el) => el.type === 'Access').props.active, false);
});
