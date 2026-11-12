import { useEffect, useState } from 'react';
import { Building2, HardDrive, History, KeyRound, Palette, ScanLine, Users, Wifi, type LucideIcon } from 'lucide-react';
import { generalAccessId, type Device, type Member } from '../lib/domain';
import type { AuditEntry, ResourceProps } from './management';
import { Empty, Field, Form, stamp, type Notify } from './ui';
import { api } from './api';
import Members from './Members';
import Devices from './Devices';
import Appearance from './Appearance';
import GymLogo from './GymLogo';
import CredentialStyle from './CredentialStyle';
import Network from './Network';
import SystemSettings from './SystemSettings';
import RecoveryKey from './RecoveryKey';
import PlatformMembers from './PlatformMembers';
import PlatformBackups from './PlatformBackups';
import CloudSync from './CloudSync';
import ConnectionSettings from './ConnectionSettings';
import './styles/app-downloads.css';

type Props = ResourceProps & { notify: Notify; members: Member[]; devices: Device[]; audit: AuditEntry[] };
type TaskId = 'organization' | 'appearance' | 'password' | 'network' | 'members' | 'devices' | 'audit' | 'system';
type TaskGroup = 'organization' | 'account' | 'equipment';
type ClosingMode = 'off' | 'hours' | 'daily';
type Task = {
  id: TaskId;
  label: string;
  description: string;
  group: TaskGroup;
  icon: LucideIcon;
  adminOnly?: boolean;
};
const timezones = [
  ['America/La_Paz', 'Bolivia (La Paz)'],
  ['America/Lima', 'Perú (Lima)'],
  ['America/Bogota', 'Colombia (Bogotá)'],
  ['America/Santiago', 'Chile (Santiago)'],
  ['America/Argentina/Buenos_Aires', 'Argentina (Buenos Aires)'],
  ['America/Mexico_City', 'México (Ciudad de México)'],
  ['Europe/Madrid', 'España (Madrid)'],
  ['UTC', 'Hora universal (UTC)'],
] as const;
const groups: { id: TaskGroup; label: string }[] = [
  { id: 'organization', label: 'Mi gimnasio' },
  { id: 'account', label: 'Tu cuenta' },
  { id: 'equipment', label: 'Equipos y copias de seguridad' },
];

export default function Settings({ data, admin, saved, notify, members, devices, audit }: Props) {
  const platform = data.platform;
  const [closingMode, setClosingMode] = useState<ClosingMode>(() =>
    data.settings.closing_time ? 'daily' : data.settings.auto_close_hours ? 'hours' : 'off',
  );
  useEffect(() => {
    setClosingMode(data.settings.closing_time ? 'daily' : data.settings.auto_close_hours ? 'hours' : 'off');
  }, [data.settings.closing_time, data.settings.auto_close_hours, platform?.gym_id]);
  const allTasks: Task[] = [
    {
      id: 'organization',
      label: 'Datos del gimnasio',
      description: 'Nombre, hora local y cierre de visitas olvidadas.',
      group: 'organization',
      icon: Building2,
    },
    {
      id: 'members',
      label: 'Personal',
      description: platform
        ? 'Crea cuentas y administra los permisos del personal de este gimnasio.'
        : members.length
          ? `${members.length} ${members.length === 1 ? 'persona' : 'personas'} con acceso al sistema. Rol y estado de cada una.`
          : 'Quién entra al sistema y qué puede hacer: administrador, cajero o consulta.',
      group: 'organization',
      icon: Users,
      adminOnly: true,
    },
    {
      id: 'audit',
      label: 'Registro de cambios',
      description: 'Quién cambió qué en la configuración y cuándo.',
      group: 'organization',
      icon: History,
      adminOnly: true,
    },
    {
      id: 'appearance',
      label: 'Apariencia',
      description: 'Elige el tema, la voz de los avisos de acceso y tus preferencias de uso.',
      group: 'account',
      icon: Palette,
    },
    {
      id: 'password',
      label: 'Tu contraseña',
      description: 'Cambia la contraseña con la que ingresas.',
      group: 'account',
      icon: KeyRound,
    },
    {
      id: 'network',
      label: 'Conexión',
      description: 'Elige si quieres trabajar de forma local o en el servidor y conecta tus equipos.',
      group: 'equipment',
      icon: Wifi,
    },
    {
      id: 'devices',
      label: 'Lectores',
      description: devices.length
        ? `${devices.length} ${devices.length === 1 ? 'lector registrado' : 'lectores registrados'}. Claves y conexión.`
        : 'Registra lectores externos de QR y administra sus claves.',
      group: 'equipment',
      icon: ScanLine,
      adminOnly: true,
    },
    {
      id: 'system',
      label: platform ? 'Respaldos' : 'Sistema y respaldos',
      description: platform
        ? 'Copias y restauraciones administradas desde la plataforma.'
        : 'Licencia, copias de seguridad, actualizaciones y borrado de datos.',
      group: 'equipment',
      icon: HardDrive,
      adminOnly: true,
    },
  ];
  const tasks = allTasks.filter((task) => !task.adminOnly || admin);
  const requested = new URLSearchParams(location.hash.split('?')[1]).get('tab');
  const active = tasks.find((task) => task.id === (requested === 'general' ? 'organization' : requested)) || tasks[0];
  useEffect(() => {
    document.getElementById('settings-section-title')?.focus({ preventScroll: true });
  }, [active.id]);

  return (
    <div className="settings-page">
      <header className="settings-page-heading">
        <div>
          <h1>Configuración</h1>
          <p>Administra tu gimnasio, tu cuenta y los equipos de recepción.</p>
        </div>
      </header>
      <div className="settings-layout">
        <div className="settings-mobile-navigation">
          <Field label="Sección de configuración">
            <select
              value={active.id}
              onChange={(event) => {
                const next = event.target.value;
                event.currentTarget.value = active.id;
                location.hash = '#settings?tab=' + next;
              }}
            >
              {groups.map((group) => (
                <optgroup key={group.id} label={group.label}>
                  {tasks
                    .filter((task) => task.group === group.id)
                    .map((task) => (
                      <option key={task.id} value={task.id}>
                        {task.label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </Field>
        </div>
        <nav className="settings-navigation" aria-label="Secciones de configuración">
          {groups.map((group) => (
            <section className="settings-task-group" key={group.id} aria-labelledby={'settings-group-' + group.id}>
              <h2 id={'settings-group-' + group.id}>{group.label}</h2>
              <ul className="settings-task-list">
                {tasks
                  .filter((task) => task.group === group.id)
                  .map(({ id, label, icon: Icon }) => (
                    <li key={id}>
                      <a
                        id={'settings-task-' + id}
                        className="settings-navigation-link"
                        href={'#settings?tab=' + id}
                        aria-current={active.id === id ? 'page' : undefined}
                      >
                        <Icon size={18} aria-hidden="true" />
                        <span>{label}</span>
                      </a>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </nav>
        <section className={'settings-content settings-content-' + active.id} aria-labelledby="settings-section-title">
          <header className="settings-content-heading">
            <h2 id="settings-section-title" tabIndex={-1}>
              {active.label}
            </h2>
            <p>{active.description}</p>
          </header>
          <div className="settings-task-body" key={active.id}>
            {active.id === 'organization' &&
              (admin ? (
                <div className="settings-form-column settings-organization-form">
                  <Form
                    label="Guardar cambios"
                    onSubmit={async (f) => {
                      const fields = Object.fromEntries(f);
                      delete fields.closing_mode;
                      const closingTime = closingMode === 'daily' ? String(f.get('closing_time') || '') : null;
                      if (closingTime !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(closingTime))
                        throw Error('Elige una hora de cierre válida.');
                      await api('settings', 'PATCH', {
                        ...fields,
                        closing_time: closingTime,
                        auto_close_hours:
                          closingMode === 'off'
                            ? 0
                            : closingMode === 'hours'
                              ? Number(f.get('auto_close_hours'))
                              : data.settings.auto_close_hours,
                        capacity: Number(f.get('capacity')),
                      });
                      await saved();
                    }}
                  >
                    <Field label="Nombre del gimnasio">
                      <input name="name" defaultValue={data.settings.name} required maxLength={120} />
                    </Field>
                    <fieldset className="settings-closing-policy">
                      <legend>Cierre automático</legend>
                      <Field label="Cierre automático de visitas">
                        <select
                          name="closing_mode"
                          value={closingMode}
                          onChange={(event) => setClosingMode(event.target.value as ClosingMode)}
                        >
                          <option value="off">Desactivado</option>
                          <option value="hours">Después de varias horas</option>
                          <option value="daily">A la hora de cierre del gimnasio</option>
                        </select>
                      </Field>
                      {closingMode === 'hours' && (
                        <Field
                          label="Cerrar visitas olvidadas después de (horas)"
                          hint="Si alguien no registra su salida, el sistema la cierra pasado este tiempo. Escribe 0 para no cerrar nada."
                        >
                          <input
                            name="auto_close_hours"
                            type="number"
                            min={0}
                            max={720}
                            step={1}
                            required
                            defaultValue={data.settings.auto_close_hours}
                          />
                        </Field>
                      )}
                      {closingMode === 'daily' && (
                        <Field
                          label="Hora de cierre del gimnasio"
                          hint="Se aplica cada día a la misma hora, en la zona horaria del gimnasio elegida abajo."
                        >
                          <input
                            name="closing_time"
                            type="time"
                            step={60}
                            required
                            defaultValue={data.settings.closing_time || ''}
                          />
                        </Field>
                      )}
                      {closingMode !== 'off' && (
                        <p className="helper">
                          Las visitas que sigan abiertas se cierran con salidas automáticas y estimadas.
                        </p>
                      )}
                    </fieldset>
                    <Field
                      label="Aforo máximo (personas a la vez)"
                      hint="Cuando se llena, no se registran más entradas hasta que alguien salga. Escribe 0 para no limitar."
                    >
                      <input
                        name="capacity"
                        type="number"
                        min={0}
                        max={100000}
                        step={1}
                        required
                        defaultValue={data.zones.find((zone) => zone.id === generalAccessId)?.capacity ?? 0}
                      />
                    </Field>
                    <Field
                      label="Zona horaria"
                      hint="Define la hora de las entradas y salidas nuevas. Las anteriores no cambian."
                    >
                      <select name="timezone" defaultValue={data.settings.timezone} required>
                        {[
                          ...timezones,
                          ...(timezones.some(([zone]) => zone === data.settings.timezone)
                            ? []
                            : [[data.settings.timezone, data.settings.timezone] as const]),
                        ].map(([zone, name]) => (
                          <option key={zone} value={zone}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </Form>
                  <GymLogo name={data.settings.name} logoPath={data.settings.logo_path}
                    size={data.settings.logo_watermark_size ?? 45}
                    saved={saved} notify={notify} />
                  <CredentialStyle
                    name={data.settings.name}
                    logoPath={data.settings.logo_path}
                    color={data.settings.credential_color ?? null}
                    size={data.settings.credential_watermark_size ?? 70}
                    saved={saved}
                  />
                </div>
              ) : (
                <dl className="settings-organization-details">
                  <div>
                    <dt>Nombre</dt>
                    <dd>{data.settings.name}</dd>
                  </div>
                  <div>
                    <dt>Zona horaria</dt>
                    <dd>{data.settings.timezone}</dd>
                  </div>
                  <div>
                    <dt>Cierre automático</dt>
                    <dd>
                      {data.settings.closing_time
                        ? `Cada día a las ${data.settings.closing_time} (${data.settings.timezone})`
                        : data.settings.auto_close_hours
                          ? `Tras ${data.settings.auto_close_hours} horas`
                          : 'Desactivado'}
                    </dd>
                  </div>
                </dl>
              ))}
            {active.id === 'appearance' && <Appearance />}
            {active.id === 'password' && (
              <div className="settings-form-column">
                <Form
                  label="Cambiar contraseña"
                  onSubmit={async (f) => {
                    if (f.get('password') !== f.get('confirm')) throw Error('Las contraseñas nuevas no coinciden.');
                    await api(platform ? 'platform/password' : 'auth/password', 'POST', Object.fromEntries(f));
                    if (platform) window.dispatchEvent(new Event('session-expired'));
                    else notify('Contraseña actualizada. Las demás sesiones se cerraron.');
                  }}
                >
                  <Field label="Contraseña actual">
                    <input name="current" type="password" autoComplete="current-password" required maxLength={200} />
                  </Field>
                  <Field label="Nueva contraseña">
                    <input
                      name="password"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={6}
                      maxLength={200}
                    />
                  </Field>
                  <Field label="Repetir contraseña">
                    <input
                      name="confirm"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={6}
                      maxLength={200}
                    />
                  </Field>
                </Form>
                {admin && !platform && <RecoveryKey notify={notify} />}
                {platform && (
                  <p className="helper">
                    El administrador de tu gimnasio puede cambiar la contraseña de las cuentas de su personal. Si tu
                    cuenta se comparte entre gimnasios, cambia la contraseña desde tu propia sesión o solicita
                    recuperación a la plataforma.
                  </p>
                )}
              </div>
            )}
            {active.id === 'network' && <ConnectionSettings platform={!!platform} />}
            {active.id === 'network' &&
              (platform ? (
                <section className="panel">
                  <h2>Conexión al gimnasio</h2>
                  <p>
                    Abre esta dirección en el teléfono o equipo e inicia sesión con tu propia cuenta. Si tienes varios
                    gimnasios, elige {platform.gym_name}.
                  </p>
                  <Field label="Dirección de la plataforma">
                    <input readOnly value={location.origin} onFocus={(event) => event.currentTarget.select()} />
                  </Field>
                  <button
                    className="btn secondary"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(location.origin);
                        notify('Dirección copiada.');
                      } catch {
                        notify('Selecciona y copia la dirección del campo.');
                      }
                    }}
                  >
                    Copiar dirección
                  </button>
                  <p className="helper">
                    La conexión HTTPS permite usar la cámara del teléfono desde el navegador. Para la aplicación
                    lectora, utiliza esta misma dirección y una cuenta con acceso al gimnasio.
                  </p>
                </section>
              ) : (
                <Network notify={notify} admin={admin} />
              ))}
            {admin &&
              active.id === 'system' &&
              (platform ? (
                <PlatformBackups
                  gymName={platform.gym_name}
                  suspended={platform.read_only}
                  onRestored={saved}
                  canRestore={platform.superadmin && platform.support}
                />
              ) : (
                <SystemSettings notify={notify} timezone={data.settings.timezone} owner={data.owner} />
              ))}
            {admin &&
              active.id === 'members' &&
              (platform ? (
                <PlatformMembers
                  gymId={platform.gym_id}
                  superadmin={platform.superadmin}
                  currentUserId={data.user.id}
                />
              ) : (
                <Members members={members} saved={saved} />
              ))}
            {admin && active.id === 'devices' && (
              <Devices data={data} devices={devices} saved={saved} notify={notify} />
            )}
            {admin && active.id === 'audit' && (
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Registro de cambios</h2>
                    <p>Últimos 100 cambios registrados</p>
                  </div>
                </div>
                {!audit.length ? (
                  <Empty text="Los cambios de configuración aparecerán aquí." />
                ) : (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Usuario</th>
                          <th>Acción</th>
                          <th>Fecha</th>
                        </tr>
                      </thead>
                      <tbody>
                        {audit.map((entry) => (
                          <tr key={entry.id}>
                            <td>{entry.actor}</td>
                            <td>
                              {entry.action === 'gym_session.corrected' ? (
                                <details>
                                  <summary>Corrección de horas de una visita</summary>
                                  <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '60ch' }}>
                                    {entry.entity_id}
                                  </pre>
                                </details>
                              ) : (
                                entry.action
                              )}
                            </td>
                            <td>{stamp(entry.occurred_at, data.settings.timezone, true)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}
          </div>
        </section>
      </div>
      {admin && active.id === 'network' && <CloudSync platform={!!platform} />}
    </div>
  );
}
