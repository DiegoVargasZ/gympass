import assert from 'node:assert/strict';
import { test } from 'node:test';
import { componentHarness, componentStubs, findElement } from './component-harness.ts';

for (const userAgent of [
  'Mozilla/5.0 Chrome/130.0',
  'Mozilla/5.0 Android Chrome/130.0',
  'Mozilla/5.0 GymPASS-Android/4.5.2',
  'Mozilla/5.0 GymPASSConnection/replica',
  'Mozilla/5.0 GymPASSConnection/remote',
  'Mozilla/5.0 Electron/45.0',
]) {
  test(`las descargas solo aparecen en el navegador: ${userAgent}`, (t) => {
    const h = componentHarness({ navigator: { userAgent } });
    t.after(() => h.cleanup());
    const { default: AppDownloads } = h.load('../src/AppDownloads.tsx', {
      'lucide-react': componentStubs,
      './styles/app-downloads.css': {},
    });
    const tree = h.render(AppDownloads);
    if (userAgent.includes('GymPASS') || userAgent.includes('Electron')) assert.equal(tree, null);
    else {
      findElement(tree, (element) => element.type === 'a' && element.props.href.endsWith('.apk'));
      findElement(tree, (element) => element.type === 'a' && element.props.href.endsWith('.exe'));
    }
  });
}
