import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { resolve, join, basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { restoreSignedApk } from "./apk-delta.mjs";
const version = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const {
  GH_TOKEN,
  GITHUB_REPOSITORY,
  RELEASE_ID,
  RELEASE_ASSET_ID,
  RELEASE_ARCHIVE_SHA256,
  RELEASE_WORKSPACE,
} = process.env;
const mode = process.argv[2];
const preparedBlob = /^[a-f0-9]{40}$/.test(RELEASE_ASSET_ID || "");
if (
  (!GH_TOKEN && mode !== "validate") ||
  !/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPOSITORY || "") ||
  !/^\d+$/.test(RELEASE_ID || "") ||
  (!/^\d+$/.test(RELEASE_ASSET_ID || "") && !preparedBlob) ||
  !/^[a-f0-9]{64}$/.test(RELEASE_ARCHIVE_SHA256 || "") ||
  !RELEASE_WORKSPACE
)
  throw Error("Configuración de entrega incompleta.");
const headers = {
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "GymPASS-clients",
};
const base = `https://api.github.com/repos/${GITHUB_REPOSITORY}`;
async function api(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  if (!response.ok) throw Error(`GitHub respondió HTTP ${response.status}.`);
  return response;
}
const release =
  mode === "validate"
    ? null
    : await (await api(`/releases/${RELEASE_ID}`)).json();
if (release && (!release.draft || release.tag_name !== `v${version}`))
  throw Error("Solo se adjuntan archivos al borrador de esta versión.");
const work = resolve(RELEASE_WORKSPACE),
  prepared = join(work, "package");
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
if (mode === "prepare") {
  mkdirSync(work, { recursive: true });
  const path = join(work, "clients.7z");
  if (preparedBlob) {
    const blob = await (await api(`/git/blobs/${RELEASE_ASSET_ID}`)).json();
    if (blob.sha !== RELEASE_ASSET_ID || blob.encoding !== "base64" || !Number.isInteger(blob.size) || blob.size <= 0 || blob.size > 64 * 1024 * 1024)
      throw Error("El blob preparado no es un paquete válido de este repositorio.");
    const bytes = Buffer.from(blob.content, "base64");
    if (bytes.length !== blob.size || createHash("sha256").update(bytes).digest("hex") !== RELEASE_ARCHIVE_SHA256)
      throw Error("No coincide la huella del runtime preparado.");
    writeFileSync(path, bytes);
  } else {
  const asset = release.assets.find(
    (item) => String(item.id) === RELEASE_ASSET_ID,
  );
  if (
    !asset ||
    asset.name !== `GymPASS-prepared-clients-${version}.7z` ||
    asset.state !== "uploaded"
  )
    throw Error("El paquete preparado no pertenece al borrador.");
  const response = await api(`/releases/assets/${RELEASE_ASSET_ID}`, {
    headers: { Accept: "application/octet-stream" },
  });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
  }
  if ((await digest(path)) !== RELEASE_ARCHIVE_SHA256)
    throw Error("No coincide la huella del paquete preparado.");
  console.log("Paquete preparado verificado.");
} else {
  const manifest = JSON.parse(
    readFileSync(join(prepared, "prepared.json"), "utf8"),
  );
  if (
    manifest.version !== version ||
    !/^[a-f0-9]{40}$/.test(manifest.source_commit) ||
    (process.env.GITHUB_SHA && manifest.source_commit !== process.env.GITHUB_SHA)
  )
    throw Error("Versión de runtime incorrecta.");
  const apk = join(prepared, `GymPASS-Android-${version}.apk`);
  const windowsOnly = manifest.windows_only === true;
  if (windowsOnly) {
    if (!manifest.native_smoke?.passed || manifest.native_smoke.version !== version)
      throw Error('Falta la comprobación de arranque de Windows.');
    for (const name of ['gympass-logo.png', 'gympass-icon-512.png']) {
      const asset = manifest.public_images?.[name];
      if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw Error('Falta la huella de la imagen: ' + name);
      const target = join(prepared, 'desktop-runtime', 'dist', name);
      if (!existsSync(target)) {
        const url = `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${manifest.source_commit}/dist/${name}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw Error('No se pudo recuperar la imagen: ' + name);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw Error('La imagen publicada difiere: ' + name);
        writeFileSync(target, bytes);
      }
      if (await digest(target) !== asset.sha256) throw Error('Imagen incorrecta: ' + name);
    }
    for (const name of ['desktop/main.cjs', 'desktop/remote.cjs', 'desktop-runtime/server/replica-client.js', 'desktop-runtime/dist/index.html']) {
      const expected = manifest.runtime_sha256?.[name];
      if (!/^[a-f0-9]{64}$/.test(expected || '') || await digest(join(prepared, name)) !== expected)
        throw Error('El runtime de Windows no coincide: ' + name);
    }
  }
  if (!windowsOnly) {
  if (!existsSync(apk)) {
    const patch = JSON.parse(readFileSync(join(prepared, 'android-delta.json'), 'utf8'));
    const source = new URL(patch.base_url);
    if (source.origin !== 'https://github.com' || !source.pathname.startsWith(`/${GITHUB_REPOSITORY}/releases/download/`) || source.search || source.hash)
      throw Error('La base Android no pertenece a las entregas de este repositorio.');
    const response = await fetch(source, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw Error('No se pudo descargar la base Android publicada.');
    if (patch.sha256 !== manifest.android_sha256) throw Error('El delta no corresponde al APK firmado del manifiesto.');
    const bytes = restoreSignedApk(Buffer.from(await response.arrayBuffer()), readFileSync(join(prepared, 'android-delta.bin')), patch);
    writeFileSync(apk, bytes);
  }
  if ((await digest(apk)) !== manifest.android_sha256)
    throw Error("No coincide el APK firmado.");
  }
  for (const name of [
    "server/replica-client.js",
    "server/replication.js",
    "server/migrations/021_offline_order.sql",
    "dist/index.html",
  ])
    if (!existsSync(join(prepared, "desktop-runtime", name)))
      throw Error("Runtime incompleto: " + name);
  console.log(`Runtime ${manifest.source_commit} verificado${windowsOnly ? ' para Windows' : ' con el APK firmado'}.`);
  if (mode === "upload") {
    const paths = [
      ...(windowsOnly ? [] : [apk]),
      ...["Setup", "Portable"].map((kind) =>
        join(work, "dist-escritorio", `GymPASS-${kind}-${version}.exe`),
      ),
    ];
    const hashes = [];
    for (const path of paths)
      hashes.push(`${await digest(path)}  ${basename(path)}`);
    const checksum = join(work, `GymPASS-${version}-SHA256.txt`);
    writeFileSync(checksum, hashes.join("\n") + "\n");
    paths.push(checksum);
    for (const path of paths) {
      const name = basename(path),
        hash = await digest(path);
      const existing = release.assets.find((item) => item.name === name);
      if (
        existing &&
        existing.digest === `sha256:${hash}` &&
        existing.state === "uploaded"
      )
        continue;
      if (existing)
        await api(`/releases/assets/${existing.id}`, { method: "DELETE" });
      const response = await fetch(
        release.upload_url.replace(/\{.*$/, "") +
          "?name=" +
          encodeURIComponent(name),
        {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/octet-stream",
            "Content-Length": String(statSync(path).size),
          },
          body: createReadStream(path),
          duplex: "half",
          signal: AbortSignal.timeout(15 * 60 * 1000),
        },
      );
      if (!response.ok)
        throw Error(`No se pudo adjuntar ${name}: HTTP ${response.status}.`);
      const uploaded = await response.json();
      if (
        uploaded.digest !== `sha256:${hash}` ||
        uploaded.size !== statSync(path).size
      )
        throw Error("La descarga publicada no coincide: " + name);
      console.log(`Adjuntado y verificado: ${name} (${uploaded.size} bytes).`);
    }
    if (!preparedBlob) await api(`/releases/assets/${RELEASE_ASSET_ID}`, { method: "DELETE" });
    console.log(
      "Paquete temporal retirado; el borrador está listo para revisión.",
    );
    console.log(hashes.join("\n"));
  } else if (mode !== "validate") throw Error("Operación desconocida.");
}
