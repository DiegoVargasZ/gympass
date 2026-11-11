import { reasons, type AccessEvent } from './domain.ts';

export type FeedbackEvent = Pick<AccessEvent, 'allowed' | 'direction' | 'person_name' | 'zone_name' | 'reason'> &
  Partial<Pick<AccessEvent, 'person_id' | 'photo_path' | 'membership'>>;
export const feedbackTiming = { enter: 180, hold: 3520, exit: 300, total: 4000, clear: 5000 } as const;
export function feedbackSound(event: Pick<AccessEvent, 'allowed' | 'direction'>) {
  return !event.allowed ? 'denied' : event.direction === 'exit' ? 'exit' : 'entry';
}
export function feedbackAnnouncement(direction: string, personName = '') {
  const name = personName.trim().replace(/\s+/g, ' ');
  return `${direction === 'exit' ? 'Saliendo' : 'Entrando'}${name ? `, ${name}` : ''}.`;
}

export type VoiceGender = 'auto' | 'female' | 'male';
export type VoiceSettings = { voiceURI: string; voiceGender: VoiceGender; voiceRate: number };
export const voiceRateLimits = { min: 0.5, max: 3, step: 0.01 } as const;
export const defaultVoiceSettings: VoiceSettings = { voiceURI: '', voiceGender: 'auto', voiceRate: 0.98 };
export function normalizeVoiceSettings(value: Partial<VoiceSettings>): VoiceSettings {
  return {
    voiceURI: typeof value.voiceURI === 'string' ? value.voiceURI : '',
    voiceGender: value.voiceGender === 'female' || value.voiceGender === 'male' ? value.voiceGender : 'auto',
    voiceRate: typeof value.voiceRate === 'number' && Number.isFinite(value.voiceRate)
      ? Math.max(voiceRateLimits.min, Math.min(voiceRateLimits.max, value.voiceRate)) : defaultVoiceSettings.voiceRate,
  };
}

type FeedbackVoice = { name: string; lang: string; localService: boolean; default: boolean; voiceURI?: string };
export function voiceIdentity(voice: FeedbackVoice) {
  return voice.voiceURI || `${voice.lang}:${voice.name}`;
}
export function voiceGender(voice: FeedbackVoice): VoiceGender {
  // Web Speech has no gender field. Classify known Spanish voices; leave other names unspecified.
  const name = voice.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/(?:multilingual)?neural\b/g, ' ').replaceAll('_', ' ');
  if (/\b(female|femenina|dalia|sofia|elena|catalina|salome|maria|belkys|ramona|marta|beatriz|camila|carlota|conchita|helena|hilda|laura|lucia|lupe|mia|monica|paloma|paulina|penelope|sabina|ximena)\b/.test(name)) return 'female';
  if (/\b(male|masculina|marcelo|tomas|lorenzo|gonzalo|juan|manuel|emilio|enric|alonso|alvaro|andres|carlos|cecilio|gerardo|javier|jeronimo|jorge|julio|leon|luis|luciano|mateo|miguel|pablo|paco|rafael|raul|rodrigo|rogelio|roberto|diego)\b/.test(name)) return 'male';
  return 'auto';
}
export function isNaturalVoice(voice: FeedbackVoice) {
  return /natural|neural|premium|enhanced/i.test(voice.name);
}
export function preferredSpanishVoice<T extends FeedbackVoice>(voices: T[], online = true, choice: Partial<VoiceSettings> = {}): T | undefined {
  const score = (voice: T) => {
    const language = voice.lang.replaceAll('_', '-').toLowerCase();
    return (isNaturalVoice(voice) ? 100 : 0) +
      (/google/i.test(voice.name) ? 40 : 0) +
      (!voice.localService ? 20 : 0) +
      (language === 'es-bo' ? 15 : language === 'es-mx' || language === 'es-419' ? 10 : 0) +
      (voice.default ? 1 : 0);
  };
  const available = voices.filter((voice) => /^es(?:[-_]|$)/i.test(voice.lang) && (online || voice.localService));
  const matching = choice.voiceGender && choice.voiceGender !== 'auto'
    ? available.filter((voice) => voiceGender(voice) === choice.voiceGender) : available;
  const selected = choice.voiceURI && matching.find((voice) => voiceIdentity(voice) === choice.voiceURI);
  if (selected) return selected;
  return (matching.length ? matching : available).sort((a, b) => score(b) - score(a))[0];
}
export function accessPresentation(event: FeedbackEvent) {
  return {
    phase: event.allowed ? 'allowed' : 'denied',
    color: event.allowed ? '#2e7d4f' : '#b3261e',
    title: !event.allowed
      ? 'Acceso denegado'
      : event.direction === 'exit'
        ? 'Salida registrada'
        : event.direction === 'entry'
          ? 'Entrada registrada'
          : 'Movimiento registrado',
    name: event.person_name,
    initials: event.person_name
      .split(' ')
      .filter(Boolean)
      .map((word) => word[0])
      .slice(0, 2)
      .join('')
      .toUpperCase(),
    detail: [event.zone_name, reasons[event.reason] || event.reason].filter(Boolean).join(' · '),
    membership: event.membership?.managed
      ? `${event.membership.valid_until ? `Plan vigente hasta ${event.membership.valid_until} · ` : ''}${event.membership.sessions_remaining} sesiones disponibles`
      : '',
  };
}
