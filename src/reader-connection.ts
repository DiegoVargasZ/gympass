export type ReaderSetup = {
  id: string;
  name: string;
  kind: string;
  direction: string;
  zone_id: string;
  token: string;
};
export function readerConfiguration(origin: string, accessPath: string, reader: ReaderSetup) {
  return {
    format: 'gympass-reader-v1',
    id: reader.id,
    name: reader.name,
    kind: reader.kind,
    direction: reader.direction,
    zone_id: reader.zone_id,
    access_url: new URL(accessPath, origin).href,
    check_url: new URL(accessPath.replace(/device-access$/, 'device-check'), origin).href,
    token: reader.token.trim(),
  };
}
export type ReaderConfiguration = ReturnType<typeof readerConfiguration>;
export async function checkReaderConnection(configuration: ReaderConfiguration, signal?: AbortSignal) {
  if (!configuration.token) throw Error('Pega la clave que guardaste al crear este lector.');
  const response = await fetch(configuration.check_url, {
    method: 'GET',
    credentials: 'omit',
    cache: 'no-store',
    headers: { Authorization: 'Bearer ' + configuration.token },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw Error(result?.error || 'No se pudo comprobar la conexión.');
  if (!result?.ok || result.device?.id !== configuration.id)
    throw Error('La clave corresponde a otro lector o el servidor no devolvió una comprobación válida.');
  return result;
}
export function saveReaderConfiguration(configuration: ReaderConfiguration) {
  if (!configuration.token) throw Error('Pega la clave antes de guardar la configuración.');
  const file = new Blob([JSON.stringify(configuration, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'gympass-lector-' + configuration.id.replace(/[^a-zA-Z0-9_-]/g, '') + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
