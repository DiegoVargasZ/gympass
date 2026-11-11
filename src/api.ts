import { assertPlatformGeneration, getPlatformGeneration, platformFetch } from './platform-context.ts';

/** The request never reached the server, so retrying it later is safe. */
export class NetworkError extends Error {
  constructor(message = 'Sin conexión con el servidor.') {
    super(message);
    this.name = 'NetworkError';
  }
}
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
let sessionRevision = 0;
function expireSession(revision: number) {
  if (revision !== sessionRevision) return;
  sessionRevision++;
  window.dispatchEvent(new Event('session-expired'));
}
export async function api<T = any>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  const revision = sessionRevision;
  const contextGeneration = getPlatformGeneration();
  const requestBody = body === undefined && !['GET', 'HEAD'].includes(method.toUpperCase()) ? {} : body;
  const timeout = AbortSignal.timeout(
    path === 'network/check' ||
      path.startsWith('backups') ||
      path.startsWith('cloud-sync/') ||
      path === 'platform/backups' ||
      path === 'system/update' ||
      path === 'system/reset'
      ? 120000
      : 12000,
  );
  try {
    response = await platformFetch(path, {
      method,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'GymPASS' },
      ...(requestBody !== undefined ? { body: JSON.stringify(requestBody) } : {}),
    });
  } catch (error) {
    // An aborted request was cancelled on purpose; anything else means the server is unreachable.
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw new NetworkError();
  }
  const data = await response.json().catch(() => null);
  assertPlatformGeneration(contextGeneration);
  if (!response.ok) {
    if (
      response.status === 401 &&
      !path.startsWith('auth/') &&
      !['platform/login', 'platform/recovery/accept', 'platform/invitations/accept'].includes(path)
    )
      expireSession(revision);
    throw new HttpError(response.status, data?.error || 'No se pudo completar la solicitud.');
  }
  if (data === null) throw new NetworkError('El servidor devolvió una respuesta ilegible.');
  if (
    method.toUpperCase() === 'POST' &&
    [
      'auth/login',
      'auth/setup',
      'auth/logout',
      'platform/login',
      'platform/logout',
      'platform/password',
      'platform/recovery/accept',
    ].includes(path)
  )
    sessionRevision++;
  return data as T;
}
export async function download(path: string, name: string) {
  const generation = getPlatformGeneration();
  const r = await platformFetch(path);
  if (!r.ok) {
    const data = await r.json();
    throw Error(data.error || 'No se pudo exportar.');
  }
  const blob = await r.blob();
  assertPlatformGeneration(generation);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function uploadBackup<T>(file: File): Promise<T> {
  const revision = sessionRevision;
  const generation = getPlatformGeneration();
  const response = await platformFetch('backups/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'GymPASS' },
    body: file,
    signal: AbortSignal.timeout(120000),
  });
  const data = await response.json().catch(() => null);
  assertPlatformGeneration(generation);
  if (!response.ok) {
    if (response.status === 401) expireSession(revision);
    throw new HttpError(response.status, data?.error || 'No se pudo importar el respaldo.');
  }
  if (!data) throw new NetworkError('El servidor no confirmó la importación.');
  return data as T;
}
export async function upload(path: string, file: Blob) {
  const revision = sessionRevision;
  const generation = getPlatformGeneration();
  const response = await platformFetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': file.type, 'X-Requested-With': 'GymPASS' },
    body: file,
  });
  const data = await response.json();
  assertPlatformGeneration(generation);
  if (!response.ok) {
    if (response.status === 401) expireSession(revision);
    throw Error(data.error || 'No se pudo guardar la imagen.');
  }
  return data as { path: string };
}
