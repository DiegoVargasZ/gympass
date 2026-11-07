import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { restoreSignedApk } from './apk-delta.mjs';

const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, RELEASE_ID, RELEASE_ASSET_ID, RELEASE_ARCHIVE_SHA256 } = process.env;
if (!GH_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPOSITORY || '') || !/^\d+$/.test(RELEASE_ID || '') || !/^\d+$/.test(RELEASE_ASSET_ID || '') || !/^[a-f0-9]{64}$/.test(RELEASE_ARCHIVE_SHA256 || ''))
  throw Error('Configuración Android incompleta.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const headers = { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'GymPASS-Android-release' };
const base = `https://api.github.com/repos/${GITHUB_REPOSITORY}`;
async function api(path, options = {}) {
  const response = await fetch(base + path, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw Error(`GitHub HTTP ${response.status}: ${path}`);
  return response;
}
let release = await (await api(`/releases/${RELEASE_ID}`)).json();
if (!release.draft || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw Error('Se requiere la entrega Android en borrador.');
const version = release.tag_name.slice(1);
const archive = release.assets.find(item => String(item.id) === RELEASE_ASSET_ID);
if (!archive || archive.name !== `GymPASS-Android-prepared-${version}.json.gz` || archive.state !== 'uploaded' || archive.digest !== `sha256:${RELEASE_ARCHIVE_SHA256}`)
  throw Error('El paquete Android no coincide con el borrador.');
const archiveBytes = Buffer.from(await (await api(`/releases/assets/${archive.id}`, { headers: { Accept: 'application/octet-stream' } })).arrayBuffer());
if (hash(archiveBytes) !== RELEASE_ARCHIVE_SHA256) throw Error('Huella del paquete Android incorrecta.');
const { manifest, patch, literal } = JSON.parse(gunzipSync(archiveBytes, { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8'));
if (manifest.version !== version || manifest.source_commit !== GITHUB_SHA || !manifest.smoke?.passed || manifest.smoke.sha256 !== manifest.sha256 || patch.sha256 !== manifest.sha256)
  throw Error('El APK no tiene una comprobación de arranque de esta revisión.');
const source = new URL(patch.base_url);
if (source.origin !== 'https://github.com' || !source.pathname.startsWith(`/${GITHUB_REPOSITORY}/releases/download/`) || source.search || source.hash)
  throw Error('La base Android no corresponde a una entrega de este repositorio.');
const previous = await fetch(source, { signal: AbortSignal.timeout(120000) });
if (!previous.ok) throw Error('No se pudo descargar la base publicada.');
const apk = restoreSignedApk(Buffer.from(await previous.arrayBuffer()), Buffer.from(literal, 'base64'), patch);
const apkName = `GymPASS-Android-${version}.apk`;
const checksumName = `GymPASS-Android-${version}-SHA256.txt`;
for (const [name, bytes] of [[apkName, apk], [checksumName, Buffer.from(`${hash(apk)}  ${apkName}\n`)]]) {
  release = await (await api(`/releases/${RELEASE_ID}`)).json();
  if (!release.draft) throw Error('La entrega dejó de ser un borrador.');
  const existing = release.assets.find(item => item.name === name);
  if (existing) {
    if (existing.state === 'uploaded' && existing.digest === `sha256:${hash(bytes)}` && existing.size === bytes.length) continue;
    throw Error('Existe un archivo diferente en el borrador: ' + name);
  }
  const response = await fetch(release.upload_url.replace(/\{.*$/, '') + '?name=' + encodeURIComponent(name), {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) }, body: bytes, signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw Error('No se confirmó la subida de ' + name + ': HTTP ' + response.status);
  const uploaded = await response.json();
  if (uploaded.state !== 'uploaded' || uploaded.size !== bytes.length || uploaded.digest !== `sha256:${hash(bytes)}`)
    throw Error('El archivo publicado no coincide: ' + name);
  console.log('Adjuntado y verificado: ' + name);
}
await api(`/releases/assets/${archive.id}`, { method: 'DELETE' });
console.log('APK firmado y arranque verificados. Paquete temporal retirado. El borrador está listo para publicación.');
