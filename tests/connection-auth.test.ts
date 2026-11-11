import assert from 'node:assert/strict';
import test from 'node:test';
import { serverOrigin } from '../src/connection-mode.ts';
import { componentHarness, componentStubs, elementText, findElement } from './component-harness.ts';

test('mostrar y ocultar contraseña conserva valor, validación, nombre y autocompletado y no envía el formulario', async t => {
  const h = componentHarness();
  t.after(() => h.cleanup());
  const { default: PasswordInput } = h.load('../src/PasswordInput.tsx', { 'lucide-react': componentStubs });
  h.render(() => PasswordInput({ id: 'secret', name: 'password', defaultValue: ' secreta ', required: true, minLength: 6, maxLength: 200, autoComplete: 'new-password' }));
  let tree = await h.settle();
  for (const type of ['password', 'text', 'password']) {
    const input = findElement(tree, e => e.type === 'input');
    assert.equal(input.props.type, type);
    assert.equal(input.props.defaultValue, ' secreta ');
    assert.equal(input.props.name, 'password');
    assert.equal(input.props.autoComplete, 'new-password');
    assert.equal(input.props.minLength, 6);
    assert.equal(input.props.required, true);
    const button = findElement(tree, e => e.type === 'button');
    assert.equal(button.props.type, 'button');
    assert.equal(button.props['aria-controls'], 'secret');
    assert.equal(button.props['aria-pressed'], type === 'text');
    button.props.onClick();
    tree = await h.settle();
  }
});

test('una cuenta nueva puede abrir el servidor desde el acceso local de Windows sin reemplazar su base', t => {
  const h = componentHarness({ navigator: { userAgent: 'GymPASSConnection/local GymPASSServer/https%3A%2F%2Fgym.example.test' } });
  t.after(() => h.cleanup());
  const { default: ServerAccessLink } = h.load('../src/ServerAccessLink.tsx', { './connection-mode': { serverOrigin } });
  const tree = h.render(() => ServerAccessLink());
  const link = findElement(tree, e => e.type === 'a');
  const target = new URL(link.props.href);
  assert.equal(target.protocol, 'gympass-connection:');
  assert.equal(target.searchParams.get('mode'), 'remote');
  assert.equal(target.searchParams.get('server'), 'https://gym.example.test');
  assert.match(elementText(link), /Usar mi cuenta del servidor/);
});

for (const platform of [true, false]) {
  test(`la cabecera comprueba el servidor real y recupera el estado tras reconectar (${platform ? 'central' : 'local'})`, async t => {
    const events: Record<string, () => Promise<void>> = {};
    let online = true;
    const h = componentHarness({ setInterval: () => 1, clearInterval() {}, window: { addEventListener: (name: string, cb: () => Promise<void>) => events[name] = cb, removeEventListener() {} } });
    t.after(() => h.cleanup());
    const { default: ConnectionStatus } = h.load('../src/ConnectionStatus.tsx', {
      'lucide-react': componentStubs,
      './api': { api: async () => { if (!online) throw Error('offline'); return { ok: true }; } },
    });
    h.render(() => ConnectionStatus({ platform }));
    assert.match(elementText(await h.settle()), platform ? /Servidor central/ : /Servidor local/);
    online = false;
    await events.offline();
    assert.match(elementText(await h.settle()), /Sin conexión al servidor/);
    online = true;
    await events.online();
    assert.match(elementText(await h.settle()), platform ? /Servidor central/ : /Servidor local/);
  });
}

test('la copia local diferencia conexión central, trabajo sin Internet y pendientes', async t => {
  let state = { linked: true, online: true, pending: 0, error: '' };
  let refresh!: () => Promise<void>;
  const h = componentHarness({ setInterval: () => 1, clearInterval() {}, window: { addEventListener: (_: string, cb: () => Promise<void>) => refresh = cb, removeEventListener() {} } });
  t.after(() => h.cleanup());
  const { default: ConnectionStatus } = h.load('../src/ConnectionStatus.tsx', { 'lucide-react': componentStubs, './api': { api: async () => state } });
  h.render(() => ConnectionStatus({ replica: true }));
  assert.match(elementText(await h.settle()), /Servidor conectado · copia local/);
  state = { linked: true, online: false, pending: 3, error: 'Sin Internet' };
  await refresh();
  assert.match(elementText(await h.settle()), /Servidor local · copia del gimnasio · 3 pendientes/);
});
