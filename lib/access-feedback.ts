import { reasons, type AccessEvent } from './domain.ts';

export type FeedbackEvent = Pick<AccessEvent, 'allowed' | 'direction' | 'person_name' | 'zone_name' | 'reason'> &
  Partial<Pick<AccessEvent, 'person_id' | 'photo_path' | 'membership'>>;
export const feedbackTiming = { enter: 180, hold: 3520, exit: 300, total: 4000, clear: 5000 } as const;
export function feedbackSound(event: Pick<AccessEvent, 'allowed' | 'direction'>) {
  return !event.allowed ? 'denied' : event.direction === 'exit' ? 'exit' : 'entry';
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
