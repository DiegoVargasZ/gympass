import { useEffect, useState } from 'react';
import { api, download } from './api';
import { Field, Form } from './ui';
import ServerAccessLink from './ServerAccessLink';
import ConnectionStatus from './ConnectionStatus';
import './styles/cloud-sync.css';
const stamp = (value: number) => new Date(value).toLocaleString();

type SyncStatus = {
  linked: boolean;
  required?: boolean;
  server: string;
  gym_name?: string;
  pending: number;
  online: boolean;
  last_success?: number;
  expires_at?: number;
  conflict?: string;
  error?: string;
  revoked?: boolean;
};
type Device = { id: string; name: string; kind: string; last_sync_at: number | null; revoked_at: number | null };
type Conflict = { device_id: string; batch_id: string; name: string; conflict: string; created_at: number };
export default function CloudSync({ platform = false, initial = false }: { platform?: boolean; initial?: boolean }) {
  const [status, setStatus] = useState<SyncStatus | null>(null),
    [devices, setDevices] = useState<Device[]>([]),
    [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [error, setError] = useState(''),
    [relink, setRelink] = useState(false),
    [busy, setBusy] = useState(false),
    [gyms, setGyms] = useState<{ id: string; name: string }[]>([]);
  const refresh = async () => {
    if (platform) {
      const [d, c] = await Promise.all([api<Device[]>('sync/devices'), api<Conflict[]>('sync/conflicts')]);
      setDevices(d);
      setConflicts(c);
    } else setStatus(await api<SyncStatus>('cloud-sync/status'));
  };
  useEffect(() => {
    void refresh().catch((cause) => setError(cause.message));
    const timer = setInterval(() => void refresh().catch(() => {}), 15000);
    return () => clearInterval(timer);
  }, [platform]);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await operation();
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={initial ? 'panel cloud-sync sync-initial' : 'panel cloud-sync'}>
      {initial && <ConnectionStatus />}
      <h2>{initial ? 'Iniciar sesión en GymPASS' : platform ? 'Equipos vinculados' : 'Sincronización'}</h2>
      {initial && (
        <p>
          Entra con la cuenta administradora de tu gimnasio en el servidor. Sus socios, planes, cobros y credenciales se
          descargarán automáticamente antes de empezar.
        </p>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {platform ? (
        <>
          {!devices.length && (
            <p>
              Todavía no hay equipos vinculados. La primera vinculación se hace desde la aplicación, con Internet y una
              cuenta administradora.
            </p>
          )}
          <div className="sync-devices">
            {devices.map((device) => (
              <div className="sync-device" key={device.id}>
                <div>
                  <h3>{device.name}</h3>
                  <p>
                    {device.kind === 'mobile' ? 'Aplicación móvil' : 'Computadora Windows'} ·{' '}
                    {device.revoked_at ? 'Acceso desactivado' : 'Vinculación activa'}
                  </p>
                  <p>
                    {device.last_sync_at
                      ? 'Última copia actualizada: ' + stamp(device.last_sync_at)
                      : 'Todavía no terminó la primera descarga'}
                  </p>
                </div>
                <button
                  className="btn secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (device.revoked_at) {
                        if (
                          confirm(
                            '¿Reactivar esta vinculación para que el dispositivo pueda sincronizar sus pendientes?',
                          )
                        )
                          await api('sync/devices/' + device.id, 'POST', { confirm: 'REACTIVAR' });
                        return;
                      }
                      if (
                        confirm(
                          '¿Revocar la vinculación de este dispositivo? Se bloqueará al reconectar y, sin conexión, al vencer su autorización.',
                        )
                      )
                        await api('sync/devices/' + device.id, 'DELETE');
                    })
                  }
                >
                  {device.revoked_at ? 'Permitir acceso de nuevo' : 'Desactivar este equipo'}
                </button>
              </div>
            ))}
          </div>
          {conflicts.map((conflict) => (
            <div className="sync-conflict" key={conflict.device_id + ':' + conflict.batch_id}>
              <h3>Revisar cambios de {conflict.name}</h3>
              <p>{conflict.conflict}</p>
              <p>Los cambios locales se conservaron. Revisa el respaldo y los cobros antes de decidir.</p>
              <button
                className="btn secondary"
                onClick={() =>
                  void run(() =>
                    download(
                      'sync/conflicts/' + conflict.device_id + '/' + conflict.batch_id + '/export',
                      'pendientes-' + conflict.batch_id + '.json',
                    ),
                  )
                }
              >
                Descargar pendientes
              </button>
              <button
                className="btn secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (
                      confirm(
                        'Se conservarán los datos de la nube. El lote local quedará archivado y se reemplazará en el dispositivo al sincronizar. ¿Continuar?',
                      )
                    )
                      await api('sync/conflicts/' + conflict.device_id + '/' + conflict.batch_id, 'POST', {
                        confirm: 'CONSERVAR NUBE',
                      });
                  })
                }
              >
                Conservar nube y archivar lote local
              </button>
            </div>
          ))}
        </>
      ) : (
        status && (
          <>
            {status.linked && !relink ? (
              <>
                <h3>{status.gym_name}</h3>
                <p role="status">
                  {status.online ? 'Conectado al servidor' : 'Trabajando con la copia local'} ·{' '}
                  {status.pending
                    ? status.pending + ' cambios pendientes de enviar'
                    : 'Sin cambios pendientes de enviar'}
                </p>
                <p>
                  {status.last_success && 'Última sincronización: ' + stamp(status.last_success)}
                  {status.expires_at && ' · Autorización sin conexión hasta ' + stamp(status.expires_at)}
                </p>
                {(status.conflict || status.error) && (
                  <p className="error-message" role="alert">
                    {status.conflict || status.error}
                  </p>
                )}
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      setStatus(await api<SyncStatus>('cloud-sync/run', 'POST'));
                      window.dispatchEvent(new Event('activation-changed'));
                    })
                  }
                >
                  {busy ? 'Sincronizando…' : 'Sincronizar ahora'}
                </button>
                <p className="helper">
                  Para revisar conflictos o revocar equipos, entra con Internet en Configuración → Conexión del gimnasio
                  en la plataforma. Puedes descargar un respaldo local antes de resolverlos.
                </p>
                <button className="btn secondary" disabled={busy} onClick={() => setRelink(true)}>
                  Volver a vincular con mi cuenta
                </button>
              </>
            ) : (
              <Form
                label={initial ? 'Entrar y descargar mis datos' : 'Vincular y descargar copia'}
                onSubmit={async (form) => {
                  setError('');
                  const result = await api<{ gyms?: { id: string; name: string }[]; linked?: boolean }>(
                    'cloud-sync/link',
                    'POST',
                    Object.fromEntries(form),
                  );
                  if (result.gyms) {
                    if (!result.gyms.length) throw Error('Esta cuenta no administra gimnasios activos.');
                    setGyms(result.gyms);
                  } else if (result.linked) location.reload();
                }}
              >
                <Field label="Servidor de tu gimnasio">
                  <input name="server" type="url" defaultValue={status.server || 'https://gympass.site'} required />
                </Field>
                <Field label="Correo electrónico">
                  <input name="email" type="email" autoComplete="username" required />
                </Field>
                <Field label="Contraseña">
                  <input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    minLength={6}
                    maxLength={200}
                    required
                  />
                </Field>
                {initial ? (
                  <input type="hidden" name="name" value="Recepción" />
                ) : (
                  <Field label="Nombre de esta computadora">
                    <input name="name" defaultValue="Recepción" maxLength={100} required />
                  </Field>
                )}
                {!!gyms.length && (
                  <Field label="Gimnasio">
                    <select name="gym_id" required>
                      <option value="">Elige tu gimnasio</option>
                      {gyms.map((gym) => (
                        <option key={gym.id} value={gym.id}>
                          {gym.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {!initial && (
                  <Field
                    label="Si esta base tiene datos, escribe REEMPLAZAR"
                    hint="Se guardará una copia local antes de descargar el gimnasio central."
                  >
                    <input name="confirm" autoComplete="off" />
                  </Field>
                )}
              </Form>
            )}
          </>
        )
      )}
      {!initial && (
        <p className="helper">
          La copia permite trabajar hasta 7 días desde la última sincronización. Los vencimientos de los planes se
          siguen respetando. Si dos equipos modifican el mismo dato sin Internet, GymPASS conserva ambos cambios para
          que el administrador los revise.
        </p>
      )}
      {initial && <ServerAccessLink />}
    </section>
  );
}
