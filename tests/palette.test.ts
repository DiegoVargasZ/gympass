import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contrast } from '../lib/branding.ts';

const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

/** Reads the literal hex tokens of one block. Derived values (color-mix) are skipped. */
function tokens(startMarker: string) {
  const start = css.indexOf(startMarker);
  assert.ok(start >= 0, 'bloque no encontrado: ' + startMarker);
  const block = css.slice(start, css.indexOf('}', start));
  const found: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) found[name] = value;
  return found;
}

function rgb(hex: string) {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
}
/** Hue angle in degrees; grey returns 0. */
function hue(hex: string) {
  const [r, g, b] = rgb(hex).map((channel) => channel / 255);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    span = max - min;
  if (!span) return 0;
  const angle = max === r ? ((g - b) / span) % 6 : max === g ? (b - r) / span + 2 : (r - g) / span + 4;
  return (angle * 60 + 360) % 360;
}
function hueDistance(a: string, b: string) {
  const difference = Math.abs(hue(a) - hue(b)) % 360;
  return difference > 180 ? 360 - difference : difference;
}

const light = tokens(':root {');
const dark = tokens(":root[data-theme='dark'] {");

// Text that must stay readable, and the surface it sits on.
const pairs: [string, string, number][] = [
  ['ink', 'bg', 7],
  ['ink', 'surface', 7],
  ['ink-2', 'surface', 4.5],
  ['ink-2', 'surface-2', 4.5],
  ['muted', 'surface', 4.5],
  ['ok', 'ok-bg', 4.5],
  ['warn', 'warn-bg', 4.5],
  ['danger', 'danger-bg', 4.5],
  ['info', 'info-bg', 4.5],
  ['purple', 'purple-bg', 4.5],
];

for (const [theme, palette] of [
  ['claro', light],
  ['oscuro', dark],
] as const) {
  test(`Paleta ${theme}: el texto cumple contraste AA sobre su fondo`, () => {
    for (const [foreground, background, minimum] of pairs) {
      const value = contrast(palette[foreground], palette[background]);
      assert.ok(
        value >= minimum,
        `--${foreground} sobre --${background}: ${value.toFixed(2)} < ${minimum} (${palette[foreground]} / ${palette[background]})`,
      );
    }
  });

  if (theme === 'claro')
    test(`Paleta ${theme}: los estados ocupan matices separados`, () => {
      // Lo que importa entre dos colores de estado no es su contraste mutuo —ninguno se dibuja
      // sobre el otro— sino que no se confundan como muestras. Eso es distancia de matiz.
      const states = ['ok', 'warn', 'danger'] as const;
      for (let i = 0; i < states.length; i++)
        for (let j = i + 1; j < states.length; j++) {
          const difference = hueDistance(palette[states[i]], palette[states[j]]);
          assert.ok(
            difference >= 25,
            `--${states[i]} (${palette[states[i]]}) y --${states[j]} (${palette[states[j]]}) comparten matiz: ${difference.toFixed(0)}°`,
          );
        }
    });

  test(`Paleta ${theme}: las superficies se separan del fondo y del borde`, () => {
    assert.notEqual(palette.border, palette.bg, 'los bordes distinguen paneles y fondo');
    assert.notEqual(palette.surface, palette['surface-2']);
    assert.notEqual(palette.border, palette.surface);
  });
  test(`Paleta ${theme}: WhatsApp mantiene contraste AA en reposo y al pasar el cursor`, () => {
    for (const token of ['whatsapp', 'whatsapp-hover'])
      assert.ok(contrast(palette[token], palette['on-whatsapp']) >= 4.5, token);
  });
}

test('Ambos temas conservan botones verde oliva con texto blanco legible', () => {
  for (const palette of [light, dark]) {
    assert.equal(palette['brand-base'], '#636b2f');
    assert.equal(palette['on-brand'], '#ffffff');
    for (const token of ['brand-base', 'brand-hover'])
      assert.ok(contrast(palette[token], palette['on-brand']) >= 4.5, token);
  }
});

test('El acceso permitido es verde y el denegado rojo en ambos temas', () => {
  for (const palette of [light, dark]) {
    assert.ok(hueDistance(palette['result-ok'], '#008000') < 50);
    assert.ok(hueDistance(palette['result-danger'], '#ff0000') < 20);
    assert.ok(contrast(palette['result-ok'], palette['result-ok-ink']) >= 4.5);
    assert.ok(contrast(palette['result-danger'], palette['result-danger-ink']) >= 4.5);
  }
});

test('Oscuro: la estructura usa negro, blanco y grises y las acciones usan verde', () => {
  for (const name of ['bg', 'surface', 'surface-2', 'ink', 'ink-2', 'muted', 'nav-bg', 'nav-text']) {
    const value = dark[name];
    const [r, g, b] = rgb(value);
    assert.ok(r === g && g === b, `--${name}: ${value} no es monocromo`);
  }
  assert.equal(dark.bg, '#000000');
  assert.equal(dark.ink, '#ffffff');
  assert.ok(dark['brand-base'], 'El modo oscuro debe resolver también el color de las acciones');
  assert.ok(dark['on-brand']);
  assert.ok(contrast(dark['brand-base'], dark['on-brand']) >= 4.5);
});

test('Oscuro: ayudas, controles, foco y resultados mantienen contraste AA', () => {
  for (const background of ['bg', 'surface', 'surface-2']) {
    assert.ok(contrast(dark.muted, dark[background]) >= 4.5, `ayuda sobre --${background}`);
    assert.ok(contrast(dark.focus, dark[background]) >= 3, `foco sobre --${background}`);
    assert.ok(contrast(dark['border-strong'], dark[background]) >= 3, `controles sobre --${background}`);
  }
  for (const result of ['result-ok', 'result-danger', 'result-queued']) {
    assert.ok(contrast(dark[result], dark[result+'-ink']) >= 4.5, result);
  }
});

test('El tema automático oscuro comparte todos los tokens del oscuro explícito', () => {
  assert.deepEqual(tokens(":root[data-theme='system'] {"), dark);
});

test('Paleta: cada resultado usa un primer plano con contraste AA', () => {
  for (const token of ['result-ok', 'result-danger', 'result-queued']) {
    const value = contrast(light[token], light[token+'-ink']);
    assert.ok(value >= 4.5, `--${token} con --result-ink: ${value.toFixed(2)}`);
  }
});

test('Paleta: la estructura ya no arrastra el tinte verde de la marca', () => {
  // El rediseño saca el verde de la estructura: ningún gris puede tener el verde dominante,
  // y la desviación respecto a un gris puro se mantiene discreta. Un gris frío sí es válido.
  for (const [theme, palette] of [
    ['claro', light],
    ['oscuro', dark],
  ] as const)
    for (const token of ['bg', 'surface', 'surface-2', 'border', 'ink', 'ink-2', 'muted']) {
      const [r, g, b] = rgb(palette[token]);
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      assert.ok(spread <= 36, `${theme}: --${token} (${palette[token]}) está demasiado saturado`);
      assert.ok(!(g > r && g > b), `${theme}: --${token} (${palette[token]}) conserva el tinte verde en la estructura`);
    }
});
