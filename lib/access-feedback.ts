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

type FeedbackVoice = { name: string; lang: string; localService: boolean; default: boolean };
export function preferredSpanishVoice<T extends FeedbackVoice>(voices: T[], online = true): T | undefined {
  const score = (voice: T) => {
    const language = voice.lang.replaceAll('_', '-').toLowerCase();
    return (/natural|neural|premium|enhanced/i.test(voice.name) ? 100 : 0) +
      (/google/i.test(voice.name) ? 40 : 0) +
      (!voice.localService ? 20 : 0) +
      (language === 'es-bo' ? 15 : language === 'es-mx' || language === 'es-419' ? 10 : 0) +
      (voice.default ? 1 : 0);
  };
  return voices
    .filter((voice) => /^es(?:[-_]|$)/i.test(voice.lang) && (online || voice.localService))
    .sort((a, b) => score(b) - score(a))[0];
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
