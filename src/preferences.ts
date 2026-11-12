import { useSyncExternalStore } from 'react';
import { accentProperties, accentTokens, defaultAccent, normalizeAccent } from '../lib/accent';
import { defaultVoiceSettings, normalizeVoiceSettings, recordedAccessVoice, type VoiceSettings } from '../lib/access-feedback';

export type Preferences = VoiceSettings & {
  theme: 'light' | 'dark';
  density: 'comfortable' | 'compact';
  /** Color de los botones y del menú activo en este dispositivo. */
  accent: string;
  sound: boolean;
  vibration: boolean;
};
const key = 'gympass.preferences';
const preferencesVersion = 4;
let user = '';
const listeners = new Set<() => void>();
function load(): Preferences {
  const defaults: Preferences = { theme: 'light', density: 'comfortable', accent: defaultAccent, sound: false, vibration: false, ...defaultVoiceSettings, voiceURI: recordedAccessVoice };
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '{}') || {};
    const theme =
      saved.theme === 'system'
        ? globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : saved.theme;
    return {
      ...defaults,
      theme: theme === 'dark' ? 'dark' : 'light',
      accent: normalizeAccent(saved.accent),
      sound: saved.sound === true,
      vibration: saved.vibration === true,
      ...normalizeVoiceSettings({
        ...saved,
        voiceURI: typeof saved.voiceURI === 'string' && (saved.version === preferencesVersion || saved.voiceURI !== '')
          ? saved.voiceURI : recordedAccessVoice,
      }),
    };
  } catch {
    return defaults;
  }
}
let preferences = load();
export function applyPreferences() {
  document.documentElement.dataset.theme = preferences.theme;
  document.documentElement.dataset.density = preferences.density;
  const accent = accentTokens(preferences.accent, preferences.theme);
  const style = document.documentElement.style as CSSStyleDeclaration | undefined;
  for (const name of accentProperties) {
    if (accent) style?.setProperty(name, accent[name]);
    else style?.removeProperty(name);
  }
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', preferences.theme === 'dark' ? '#1c2128' : '#ffffff');
}
export function setPreferencesUser(email: string) {
  user = email;
  let density: Preferences['density'] = 'comfortable';
  try {
    if (localStorage.getItem('gympass.density.' + user) === 'compact') density = 'compact';
  } catch {
    /* Storage is optional. */
  }
  preferences = { ...preferences, density };
  applyPreferences();
  listeners.forEach((listener) => listener());
}
export function updatePreferences(change: Partial<Preferences>) {
  preferences = {
    ...preferences,
    ...change,
    ...normalizeVoiceSettings({ ...preferences, ...change }),
    accent: normalizeAccent(change.accent ?? preferences.accent),
  };
  let stored = true;
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        version: preferencesVersion,
        theme: preferences.theme,
        accent: preferences.accent,
        sound: preferences.sound,
        vibration: preferences.vibration,
        voiceURI: preferences.voiceURI,
        voiceGender: preferences.voiceGender,
        voiceRate: preferences.voiceRate,
      }),
    );
    if (change.density) localStorage.setItem('gympass.density.' + user, preferences.density);
  } catch {
    stored = false;
  }
  applyPreferences();
  listeners.forEach((listener) => listener());
  return stored;
}
export function usePreferences() {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    () => preferences,
  );
}
window.addEventListener('gympass-theme', (event) => {
  const theme = (event as CustomEvent).detail;
  if (theme === 'light' || theme === 'dark') updatePreferences({ theme });
});
