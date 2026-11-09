import { qrMatrix } from './qr.ts';
import type { CardData } from './card.ts';
import { contrast } from './branding.ts';
import type { InvitationTheme } from './domain.ts';

export const invitationThemes: Record<
  InvitationTheme,
  { name: string; background: string; ink: string; muted: string; accent: string }
> = {
  midnight: { name: 'Noche elegante', background: '#121e2c', ink: '#fffaf0', muted: '#c2cbd5', accent: '#e7bc75' },
  minimal: { name: 'Clásico claro', background: '#f8f5ed', ink: '#20362e', muted: '#566b60', accent: '#28785a' },
  celebration: { name: 'Celebración', background: '#421c42', ink: '#fff6fa', muted: '#e5c8dc', accent: '#f2a3cc' },
};
type Shape =
  | {
      kind: 'rect';
      x: number;
      y: number;
      width: number;
      height: number;
      fill: string;
      radius?: number;
      alpha?: number;
      stroke?: string;
    }
  | { kind: 'circle'; x: number; y: number; radius: number; fill: string; alpha: number }
  | { kind: 'line'; x: number; y: number; endX: number; endY: number; stroke: string; alpha?: number }
  | {
      kind: 'text';
      x: number;
      y: number;
      value: string;
      size: number;
      fill: string;
      weight?: number;
      serif?: boolean;
      align?: 'left' | 'center' | 'right';
      maxWidth?: number;
    }
  | { kind: 'image'; source: string; x: number; y: number; width: number; height: number; logo?: boolean }
  | { kind: 'qr'; x: number; y: number; size: number; matrix: boolean[][] };

function fit(value: string, max: number) {
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}
export function invitationLines(value: string, max = 22, count = 3) {
  const lines: string[] = [];
  let line = '';
  for (const word of value.match(new RegExp(`\\S{1,${max}}`, 'g')) || []) {
    if (line && line.length + word.length + 1 > max) {
      lines.push(line);
      line = '';
    }
    line += (line ? ' ' : '') + word;
  }
  if (line) lines.push(line);
  return lines.length > count ? [...lines.slice(0, count - 1), fit(lines[count - 1] + '…', max)] : lines;
}
function dateLabel(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return `${match[3]} ${['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'][Number(match[2]) - 1]} ${match[1]}`;
}

/** One drawing description is used by the preview, SVG printing and direct PNG export. */
export function invitationArtwork(card: CardData): Shape[] {
  const theme = invitationThemes[card.theme || 'midnight'] || invitationThemes.midnight;
  const chosen = /^#[a-f\d]{6}$/i.test(card.accent || '') ? card.accent! : theme.accent;
  const accent = contrast(chosen, theme.background) >= 4.5 ? chosen : theme.accent;
  const background = /^data:image\/(?:png|webp|jpeg);base64,[a-z\d+/=]+$/i.test(card.background || '')
    ? card.background
    : null;
  const shapes: Shape[] = [{ kind: 'rect', x: 0, y: 0, width: 638, height: 1012, fill: theme.background }];
  if (background) {
    const ratio = Math.max(0.01, card.background_ratio || 638 / 1012),
      zoom = Math.min(3, Math.max(1, card.background_zoom || 1));
    const height = Math.max(1012, 638 / ratio) * zoom,
      width = height * ratio;
    shapes.push(
      {
        kind: 'image',
        source: background,
        x: ((638 - width) * (card.background_x ?? 50)) / 100,
        y: ((1012 - height) * (card.background_y ?? 50)) / 100,
        width,
        height,
      },
      {
        kind: 'rect',
        x: 0,
        y: 0,
        width: 638,
        height: 644,
        fill: theme.background,
        alpha: Math.max(0.7, Math.min(0.98, card.background_shade ?? (card.theme === 'minimal' ? 0.92 : 0.84))),
      },
    );
  } else
    shapes.push(
      { kind: 'circle', x: 600, y: 96, radius: 215, fill: accent, alpha: 0.07 },
      { kind: 'circle', x: 10, y: 650, radius: 210, fill: accent, alpha: 0.06 },
    );
  shapes.push({
    kind: 'rect',
    x: 22,
    y: 22,
    width: 594,
    height: 968,
    fill: 'transparent',
    radius: 26,
    stroke: accent,
    alpha: 0.4,
  });
  const text = (
    value: string,
    x: number,
    y: number,
    size: number,
    fill = theme.ink,
    weight = 400,
    extra: Partial<Extract<Shape, { kind: 'text' }>> = {},
  ) => shapes.push({ kind: 'text', value, x, y, size, fill, weight, ...extra });
  text(fit(card.organization.toUpperCase(), 36), 52, 76, 17, theme.muted, 600, { maxWidth: 430 });
  if (/^data:image\/(?:png|webp);base64,[a-z\d+/=]+$/i.test(card.logo_data || ''))
    shapes.push({ kind: 'image', source: card.logo_data!, x: 532, y: 90, width: 44, height: 44, logo: true });
  text(card.ticket_number ? '#' + card.ticket_number : 'INVITACIÓN', 586, 76, 14, accent, 700, {
    align: 'right',
    maxWidth: 130,
  });
  text('ESTÁS INVITADO', 52, 128, 13, accent, 700);
  invitationLines(card.name, 23, 3).forEach((line, index) =>
    text(line, 50, 190 + index * 49, 46, theme.ink, 600, { serif: card.theme !== 'celebration', maxWidth: 538 }),
  );
  shapes.push({ kind: 'line', x: 52, y: 316, endX: 586, endY: 316, stroke: accent, alpha: 0.5 });
  text('PARA', 52, 350, 12, accent, 700);
  invitationLines(card.guest || 'Un invitado especial', 27, 2).forEach((line, index) =>
    text(line, 52, 391 + index * 36, 31, theme.ink, 600, { maxWidth: 534 }),
  );
  invitationLines(card.note || 'Te esperamos para compartir un momento especial.', 52, 2).forEach((line, index) =>
    text(line, 52, 465 + index * 24, 18, theme.muted, 400, { maxWidth: 534 }),
  );
  text('FECHA', 52, 535, 12, accent, 700);
  text(dateLabel(card.valid_on || card.expires || ''), 52, 571, 27, theme.ink, 650);
  text('HORA', 586, 535, 12, accent, 700, { align: 'right' });
  text(card.event_time || 'TODO EL DÍA', 586, 571, 21, theme.ink, 600, { align: 'right', maxWidth: 200 });
  text(fit(card.location || 'Una celebración para recordar', 46), 52, 613, 20, theme.muted, 400, { maxWidth: 534 });
  shapes.push({ kind: 'rect', x: 30, y: 644, width: 578, height: 334, radius: 24, fill: '#ffffff' });
  shapes.push({ kind: 'qr', x: 175, y: 655, size: 288, matrix: qrMatrix(card.code) });
  text(
    card.access_mode === 'reentry' ? 'ENTRADAS Y SALIDAS · VÁLIDA TODO EL DÍA' : 'UN INGRESO · QR DE UN SOLO USO',
    319,
    966,
    13,
    '#49596b',
    650,
    { align: 'center', maxWidth: 526 },
  );
  text(fit(card.document, 42), 319, 1003, 11, theme.muted, 400, { align: 'center', maxWidth: 530 });
  return shapes;
}
const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
function qrGeometry(shape: Extract<Shape, { kind: 'qr' }>) {
  const unit = Math.floor(shape.size / (shape.matrix.length + 8));
  const inset = Math.round((shape.size - (shape.matrix.length + 8) * unit) / 2) + 4 * unit;
  return { unit, inset };
}
function svgShape(shape: Shape): string {
  switch (shape.kind) {
    case 'rect':
      return `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" rx="${shape.radius || 0}" fill="${shape.fill}"${shape.stroke ? ` stroke="${shape.stroke}" stroke-width="1.5"` : ''} opacity="${shape.alpha ?? 1}"/>`;
    case 'circle':
      return `<circle cx="${shape.x}" cy="${shape.y}" r="${shape.radius}" fill="${shape.fill}" opacity="${shape.alpha}"/>`;
    case 'line':
      return `<line x1="${shape.x}" y1="${shape.y}" x2="${shape.endX}" y2="${shape.endY}" stroke="${shape.stroke}" opacity="${shape.alpha ?? 1}"/>`;
    case 'image':
      return `<image href="${shape.source}" x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" preserveAspectRatio="${shape.logo ? 'xMidYMid meet' : 'none'}"/>`;
    case 'text': {
      const estimated = Array.from(shape.value).reduce(
        (width, char) =>
          width +
          (/[WM@]/.test(char) ? 0.95 : /[il.,' ]/.test(char) ? 0.3 : /[A-ZÁÉÍÓÚÑ]/.test(char) ? 0.68 : 0.55) *
            shape.size,
        0,
      );
      const sizing =
        shape.maxWidth && estimated > shape.maxWidth
          ? ` textLength="${shape.maxWidth}" lengthAdjust="spacingAndGlyphs"`
          : '';
      return `<text x="${shape.x}" y="${shape.y}" font-family="${shape.serif ? 'Georgia, Times New Roman, serif' : 'Segoe UI, Arial, sans-serif'}" font-size="${shape.size}" font-weight="${shape.weight || 400}" fill="${shape.fill}" text-anchor="${shape.align === 'center' ? 'middle' : shape.align === 'right' ? 'end' : 'start'}"${sizing}>${xml(shape.value)}</text>`;
    }
    case 'qr': {
      const { unit, inset } = qrGeometry(shape);
      let path = '';
      shape.matrix.forEach((row, y) =>
        row.forEach((dark, x) => {
          if (dark) path += `M${x * unit + inset},${y * unit + inset}h${unit}v${unit}h-${unit}z`;
        }),
      );
      return `<g transform="translate(${shape.x},${shape.y})"><rect width="${shape.size}" height="${shape.size}" fill="#ffffff"/><path d="${path}" fill="#142030"/></g>`;
    }
  }
}
export function invitationSvg(card: CardData) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="638" height="1012" viewBox="0 0 638 1012" role="img" aria-label="Invitación de ${xml(card.name)}">${invitationArtwork(card).map(svgShape).join('')}</svg>`;
}
export function drawInvitation(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  card: CardData,
  image?: HTMLImageElement | null,
  logo?: HTMLImageElement | null,
) {
  for (const shape of invitationArtwork(card)) {
    ctx.save();
    switch (shape.kind) {
      case 'rect':
        ctx.globalAlpha = shape.alpha ?? 1;
        ctx.fillStyle = shape.fill;
        ctx.beginPath();
        ctx.roundRect(shape.x, shape.y, shape.width, shape.height, shape.radius || 0);
        ctx.fill();
        if (shape.stroke) {
          ctx.strokeStyle = shape.stroke;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        break;
      case 'circle':
        ctx.globalAlpha = shape.alpha;
        ctx.fillStyle = shape.fill;
        ctx.beginPath();
        ctx.arc(shape.x, shape.y, shape.radius, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'line':
        ctx.globalAlpha = shape.alpha ?? 1;
        ctx.strokeStyle = shape.stroke;
        ctx.beginPath();
        ctx.moveTo(shape.x, shape.y);
        ctx.lineTo(shape.endX, shape.endY);
        ctx.stroke();
        break;
      case 'text':
        ctx.fillStyle = shape.fill;
        ctx.font = `${shape.weight || 400} ${shape.size}px ${shape.serif ? 'Georgia, "Times New Roman", serif' : '"Segoe UI", Arial, sans-serif'}`;
        ctx.textAlign = shape.align || 'left';
        ctx.fillText(shape.value, shape.x, shape.y, shape.maxWidth || 570);
        break;
      case 'image':
        {
          const asset = shape.logo ? logo : image;
          if (asset) {
            ctx.drawImage(asset, shape.x, shape.y, shape.width, shape.height);
          }
        }
        break;
      case 'qr': {
        const { unit, inset } = qrGeometry(shape);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(shape.x, shape.y, shape.size, shape.size);
        ctx.fillStyle = '#142030';
        shape.matrix.forEach((row, y) =>
          row.forEach((dark, x) => {
            if (dark) ctx.fillRect(shape.x + inset + x * unit, shape.y + inset + y * unit, unit, unit);
          }),
        );
        break;
      }
    }
    ctx.restore();
  }
}
