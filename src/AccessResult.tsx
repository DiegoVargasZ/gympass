import { CheckCircle2, CloudOff, LoaderCircle, ScanLine, ShieldX } from 'lucide-react';
import { type AccessEvent } from '../lib/domain';
import { accessPresentation } from '../lib/access-feedback';
import { Avatar } from './ui';
import type { ReactNode } from 'react';

export default function AccessResult({
  event,
  queued,
  pending,
  variant = 'access',
  action,
}: {
  event: AccessEvent | null;
  queued: boolean;
  pending: boolean;
  variant?: 'access' | 'kiosk';
  action?: ReactNode;
}) {
  if (variant === 'access' && !event && !queued && !pending)
    return <p className="access-waiting">Esperando una credencial</p>;
  const presentation = event ? accessPresentation(event) : null;
  const phase = presentation?.phase || (queued ? 'queued' : 'idle');
  const title = event
    ? presentation!.title
    : queued
      ? 'Pendiente de autorización'
      : pending
        ? 'Comprobando credencial'
        : 'Presenta tu credencial del gimnasio';
  const Icon = event ? (event.allowed ? CheckCircle2 : ShieldX) : queued ? CloudOff : pending ? LoaderCircle : ScanLine;
  return (
    <div role="status" className={(variant === 'kiosk' ? 'kiosk-result ' : 'access-result ') + phase}>
      {event?.person_id ? (
        <Avatar name={event.person_name} personId={event.person_id} photoPath={event.photo_path} />
      ) : (
        <Icon
          className={'kiosk-result-symbol ' + (!event && pending && !queued ? 'spin' : '')}
          size={variant === 'kiosk' ? 34 : 44}
        />
      )}
      <div className="kiosk-result-copy">
        {event ? (
          <>
            <strong className="kiosk-result-label">
              <Icon size={20} /> {title}
            </strong>
            <h2>{event.person_name}</h2>
            <p>{presentation!.detail}</p>
            {presentation!.membership && <p>{presentation!.membership}</p>}
          </>
        ) : (
          <>
            <h2>{title}</h2>
            <p>
              {queued
                ? 'Se comprobará al volver la conexión. Espera la autorización del servidor.'
                : pending
                  ? 'Espera el resultado para dar acceso.'
                  : 'La lectura se registra automáticamente.'}
            </p>
          </>
        )}
      </div>
      {action}
    </div>
  );
}
