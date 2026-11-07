import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { ApiError } from "../lib/service.ts";
import { safeBackupDirectory } from "./backups.ts";

const pattern = /^platform-\d{13}-[a-f\d-]{36}$/;
export function platformCopies(root: string) {
  const directory = safeBackupDirectory(join(root, "platform-backups"));
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((id) => pattern.test(id))
    .flatMap((id) => {
      try {
        const path = safeBackupDirectory(join(directory, id));
        const manifest = JSON.parse(
          readFileSync(join(path, "complete.json"), "utf8"),
        );
        if (manifest.format !== 1 || !Number.isFinite(manifest.created_at))
          return [];
        return [{ id, created_at: manifest.created_at }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.created_at - a.created_at);
}

/** A standard tar.gz can be extracted before using platform-restore.ts. */
export function exportPlatformCopy(root: string, id: string) {
  if (!pattern.test(id))
    throw new ApiError(400, "Respaldo de plataforma inválido.");
  const directory = safeBackupDirectory(join(root, "platform-backups", id));
  if (!existsSync(directory))
    throw new ApiError(404, "No se encontró el respaldo.");
  const manifestPath = join(directory, "complete.json");
  if (lstatSync(manifestPath).isSymbolicLink())
    throw new ApiError(409, "Respaldo inválido.");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest.format !== 1 ||
    !manifest.files ||
    !manifest.files["platform.sqlite"]
  )
    throw new ApiError(409, "La copia está incompleta.");
  const entries = [...Object.keys(manifest.files), "complete.json"];
  const chunks: Buffer[] = [];
  let total = 0;
  for (const file of entries) {
    if (
      file.includes("\\") ||
      file.startsWith("/") ||
      file.split("/").some((p) => !p || p === "." || p === "..") ||
      Buffer.byteLength(file) > 255
    )
      throw new ApiError(409, "El respaldo contiene una ruta inválida.");
    const target = resolve(directory, file);
    if (!target.startsWith(directory + sep))
      throw new ApiError(409, "Ruta fuera del respaldo.");
    for (const part of file
      .split("/")
      .reduce<string[]>(
        (paths, part) => [...paths, join(paths.at(-1) || directory, part)],
        [],
      ))
      if (lstatSync(part).isSymbolicLink())
        throw new ApiError(409, "No se exportan enlaces.");
    const info = lstatSync(target);
    total += info.size;
    if (!info.isFile() || total > 256 * 1024 * 1024)
      throw new ApiError(
        413,
        "La copia supera el límite de descarga de 256 MiB.",
      );
    const bytes = readFileSync(target);
    if (
      file !== "complete.json" &&
      createHash("sha256").update(bytes).digest("hex") !== manifest.files[file]
    )
      throw new ApiError(
        409,
        "La copia está dañada o cambió durante la descarga.",
      );
    const header = Buffer.alloc(512);
    const split = file.length > 100 ? file.lastIndexOf("/") : -1;
    const name = split < 0 ? file : file.slice(split + 1),
      prefix = split < 0 ? "" : file.slice(0, split);
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155)
      throw new ApiError(409, "Nombre de archivo demasiado largo.");
    header.write(name);
    header.write("0000600\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write(
      Math.floor(manifest.created_at / 1000)
        .toString(8)
        .padStart(11, "0") + "\0",
      136,
    );
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    header.write(prefix, 345);
    header.write(
      [...header]
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
      148,
    );
    chunks.push(
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  }
  chunks.push(Buffer.alloc(1024));
  return { filename: id + ".tar.gz", bytes: gzipSync(Buffer.concat(chunks)) };
}
