import { useEffect, useRef, useState } from 'react';
import { Download, HardDrive, RefreshCw, Upload } from 'lucide-react';
import { maxBackupTransferBytes } from '../lib/backup-limits';
import { api, download, uploadBackup } from './api';
import { Empty, Field, Form, Modal, Skeleton } from './ui';

type Copy = {
  id: string;
  created_at: number;
  version: string;
  kind: string;
  people?: number;
  events?: number;
  invitations?: number;
  schema?: number;
  bytes?: number;
};
type Backups = { copies: Copy[]; last?: Copy | null; error?: string };

export default function PlatformBackups({
  gymName,
  suspended = false,
  onRestored,
  canRestore = false,
  global = false,
  gymId,
}: {
  gymName: string;
  suspended?: boolean;
  onRestored?: () => Promise<void>;
  canRestore?: boolean;
  global?: boolean;
  gymId?: string;
}) {
  const [data, setData] = useState<Backups | null>(null);
  const [restore, setRestore] = useState<Copy | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const sequence = useRef(0);
  const endpoint = global ? 'platform/backups' : gymId ? 'platform/gyms/' + encodeURIComponent(gymId) + '/backups' : 'backups';
  const refresh = async () => {
    const current = ++sequence.current;
    try {
      const next = await api<Backups>(endpoint);
      if (current !== sequence.current) return;
      setData(next);
      setError('');
    } catch (cause) {
      if (current === sequence.current) setError((cause as Error).message);
    }
  };
  useEffect(() => {
    void refresh();
    return () => {
      sequence.current++;
    };
  }, []);
  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel platform-backups">
      <div className="panel-heading">
        <div>
          <h2>Respaldos de {gymName}</h2>
          <p>
            {global ? 'Las copias completas incluyen el registro central y todos los gimnasios.' : 'Las copias incluyen los datos y archivos de este gimnasio. Las cuentas y los permisos se administran en el registro central.'}
          </p>
        </div>
        <div className="platform-actions">
          <button
            className="btn secondary"
            disabled={busy}
            aria-label="Actualizar respaldos"
            onClick={() => void perform(refresh)}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </button>
          {!global && (
            <button className="btn secondary" disabled={busy || suspended} onClick={() => setImportOpen(true)}>
              <Upload size={16} aria-hidden="true" />
              Usar respaldo descargado
            </button>
          )}
          {!global && (
            <button
              className="btn primary"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const copy = await api<Copy>(endpoint, 'POST');
                  await refresh();
                  setNotice('Respaldo creado: ' + copy.id);
                })
              }
            >
              <HardDrive size={16} aria-hidden="true" />
              {busy ? 'Procesando…' : 'Crear respaldo'}
            </button>
          )}
        </div>
      </div>
      {suspended && (
        <p className="helper">
          El gimnasio está suspendido. Puedes crear, consultar y descargar copias. Reactívalo para importar o restaurar
          un respaldo.
        </p>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {data?.error && (
        <p className="error-message" role="alert">
          {data.error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!data && !error && <Skeleton rows={3} label="Cargando respaldos" />}
      {data &&
        (!data.copies.length ? (
          <Empty text="Crea el primer respaldo de este gimnasio." />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  {!global && <th>Tamaño</th>}
                  {!global && <th>Versión</th>}
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {data.copies.map((copy) => (
                  <tr key={copy.id}>
                    <td>
                      {new Date(copy.created_at).toLocaleString()}
                      {!global && <small>{copy.id}</small>}
                    </td>
                    {!global && <td>
                      {copy.bytes === undefined
                        ? '—'
                        : (copy.bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' KB'}
                    </td>}
                    {!global && <td>{copy.version}</td>}
                    <td>
                      <div className="platform-actions">
                        <button
                          className="btn secondary"
                          disabled={busy}
                          onClick={() =>
                            void perform(() =>
                              download(
                                endpoint + '/' + encodeURIComponent(copy.id) + '/export',
                                copy.id + (global ? '.tar.gz' : '.gympassbackup'),
                              ),
                            )
                          }
                        >
                          <Download size={16} aria-hidden="true" />
                          Descargar
                        </button>
                        {canRestore && (
                          <button
                            className="btn secondary"
                            disabled={busy || suspended}
                            onClick={() =>
                              void perform(async () => {
                                const preview = await api<Copy>(endpoint + '/' + encodeURIComponent(copy.id) + '/inspect');
                                setRestore(preview);
                              })
                            }
                          >
                            Restaurar
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      {importOpen && (
        <Modal title="Usar respaldo descargado" onClose={() => { if (!busy) setImportOpen(false); }}>
          <p>Selecciona un archivo .gympassbackup de este gimnasio. Se verificará antes de añadirlo a la lista de respaldos.</p>
          <p className="helper">Importar conserva los datos actuales. El archivo puede pesar hasta 256 MiB.</p>
          <Form
            label="Importar y verificar"
            onCancel={() => { if (!busy) setImportOpen(false); }}
            onSubmit={async (form) => {
              const file = form.get('backup');
              if (!file || typeof file === 'string' || !/\.gympassbackup$/i.test(file.name))
                throw Error('Selecciona un archivo .gympassbackup.');
              if (!file.size || file.size > maxBackupTransferBytes)
                throw Error('El archivo debe contener un respaldo de hasta 256 MiB.');
              setBusy(true);
              setNotice('');
              try {
                const copy = await uploadBackup<Copy>(file, endpoint + '/import');
                setImportOpen(false);
                await refresh();
                if (canRestore && !suspended) setRestore(copy);
                else setNotice('Respaldo importado y verificado. Un superadministrador en modo soporte puede restaurarlo.');
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Archivo de respaldo">
              <input name="backup" type="file" accept=".gympassbackup" required />
            </Field>
          </Form>
        </Modal>
      )}
      {restore && (
        <Modal title={'Restaurar ' + gymName} onClose={() => setRestore(null)}>
          <p>
            Se reemplazarán los datos operativos de este gimnasio por la copia del{' '}
            {new Date(restore.created_at).toLocaleString()}: {restore.people} socios y {restore.events} movimientos. El
            servidor prepara una copia previa.
          </p>
          <Form
            label="Restaurar respaldo"
            onCancel={() => setRestore(null)}
            onSubmit={async (form) => {
              if (form.get('confirm') !== 'RESTAURAR') throw Error('Escribe RESTAURAR para confirmar.');
              const result = await api<{ safety: string; restart: boolean }>(
                endpoint + '/' + encodeURIComponent(restore.id) + '/restore',
                'POST',
                { confirm: 'RESTAURAR', password: form.get('password') },
              );
              setRestore(null);
              await refresh();
              await onRestored?.();
              setNotice('Datos restaurados. Copia previa: ' + result.safety + '.');
            }}
          >
            <Field label="Confirmación" hint="Escribe RESTAURAR.">
              <input name="confirm" autoComplete="off" required pattern="RESTAURAR" />
            </Field>
            <Field label="Tu contraseña de superadministrador">
              <input name="password" type="password" autoComplete="current-password" required maxLength={200} />
            </Field>
          </Form>
        </Modal>
      )}
    </section>
  );
}
