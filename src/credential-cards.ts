import { api } from './api';
import { inlinePhoto } from './card-download';
import { kindLabels, type Settings } from '../lib/domain';
import { displayBrandColor } from '../lib/branding';
import type { CardData } from '../lib/card';

export async function credentialCardData(
  id: string,
  settings: Pick<Settings, 'name' | 'brand_color'>,
  signal?: AbortSignal,
): Promise<CardData> {
  const row = await api<{
    name: string;
    document: string;
    department: string;
    person_kind: string;
    expires: string | null;
    membership_managed?: number;
    sessions_remaining?: number;
    person_id: string;
    photo_path: string | null;
    code: string;
  }>('credentials/' + encodeURIComponent(id) + '/card', 'GET', undefined, signal);
  return {
    name: row.name,
    document: row.document,
    subtitle: row.department || kindLabels[row.person_kind],
    organization: settings.name,
    expires: null,
    access_note: 'Acceso según el plan vigente',
    code: row.code,
    accent: displayBrandColor(settings.brand_color),
    label: 'Credencial permanente',
    photo: row.photo_path ? await inlinePhoto(row.person_id) : null,
  };
}
