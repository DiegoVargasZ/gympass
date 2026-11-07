import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  existsSync,
  copyFileSync,
} from "node:fs";
import { resolve, join, basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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
if (
  (!GH_TOKEN && mode !== "validate") ||
  !/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPOSITORY || "") ||
  !/^\d+$/.test(RELEASE_ID || "") ||
  !/^\d+$/.test(RELEASE_ASSET_ID || "") ||
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
  const asset = release.assets.find(
    (item) => String(item.id) === RELEASE_ASSET_ID,
  );
  if (
    !asset ||
    asset.name !== `GymPASS-prepared-clients-${version}.7z` ||
    asset.state !== "uploaded"
  )
    throw Error("El paquete preparado no pertenece al borrador.");
  mkdirSync(work, { recursive: true });
  const response = await api(`/releases/assets/${RELEASE_ASSET_ID}`, {
    headers: { Accept: "application/octet-stream" },
  });
  const path = join(work, "clients.7z");
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
  if ((await digest(path)) !== RELEASE_ARCHIVE_SHA256)
    throw Error("No coincide la huella del paquete preparado.");
  console.log("Paquete preparado verificado.");
  // The signed APK is uploaded once from the signing machine, separately from
  // the much smaller Windows runtime. Never replace it with an unsigned build.
  let android;
  for (let attempt = 0; attempt < 120; attempt++) {
    const current = await (await api(`/releases/${RELEASE_ID}`)).json();
    if (!current.draft || current.tag_name !== `v${version}`)
      throw Error("La entrega dejó de ser el borrador esperado.");
    android = current.assets.find(item => item.name === `GymPASS-Android-${version}.apk` && item.state === "uploaded");
    if (android) break;
    if (attempt % 6 === 0) console.log("Esperando el APK firmado de esta versión…");
    await new Promise(done => setTimeout(done, 10000));
  }
  if (!android || !/^sha256:[a-f0-9]{64}$/.test(android.digest || ""))
    throw Error("No está disponible el APK firmado verificado.");
  const androidResponse = await api(`/releases/assets/${android.id}`, { headers: { Accept: "application/octet-stream" } });
  const androidPath = join(work, `GymPASS-Android-${version}.apk`);
  await pipeline(Readable.fromWeb(androidResponse.body), createWriteStream(androidPath));
  if (`sha256:${await digest(androidPath)}` !== android.digest)
    throw Error("No coincide el APK descargado de la entrega.");
} else {
  const manifest = JSON.parse(
    readFileSync(join(prepared, "prepared.json"), "utf8"),
  );
  if (
    manifest.version !== version ||
    !/^[a-f0-9]{40}$/.test(manifest.source_commit)
  )
    throw Error("Versión de runtime incorrecta.");
  const apk = join(prepared, `GymPASS-Android-${version}.apk`);
  if (!existsSync(apk)) copyFileSync(join(work, `GymPASS-Android-${version}.apk`), apk);
  if ((await digest(apk)) !== manifest.android_sha256)
    throw Error("No coincide el APK firmado.");
  for (const name of [
    "server/replica-client.js",
    "server/replication.js",
    "server/migrations/021_offline_order.sql",
    "dist/index.html",
  ])
    if (!existsSync(join(prepared, "desktop-runtime", name)))
      throw Error("Runtime incompleto: " + name);
  console.log(`Runtime ${manifest.source_commit} y APK firmado verificados.`);
  if (mode === "upload") {
    const paths = [
      apk,
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
    await api(`/releases/assets/${RELEASE_ASSET_ID}`, { method: "DELETE" });
    console.log(
      "Paquete temporal retirado; el borrador está listo para revisión.",
    );
    console.log(hashes.join("\n"));
  } else if (mode !== "validate") throw Error("Operación desconocida.");
}
