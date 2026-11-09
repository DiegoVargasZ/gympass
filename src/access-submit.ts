import { api, NetworkError } from './api';
import { captureAccessIdentity, enqueueAccess, type QueuedAccess } from './offline';
import type { QueueIdentity } from './offline-queue';
import type { AccessEvent } from '../lib/domain';

export type AccessSubmission = {
  zone_id: string;
  direction: string;
  code?: string;
  person_id?: string;
  reason?: string;
};
export type AccessOutcome = { event: AccessEvent; queued?: undefined } | { event?: undefined; queued: QueuedAccess };

/**
 * Sends one movement. When the server is unreachable the movement is stored locally with the same
 * request_id, so the later resend is deduplicated by the server instead of creating a second event.
 * The caller owns the request_id: reusing it for an identical payload makes retries idempotent.
 */
export async function submitAccess(
  body: AccessSubmission,
  requestId: string,
  context: { zoneName: string; personName?: string; identity: QueueIdentity },
): Promise<AccessOutcome> {
  const capture = captureAccessIdentity(context.identity);
  try {
    return {
      event: await api<AccessEvent>('access', 'POST', {
        ...body,
        request_id: requestId,
        expected_actor_id: capture.identity.actor_id,
        expected_installation_id: capture.identity.installation_id,
      }),
    };
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error;
    const record: QueuedAccess = {
      request_id: requestId,
      installation_id: capture.identity.installation_id,
      actor_id: capture.identity.actor_id,
      zone_id: body.zone_id,
      zone_name: context.zoneName,
      direction: body.direction,
      code: body.code,
      person_id: body.person_id,
      person_name: context.personName,
      reason: body.reason,
      queued_at: Date.now(),
      attempts: 0,
    };
    const saved = await enqueueAccess(record, capture);
    if (!saved) throw new Error('Sin conexión con el servidor y este navegador no permite guardar la cola local.');
    return { queued: saved };
  }
}

export function directionLabel(direction: string, resolved = false) {
  if (direction === 'entry') return resolved ? 'Entrada registrada' : 'Entrada';
  if (direction === 'exit') return resolved ? 'Salida registrada' : 'Salida';
  return resolved ? 'Movimiento registrado' : 'Automático (alternar)';
}
