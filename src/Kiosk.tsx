import { useCallback, useEffect, useRef, useState } from 'react';
import { CloudOff, Lock, Maximize, Minimize, Users, Settings2, X } from 'lucide-react';
import { type AccessEvent, type Bootstrap, generalAccessId } from '../lib/domain';
import { submitAccess } from './access-submit';
import { accessQueueIdentity, flushAccessQueue, useAccessQueue } from './offline';
import { accessFeedback, prepareAccessVoice, prepareAudio } from './feedback';
import { usePreferences } from './preferences';
import { Field, Form, Modal } from './ui';
import { logoUrl } from './branding';
import ScopedImage from './ScopedImage';
import CameraScanner from './CameraScanner';
import AccessResult from './AccessResult';
import QueueReview from './QueueReview';
import { newRequestId } from './browser';
import { claimScan, useScanCooldown } from './scan-cooldown';
import { api } from './api';

export type KioskTarget = { zone: string; direction: 'auto' };
const pinKey = 'gympass.kiosk.pin';

export function kioskTarget(): KioskTarget {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  return {
    zone: params.get('zone') || '',
    direction: 'auto',
  };
}
function readPin() {
  try {
    return localStorage.getItem(pinKey) || '';
  } catch {
    return '';
  }
}
function writePin(value: string) {
  try {
    if (value) localStorage.setItem(pinKey, value);
    else localStorage.removeItem(pinKey);
  } catch {
    /* A browser without storage simply keeps the kiosk unlocked. */
  }
}

export default function Kiosk({ data, reload, restricted = false }: { data: Bootstrap; reload: () => Promise<void>; restricted?: boolean }) {
  const preferences = usePreferences();
  const queue = useAccessQueue();
  const scanWait = useScanCooldown();
  const zone = data.zones.find((z) => z.id === generalAccessId);
  const [result, setResult] = useState<AccessEvent | null>(null),
    [queued, setQueued] = useState(false),
    [error, setError] = useState(''),
    [fullscreen, setFullscreen] = useState(false),
    [pin, setPin] = useState(readPin),
    [exiting, setExiting] = useState(false),
    [attempt, setAttempt] = useState(''),
    [pinError, setPinError] = useState('');
  const [options, setOptions] = useState(false),
    [registering, setRegistering] = useState(false),
    [mode, setMode] = useState<'camera' | 'reader'>('camera');
  const reader = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false),
    pending = useRef<{ payload: string; id: string } | null>(null),
    alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const original = document.title;
    document.title = 'Acceso automático · ' + data.settings.name;
    return () => {
      document.title = original;
    };
  }, [data.settings.name]);
  useEffect(() => {
    if (mode === 'reader' && !registering && scanWait === 0 && !options && !exiting)
      reader.current?.focus({ preventScroll: true });
  }, [mode, registering, scanWait, options, exiting]);
  useEffect(() => {
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]'),
      original = viewport?.content;
    if (viewport && !viewport.content.includes('viewport-fit')) viewport.content += ',viewport-fit=cover';
    document.body.classList.add('kiosk-active');
    return () => {
      document.body.classList.remove('kiosk-active');
      if (viewport && original !== undefined) viewport.content = original;
    };
  }, []);
  // Keep the tablet awake for as long as the kiosk is open.
  useEffect(() => {
    let sentinel: { release: () => Promise<void>; released: boolean } | null = null;
    let cancelled = false;
    const request = async () => {
      try {
        const lock = (navigator as unknown as { wakeLock?: { request: (type: 'screen') => Promise<typeof sentinel> } })
          .wakeLock;
        if (!lock || cancelled || document.visibilityState !== 'visible') return;
        sentinel = await lock.request('screen');
      } catch {
        /* Screen wake lock is unavailable on this device. */
      }
    };
    void request();
    const resume = () => {
      if (document.visibilityState === 'visible' && (!sentinel || sentinel.released)) void request();
    };
    document.addEventListener('visibilitychange', resume);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', resume);
      void sentinel?.release().catch(() => {});
    };
  }, []);
  useEffect(() => {
    const sync = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  useEffect(() => {
    if (preferences.sound) prepareAccessVoice(preferences.voiceURI);
    const prepare = () => {
      if (preferences.sound) prepareAudio();
    };
    window.addEventListener('pointerdown', prepare);
    window.addEventListener('keydown', prepare);
    return () => {
      window.removeEventListener('pointerdown', prepare);
      window.removeEventListener('keydown', prepare);
    };
  }, [preferences.sound, preferences.voiceURI]);
  useEffect(() => {
    if (!result && !queued) return;
    const timer = setTimeout(() => {
      setResult(null);
      setQueued(false);
    }, 5000);
    return () => clearTimeout(timer);
  }, [result, queued]);

  const register = useCallback(
    async (code: string) => {
      if (inFlight.current) return;
      if (!zone) {
        const reason = new Error('No hay zonas configuradas.');
        setError(reason.message);
        throw reason;
      }
      const body = { zone_id: zone.id, direction: 'auto', code },
        payload = JSON.stringify(body);
      if (pending.current?.payload !== payload) {
        claimScan();
        pending.current = { payload, id: newRequestId() };
      }
      inFlight.current = true;
      setRegistering(true);
      setResult(null);
      setQueued(false);
      setError('');
      try {
        const outcome = await submitAccess(body, pending.current.id, {
          zoneName: zone.name,
          identity: accessQueueIdentity(data),
        });
        pending.current = null;
        if (!alive.current) return;
        if (reader.current) reader.current.value = '';
        if (outcome.queued) {
          setQueued(true);
          return;
        }
        setResult(outcome.event);
        void accessFeedback(!!outcome.event.allowed, preferences.sound, preferences.vibration, outcome.event.direction, outcome.event.person_name, preferences);
        void reload().catch(() => {});
      } catch (reason) {
        if (alive.current) setError((reason as Error).message);
        throw reason;
      } finally {
        inFlight.current = false;
        if (alive.current) setRegistering(false);
      }
    },
    [
      zone?.id,
      zone?.name,
      preferences.sound,
      preferences.vibration,
      preferences.voiceURI,
      preferences.voiceGender,
      preferences.voiceRate,
      reload,
      data.installation_id,
      data.user.id,
      data.user.role,
    ],
  );

  function leave() {
    if (restricted) {
      void api('platform/logout', 'POST').then(() => location.assign(location.pathname)).catch(reason => setError(reason.message));
      return;
    }
    if (!pin) {
      writePin('');
      location.hash = '#access';
      return;
    }
    setExiting(true);
    setAttempt('');
    setPinError('');
  }
  const inside = zone ? zone.inside : 0;
  const canFullscreen =
    !!document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === 'function';

  return (
    <main className="kiosk" aria-label="Acceso automático">
      <header className="kiosk-bar">
        <div className="kiosk-identity">
          {data.settings.logo_path ? (
            <ScopedImage src={logoUrl(data.settings.logo_path)} alt={'Logo de ' + data.settings.name} />
          ) : (
            <img src="/gympass-mark.svg" alt="GymPASS" />
          )}
          <div>
            <h1>Acceso automático</h1>
            <small>
              {data.settings.name} · {zone?.name || 'Acceso general'}
            </small>
          </div>
        </div>
        <div className="kiosk-count" aria-label={`${inside} personas dentro`}>
          <Users size={18} />
          <strong>{inside}</strong>
          <small>dentro</small>
        </div>
        <div className="kiosk-tools">
          <button
            className="icon-btn"
            type="button"
            aria-label="Opciones de acceso automático"
            onClick={() => {
              setOptions(true);
              setPinError('');
            }}
          >
            <Settings2 size={21} />
          </button>
          <button className="btn secondary kiosk-leave" type="button" onClick={leave} aria-label="Volver a Recepción">
            {pin ? <Lock size={18} /> : <X size={18} />} <span>Salir</span>
          </button>
        </div>
      </header>
      {!!queue.pending && (
        <button
          className="kiosk-queue"
          type="button"
          disabled={queue.sending}
          onClick={() => void flushAccessQueue().then(() => reload().catch(() => {}))}
        >
          <CloudOff size={18} />
          {queue.pending} movimientos de tu cuenta sin enviar · {queue.sending ? 'Enviando…' : 'Reintentar'}
        </button>
      )}
      {!!queue.blocked && (
        <p className="error-message" role="status">
          {queue.blocked} movimientos retenidos. Esta sesión no puede reenviarlos.
          {!!queue.legacy && ` ${queue.legacy} no tienen autor verificado y no se enviarán automáticamente.`}
        </p>
      )}
      {queue.lastError && (
        <p className="error-message" role="alert">
          {queue.lastError}
        </p>
      )}
      {!restricted && <QueueReview />}

      <div className="kiosk-stage">
        <div className="kiosk-camera">
          <div className="kiosk-methods" role="group" aria-label="Método de lectura">
            <button
              type="button"
              className={'btn ' + (mode === 'camera' ? 'primary' : 'secondary')}
              aria-pressed={mode === 'camera'}
              disabled={registering}
              onClick={() => setMode('camera')}
            >
              Cámara
            </button>
            <button
              type="button"
              className={'btn ' + (mode === 'reader' ? 'primary' : 'secondary')}
              aria-pressed={mode === 'reader'}
              disabled={registering}
              onClick={() => setMode('reader')}
            >
              Lector USB
            </button>
          </div>
          {mode === 'camera' ? (
            <CameraScanner
              variant="kiosk"
              autoStart
              resetToken={(zone?.id || '') + ':auto'}
              onScan={register}
              onClear={() => {
                setResult(null);
                setQueued(false);
                setError('');
              }}
            />
          ) : (
            <section className="kiosk-reader" aria-labelledby="kiosk-reader-title">
              <h2 id="kiosk-reader-title">Escanea tu credencial</h2>
              <p>Acerca el QR al lector USB. El registro se envía al leer el código.</p>
              <Form
                label="Registrar credencial"
                disabled={registering || scanWait > 0}
                onSubmit={async (fields) => {
                  const code = String(fields.get('code') || '').trim();
                  if (code) await register(code);
                }}
              >
                <Field label="Código de credencial">
                  <input
                    ref={reader}
                    name="code"
                    autoComplete="off"
                    autoFocus
                    required
                    maxLength={200}
                    placeholder="Esperando lectura del lector USB"
                  />
                </Field>
              </Form>
              <p className="scanner-status" role="status">
                {scanWait > 0
                  ? `Próxima lectura en ${scanWait} s.`
                  : 'Lector listo. También puedes pegar el código y pulsar Enter.'}
              </p>
            </section>
          )}
        </div>
        <div className="kiosk-feedback" aria-live="assertive" aria-atomic="true">
          <AccessResult event={result} queued={queued} pending={registering} variant="kiosk" />
          <p className="kiosk-instructions">Cada lectura registra entrada o salida según la presencia.</p>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>

      {options && (
        <Modal title="Opciones de acceso automático" className="kiosk-options-modal" onClose={() => setOptions(false)}>
          {canFullscreen && (
            <button
              className="btn secondary"
              onClick={() => {
                if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
                else void document.documentElement.requestFullscreen().catch(() => {});
              }}
            >
              {fullscreen ? <Minimize size={19} /> : <Maximize size={19} />}{' '}
              {fullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
            </button>
          )}
          {restricted ? <p>La sesión solo permite leer credenciales. Para volver al panel, pulsa Salir e inicia sesión con tu correo y contraseña.</p> : pin ? (
            <div className="kiosk-pin-summary">
              <Lock size={21} />
              <div>
                <strong>Salida protegida con PIN</strong>
                <p>Se pedirá el PIN al salir de este lector.</p>
              </div>
            </div>
          ) : (
            <form
              className="kiosk-pin-setup"
              onSubmit={(event) => {
                event.preventDefault();
                const value = new FormData(event.currentTarget).get('pin');
                const candidate = String(value || '');
                if (!/^\d{4,8}$/.test(candidate)) {
                  setPinError('Usa entre 4 y 8 dígitos.');
                  return;
                }
                writePin(candidate);
                setPin(candidate);
                setPinError('');
                setOptions(false);
              }}
            >
              <Field
                label="PIN para volver a Recepción"
                hint="Opcional. Entre 4 y 8 dígitos, guardados solo en este dispositivo."
              >
                <input
                  name="pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  pattern="[0-9]{4,8}"
                  required
                  minLength={4}
                  maxLength={8}
                />
              </Field>
              {pinError && (
                <p className="error-message" role="alert">
                  {pinError}
                </p>
              )}
              <div className="button-row">
                <button className="btn primary" type="submit">
                  Proteger con PIN
                </button>
                <button className="btn secondary" type="button" onClick={() => setOptions(false)}>
                  Seguir sin PIN
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}

      {exiting && (
        <Modal title="Volver a Recepción" className="kiosk-exit-modal" onClose={() => setExiting(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (attempt !== pin) {
                setPinError('PIN incorrecto.');
                setAttempt('');
                return;
              }
              writePin('');
              if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
              location.hash = '#access';
            }}
          >
            <Field label="PIN">
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                data-autofocus
                maxLength={8}
                value={attempt}
                onChange={(event) => setAttempt(event.target.value)}
              />
            </Field>
            {pinError && (
              <p className="error-message" role="alert">
                {pinError}
              </p>
            )}
            <div className="button-row">
              <button className="btn primary" type="submit">
                Salir
              </button>
              <button className="btn secondary" type="button" onClick={() => setExiting(false)}>
                Seguir leyendo
              </button>
            </div>
          </form>
        </Modal>
      )}
    </main>
  );
}
