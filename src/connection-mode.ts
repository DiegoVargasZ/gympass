export type ConnectionMode = 'local' | 'remote' | 'replica';

export function connectionMode(userAgent: string, hostname: string): ConnectionMode {
  const native = /GymPASSConnection\/(local|remote|replica)\b/.exec(userAgent);
  if (native) return native[1] as ConnectionMode;
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname) ? 'local' : 'remote';
}

export function serverOrigin(value: string): string {
  if (!/^https:\/\/[^/?#\\]+\/?$/i.test(value.trim()))
    throw Error('Escribe solo la dirección HTTPS del servidor, sin rutas ni credenciales.');
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw Error('Escribe solo la dirección HTTPS del servidor, sin rutas ni credenciales.');
  return url.origin;
}

export function localOrigin(value: string): string {
  const url = new URL(value.trim());
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw Error('Usa la dirección local de esta computadora, por ejemplo http://localhost:3000.');
  return url.origin;
}

export function connectionDestination(mode: ConnectionMode, server: string, local: string, desktop: boolean, work?: 'local' | 'server'): string {
  if (desktop) {
    const query = new URLSearchParams({ mode: mode === 'local' ? 'replica' : mode });
    query.set('server', serverOrigin(server || 'https://gympass.site'));
    if (work || mode === 'local') query.set('work', work || 'local');
    return 'gympass-connection://apply/?' + query;
  }
  return (mode === 'local' ? localOrigin(local) : serverOrigin(server)) + '/';
}
