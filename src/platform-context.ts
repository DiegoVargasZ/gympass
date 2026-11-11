export type PlatformContext = { gymId: string; supportToken?: string };

let context: PlatformContext | null = null;
let generation = 0;
let controller = new AbortController();

export function setPlatformContext(next: PlatformContext | null) {
  if (next?.gymId === context?.gymId && next?.supportToken === context?.supportToken) return;
  controller.abort();
  controller = new AbortController();
  context = next ? { ...next } : null;
  generation++;
}

export function getPlatformContext(): PlatformContext | null {
  return context ? { ...context } : null;
}

export function getPlatformGeneration() {
  return generation;
}

export function getPlatformSignal() {
  return controller.signal;
}

export function assertPlatformGeneration(expected: number) {
  if (expected !== generation) throw new DOMException('Se cambió el gimnasio o la sesión.', 'AbortError');
}

export function apiUrl(path: string) {
  if (/^(?:https?:|data:|blob:|\/\/)/i.test(path)) return path;
  const clean = path.replace(/^\/?api\//, '').replace(/^\//, '');
  if (!context || clean === 'health' || clean.startsWith('platform/') || clean.startsWith('gyms/')) return '/api/' + clean;
  return '/api/gyms/' + encodeURIComponent(context.gymId) + '/' + clean;
}

export async function platformFetch(path: string, init: RequestInit = {}) {
  const current = generation;
  const url = apiUrl(path);
  const central = /^\/api\/platform\//.test(url);
  const headers = new Headers(init.headers);
  if (context?.supportToken && url.startsWith('/api/gyms/' + encodeURIComponent(context.gymId) + '/'))
    headers.set('X-GymPASS-Support', context.supportToken);
  const signal = central
    ? init.signal
    : init.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
  const response = await fetch(url, { ...init, headers, ...(signal ? { signal } : {}) });
  if (!central) assertPlatformGeneration(current);
  return response;
}
