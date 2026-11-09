export type ZipFile = { name: string; data: Blob | Uint8Array };
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
/** Standard ZIP with stored PNG files. PNG is already compressed; this avoids extra dependencies. */
export async function zipFiles(files: ZipFile[]) {
  if (files.length > 65535) throw Error('Demasiados archivos para un ZIP.');
  const parts: BlobPart[] = [],
    directory: BlobPart[] = [];
  let offset = 0,
    directorySize = 0;
  const now = new Date(),
    year = Math.max(1980, Math.min(2107, now.getFullYear()));
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const seen = new Set<string>();
  for (const file of files) {
    if (!file.name || /[\\/\0]/.test(file.name) || file.name === '..' || seen.has(file.name))
      throw Error('Nombre de archivo ZIP inválido o repetido.');
    seen.add(file.name);
    const name = encoder.encode(file.name);
    const bytes = file.data instanceof Blob ? new Uint8Array(await file.data.arrayBuffer()) : new Uint8Array(file.data);
    if (name.length > 65535 || offset + bytes.length > 0xffffffff) throw Error('El archivo ZIP es demasiado grande.');
    const crc = crc32(bytes);
    const header = new Uint8Array(30),
      h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x0800, true);
    h.setUint16(10, time, true);
    h.setUint16(12, date, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, bytes.length, true);
    h.setUint32(22, bytes.length, true);
    h.setUint16(26, name.length, true);
    const central = new Uint8Array(46),
      c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, bytes.length, true);
    c.setUint32(24, bytes.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    parts.push(header, name, bytes);
    directory.push(central, name);
    offset += header.length + name.length + bytes.length;
    directorySize += central.length + name.length;
  }
  const end = new Uint8Array(22),
    e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, directorySize, true);
  e.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
