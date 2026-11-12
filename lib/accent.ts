import { contrast } from './branding.ts';

/** El verde oliva con el que se diseñó la interfaz. Con este valor no se tocan los estilos. */
export const defaultAccent = '#636b2f';

export const accentPresets = [
  { name: 'Verde oliva', color: defaultAccent },
  { name: 'Azul', color: '#2455a4' },
  { name: 'Petróleo', color: '#2c6770' },
  { name: 'Bosque', color: '#356653' },
  { name: 'Ciruela', color: '#75516f' },
  { name: 'Terracota', color: '#9a533f' },
  { name: 'Grafito', color: '#515e6d' },
] as const;

/** Variables CSS que depende del color de acento; se quitan todas al volver al verde oliva. */
export const accentProperties = [
  '--brand-base',
  '--brand-900',
  '--brand-700',
  '--brand-600',
  '--brand-100',
  '--brand-hover',
  '--accent',
  '--focus',
  '--whatsapp',
  '--whatsapp-hover',
  '--camera-guide',
] as const;

/** Superficie del tema oscuro sobre la que se lee el acento como texto o contorno. */
const darkSurface = '#1c2128';

export function normalizeAccent(value: unknown): string {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : defaultAccent;
}

type Hsl = [number, number, number];

function toHsl(hex: string): Hsl {
  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    span = max - min,
    lightness = (max + min) / 2;
  if (!span) return [0, 0, lightness];
  const saturation = span / (1 - Math.abs(2 * lightness - 1));
  const angle = max === r ? ((g - b) / span) % 6 : max === g ? (b - r) / span + 2 : (r - g) / span + 4;
  return [(angle * 60 + 360) % 360, saturation, lightness];
}

function fromHsl([hue, saturation, lightness]: Hsl): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const [r, g, b] =
    hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  const offset = lightness - chroma / 2;
  return '#' + [r, g, b].map((channel) => Math.round((channel + offset) * 255).toString(16).padStart(2, '0')).join('');
}

/** Mezcla `amount` de `top` sobre `base`, ya resuelto: color-mix() no existe en los navegadores antiguos. */
function mix(top: string, base: string, amount: number): string {
  const channel = (hex: string, offset: number) => parseInt(hex.slice(offset, offset + 2), 16);
  return (
    '#' +
    [1, 3, 5]
      .map((offset) => Math.round(channel(top, offset) * amount + channel(base, offset) * (1 - amount)).toString(16).padStart(2, '0'))
      .join('')
  );
}

/** El color elegido, oscurecido lo justo para que el texto blanco de los botones se lea bien. */
export function accentButtonColor(accent: string): string {
  const [hue, saturation, start] = toHsl(normalizeAccent(accent));
  let lightness = start;
  while (lightness > 0 && contrast(fromHsl([hue, saturation, lightness]), '#ffffff') < 5) lightness -= 0.01;
  return fromHsl([hue, saturation, Math.max(0, lightness)]);
}

/**
 * Variables CSS del color de acento para un tema, o null si es el verde oliva original.
 * El tema oscuro necesita además una versión clara para texto y contornos sobre superficies oscuras.
 */
export function accentTokens(accent: string, theme: 'light' | 'dark'): Record<(typeof accentProperties)[number], string> | null {
  if (normalizeAccent(accent) === defaultAccent) return null;
  const base = accentButtonColor(accent);
  const [hue, saturation, lightness] = toHsl(base);
  const hover = fromHsl([hue, saturation, Math.max(0, lightness - 0.06)]);
  if (theme === 'light')
    return {
      '--brand-base': base,
      '--brand-900': fromHsl([hue, saturation, lightness * 0.7]),
      '--brand-700': base,
      '--brand-600': base,
      '--brand-100': mix(base, '#ffffff', 0.09),
      '--brand-hover': hover,
      '--accent': base,
      '--focus': base,
      '--whatsapp': base,
      '--whatsapp-hover': hover,
      '--camera-guide': base,
    };
  let light = lightness;
  while (light < 0.95 && contrast(fromHsl([hue, saturation, light]), darkSurface) < 7) light += 0.01;
  const text = fromHsl([hue, saturation, light]);
  return {
    '--brand-base': base,
    '--brand-900': fromHsl([hue, Math.min(saturation, 0.4) * 0.8, 0.76]),
    '--brand-700': text,
    '--brand-600': text,
    '--brand-100': mix(base, darkSurface, 0.18),
    '--brand-hover': hover,
    '--accent': base,
    '--focus': text,
    '--whatsapp': base,
    '--whatsapp-hover': hover,
    '--camera-guide': text,
  };
}
