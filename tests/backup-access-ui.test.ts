import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness, componentStubs, elementText } from './component-harness.ts';

test('Sistema no ofrece ni consulta respaldos para el administrador local', async t => {
  const h = componentHarness(); t.after(() => h.cleanup());
  const requests: string[] = [];
  const { default: SystemSettings } = h.load('../src/SystemSettings.tsx', {
    'lucide-react': componentStubs,
    './ui': { ...componentStubs, Badge: 'Badge', Field: 'Field', Form: 'Form', Modal: 'Modal', Skeleton: 'Skeleton', stamp: () => '' },
    './SystemTools': { default: 'SystemTools' },
    './styles/backup-transfer.css': {},
    './api': { api: async (path: string) => { requests.push(path); return { version: '5.2.1', desktop: true }; } },
  });
  h.render(() => SystemSettings({ owner: true, timezone: 'America/La_Paz', notify() {} }));
  const tree = await h.settle();
  assert.deepEqual(requests, ['system-info']);
  assert.doesNotMatch(elementText(tree), /Respaldos|Crear respaldo|Importar|Restaurar/);
  assert.match(elementText(tree), /Actualizar GymPASS/);
});
