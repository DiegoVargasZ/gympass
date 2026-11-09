import { lazy, useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Building2,
  History,
  LogOut,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react';
import BrandLogo from './BrandLogo';
import AppDownloads from './AppDownloads';
import { api } from './api';
import { Empty, Field, Form, Modal, Skeleton } from './ui';
import { setPlatformContext } from './platform-context';
import './styles/platform.css';
const App = lazy(() => import('./App'));
const PlatformKiosk = lazy(() => import('./PlatformKiosk'));
const PlatformMembers = lazy(() => import('./PlatformMembers'));
const PlatformBackups = lazy(() => import('./PlatformBackups'));
const CloudSync = lazy(() => import('./CloudSync'));
const PlatformBilling = lazy(() => import('./PlatformBilling'));
const PlatformBillingSummary = lazy(() =>
  import('./PlatformBilling').then((module) => ({ default: module.PlatformBillingSummary })),
);

type CentralUser = { id: string; email: string; name: string; global_role: 'superadmin' | 'user' };
type Gym = {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended' | 'provisioning';
  role?: string;
  archived: boolean;
  deleted: boolean;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
};
type Status = {
  mode: 'platform' | 'local';
  protocol: number;
  user: CentralUser | null;
  gyms: Gym[];
  kiosk?: { id: string; name: string };
  replica_required?: boolean;
};
type Selection = { gym: Gym; supportToken?: string; expiresAt?: number };
type Audit = {
  id: string | number;
  actor?: string;
  actor_name?: string;
  actor_email?: string;
  action: string;
  gym_id?: string | null;
  entity_id?: string | null;
  created_at: number;
};
type Editor =
  | { kind: 'create' | 'backup' }
  | { kind: 'edit' | 'members' | 'support'; gym: Gym }
  | { kind: 'billing'; gym: { id: string; name: string } };
const statuses = { active: 'Activo', suspended: 'Suspendido', provisioning: 'En preparación' };

function tokenFromHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (params.has('invite')) return { kind: 'invite' as const, token: params.get('invite')! };
  if (params.has('recover') || params.has('recovery'))
    return { kind: 'recover' as const, token: params.get('recover') || params.get('recovery')! };
  return null;
}

function mayLeave() {
  return (
    !document.querySelector('[data-dirty="true"]') ||
    confirm('Hay cambios sin guardar. ¿Descartarlos y cambiar de gimnasio?')
  );
}

function writeGymUrl(gymId?: string) {
  const url = new URL(location.origin + location.pathname + location.search + location.hash);
  if (gymId) url.searchParams.set('gym', gymId);
  else url.searchParams.delete('gym');
  history.replaceState(null, '', url.pathname + url.search + (gymId ? '#dashboard' : ''));
}

export default function Platform() {
  const [mode, setMode] = useState<'loading' | 'local' | 'platform' | 'error' | 'link'>('loading');
  const [status, setStatus] = useState<Status | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [audit, setAudit] = useState<Audit[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [linkToken, setLinkToken] = useState(tokenFromHash);
  const [existingAccount, setExistingAccount] = useState(false);
  const [scope, setScope] = useState<'active' | 'archived' | 'deleted'>('active');
  const [busyGym, setBusyGym] = useState('');
  const [showBilling, setShowBilling] = useState(false);
  const [billingLocked, setBillingLocked] = useState(false);
  const billingPending = useRef(false);
  const [search, setSearch] = useState('');
  const requestSequence = useRef(0);
  const selected = useRef<Selection | null>(null);
  selected.current = selection;

  const enter = useCallback((next: Selection) => {
    setPlatformContext({ gymId: next.gym.id, ...(next.supportToken ? { supportToken: next.supportToken } : {}) });
    setSelection(next);
    setEditor(null);
    setError('');
    writeGymUrl(next.gym.id);
  }, []);

  const refresh = useCallback(
    async (autoOpen = false) => {
      const sequence = ++requestSequence.current;
      try {
        const next = await api<Status>('platform/status' + (scope === 'active' ? '' : '?scope=' + scope));
        if (sequence !== requestSequence.current) return;
        if (next.mode === 'local') {
          setPlatformContext(null);
          setMode(next.replica_required ? 'link' : 'local');
          return;
        }
        if (next.mode !== 'platform' || next.protocol !== 1)
          throw Error('Este servidor necesita una versión compatible de GymPASS.');
        setStatus(next);
        setMode('platform');
        setError('');
        if (autoOpen && next.user?.global_role === 'user' && !tokenFromHash()) {
          const allowed = next.gyms.filter((gym) => gym.status === 'active');
          const requested = new URLSearchParams(location.search).get('gym');
          const gym = allowed.find((item) => item.id === requested) || (allowed.length === 1 ? allowed[0] : undefined);
          if (gym) enter({ gym });
        }
        if (!next.user) {
          setPlatformContext(null);
          setSelection(null);
        }
      } catch (cause) {
        if (sequence !== requestSequence.current) return;
        if (cause && typeof cause === 'object' && 'status' in cause && cause.status === 404) {
          setPlatformContext(null);
          setMode('local');
        } else {
          setError((cause as Error).message);
          setMode((previous) => (previous === 'loading' ? 'error' : previous));
        }
      }
    },
    [enter, scope],
  );

  useEffect(() => {
    void refresh(true);
    const hashChanged = () => {
      setLinkToken(tokenFromHash());
      setExistingAccount(false);
    };
    const expired = () => {
      requestSequence.current++;
      setPlatformContext(null);
      setSelection(null);
      setNotice('Tu acceso terminó. Vuelve a entrar o elige un gimnasio disponible.');
      void refresh(false);
    };
    window.addEventListener('hashchange', hashChanged);
    window.addEventListener('session-expired', expired);
    return () => {
      requestSequence.current++;
      window.removeEventListener('hashchange', hashChanged);
      window.removeEventListener('session-expired', expired);
    };
  }, [refresh]);

  useEffect(() => {
    if (!selection?.expiresAt) return;
    const remaining = selection.expiresAt - Date.now();
    const timer = setTimeout(
      () => {
        setPlatformContext(null);
        setSelection(null);
        writeGymUrl();
        setNotice('El tiempo de soporte terminó. Puedes abrir otra sesión indicando el motivo.');
      },
      Math.max(0, remaining),
    );
    return () => clearTimeout(timer);
  }, [selection?.supportToken, selection?.expiresAt]);

  const leave = async () => {
    if (!mayLeave() || busy) return;
    setBusy(true);
    setError('');
    try {
      if (selected.current?.supportToken)
        await api('platform/support/' + encodeURIComponent(selected.current.supportToken), 'DELETE');
      setPlatformContext(null);
      setSelection(null);
      writeGymUrl();
      await refresh(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    if (!mayLeave() || busy) return;
    setBusy(true);
    setError('');
    try {
      await api('platform/logout', 'POST');
      setPlatformContext(null);
      setSelection(null);
      setEditor(null);
      setAudit(null);
      setScope('active');
      setShowBilling(false);
      setSearch('');
      writeGymUrl();
      await refresh(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const login = async (form: FormData) => {
    await api('platform/login', 'POST', {
      email: form.get('email'),
      password: form.get('password'),
      remember: form.has('remember'),
    });
    await refresh(true);
    setNotice('');
  };

  if (mode === 'loading')
    return (
      <div className="loading-screen">
        <Skeleton rows={3} label="Abriendo GymPASS" />
      </div>
    );
  if (mode === 'local') return <App />;
  if (mode === 'link') return <CloudSync initial />;
  if (status?.kiosk) return <PlatformKiosk gymId={status.kiosk.id} />;
  if (mode === 'error')
    return (
      <main className="loading-screen">
        <h1>No pudimos conectar</h1>
        <p role="alert">{error}</p>
        <button className="btn primary" onClick={() => void refresh(true)}>
          Reintentar
        </button>
      </main>
    );

  const superadmin = status?.user?.global_role === 'superadmin';
  /** Baja o restauración de un gimnasio, con el panel recargado al terminar. */
  async function runOnGym(gym: Gym, work: () => Promise<unknown>) {
    setBusyGym(gym.id);
    setError('');
    try {
      await work();
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyGym('');
    }
  }
  const loginFields = (
    <>
      <Field label="Correo electrónico">
        <input type="email" name="email" autoComplete="username" required maxLength={254} />
      </Field>
      <Field label="Contraseña">
        <input type="password" name="password" autoComplete="current-password" required maxLength={200} />
      </Field>
      <label className="check-inline">
        <input type="checkbox" name="remember" defaultChecked /> Mantener sesión durante 30 días
      </label>
    </>
  );

  if (linkToken || !status?.user)
    return (
      <div className="auth-layout platform-auth">
        <section className="auth-story">
          <a className="brand" href="#">
            <BrandLogo />
          </a>
          <div className="auth-copy">
            <h1>
              Tu gimnasio.
              <br />
              Cada visita cuenta.
            </h1>
            <p>Socios, recepción y visitas en el gimnasio que administras.</p>
          </div>
          <p className="auth-foot">GymPASS / ACCESO AL GIMNASIO</p>
        </section>
        <main className="auth-main">
          <div className="auth-card">
            <span className="auth-icon">
              <ShieldCheck size={24} aria-hidden="true" />
            </span>
            <h2>
              {linkToken?.kind === 'recover'
                ? 'Restablecer contraseña'
                : linkToken
                  ? 'Aceptar invitación'
                  : 'Iniciar sesión'}
            </h2>
            {notice && <p role="status">{notice}</p>}
            {error && (
              <p className="error-message" role="alert">
                {error}
              </p>
            )}
            {linkToken?.kind === 'recover' ? (
              <Form
                label="Guardar nueva contraseña"
                onSubmit={async (form) => {
                  if (form.get('password') !== form.get('confirm')) throw Error('Las contraseñas no coinciden.');
                  await api('platform/recovery/accept', 'POST', {
                    token: linkToken.token,
                    password: form.get('password'),
                  });
                  history.replaceState(null, '', location.pathname);
                  setLinkToken(null);
                  setNotice('Contraseña restablecida. Inicia sesión con tu nueva contraseña.');
                  await refresh(false);
                }}
              >
                <Field label="Nueva contraseña" hint="Entre 6 y 200 caracteres.">
                  <input
                    name="password"
                    type="password"
                    minLength={6}
                    maxLength={200}
                    autoComplete="new-password"
                    required
                  />
                </Field>
                <Field label="Repetir contraseña">
                  <input
                    name="confirm"
                    type="password"
                    minLength={6}
                    maxLength={200}
                    autoComplete="new-password"
                    required
                  />
                </Field>
              </Form>
            ) : linkToken && !existingAccount ? (
              <>
                <p>
                  {status?.user
                    ? 'Acepta con la cuenta ' + status.user.email + '.'
                    : 'Crea tu contraseña para entrar. Si ya tienes una cuenta de GymPASS, inicia sesión primero.'}
                </p>
                <Form
                  label="Aceptar invitación"
                  onSubmit={async (form) => {
                    await api('platform/invitations/accept', 'POST', {
                      token: linkToken.token,
                      ...(status?.user ? {} : { name: form.get('name') || undefined, password: form.get('password') }),
                    });
                    history.replaceState(null, '', location.pathname);
                    setLinkToken(null);
                    setNotice('Invitación aceptada. Ya puedes acceder al gimnasio con tu cuenta.');
                    await refresh(true);
                  }}
                >
                  {!status?.user && (
                    <>
                      <Field label="Tu nombre">
                        <input name="name" autoComplete="name" maxLength={120} />
                      </Field>
                      <Field label="Crea tu contraseña" hint="Entre 6 y 200 caracteres.">
                        <input
                          name="password"
                          type="password"
                          autoComplete="new-password"
                          minLength={6}
                          maxLength={200}
                          required
                        />
                      </Field>
                    </>
                  )}
                </Form>
                {!status?.user && (
                  <button className="text-btn" onClick={() => setExistingAccount(true)}>
                    Ya tengo cuenta: iniciar sesión
                  </button>
                )}
                {status?.user && (
                  <button className="text-btn" onClick={() => void logout()} disabled={busy}>
                    Usar otra cuenta
                  </button>
                )}
              </>
            ) : (
              <>
                {linkToken && <p>Inicia sesión con el correo al que se envió la invitación.</p>}
                <Form
                  label="Iniciar sesión"
                  onSubmit={async (form) => {
                    await login(form);
                    setExistingAccount(false);
                  }}
                >
                  {loginFields}
                </Form>
                <p className="helper">Si olvidaste tu contraseña, solicita ayuda al administrador de tu gimnasio.</p>
                {linkToken && (
                  <button className="text-btn" onClick={() => setExistingAccount(false)}>
                    Volver a la invitación
                  </button>
                )}
              </>
            )}
            {!linkToken && <AppDownloads />}
          </div>
        </main>
      </div>
    );

  if (selection)
    return (
      <div className={'platform-operational' + (selection.supportToken ? ' platform-support' : '')}>
        <div className="platform-context-bar" aria-label="Gimnasio actual">
          <div>
            <BrandLogo />
            <span>
              {selection.supportToken
                ? 'Soporte · ' + status.user.name + (selection.gym.status === 'suspended' ? ' · Solo lectura' : '')
                : status.user.name}
            </span>
          </div>
          <div className="platform-actions">
            {superadmin && <button className="btn secondary" disabled={busy} onClick={() => void leave()}>
              <ArrowLeft size={16} aria-hidden="true" />
              {selection.supportToken ? 'Terminar soporte' : 'Volver a gimnasios'}
            </button>}
            <button className="btn secondary" disabled={busy} onClick={() => void logout()}>
              <LogOut size={16} aria-hidden="true" />
              Cerrar sesión
            </button>
          </div>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
        </div>
        <App
          key={selection.gym.id + ':' + status.user.id + ':' + (selection.supportToken || 'member')}
          onLogout={() => {
            setPlatformContext(null);
            setSelection(null);
            writeGymUrl();
            void refresh(false);
          }}
        />
      </div>
    );

  return (
    <div className="platform-page">
      <header className="platform-header">
        <a className="brand" href="#">
          <BrandLogo />
        </a>
        <div className="platform-actions">
          <span>{status.user.name}</span>
          <button className="btn secondary" disabled={busy} onClick={() => void logout()}>
            <LogOut size={16} aria-hidden="true" />
            Cerrar sesión
          </button>
        </div>
      </header>
      <main className="platform-main" id="main-content">
        <header className="platform-heading">
          <div>
            <h1>{superadmin ? 'Gimnasios' : 'Elige tu gimnasio'}</h1>
            <p>
              {superadmin
                ? 'Administra accesos, usuarios y soporte de la plataforma.'
                : 'Tu cuenta tiene acceso a estos gimnasios.'}
            </p>
          </div>
          <div className="platform-actions">
            <button
              className="btn secondary"
              disabled={busy}
              onClick={() => void refresh(false)}
              aria-label="Actualizar gimnasios"
            >
              <RefreshCw size={16} aria-hidden="true" />
            </button>
            {superadmin && (
              <>
                <button className="btn secondary" onClick={() => setEditor({ kind: 'backup' })}>
                  Copia de plataforma
                </button>
                <button
                  className="btn secondary"
                  aria-pressed={showBilling}
                  onClick={() => setShowBilling((value) => !value)}
                >
                  {showBilling ? 'Ocultar mensualidades' : 'Mensualidades'}
                </button>
                <button
                  className="btn secondary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError('');
                    try {
                      const result = await api<{ audit: Audit[] }>('platform/audit');
                      setAudit(result.audit);
                    } catch (cause) {
                      setError((cause as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <History size={16} aria-hidden="true" />
                  Actividad
                </button>
                <button
                  className="btn primary"
                  onClick={() => {
                    setNotice('');
                    setEditor({ kind: 'create' });
                  }}
                >
                  <Plus size={16} aria-hidden="true" />
                  Crear gimnasio
                </button>
              </>
            )}
          </div>
        </header>
        {notice && (
          <p role="status" className="platform-notice">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="error-message">
            {error}
          </p>
        )}
        {superadmin && showBilling && <PlatformBillingSummary onOpen={(gym) => setEditor({ kind: 'billing', gym })} />}
        <div className="platform-billing-filters">
          <Field label="Buscar gimnasio">
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
          </Field>
          {superadmin && (
            <Field label="Mostrar">
              <select
                value={scope}
                onChange={(event) => setScope(event.target.value as 'active' | 'archived' | 'deleted')}
              >
                <option value="active">Gimnasios en servicio</option>
                <option value="archived">Gimnasios archivados</option>
                <option value="deleted">Gimnasios dados de baja</option>
              </select>
            </Field>
          )}
        </div>
        {!status.gyms.length ? (
          <Empty
            title={
              !superadmin
                ? 'Sin gimnasios disponibles'
                : scope === 'archived'
                  ? 'Sin gimnasios archivados'
                  : scope === 'deleted'
                    ? 'Sin gimnasios dados de baja'
                    : 'Todavía no hay gimnasios'
            }
            text={
              !superadmin
                ? 'Solicita al administrador de tu gimnasio una cuenta con acceso.'
                : scope === 'archived'
                  ? 'Los gimnasios archivados aparecerán aquí y podrán restaurarse.'
                  : scope === 'deleted'
                    ? 'Los gimnasios que des de baja aparecerán aquí con todos sus datos, listos para restaurarse.'
                    : 'Crea un gimnasio y la cuenta de su primer administrador.'
            }
          />
        ) : (
          <div className="platform-gym-list">
            {status.gyms
              .filter((gym) => (gym.name + ' ' + gym.slug).toLocaleLowerCase().includes(search.toLocaleLowerCase()))
              .map((gym) => (
                <section className="panel platform-gym" key={gym.id}>
                  <div className="platform-gym-identity">
                    <Building2 size={24} aria-hidden="true" />
                    <div>
                      <h2>{gym.name}</h2>
                      <p>
                        {superadmin
                          ? gym.slug
                          : gym.role === 'admin'
                            ? 'Administrador'
                            : gym.role === 'operator'
                              ? 'Cajero'
                              : 'Consulta'}
                      </p>
                    </div>
                    <span className={'platform-state platform-state-' + gym.status}>
                      {gym.deleted ? 'Dado de baja' : gym.archived ? 'Archivado' : statuses[gym.status]}
                    </span>
                  </div>
                  <div className="platform-actions">
                    {superadmin && gym.deleted ? (
                      <>
                        <button className="btn secondary" onClick={() => setEditor({ kind: 'billing', gym })}>
                          Cuenta GymPASS
                        </button>
                        <button
                          className="btn primary"
                          disabled={busyGym === gym.id}
                          onClick={() =>
                            void runOnGym(gym, () =>
                              api('platform/gyms/' + encodeURIComponent(gym.id) + '/restore', 'POST'),
                            )
                          }
                        >
                          <RotateCcw size={16} aria-hidden="true" /> {busyGym === gym.id ? 'Restaurando…' : 'Restaurar'}
                        </button>
                      </>
                    ) : superadmin ? (
                      <>
                        <button className="btn secondary" onClick={() => setEditor({ kind: 'edit', gym })}>
                          Editar
                        </button>
                        <button className="btn secondary" onClick={() => setEditor({ kind: 'billing', gym })}>
                          Cuenta GymPASS
                        </button>
                        <button className="btn secondary" onClick={() => setEditor({ kind: 'members', gym })}>
                          <Users size={16} aria-hidden="true" />
                          Usuarios
                        </button>
                        <button
                          className="btn primary"
                          disabled={gym.status === 'provisioning' || gym.archived}
                          onClick={() => setEditor({ kind: 'support', gym })}
                        >
                          Abrir soporte
                        </button>
                        <button
                          className="btn secondary danger"
                          disabled={busyGym === gym.id}
                          onClick={() => {
                            if (
                              !confirm(
                                `¿Dar de baja «${gym.name}»? Saldrá del panel, nadie podrá operarlo y dejará de generar cargos desde el mes siguiente. Sus datos y su historial de cobros se conservan y puedes restaurarlo.`,
                              )
                            )
                              return;
                            void runOnGym(gym, () => api('platform/gyms/' + encodeURIComponent(gym.id), 'DELETE'));
                          }}
                        >
                          <Trash2 size={16} aria-hidden="true" />{' '}
                          {busyGym === gym.id ? 'Dando de baja…' : 'Dar de baja'}
                        </button>
                      </>
                    ) : (
                      <button className="btn primary" disabled={gym.status !== 'active'} onClick={() => enter({ gym })}>
                        Entrar a {gym.name}
                      </button>
                    )}
                  </div>
                </section>
              ))}
          </div>
        )}
        {status.gyms.length > 0 &&
          !status.gyms.some((gym) =>
            (gym.name + ' ' + gym.slug).toLocaleLowerCase().includes(search.toLocaleLowerCase()),
          ) && <Empty title="Sin coincidencias" text="Prueba con otro nombre o identificador." />}
      </main>
      {editor?.kind === 'create' && (
        <Modal title="Crear gimnasio" onClose={() => setEditor(null)}>
          <Form
            label="Crear gimnasio y administrador"
            onCancel={() => setEditor(null)}
            onSubmit={async (form) => {
              const { admin_password_confirmation, ...input } = Object.fromEntries(form);
              if (input.admin_password !== admin_password_confirmation) throw Error('Las contraseñas no coinciden.');
              await api('platform/gyms', 'POST', input);
              setNotice('Gimnasio creado. El administrador ya puede iniciar sesión y crear a su personal.');
              setEditor(null);
              await refresh(false);
            }}
          >
            <Field label="Nombre del gimnasio">
              <input name="name" required minLength={2} maxLength={120} />
            </Field>
            <Field label="Identificador" hint="Letras minúsculas, números y guiones. Ejemplo: gimnasio-centro.">
              <input name="slug" required minLength={2} maxLength={80} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" />
            </Field>
            <Field label="Nombre del primer administrador">
              <input name="admin_name" required maxLength={120} autoComplete="name" />
            </Field>
            <Field label="Correo del administrador">
              <input name="admin_email" type="email" required maxLength={254} autoComplete="email" />
            </Field>
            <Field label="Contraseña del administrador" hint="Entre 6 y 200 caracteres.">
              <input
                name="admin_password"
                type="password"
                autoComplete="new-password"
                required
                minLength={6}
                maxLength={200}
              />
            </Field>
            <Field label="Repetir contraseña">
              <input
                name="admin_password_confirmation"
                type="password"
                autoComplete="new-password"
                required
                minLength={6}
                maxLength={200}
              />
            </Field>
            <p className="helper">
              Entrega el correo y la contraseña al administrador. Podrá gestionar el gimnasio y crear sus usuarios desde
              Configuración.
            </p>
          </Form>
        </Modal>
      )}
      {editor?.kind === 'edit' && (
        <Modal title={'Editar ' + editor.gym.name} onClose={() => setEditor(null)}>
          <Form
            onCancel={() => setEditor(null)}
            onSubmit={async (form) => {
              await api('platform/gyms/' + encodeURIComponent(editor.gym.id), 'PATCH', Object.fromEntries(form));
              setEditor(null);
              await refresh(false);
            }}
          >
            <Field label="Nombre del gimnasio">
              <input name="name" required maxLength={120} defaultValue={editor.gym.name} />
            </Field>
            <Field label="Identificador estable">
              <input readOnly value={editor.gym.slug} />
            </Field>
            <Field label="Contacto de cobros">
              <input name="contact_name" maxLength={120} defaultValue={editor.gym.contact_name} />
            </Field>
            <Field label="Correo de contacto">
              <input name="contact_email" type="email" maxLength={254} defaultValue={editor.gym.contact_email} />
            </Field>
            <Field label="Teléfono de contacto">
              <input name="contact_phone" type="tel" maxLength={120} defaultValue={editor.gym.contact_phone} />
            </Field>
            {editor.gym.status !== 'provisioning' && (
              <Field label="Estado" hint="Suspender bloquea el acceso del gimnasio y conserva sus datos.">
                <select name="status" defaultValue={editor.gym.status}>
                  <option value="active">Activo</option>
                  <option value="suspended">Suspendido</option>
                </select>
              </Field>
            )}
          </Form>
          <Form
            label={editor.gym.archived ? 'Restaurar gimnasio' : 'Archivar gimnasio'}
            onSubmit={async () => {
              if (
                !confirm(
                  editor.gym.archived
                    ? '¿Restaurar este gimnasio? Si está activo, se reanudarán los cargos desde este mes.'
                    : '¿Archivar este gimnasio? Dejará de operar y conservará todos sus datos y su deuda.',
                )
              )
                return;
              await api('platform/gyms/' + encodeURIComponent(editor.gym.id), 'PATCH', {
                archived: !editor.gym.archived,
              });
              setEditor(null);
              await refresh(false);
            }}
          >
            <p className="helper">
              Archivar impide operar, conserva el historial y detiene cargos desde el mes siguiente. Restaurar respeta
              el estado de suspensión.
            </p>
          </Form>
        </Modal>
      )}
      {editor?.kind === 'billing' && (
        <Modal
          title={'Mensualidades · ' + editor.gym.name}
          wide
          protectChanges={!billingLocked}
          onClose={() => {
            if (billingPending.current)
              alert('Hay un pago pendiente de confirmación. Reintenta el mismo pago antes de cerrar la cuenta.');
            else setEditor(null);
          }}
        >
          <PlatformBilling
            key={status.user.id + ':' + editor.gym.id}
            userId={status.user.id}
            gymId={editor.gym.id}
            gymName={editor.gym.name}
            onPendingChange={(pending) => {
              billingPending.current = pending;
              setBillingLocked(pending);
            }}
          />
        </Modal>
      )}
      {editor?.kind === 'members' && (
        <Modal title={'Usuarios de ' + editor.gym.name} wide onClose={() => setEditor(null)}>
          <PlatformMembers gymId={editor.gym.id} superadmin currentUserId={status.user.id} />
        </Modal>
      )}
      {editor?.kind === 'support' && (
        <Modal title={'Soporte · ' + editor.gym.name} onClose={() => setEditor(null)}>
          <p>
            Entrarás con tu identidad. El motivo y las acciones quedan registrados. La autorización vence a los 30
            minutos.
            {editor.gym.status === 'suspended' ? ' El gimnasio está suspendido; el soporte será de solo lectura.' : ''}
          </p>
          <Form
            label="Iniciar soporte"
            onCancel={() => setEditor(null)}
            onSubmit={async (form) => {
              const reason = String(form.get('reason') || '').trim();
              if (reason.length < 5) throw Error('Describe el motivo del soporte (al menos 5 caracteres).');
              const result = await api<{ support_token: string; expires_at: number }>(
                'platform/gyms/' + encodeURIComponent(editor.gym.id) + '/support',
                'POST',
                { reason },
              );
              enter({ gym: editor.gym, supportToken: result.support_token, expiresAt: result.expires_at });
            }}
          >
            <Field label="Motivo del soporte">
              <textarea name="reason" required minLength={5} maxLength={1000} rows={3} />
            </Field>
          </Form>
        </Modal>
      )}
      {editor?.kind === 'backup' && (
        <Modal title="Copia de la plataforma" onClose={() => setEditor(null)}>
          <p>
            Prepara en el servidor una copia coordinada del registro central y los gimnasios. La operación puede tardar;
            después puedes descargarla en esta computadora.
          </p>
          <Form
            label="Crear copia de plataforma"
            onCancel={() => setEditor(null)}
            onSubmit={async (form) => {
              const result = await api<{ id: string; created_at: number }>('platform/backups', 'POST', {
                password: form.get('password'),
              });
              setNotice(
                'Copia de plataforma guardada en el servidor: ' +
                  result.id +
                  ' · ' +
                  new Date(result.created_at).toLocaleString(),
              );
            }}
          >
            <Field label="Tu contraseña de superadministrador">
              <input name="password" type="password" autoComplete="current-password" required maxLength={200} />
            </Field>
          </Form>
          <PlatformBackups key={notice} gymName="la plataforma" global />
        </Modal>
      )}
      {audit && (
        <Modal title="Actividad de la plataforma" wide onClose={() => setAudit(null)}>
          {!audit.length ? (
            <Empty text="Las acciones administrativas aparecerán aquí." />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Usuario</th>
                    <th>Acción</th>
                    <th>Gimnasio</th>
                    <th>Fecha</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.actor_name || entry.actor_email || entry.actor || '—'}</td>
                      <td>{entry.action}</td>
                      <td>
                        {status.gyms.find((gym) => gym.id === entry.gym_id)?.name || entry.gym_id || 'Plataforma'}
                      </td>
                      <td>{new Date(entry.created_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
