import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/**
 * Piso de compatibilidad: Chrome/Edge 109 y Firefox 115 ESR son las ultimas versiones
 * que se instalan en Windows 7 y 8.1. Lo que aparezca aqui compila sin avisos pero
 * falla al ejecutarse en esos equipos, asi que se revisa en el codigo fuente.
 */
const jsForbidden = [
  [/\.toSorted\s*\(/, 'Array.prototype.toSorted necesita Chrome 110; usa [...lista].sort()'],
  [/\.toReversed\s*\(/, 'Array.prototype.toReversed necesita Chrome 110; usa [...lista].reverse()'],
  [/\.toSpliced\s*\(/, 'Array.prototype.toSpliced necesita Chrome 110'],
  [/Object\.groupBy\s*\(/, 'Object.groupBy necesita Chrome 117; agrupa con un Map'],
  [/Map\.groupBy\s*\(/, 'Map.groupBy necesita Chrome 117; agrupa con un Map'],
  [/Promise\.withResolvers\s*\(/, 'Promise.withResolvers necesita Chrome 119; usa new Promise'],
  [/Array\.fromAsync\s*\(/, 'Array.fromAsync necesita Chrome 121'],
  [/\.isWellFormed\s*\(/, 'String.prototype.isWellFormed necesita Chrome 111'],
  [/\.toWellFormed\s*\(/, 'String.prototype.toWellFormed necesita Chrome 111'],
  [/Intl\.DurationFormat/, 'Intl.DurationFormat necesita Chrome 129'],
  [/Intl\.supportedValuesOf/, 'Intl.supportedValuesOf necesita Chrome 99 en Firefox 115 no existe'],
  [/navigator\.scheduling/, 'navigator.scheduling no existe en Firefox'],
];

const cssForbidden = [
  [/color-mix\s*\(/, 'color-mix() necesita Chrome 111; resuelve el color en tokens.css'],
  [/light-dark\s*\(/, 'light-dark() necesita Chrome 123; usa los bloques de tema de tokens.css'],
  [/\boklch\s*\(/, 'oklch() necesita Chrome 111; usa hex o rgb()'],
  [/\boklab\s*\(/, 'oklab() necesita Chrome 111; usa hex o rgb()'],
  [/text-wrap\s*:\s*(balance|pretty)/, 'text-wrap: balance necesita Chrome 114'],
  [/field-sizing\s*:/, 'field-sizing necesita Chrome 123'],
  [/@starting-style/, '@starting-style necesita Chrome 117'],
  [/anchor-name\s*:/, 'el posicionamiento por anclaje necesita Chrome 125'],
  [/:user-(valid|invalid)/, ':user-valid necesita Chrome 119'],
];

function sources(directory, extensions) {
  const result = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) result.push(...sources(path, extensions));
    else if (extensions.some((extension) => entry.endsWith(extension))) result.push(path);
  }
  return result;
}

// El anidamiento nativo de CSS necesita Chrome 112: un selector anidado empieza por & o por :.
const nesting = /^[ \t]+(&|:(?:hover|focus|active|checked|disabled|first-child|last-child|not|has)\b)/m;

test('el codigo del navegador no usa nada posterior a Chrome 109 ni Firefox 115', () => {
  const problems = [];
  for (const file of sources(join(root, 'src'), ['.ts', '.tsx'])) {
    const text = readFileSync(file, 'utf8');
    for (const [pattern, reason] of jsForbidden)
      if (pattern.test(text)) problems.push(`${file.slice(root.length)}: ${reason}`);
  }
  for (const file of sources(join(root, 'src'), ['.css'])) {
    const text = readFileSync(file, 'utf8');
    // Los comentarios nombran las APIs prohibidas al explicar por que no se usan.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [pattern, reason] of cssForbidden)
      if (pattern.test(code)) problems.push(`${file.slice(root.length)}: ${reason}`);
    if (nesting.test(code))
      problems.push(`${file.slice(root.length)}: el anidamiento nativo de CSS necesita Chrome 112`);
  }
  assert.deepEqual(problems, [], 'Incompatibilidades con Windows 7:\n' + problems.join('\n'));
});

test('la compilacion fija el piso de navegadores en vez de dejar el valor por omision', () => {
  const config = readFileSync(join(root, 'vite.config.ts'), 'utf8');
  for (const browser of ['chrome109', 'edge109', 'firefox115'])
    assert.ok(config.includes(browser), `vite.config.ts debe fijar ${browser} como objetivo`);
  assert.ok(config.includes('cssTarget'), 'vite.config.ts debe fijar cssTarget para el CSS emitido');
});
