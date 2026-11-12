import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrast } from '../lib/branding.ts';
import { accentButtonColor, accentPresets, accentProperties, accentTokens, defaultAccent, normalizeAccent } from '../lib/accent.ts';

const darkSurface = '#1c2128';
const samples = [...accentPresets.map((preset) => preset.color), '#ffee88', '#ffffff', '#000000', '#ff00d4', '#12ab34'];

test('Acento: el verde oliva original no cambia ningún estilo', () => {
  assert.equal(accentTokens(defaultAccent, 'light'), null);
  assert.equal(accentTokens(defaultAccent, 'dark'), null);
  assert.equal(normalizeAccent('#636B2F'), defaultAccent);
});

test('Acento: un valor inválido vuelve al verde oliva', () => {
  for (const value of [undefined, null, 5, '', 'red', '#12345', '#12345g', 'javascript:1']) assert.equal(normalizeAccent(value), defaultAccent);
});

test('Acento: cualquier color deja el texto blanco legible en los botones', () => {
  for (const color of samples) {
    assert.ok(contrast(accentButtonColor(color), '#ffffff') >= 5, `botón ${color}`);
    for (const theme of ['light', 'dark'] as const) {
      const tokens = accentTokens(color, theme);
      if (!tokens) continue;
      assert.ok(contrast(tokens['--brand-base'], '#ffffff') >= 5, `${theme} ${color}`);
      assert.deepEqual(Object.keys(tokens).sort(), [...accentProperties].sort());
      for (const value of Object.values(tokens)) assert.match(value, /^#[\da-f]{6}$/, `${theme} ${color}`);
    }
  }
});

test('Acento: en oscuro el texto y el foco se leen sobre las superficies oscuras', () => {
  for (const color of samples) {
    const tokens = accentTokens(color, 'dark');
    if (!tokens) continue;
    for (const name of ['--brand-700', '--brand-600', '--focus'] as const)
      assert.ok(contrast(tokens[name], darkSurface) >= 7, `${name} ${color}`);
  }
});

test('Acento: en claro el texto de acento se lee sobre blanco', () => {
  for (const color of samples) {
    const tokens = accentTokens(color, 'light');
    if (!tokens) continue;
    assert.ok(contrast(tokens['--brand-700'], '#ffffff') >= 5, color);
    assert.ok(contrast(tokens['--brand-hover'], '#ffffff') >= 5, color);
  }
});
