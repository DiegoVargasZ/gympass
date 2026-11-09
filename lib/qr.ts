// QR Model 2, version 4, level M, byte mode. Maximum payload: 62 bytes.
// 64 data codewords: two blocks of 32 data + 18 Reed–Solomon codewords, interleaved.
// Fixed version keeps this encoder small; Reed–Solomon ECC and all function patterns are real.
export function qrMatrix(value: string): boolean[][] {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > 62) throw Error('La credencial excede la capacidad del QR.');
  const bits: number[] = [];
  const append = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  append(4, 4);
  append(bytes.length, 8);
  for (const b of bytes) append(b, 8);
  append(0, Math.min(4, 512 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0));
  while (data.length < 64) data.push(data.length % 2 === Math.ceil(bits.length / 8) % 2 ? 0xec : 0x11);
  const mul = (a: number, b: number) => {
    let r = 0;
    for (let i = 7; i >= 0; i--) {
      r = (r << 1) ^ ((r >>> 7) * 0x11d);
      r ^= ((b >>> i) & 1) * a;
    }
    return r;
  };
  let generator = [1];
  let root = 1;
  for (let i = 0; i < 18; i++) {
    const next = Array(generator.length + 1).fill(0);
    for (let j = 0; j < generator.length; j++) {
      next[j] ^= generator[j];
      next[j + 1] ^= mul(generator[j], root);
    }
    generator = next;
    root = mul(root, 2);
  }
  const blocks = [data.slice(0, 32), data.slice(32)];
  const ecc = blocks.map((block) => {
    const rem = Array(18).fill(0);
    for (const b of block) {
      const factor = b ^ rem.shift()!;
      rem.push(0);
      for (let j = 0; j < 18; j++) rem[j] ^= mul(generator[j + 1], factor);
    }
    return rem;
  });
  const interleaved = [blocks, ecc].flatMap((group) =>
    group[0].flatMap((_, index) => group.map((block) => block[index])),
  );
  const stream = interleaved.flatMap((b) => Array.from({ length: 8 }, (_, i) => (b >>> (7 - i)) & 1));
  const n = 33,
    m = Array.from({ length: n }, () => Array(n).fill(false)),
    reserved = Array.from({ length: n }, () => Array(n).fill(false));
  const set = (x: number, y: number, v: boolean) => {
    if (x >= 0 && y >= 0 && x < n && y < n) {
      m[y][x] = v;
      reserved[y][x] = true;
    }
  };
  for (let i = 0; i < n; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [n - 4, 3],
    [3, n - 4],
  ])
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, distance !== 2 && distance !== 4);
      }
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) set(26 + dx, 26 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  const format = 0x5412,
    bit = (i: number) => ((format >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, n - 15 + i, bit(i));
  set(8, n - 8, true);
  let cursor = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      const up = ((right + 1) & 2) === 0,
        y = up ? n - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (!reserved[y][x]) m[y][x] = ((stream[cursor++] || 0) !== 0) !== ((x + y) % 2 === 0);
      }
    }
  }
  return m;
}
export function qrSvg(value: string) {
  const m = qrMatrix(value);
  let d = '';
  for (let y = 0; y < m.length; y++) for (let x = 0; x < m.length; x++) if (m[y][x]) d += `M${x + 4},${y + 4}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 41 41"><rect width="41" height="41" fill="white"/><path d="${d}" fill="#122d24"/></svg>`;
}
