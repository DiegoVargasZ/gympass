import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as feedback from '../lib/access-feedback.ts';
import * as voiceCatalog from '../lib/voice-catalog.ts';
import * as backupLimits from '../lib/backup-limits.ts';

export type Element = { type: unknown; props: Record<string, any> };

export function findElement(tree: unknown, predicate: (element: Element) => boolean): Element {
  if (Array.isArray(tree)) {
    for (const child of tree) {
      try {
        return findElement(child, predicate);
      } catch {}
    }
  } else if (tree && typeof tree === 'object' && 'props' in tree) {
    const original = tree as Element;
    const resolved = (original.type as { resolved?: unknown })?.resolved;
    const element = resolved ? { ...original, type: resolved } : original;
    if (predicate(element)) return element;
    return findElement(element.props.children, predicate);
  }
  throw Error('Elemento no encontrado');
}

export function elementText(tree: any): string {
  if (Array.isArray(tree)) return tree.map(elementText).join('');
  if (tree && typeof tree === 'object') return elementText(tree.props?.children);
  return tree === undefined || tree === null || typeof tree === 'boolean' ? '' : String(tree);
}

// Only React's hooks and browser boundaries are simulated. Components and their callbacks execute unchanged.
export function componentHarness(globals: Record<string, unknown> = {}) {
  const values: any[] = [];
  const effects: { deps: unknown[]; cleanup?: () => void }[] = [];
  const pending: (() => void)[] = [];
  let index = 0;
  let dirty = false;
  let renderComponent: () => unknown;
  let tree: unknown;
  const hooks = {
    useSyncExternalStore(_subscribe: unknown, snapshot: () => unknown) { return snapshot(); },
    lazy(load: () => Promise<{ default: unknown }>) {
      const component: { resolved?: unknown } = {};
      void load().then((module) => {
        component.resolved = module.default;
        dirty = true;
      });
      return component;
    },
    Suspense: 'Suspense',
    useState(initial: any) {
      const slot = index++;
      if (!(slot in values)) values[slot] = typeof initial === 'function' ? initial() : initial;
      return [
        values[slot],
        (next: any) => {
          const value = typeof next === 'function' ? next(values[slot]) : next;
          if (!Object.is(values[slot], value)) {
            values[slot] = value;
            dirty = true;
          }
        },
      ];
    },
    useRef(initial: any) {
      const slot = index++;
      if (!(slot in values)) values[slot] = { current: initial };
      return values[slot];
    },
    useCallback(callback: unknown) {
      index++;
      return callback;
    },
    useEffect(callback: () => (() => void) | void, deps: unknown[]) {
      const slot = index++;
      const previous = effects[slot];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        pending.push(() => {
          previous?.cleanup?.();
          effects[slot] = { deps, cleanup: callback() || undefined };
        });
      }
    },
  };
  const require = createRequire(import.meta.url);
  const browser = {
    innerWidth: 1440,
    innerHeight: 1000,
    addEventListener() {},
    removeEventListener() {},
  };
  const modules = new Map<string, any>();
  function load(file: string, dependencies: Record<string, any> = {}): any {
    if (modules.has(file)) return modules.get(file);
    const exports: Record<string, any> = {};
    modules.set(file, exports);
    const filename = new URL(file, import.meta.url);
    const source = ts.transpileModule(
      readFileSync(filename, 'utf8').replaceAll('import.meta.url', JSON.stringify(filename.href)),
      {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
        fileName: file,
      },
    ).outputText;
    runInNewContext(source, {
      exports,
      require: (name: string) => {
        if (name === 'react') return hooks;
        if (name === 'react/jsx-runtime') return require(name);
        if (/lib\/access-feedback$/.test(name)) return feedback;
        if (/lib\/voice-catalog$/.test(name)) return voiceCatalog;
        if (/lib\/backup-limits$/.test(name)) return backupLimits;
        if (name in dependencies) {
          const dependency = dependencies[name];
          return dependency && 'default' in dependency ? { __esModule: true, ...dependency } : dependency;
        }
        if (['./ConnectionStatus', './ServerAccessLink', './PasswordInput', './ThemeToggle'].includes(name))
          return { __esModule: true, default: name.slice(2) };
        throw Error(`Dependencia no configurada: ${name}`);
      },
      window: browser,
      document: {
        querySelector: () => null,
        body: { classList: { add() {}, remove() {} } },
        documentElement: {},
        addEventListener() {},
        removeEventListener() {},
      },
      navigator: {},
      location: { hash: '#events' },
      localStorage: { getItem: () => null },
      setTimeout,
      clearTimeout,
      AbortController,
      AbortSignal,
      Headers,
      DOMException,
      fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
      URLSearchParams,
      Blob,
      ...globals,
    });
    return exports;
  }
  return {
    load,
    render(component: () => unknown) {
      renderComponent = component;
      index = 0;
      dirty = false;
      tree = component();
      while (pending.length) pending.shift()!();
      return tree;
    },
    async settle() {
      for (let turn = 0; turn < 20; turn++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (dirty) this.render(renderComponent);
      }
      return tree;
    },
    cleanup() {
      for (const effect of effects) effect?.cleanup?.();
    },
  };
}

export const componentStubs = new Proxy({}, { get: (_target, name) => String(name) });
