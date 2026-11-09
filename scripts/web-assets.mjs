import { readFileSync, existsSync } from 'node:fs';
import { posix, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

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
    for (const [, reference] of source.matchAll(/["']([^"'\s?#]+\.(?:js|css))["']/g)) {
      if (/^(https?:|data:)/.test(reference)) continue;
      const child = reference.startsWith('/') ? reference.slice(1) : reference.startsWith('assets/') ? reference : posix.normalize(posix.join(posix.dirname(name), reference));
      if (child.startsWith('assets/')) visit(child);
    }
  }
  visit('index.html');
  return [...seen].filter((name) => name.startsWith('assets/')).sort().map((path) => ({
    path, sha256: createHash('sha256').update(readFileSync(resolve(directory, path))).digest('hex'),
  }));
}
