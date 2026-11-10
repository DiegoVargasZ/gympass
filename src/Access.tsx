import { useEffect, useRef, useState } from 'react';
import { CloudOff, Monitor } from 'lucide-react';
import { type AccessEvent, type Bootstrap, generalAccessId } from '../lib/domain';
import { EventTable, Field, Form, Badge } from './ui';
import { usePreferences } from './preferences';
import { accessFeedback, prepareAudio } from './feedback';
import { submitAccess } from './access-submit';
import { accessQueueIdentity, flushAccessQueue, useAccessQueue } from './offline';
import QueueReview from './QueueReview';
import CameraScanner from './CameraScanner';
import AccessResult from './AccessResult';
import PersonPicker from './PersonPicker';
import { newRequestId } from './browser';
import { claimScan, useScanCooldown } from './scan-cooldown';
import GymPresence from './GymPresence';

export default function Access({ data, reload }: { data: Bootstrap; reload: () => Promise<void> }) {
  const preferences = usePreferences();
  const queue = useAccessQueue();
  const scanWait = useScanCooldown();
  const initialPerson = new URLSearchParams(location.hash.split('?')[1]).get('person') || '';
  const [mode, setMode] = useState<'camera' | 'reader' | 'manual'>(
      initialPerson
        ? 'manual'
        : new URLSearchParams(location.hash.split('?')[1]).get('mode') === 'reader'
          ? 'reader'
          : 'camera',
    ),
    [result, setResult] = useState<AccessEvent | null>(null),
    [queued, setQueued] = useState<{ direction: string; zone_name: string } | null>(null),
    [loadError, setLoadError] = useState(''),
    [busy, setBusy] = useState(false);
  const [zone, setZone] = useState(() => {
    const requested = new URLSearchParams(location.hash.split('?')[1]).get('zone');
    return data.zones.some((item) => item.id === requested) ? requested! : generalAccessId;
  });
  const zoneName = data.zones.find((item) => item.id === zone)?.name || 'Acceso general';
  const code = useRef<HTMLInputElement>(null),
    resultButton = useRef<HTMLButtonElement>(null),
    pending = useRef<{ payload: string; id: string } | null>(null),
    inFlight = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    if (!result) return;
    const previous = code.current || document.querySelector<HTMLElement>('.access-panel .tabs .selected');
    resultButton.current?.focus({ preventScroll: true });
    const timer = setTimeout(() => setResult(null), 5000);
    return () => {
      clearTimeout(timer);
      requestAnimationFrame(() => {
        if (previous?.isConnected) previous.focus({ preventScroll: true });
      });
    };
  }, [result]);
  useEffect(() => {
    if (!queued) return;
    const timer = setTimeout(() => setQueued(null), 5000);
    return () => clearTimeout(timer);
  }, [queued]);
  useEffect(() => {
    const prepare = () => {
      if (preferences.sound) prepareAudio();
    };
    window.addEventListener('pointerdown', prepare);
    window.addEventListener('keydown', prepare);
    return () => {
      window.removeEventListener('pointerdown', prepare);
      window.removeEventListener('keydown', prepare);
    };
  }, [preferences.sound]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function register(fields: Record<string, unknown>) {
    if (inFlight.current) throw Error('Espera a que termine el registro actual.');
    const body = { ...fields, zone_id: zone, direction: 'auto' },
      payload = JSON.stringify(body);
    if (pending.current?.payload !== payload) {
      if (fields.code) claimScan();
      pending.current = { payload, id: newRequestId() };
    }
    inFlight.current = true;
    setBusy(true);
    setResult(null);
    setQueued(null);
    try {
      const outcome = await submitAccess(body, pending.current.id, { zoneName, identity: accessQueueIdentity(data) });
      pending.current = null;
      if (outcome.queued) {
        if (alive.current) {
          setQueued({ direction: outcome.queued.direction, zone_name: outcome.queued.zone_name });
          if (code.current) {
            code.current.value = '';
            code.current.focus();
          }
        }
        return;
      }
      const event = outcome.event;
      if (alive.current) {
        setResult(event);
        accessFeedback(!!event.allowed, preferences.sound, preferences.vibration, event.direction, event.person_name, preferences);
        if (code.current) {
          code.current.value = '';
          code.current.focus();
        }
      }
      void reload().catch(() => {
        if (alive.current)
          setLoadError('El movimiento se registró, pero no pudimos actualizar la lista. Pulsa Actualizar datos.');
      });
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Recepción</h1>
          <p>Cada lectura registra entrada o salida según la presencia.</p>
        </div>
        <div className="heading-actions">
          <a className="btn secondary" href={'#kiosk?zone=' + encodeURIComponent(zone)}>
            <Monitor size={17} /> Acceso automático
          </a>
          <Badge tone="blue">Entrada / salida automática</Badge>
        </div>
      </div>
      {!!queue.pending && (
        <div className="queue-banner" role="status">
          <CloudOff size={18} />
          <div>
            <strong>
              {queue.pending} {queue.pending === 1 ? 'movimiento de tu cuenta' : 'movimientos de tu cuenta'} sin enviar
            </strong>
            <small>
              {queue.sending
                ? 'Enviando a la base de datos…'
                : 'Se reenviarán al recuperar la conexión con esta misma cuenta. No se duplicarán.'}
            </small>
          </div>
          <button
            className="btn small secondary"
            type="button"
            disabled={queue.sending}
            onClick={() => void flushAccessQueue().then(() => reload().catch(() => {}))}
          >
            Reintentar ahora
          </button>
        </div>
      )}
      <QueueReview />
      {!!queue.blocked && (
        <p className="error-message" role="status">
          {queue.blocked} movimientos retenidos en este navegador. Pertenecen a otra cuenta o instalación, o no tienen
          autor verificado. No se enviarán con esta sesión.
          {!!queue.legacy &&
            ` ${queue.legacy} son de una versión anterior sin autor verificado y requieren revisión antes de enviarse.`}
        </p>
      )}
      {queue.lastError && (
        <p className="error-message" role="alert">
          No se pudo completar el envío: {queue.lastError}
        </p>
      )}
      <div className="access-grid">
        <section className="panel access-panel">
          <div inert={!!result || !!queued}>
            {data.zones.length > 1 && (
              <Field label="Zona del gimnasio">
                <select value={zone} disabled={busy} onChange={(event) => setZone(event.target.value)}>
                  {data.zones.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                      {item.active ? '' : ' (deshabilitada)'}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <div className="tabs" aria-label="Método de registro">
              {(
                [
                  ['camera', 'Usar la cámara'],
                  ['reader', 'Lector de códigos'],
                  ['manual', 'Buscar a la persona'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  disabled={busy}
                  className={mode === id ? 'selected' : ''}
                  onClick={() => {
                    setMode(id);
                    setResult(null);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {mode === 'camera' ? (
              <CameraScanner
                autoStart={new URLSearchParams(location.hash.split('?')[1]).get('camera') === 'auto'}
                resetToken={zone + ':auto'}
                onScan={(value) => register({ code: value })}
                onClear={() => {
                  setResult(null);
                  setQueued(null);
                }}
              />
            ) : (
              <div className="access-fallback">
                <h2>{mode === 'manual' ? 'Registrar sin código QR' : 'Escanea con el lector de códigos'}</h2>
                <p className="helper">
                  {mode === 'manual'
                    ? 'Escribe el motivo (por ejemplo, olvidó su credencial). Quedará guardado.'
                    : 'Haz clic en el campo y escanea el código; el registro se hace solo.'}
                </p>
                {mode === 'reader' && scanWait > 0 && (
                  <p className="scanner-status" role="status">
                    Próxima lectura en {scanWait} s.
                  </p>
                )}
                <Form
                  label="Registrar movimiento"
                  disabled={mode === 'reader' && scanWait > 0}
                  onSubmit={async (f) => register(Object.fromEntries(f))}
                >
                  {mode === 'manual' ? (
                    <>
                      <PersonPicker initialId={initialPerson} />
                      <Field label="Motivo del registro">
                        <input
                          name="reason"
                          required
                          minLength={5}
                          maxLength={300}
                          placeholder="Ej. Credencial olvidada, identidad verificada"
                        />
                      </Field>
                    </>
                  ) : (
                    <Field label="Código de credencial">
                      <input
                        ref={code}
                        name="code"
                        autoComplete="off"
                        required
                        maxLength={200}
                        placeholder="Escanea o pega el código aquí"
                        autoFocus
                      />
                    </Field>
                  )}
                </Form>
              </div>
            )}
          </div>
          <div aria-live="polite" aria-atomic="true">
            <AccessResult
              event={result}
              queued={!!queued}
              pending={busy}
              action={
                (queued || result) && (
                  <button
                    ref={resultButton}
                    className="btn result-dismiss"
                    type="button"
                    onClick={() => {
                      setQueued(null);
                      setResult(null);
                    }}
                  >
                    Continuar escaneando
                  </button>
                )
              }
            />
          </div>
        </section>
      </div>
      <GymPresence data={data} />
      {loadError && (
        <p className="error-message" role="alert">
          {loadError}
        </p>
      )}
      <section className="panel">
        <div className="panel-heading">
          <h2>Movimientos recientes</h2>
        </div>
        <EventTable events={data.events} timezone={data.settings.timezone} />
      </section>
    </>
  );
}
