export const defaultBrandColor = '#2455a4';
export const brandPresets = [
  { name: 'GymPASS azul', color: defaultBrandColor },
  { name: 'GymPASS turquesa', color: '#60998e' },
  { name: 'Azul tinta', color: '#315b8a' },
  { name: 'Bosque', color: '#356653' },
  { name: 'Petróleo', color: '#2c6770' },
  { name: 'Ciruela', color: '#75516f' },
  { name: 'Terracota', color: '#9a533f' },
  { name: 'Grafito', color: '#515e6d' },
] as const;

export const brandPreviewThemes = [
  { id: 'light', label: 'Claro', background: '#ffffff', surface: '#ffffff', ink: '#000000' },
  { id: 'dark', label: 'Oscuro', background: '#000000', surface: '#101010', ink: '#ffffff' },
] as const;

export function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((offset) => {
      const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export function brandForeground(color: string) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw Error('Usa un color hexadecimal de seis dígitos.');
  return contrast(color, '#ffffff') >= 4.5 ? '#ffffff' : '#000000';
}

/** El azul de la marca. Es el valor de reserva y el que sustituye a los verdes heredados. */

/**
 * Color con el que se dibuja la interfaz. Respeta el matiz que eligió la organización y
 * solo sustituye los verdes que GymPASS trajo por defecto, sin tocar lo guardado.
 */
export function displayBrandColor(color: string) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw Error('Usa un color hexadecimal de seis dígitos.');
  const normalized = color.toLowerCase();
  return ['#00d6a5', '#00e6b0', '#1b654b', '#60998e', '#2563eb'].includes(normalized) ? defaultBrandColor : normalized;
}
