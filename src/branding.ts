import type { Settings } from '../lib/domain';
import { apiUrl } from './platform-context';
export function logoUrl(path: string | null) {
  return path ? apiUrl('branding/logo?v=' + encodeURIComponent(path)) : undefined;
}
export function applyBrand(_settings: Pick<Settings, 'brand_color'>) {
  document.documentElement.style.removeProperty('--organization-brand');
  document.documentElement.style.removeProperty('--organization-on-brand');
  document.querySelector('link[rel="icon"]')?.setAttribute('href', '/gympass-mark.svg');
}
