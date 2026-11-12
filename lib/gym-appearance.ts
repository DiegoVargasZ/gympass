import { defaultAccent, normalizeAccent, accentTokens } from './accent.ts';
import { themePalettes, type ThemePalette } from './theme.ts';

export type GymAppearance = { theme: 'light' | 'dark'; accent: string; density: 'comfortable' | 'compact' };
export const defaultGymAppearance: GymAppearance = { theme: 'light', accent: defaultAccent, density: 'comfortable' };
export const appearanceColumns = [
  { name: 'ui_theme', value: 'light', sql: "TEXT NOT NULL DEFAULT 'light' CHECK(ui_theme IN ('light','dark'))" },
  { name: 'ui_accent', value: defaultAccent, sql: "TEXT NOT NULL DEFAULT '#636b2f' CHECK(length(ui_accent)=7 AND substr(ui_accent,1,1)='#' AND substr(ui_accent,2) NOT GLOB '*[^0-9a-fA-F]*')" },
  { name: 'ui_density', value: 'comfortable', sql: "TEXT NOT NULL DEFAULT 'comfortable' CHECK(ui_density IN ('comfortable','compact'))" },
] as const;
export function gymAppearance(settings: { ui_theme?: unknown; ui_accent?: unknown; ui_density?: unknown }): GymAppearance {
  return { theme: settings.ui_theme === 'dark' ? 'dark' : 'light', accent: normalizeAccent(settings.ui_accent), density: settings.ui_density === 'compact' ? 'compact' : 'comfortable' };
}
export function appearanceSettings(change: Partial<GymAppearance>) {
  return Object.fromEntries(Object.entries(change).filter(([key]) => ['theme', 'accent', 'density'].includes(key)).map(([key, value]) => ['ui_' + key, value]));
}
export function appearanceColors(value: GymAppearance): ThemePalette {
  const colors = themePalettes[value.theme], accent = accentTokens(value.accent, value.theme);
  return accent ? { ...colors, brand: accent['--brand-base'], brandHover: accent['--brand-hover'], brandLight: accent['--brand-100'], brandText: accent['--brand-700'] } : colors;
}
