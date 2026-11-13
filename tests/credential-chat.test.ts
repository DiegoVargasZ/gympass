import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness, componentStubs, findElement } from './component-harness.ts';

test('el chat web se dirige al número internacional sin consultar la agenda', () => {
  const h = componentHarness();
  const { credentialWhatsappUrl } = h.load('../src/credential-sharing.ts', {});
  const link = 'https://gympass.site/c/private';
  const url = new URL(credentialWhatsappUrl('+591 7123-4567', 'José Pérez', 'Gym', link));
  assert.equal(url.origin, 'https://wa.me');
  assert.equal(url.pathname, '/59171234567');
  assert.ok(url.searchParams.get('text')!.includes(link));
  assert.match(url.searchParams.get('text')!, /José Pérez/);
  for (const value of ['', 'abc', '00000000', undefined]) assert.equal(credentialWhatsappUrl(value, 'Socio', 'Gym'), null);
});

for (const clipboardFails of [false, true]) test(`la apertura del chat no depende del portapapeles (fallo=${clipboardFails})`, async (t) => {
  const file = new File(['PNG'], 'credencial.png', { type: 'image/png' });
  const h = componentHarness({ location: { origin: 'https://gympass.site' },
    URL: { createObjectURL: () => 'blob:preview', revokeObjectURL() {} },
  });
  t.after(() => h.cleanup());
  const sharing = h.load('../src/credential-sharing.ts', {});
  const { default: Button } = h.load('../src/ShareCredentialButton.tsx', {
    'react-dom': { createPortal: (tree: unknown) => tree }, 'lucide-react': componentStubs, './ui': { Modal: 'Modal' },
    './api': { upload: async () => ({ path: '/c/private' }) },
    './credential-sharing': { ...sharing, prepareCredentialPng: async () => ({ file, name: 'José Pérez' }) },
    './native-files': { copyCredentialImage: async () => { if (clipboardFails) throw Error('Clipboard denied'); } },
  });
  let tree = h.render(() => Button({ id: 'credential', name: 'José Pérez', phone: '+591 7123-4567', settings: { name: 'Gym' }, notify() {} }));
  findElement(tree, (el) => el.type === 'button').props.onClick();
  tree = await h.settle();
  const chat = findElement(tree, (el) => el.type === 'a' && el.props.className === 'btn primary');
  assert.equal(chat.props.target, '_blank');
  const url = new URL(chat.props.href);
  assert.equal(url.pathname, '/59171234567');
  assert.ok(url.searchParams.get('text')!.includes('https://gympass.site/c/private'));
  // A normal anchor opens during the click even if asynchronous clipboard work fails.
  chat.props.onClick();
  await h.settle();
});
