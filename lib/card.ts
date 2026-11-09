import { gympassLogo } from './gympass-logo.ts';
import { qrMatrix } from './qr.ts';
import { invitationSvg, invitationLines } from './invitation-art.ts';
import type { InvitationAccess, InvitationTheme } from './domain.ts';

export type CardData = {
  name: string;
  document: string;
  subtitle: string;
  organization: string;
  code: string;
  expires: string | null;
  access_note?: string;
  valid_on?: string;
  /** A data: URI for the person's photo, or null to draw initials instead. */
  photo?: string | null;
  label?: string;
  accent?: string;
  layout?: 'portrait';
  /** Embedded raster image for invitations. */
  background?: string | null;
  background_ratio?: number;
  background_x?: number;
  background_y?: number;
  background_zoom?: number;
  background_shade?: number;
  logo_data?: string;
  guest?: string;
  note?: string;
  location?: string;
  event_time?: string;
  theme?: InvitationTheme;
  access_mode?: InvitationAccess;
  ticket_number?: string;
};

/** All credentials and invitations use the same portrait geometry. */
export const cardSize = { width: 638, height: 1012 };
export const invitationSize = cardSize;
export function cardDimensions(_card: CardData) {
  return cardSize;
}

export function cardBackground(card: CardData) {
  return /^data:image\/(?:png|webp|jpeg);base64,[a-z\d+/=]+$/i.test(card.background || '') ? card.background! : null;
}

function escapeXml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
}
function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}
/** Trims a label so it cannot run past the card edge at the given font size. */
function fit(value: string, maxChars: number) {
  return value.length > maxChars ? value.slice(0, maxChars - 1) + '…' : value;
}

/**
 * A complete, self-contained credential card. Everything is inline — no external fonts, no
 * network — so the same markup renders identically on screen, on paper and inside a PNG.
 */
export function cardSvg(card: CardData) {
  if (card.layout === 'portrait') return invitationSvg(card);
  const { width, height } = cardSize;
  const accent = /^#[\da-f]{6}$/i.test(card.accent || '') ? card.accent! : '#008568';
  const matrix = qrMatrix(card.code);
  const modules = matrix.length;
  const quiet = 4;
  const qrBox = 300;
  const unit = qrBox / (modules + quiet * 2);
  let path = '';
  for (let y = 0; y < modules; y++)
    for (let x = 0; x < modules; x++)
      if (matrix[y][x])
        path += `M${((x + quiet) * unit).toFixed(2)},${((y + quiet) * unit).toFixed(2)}h${unit.toFixed(2)}v${unit.toFixed(2)}h-${unit.toFixed(2)}z`;

  const qrX = (width - qrBox) / 2;
  const qrY = 654;
  const photoSize = 150;
  const photoX = (width - photoSize) / 2;
  const photoY = 176;
  const validity = card.valid_on
    ? `Válida solo el ${card.valid_on}`
    : card.access_note
      ? card.access_note
      : card.expires
        ? `Válida hasta ${card.expires}`
        : 'Sujeta a permisos vigentes';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Credencial de ${escapeXml(card.name)}">
  <defs>
    <clipPath id="photoClip"><circle cx="${width / 2}" cy="${photoY + photoSize / 2}" r="${photoSize / 2}"/></clipPath>
  </defs>
  <rect width="${width}" height="${height}" rx="34" fill="#ffffff"/>
  <rect width="${width}" height="${height}" rx="34" fill="none" stroke="#dfe3e8" stroke-width="2"/>
  <rect width="${width}" height="128" rx="34" fill="#061426"/>
  <rect y="94" width="${width}" height="34" fill="#061426"/>
  <image x="${width / 2 - 120}" y="16" width="240" height="58" href="${gympassLogo}" aria-label="GymPASS"/>
  <text x="${width / 2}" y="100" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="22" fill="#ffffff" opacity="0.9">${escapeXml(fit(card.organization, 38))}</text>

  ${
    card.photo
      ? `<image href="${escapeXml(card.photo)}" x="${photoX}" y="${photoY}" width="${photoSize}" height="${photoSize}" preserveAspectRatio="xMidYMid slice" clip-path="url(#photoClip)"/>`
      : `<circle cx="${width / 2}" cy="${photoY + photoSize / 2}" r="${photoSize / 2}" fill="#eef1f4"/>
         <text x="${width / 2}" y="${photoY + photoSize / 2 + 20}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="56" font-weight="650" fill="${accent}">${escapeXml(initials(card.name))}</text>`
  }
  <circle cx="${width / 2}" cy="${photoY + photoSize / 2}" r="${photoSize / 2}" fill="none" stroke="#dfe3e8" stroke-width="3"/>

  <text x="${width / 2}" y="378" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="13" font-weight="700" fill="#5b6471" letter-spacing="2.4">${escapeXml(fit((card.label || 'CREDENCIAL').toUpperCase(), 40))}</text>
  ${invitationLines(card.name, 28, 2)
    .map(
      (line, index) =>
        `<text x="${width / 2}" y="${430 + index * 40}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="34" font-weight="700" fill="#16191d">${escapeXml(line)}</text>`,
    )
    .join('')}
  <text x="${width / 2}" y="522" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="24" fill="#5b6471">${escapeXml(fit(card.subtitle, 36))}</text>
  <text x="${width / 2}" y="562" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="25" font-weight="650" fill="#16191d">ID ${escapeXml(fit(card.document, 30))}</text>
  <text x="${width / 2}" y="602" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="20" fill="#5b6471">${escapeXml(validity)}</text>

  <rect x="${qrX - 14}" y="${qrY - 14}" width="${qrBox + 28}" height="${qrBox + 28}" rx="18" fill="#ffffff" stroke="#dfe3e8" stroke-width="2"/>
  <g transform="translate(${qrX},${qrY})"><rect width="${qrBox}" height="${qrBox}" fill="#ffffff"/><path d="${path}" fill="#16191d"/></g>
</svg>`;
}

/** The card as a data: URI, ready for an <img src> or a download link. */
export function cardDataUri(card: CardData) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(cardSvg(card));
}

/** A4 portrait sheet of cards, two per row, for printing a batch at once. */
export function cardSheetSvg(cards: CardData[]) {
  // A4 at ~96 dpi, with a 40px margin and 24px gutter.
  const page = { width: 794, height: 1123, margin: 40, gap: 20 };
  const columns = 2;
  const cardWidth = (page.width - page.margin * 2 - page.gap * (columns - 1)) / columns;
  const cardHeight = Math.max(
    ...cards.map((card) => (cardWidth * cardDimensions(card).height) / cardDimensions(card).width),
    0,
  );
  const rows = Math.floor((page.height - page.margin * 2 + page.gap) / (cardHeight + page.gap));
  const perPage = columns * rows;
  const pages = Math.max(1, Math.ceil(cards.length / perPage));

  let content = '';
  for (let index = 0; index < cards.length; index++) {
    const pageIndex = Math.floor(index / perPage);
    const slot = index % perPage;
    const x = page.margin + (slot % columns) * (cardWidth + page.gap);
    const y = page.margin + Math.floor(slot / columns) * (cardHeight + page.gap) + pageIndex * page.height;
    const inner = cardSvg(cards[index])
      .replace(/^<svg[^>]*>/, '')
      .replace(/<\/svg>$/, '');
    content += `<g transform="translate(${x},${y}) scale(${(cardWidth / cardDimensions(cards[index]).width).toFixed(4)})">${inner}</g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height * pages}" viewBox="0 0 ${page.width} ${page.height * pages}">
  <rect width="${page.width}" height="${page.height * pages}" fill="#ffffff"/>${content}</svg>`;
}

/** Separate A4 pages, so browser printing keeps every card at its intended size. */
export function cardSheetPages(cards: CardData[]) {
  if (!cards.length) return [];
  const ratio = Math.max(...cards.map((card) => cardDimensions(card).height / cardDimensions(card).width));
  const perPage = 2 * Math.floor((1123 - 80 + 20) / (347 * ratio + 20));
  return Array.from({ length: Math.ceil(cards.length / perPage) }, (_, index) =>
    cardSheetSvg(cards.slice(index * perPage, (index + 1) * perPage)),
  );
}
