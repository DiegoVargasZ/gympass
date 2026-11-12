import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { componentHarness, componentStubs, elementText, findElement } from './component-harness.ts';

test('la guía inicial exige cobrar un plan antes de entregar el QR y registrar entrada', (t) => {
  const h = componentHarness(); t.after(() => h.cleanup());
  const { default: Dashboard } = h.load('../src/Dashboard.tsx', {
    'lucide-react': componentStubs,
    './ui': { PageHeader: 'PageHeader', EventTable: 'EventTable' },
    './GymPresence': { default: 'GymPresence' },
  });
  const tree = h.render(() => Dashboard({ data: { user: { role: 'admin' }, settings: { timezone: 'America/La_Paz' }, stats: { activePeople: 0 }, zones: [], events: [] } }));
  const text = elementText(tree);
  assert.match(text, /Empieza en 4 pasos/);
  assert.ok(text.indexOf('Crea y cobra su plan') < text.indexOf('Entrégale su credencial QR'));
  const link = findElement(tree, (el) => el.type === 'a' && elementText(el) === 'Abrir Caja');
  assert.equal(link.props.href, '#pos');
});

test('la entrega conserva exactamente los recursos actuales y anteriores con sus huellas', () => {
  const release = JSON.parse(readFileSync(new URL('../dist/release.json', import.meta.url), 'utf8'));
  const previous = JSON.parse(readFileSync(new URL('../web-releases/previous.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(release.version, manifest.version);
  assert.equal(release.previous_version, previous.version);
  const retained = new Set<string>();
  for (const { path, sha256 } of [...release.assets, ...previous.assets, ...(release.compatibility_assets || [])]) {
    retained.add(path);
    const bytes = readFileSync(new URL('../dist/' + path, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, path);
  }
  for (const name of readdirSync(new URL('../dist/assets/', import.meta.url))) assert.ok(retained.has('assets/' + name.replace(/\.(br|gz)$/, '')), name);
  const downloads = readFileSync(new URL('../src/AppDownloads.tsx', import.meta.url), 'utf8');
  assert.ok(downloads.includes(`/download/v${manifest.version}/`));
  assert.ok(downloads.includes(`GymPASS-Android-${manifest.version}.apk`));
  assert.ok(downloads.includes(`GymPASS-Setup-${manifest.version}.exe`));
  // La versión portable se sigue publicando, pero el inicio de sesión solo ofrece el instalador.
  assert.ok(!downloads.includes('GymPASS-Portable-'));
});
