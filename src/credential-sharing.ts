import type { Settings } from '../lib/domain';

export async function prepareCredentialPng(
  id: string,
  settings: Pick<Settings, 'name' | 'brand_color'>,
  signal?: AbortSignal,
) {
  const [{ credentialCardData }, { renderCardPng }] = await Promise.all([
    import('./credential-cards'),
    import('./card-download'),
  ]);
  const card = await credentialCardData(id, settings, signal);
  const blob = await renderCardPng(card);
  const filename = card.document.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'socio';
  return { file: new File([blob], `credencial-${filename}.png`, { type: 'image/png' }), name: card.name };
}

export function canShareCredential(file: File) {
  try {
    return typeof navigator.share === 'function' && !!navigator.canShare?.({ files: [file] });
  } catch {
    return false;
  }
}

export function credentialMessage(name: string, organization: string) {
  return `Hola ${name}, te comparto tu credencial de ${organization}. La tarjeta QR va adjunta en este chat.`;
}

export function credentialWhatsappUrl(phone: string | undefined, name: string, organization: string) {
  const digits = (phone || '').replace(/\D/g, '');
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  const message = credentialMessage(name, organization);
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
