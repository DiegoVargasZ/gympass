import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { DoorOpen, X } from 'lucide-react';
import { api } from './api';
import { type Bootstrap, type Settings as OrganizationSettings } from '../lib/domain';
import Auth from './Auth';
import Dashboard from './Dashboard';
import { Skeleton } from './ui';
import { startLiveUpdates } from './live-updates';
import AppShell from './AppShell';
import { navigationFor, pageFromHash, sectionsFor } from './navigation';
import SectionTabs from './SectionTabs';
import { setPreferencesUser, setGymAppearance } from './preferences';
import { appearanceSettings } from '../lib/gym-appearance';
import { applyBrand } from './branding';
import {
  accessQueueIdentity,
  flushAccessQueue,
  setAccessQueueIdentity,
  startOfflineQueue,
  useAccessQueue,
} from './offline';

const Attendance = lazy(() => import('./GymVisits'));
const Manage = lazy(() => import('./Manage'));
const Credentials = lazy(() => import('./Credentials'));
const Pos = lazy(() => import('./Pos'));
const People = lazy(() => import('./People'));
const Access = lazy(() => import('./Access'));
const Reports = lazy(() => import('./Reports'));
const Renewals = lazy(() => import('./Renewals'));
const CommandPalette = lazy(() => import('./CommandPalette'));
const Kiosk = lazy(() => import('./Kiosk'));
const StartPlatformKiosk = lazy(() => import('./PlatformKiosk').then(module => ({ default: module.StartPlatformKiosk })));

export default function App({ onLogout }: { onLogout?: () => void } = {}) {
  const queue = useAccessQueue();
  const [commands, setCommands] = useState(false),
    [route, setRoute] = useState(location.hash);
  const [branding, setBranding] = useState<Pick<OrganizationSettings, 'name' | 'brand_color' | 'logo_path'> | null>(
    null,
  );
  const [data, setData] = useState<Bootstrap | null>(null),
    [setup, setSetup] = useState(false),
    [ready, setReady] = useState(false),
    [error, setError] = useState('');
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    initializing = useRef(false),
    sessionGeneration = useRef(0),
    reloadSequence = useRef(0);
  const reloadFlight = useRef<{
    generation: number;
    again: boolean;
    topics: Set<string> | null;
    promise: Promise<void>;
  } | null>(null);
  const lastBootstrap = useRef('');
  const notify = useCallback((message: string, error = false) => {
    setToast({ message, error });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 6000);
  }, []);
  const clearSession = useCallback(() => {
    sessionGeneration.current++;
    lastBootstrap.current = '';
    void setAccessQueueIdentity(null);
    setGymAppearance(null);
    setData(null);
    setCommands(false);
    setToast(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const reload = useCallback((topics?: string[]): Promise<void> => {
    const generation = sessionGeneration.current;
    const existing = reloadFlight.current;
    if (existing?.generation === generation) {
      existing.again = true;
      if (!topics) existing.topics = null;
      else if (existing.topics) topics.forEach((topic) => existing.topics!.add(topic));
      return existing.promise;
    }
    const work = { generation, again: true, topics: topics ? new Set(topics) : null, promise: Promise.resolve() };
    work.promise = (async () => {
      while (work.again && generation === sessionGeneration.current) {
        work.again = false;
        const changed = work.topics ? [...work.topics] : undefined;
        work.topics = new Set<string>();
        const sequence = ++reloadSequence.current;
        const next = await api<Bootstrap>('bootstrap?compact=1');
        if (generation !== sessionGeneration.current || sequence !== reloadSequence.current) return;
        const encoded = JSON.stringify(next);
        if (encoded !== lastBootstrap.current) {
          lastBootstrap.current = encoded;
          void setAccessQueueIdentity(accessQueueIdentity(next));
          setData(next);
        }
        window.dispatchEvent(new CustomEvent('data-reloaded', { detail: { topics: changed } }));
      }
    })().finally(() => {
      if (reloadFlight.current === work) reloadFlight.current = null;
    });
    reloadFlight.current = work;
    return work.promise;
  }, []);
  const initialize = useCallback(async () => {
    if (initializing.current) return;
    initializing.current = true;
    const generation = sessionGeneration.current;
    try {
      const status = await api<{ setupRequired: boolean; user: unknown }>('auth/status');
      if (generation !== sessionGeneration.current) return;
      setSetup(status.setupRequired);
      if (status.user) await reload();
      else clearSession();
      setError('');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setReady(true);
      initializing.current = false;
    }
  }, [clearSession, reload]);
  useEffect(() => {
    void initialize();
    const expired = () => {
      clearSession();
      notify('Tu sesión terminó. Vuelve a iniciar sesión.', true);
    };
    const reset = () => {
      clearSession();
      setSetup(false);
      setBranding(null);
      notify('Datos borrados. Vuelve a entrar con la cuenta del administrador principal.');
    };
    const navigate = (event: HashChangeEvent) => {
      if (document.querySelector('[data-payment-pending="true"]')) {
        history.replaceState(null, '', new URL(event.oldURL).hash || '#dashboard');
        notify('Resuelve la confirmación del cobro pendiente antes de cambiar de pantalla.', true);
        return;
      }
      if (
        document.querySelector('[data-dirty="true"]') &&
        !confirm('Hay cambios sin guardar. ¿Descartarlos y cambiar de pantalla?')
      ) {
        history.replaceState(null, '', new URL(event.oldURL).hash || '#dashboard');
        return;
      }
      setRoute(location.hash);
      setCommands(false);
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (document.querySelector('[data-dirty="true"]')) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('session-expired', expired);
    window.addEventListener('installation-reset', reset);
    window.addEventListener('hashchange', navigate);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('session-expired', expired);
      window.removeEventListener('installation-reset', reset);
      window.removeEventListener('hashchange', navigate);
      window.removeEventListener('beforeunload', beforeUnload);
      if (timer.current) clearTimeout(timer.current);
      void setAccessQueueIdentity(null);
    };
  }, [clearSession, initialize, notify]);
  useEffect(() => {
    const changed = () => {
      void reload().catch(() => {});
    };
    window.addEventListener('activation-changed', changed);
    return () => window.removeEventListener('activation-changed', changed);
  }, [reload]);
  useEffect(() => {
    const reconnect = () => {
      if (document.visibilityState !== 'visible') return;
      if (!data || error) void initialize();
      else void reload().catch(() => {});
    };
    window.addEventListener('online', reconnect);
    window.addEventListener('pageshow', reconnect);
    document.addEventListener('visibilitychange', reconnect);
    const interval = error ? setInterval(reconnect, 10000) : null;
    return () => {
      window.removeEventListener('online', reconnect);
      window.removeEventListener('pageshow', reconnect);
      document.removeEventListener('visibilitychange', reconnect);
      if (interval) clearInterval(interval);
    };
  }, [!!data, error, initialize, reload]);
  useEffect(() => {
    if (!data) return;
    const stopLive = startLiveUpdates((topics) => {
      if (topics && topics.every((topic) => topic === 'alerts')) {
        window.dispatchEvent(new CustomEvent('data-reloaded', { detail: { topics } }));
        return Promise.resolve();
      }
      return reload(topics);
    });
    const stop = startOfflineQueue();
    void flushAccessQueue()
      .then((result) => {
        if (result.sent) void reload().catch(() => {});
      })
      .catch(() => {});
    return () => {
      stopLive();
      stop();
    };
  }, [data?.installation_id, data?.user.id, data?.user.role, reload]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route]);
  useEffect(() => {
    setPreferencesUser(data?.user.email || '');
  }, [data?.user.email]);
  useEffect(() => {
    if (!data) return;
    const editable = data.user.role === 'admin' && !data.platform?.read_only;
    setGymAppearance(data.settings, data.installation_id + ':' + (data.platform?.gym_id || ''), editable ? async change => { await api('settings', 'PATCH', appearanceSettings(change)); } : undefined);
  }, [data?.installation_id, data?.platform?.gym_id, data?.user.role, data?.platform?.read_only, data?.settings.ui_theme, data?.settings.ui_accent, data?.settings.ui_density]);
  useEffect(() => {
    const saved = () => void reload(['settings']).catch(() => {});
    window.addEventListener('appearance-saved', saved);
    return () => { window.removeEventListener('appearance-saved', saved); setGymAppearance(null); };
  }, [reload]);
  useEffect(() => {
    void api<Pick<OrganizationSettings, 'name' | 'brand_color' | 'logo_path'>>('branding')
      .then((value) => {
        setBranding(value);
        applyBrand(value);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (data) {
      setBranding(data.settings);
      applyBrand(data.settings);
    }
  }, [data?.settings.brand_color, data?.settings.logo_path, data?.settings.name]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && data) {
        event.preventDefault();
        if (!commands && document.querySelector('[role="dialog"]')) return;
        setCommands((value) => !value);
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [!!data, commands]);
  if (!ready)
    return (
      <div className="loading-screen">
        <DoorOpen size={36} />
        <Skeleton rows={3} label="Abriendo GymPASS" />
      </div>
    );
  if (error)
    return (
      <div className="loading-screen">
        <h1>No pudimos conectar</h1>
        <p role="alert">{error}</p>
        <p>
          {onLogout
            ? 'Reconectando automáticamente. Comprueba tu conexión a Internet.'
            : /Electron\/|GymPASSConnection\//.test(navigator.userAgent)
              ? 'Reconectando automáticamente con GymPASS en esta computadora. Si el aviso continúa, vuelve a abrir la aplicación; tus datos se conservan.'
              : 'Reconectando automáticamente. Comprueba que GymPASS esté abierto en la computadora que sirve esta página y que su dirección sea accesible.'}
        </p>
        <button className="btn primary" onClick={() => void initialize()}>
          Reintentar
        </button>
      </div>
    );
  if (!data) return <Auth setup={setup} onSuccess={initialize} branding={branding} />;
  if (route.slice(1).split('?')[0] === 'kiosk' && data.user.role !== 'viewer')
    return (
      <Suspense fallback={<Skeleton rows={4} label="Abriendo recepción" />}>
        {data.platform || data.replica?.linked ? <StartPlatformKiosk /> : <Kiosk key={data.installation_id + ':' + data.user.id} data={data} reload={reload} />}
      </Suspense>
    );
  const items = navigationFor(data.user.role),
    requested = pageFromHash(route);
  const active = items.some((item) => item.id === requested) ? requested : 'dashboard';
  const admin = data.user.role === 'admin';
  return (
    <>
      <AppShell
        data={data}
        page={active}
        reload={reload}
        notify={notify}
        onSearch={() => setCommands(true)}
        onLogout={() => {
          clearSession();
          onLogout?.();
        }}
      >
        <main className="main-content" id="main-content" tabIndex={-1} key={route}>
          {data.activation?.state === 'expired' && (
            <p className="error-message" role="alert">
              {data.activation.licenseType === 'monthly'
                ? 'La licencia por meses venció.'
                : 'La prueba de 30 días terminó.'}{' '}
              Tus datos siguen disponibles para consulta. Activa o renueva la licencia en{' '}
              <a href="#settings?tab=system">Sistema</a> para registrar nuevos movimientos.
            </p>
          )}
          {data.activation?.state === 'trial' && (
            <p className="helper" role="status">
              GymPASS en prueba: {data.activation.days} días restantes.{' '}
              <a href="#settings?tab=system">Activar con clave de 8 dígitos</a>
            </p>
          )}
          {data.activation?.state === 'active' &&
            data.activation.licenseType === 'monthly' &&
            data.activation.days <= 7 && (
              <p className="helper" role="status">
                Tu licencia vence en {data.activation.days} días. <a href="#settings?tab=system">Renovar licencia</a>
              </p>
            )}
          {active !== 'access' && !!queue.blocked && (
            <p className="error-message" role="status">
              {queue.blocked} movimientos retenidos en este navegador. Esta sesión no puede reenviarlos.
              {!!queue.legacy && ` ${queue.legacy} no tienen autor verificado y no se enviarán automáticamente.`}
            </p>
          )}
          <SectionTabs sections={sectionsFor(data.user.role)} page={active} />
          <Suspense fallback={<Skeleton rows={4} label="Abriendo pantalla" />}>
            {active === 'dashboard' ? (
              <Dashboard data={data} />
            ) : active === 'people' ? (
              <People data={data} reload={reload} notify={notify} />
            ) : active === 'pos' ? (
              <Pos data={data} reload={reload} notify={notify} />
            ) : active === 'access' ? (
              <Access key={data.installation_id + ':' + data.user.id} data={data} reload={reload} />
            ) : active === 'credentials' ? (
              <Credentials data={data} notify={notify} />
            ) : active === 'renewals' ? (
              <Renewals data={data} reload={reload} notify={notify} />
            ) : active === 'attendance' ? (
              <Attendance data={data} notify={notify} />
            ) : active === 'history' ? (
              <Reports data={data} notify={notify} />
            ) : (
              <Manage page="settings" data={data} reload={reload} notify={notify} admin={admin} />
            )}
          </Suspense>
        </main>
      </AppShell>
      {commands && (
        <Suspense fallback={null}>
          <CommandPalette
            data={data}
            pages={items.map((item) => [item.id, item.label, null] as const)}
            onClose={() => setCommands(false)}
          />
        </Suspense>
      )}
      {toast && (
        <div role={toast.error ? 'alert' : 'status'} className={'toast ' + (toast.error ? 'error' : '')}>
          <span>{toast.message}</span>
          <button className="icon-btn" aria-label="Cerrar aviso" onClick={() => setToast(null)}>
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
}
