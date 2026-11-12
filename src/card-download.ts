import { cardSvg, cardSheetSvg, cardSheetPages, cardDimensions, type CardData } from '../lib/card';
import { platformFetch } from './platform-context';
import './native-files';

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'credencial';
}
export async function saveBlob(blob: Blob, filename: string) {
  if (window.__gympassSaveBlob) return window.__gympassSaveBlob(blob, filename);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Fetches a person's photo and inlines it as a data URI. The card has to be self-contained:
 * an <image href="/api/..."> inside an SVG is not loaded when that SVG is rasterised.
 */
export function inlinePhoto(personId: string): Promise<string | null> {
  return inlineImage(`people/${encodeURIComponent(personId)}/photo`);
}
async function inlineImage(path: string): Promise<string | null> {
  try {
    const response = await platformFetch(path);
    if (!response.ok) return null;
    const blob = await response.blob();
    if (blob.size > 2 * 1024 * 1024) return null;
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

const logos = new Map<string, Promise<string | null>>();
/** The gym logo as a data URI, fetched once per uploaded file so a batch of cards reuses it. */
export function inlineLogo(logoPath: string): Promise<string | null> {
  let logo = logos.get(logoPath);
  if (!logo) {
    logo = inlineImage('branding/logo?v=' + encodeURIComponent(logoPath));
    logos.clear();
    logos.set(logoPath, logo);
    void logo.then((value) => {
      if (!value && logos.get(logoPath) === logo) logos.delete(logoPath);
    });
  }
  return logo;
}

export function downloadCardSvg(card: CardData) {
  return saveBlob(new Blob([cardSvg(card)], { type: 'image/svg+xml' }), `credencial-${safeName(card.document)}.svg`);
}

/** Rasterises the card. `scale` 2 gives roughly 600 dpi on a CR80 badge. */
export async function renderCardPng(card: CardData, scale = 2): Promise<Blob> {
  const size = cardDimensions(card);
  const svg = cardSvg(card);
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(Error('No se pudo preparar la imagen de la credencial.'));
    });
    image.src = url;
    await loaded;
    if (typeof OffscreenCanvas !== 'undefined')
      try {
        const canvas = new OffscreenCanvas(size.width * scale, size.height * scale);
        const context = canvas.getContext('2d');
        if (!context) throw Error('No se pudo preparar el lienzo de la tarjeta.');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return await canvas.convertToBlob({ type: 'image/png' });
      } catch {
        /* Some Android WebViews expose OffscreenCanvas without PNG conversion. */
      }
    const canvas = document.createElement('canvas');
    canvas.width = size.width * scale;
    canvas.height = size.height * scale;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!png) throw Error('No se pudo generar la imagen de la tarjeta.');
    return png;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function downloadCardPng(card: CardData, scale = 2) {
  await saveBlob(await renderCardPng(card, scale), `credencial-${safeName(card.document)}.png`);
}

export function downloadCardSheet(cards: CardData[]) {
  if (!cards.length) throw Error('Selecciona al menos una credencial.');
  return saveBlob(new Blob([cardSheetSvg(cards)], { type: 'image/svg+xml' }), `credenciales-${cards.length}.svg`);
}

/** Opens the sheet in a new window and triggers the browser's print dialog. */
export function printCardSheet(cards: CardData[]) {
  if (!cards.length) throw Error('Selecciona al menos una credencial.');
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const document_ = frame.contentDocument!;
  document_.open();
  document_.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>Credenciales</title>` +
      `<style>@page{size:A4;margin:0}body{margin:0}body>svg{display:block;width:210mm;height:297mm;break-after:page}body>svg:last-child{break-after:auto}</style></head>` +
      `<body>${cardSheetPages(cards).join('')}</body></html>`,
  );
  document_.close();
  const run = async () => {
    await Promise.all(Array.from(document_.images, (image) => image.decode().catch(() => {})));
    await new Promise<void>((resolve) => frame.contentWindow!.requestAnimationFrame(() => resolve()));
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 60000);
  };
  if (document_.readyState === 'complete') run();
  else frame.onload = run;
}
