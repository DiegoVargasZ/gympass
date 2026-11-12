import assert from 'node:assert/strict';
import test from 'node:test';
import { themePalettes } from '../lib/theme.ts';
import { componentHarness, componentStubs, findElement } from './component-harness.ts';

function luminance(hex: string) {
  const rgb = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('ambos temas mantienen contraste legible en texto, botones oliva y superficies', () => {
  for (const palette of Object.values(themePalettes)) {
    for (const [ink, background] of [[palette.ink,palette.surface],[palette.muted,palette.surface],[palette.brandText,palette.surface],[palette.onBrand,palette.brand],[palette.onChrome,palette.chrome]])
      assert.ok(contrast(ink, background) >= 4.5, `${ink} sobre ${background}`);
    assert.equal(palette.brand, '#636b2f');
    assert.ok(contrast(palette.onBrand, palette.brandHover) >= 4.5);
    assert.equal(palette.chrome, palette.surface);
  }
});

test('el cambio rápido de tema conserva las otras preferencias y puede invertir ambos modos', async t => {
  const h = componentHarness(); t.after(() => h.cleanup());
  let theme = 'light';
  const changes: unknown[] = [];
  const { default: ThemeToggle } = h.load('../src/ThemeToggle.tsx', {
    'lucide-react': componentStubs,
    './preferences': {
      usePreferences: () => ({ theme, sound: true }),
      saveAppearance: (next: { theme: string }) => { changes.push(JSON.parse(JSON.stringify(next))); theme = next.theme; },
    },
  });
  h.render(ThemeToggle);
  for (const label of ['Cambiar a modo oscuro','Cambiar a modo claro']) {
    const button = findElement(h.render(ThemeToggle), e => e.type === 'button');
    assert.equal(button.props['aria-label'], label);
    await button.props.onClick();
  }
  assert.deepEqual(changes, [{ theme: 'dark' }, { theme: 'light' }]);
});
