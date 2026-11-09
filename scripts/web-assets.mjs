import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { posix, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';

function describe(directory, names) {
  return names.sort().map((path) => ({ path, sha256: createHash('sha256').update(readFileSync(resolve(directory, path))).digest('hex') }));
}

/** Every asset emitted by the compiler must be shipped, including optional/lazy modules. */
export function emittedWebAssets(directory) {
  function files(prefix) {
    return readdirSync(resolve(directory, prefix), { withFileTypes: true }).flatMap((entry) => {
      if (entry.isSymbolicLink()) throw Error('Enlace no permitido en la compilación.');
      const path = prefix + '/' + entry.name;
      return entry.isDirectory() ? files(path) : /\.(br|gz)$/.test(path) ? [] : [path];
    });
  }
  return describe(directory, files('assets'));
}

/** Vite emits literal imports and a literal dependency table for every lazy chunk. */
export function collectWebAssets(directory) {
  const seen = new Set();
  function visit(name) {
    if (seen.has(name)) return;
    const path = resolve(directory, name);
    if (!path.startsWith(resolve(directory) + sep) || !existsSync(path)) throw Error('Recurso web ausente: ' + name);
    seen.add(name);
    if (!/\.(html|js|css)$/.test(name)) return;
    const source = readFileSync(path, 'utf8');
    const references = [];
    if (name.endsWith('.js')) {
      const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const inspect = (node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) references.push(node.text);
        ts.forEachChild(node, inspect);
      };
      inspect(ast);
    } else {
      for (const match of source.matchAll(/(?:src|href)=["']([^"']+)["']|["']((?:\.\.?\/|\/?assets\/)[^"']+)["']/g))
        references.push(match[1] || match[2]);
      if (name.endsWith('.css')) for (const match of source.matchAll(/(?:url\(\s*["']?|@import\s*["'])([^\s"')]+)["']?\s*\)?/g)) references.push(match[1]);
    }
    for (let reference of references) {
      reference = reference.split(/[?#]/)[0];
      if (!/^(?:\.\.?\/|\/?assets\/)/.test(reference)) continue;
      if (!/\.(?:js|css|png|svg|webp|woff2?|jpe?g|gif|wasm|mp3|wav|mp4|avif|ico|json)$/.test(reference)) continue;
      if (/^(https?:|data:)/.test(reference)) continue;
      const child = reference.startsWith('/') ? reference.slice(1) : reference.startsWith('assets/') ? reference : posix.normalize(posix.join(posix.dirname(name), reference));
      if (child.startsWith('assets/')) visit(child);
    }
  }
  visit('index.html');
  return describe(directory, [...seen].filter((name) => name.startsWith('assets/')));
}
