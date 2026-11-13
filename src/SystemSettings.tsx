import { useEffect, useRef, useState } from 'react';
import { ArchiveRestore, Download, FolderOpen, KeyRound, RefreshCw, Upload } from 'lucide-react';
import { api } from './api';
import { Badge, Field, Form, Modal, Skeleton, stamp, type Notify } from './ui';
import type { Backups } from '../server/backups';
import SystemTools from './SystemTools';
import './styles/backup-transfer.css';
type Status = ReturnType<Backups['status']>;
type Preview = ReturnType<Backups['inspect']>;
const kinds: Record<string, string> = {
  automatic: 'Automático',
  manual: 'Manual',
  'before-update': 'Antes de actualizar',
  'before-restore': 'Antes de restaurar',
};
export default function SystemSettings({
  notify,
  timezone,
  owner,
  manageBackups = false,
}: {
  notify: Notify;
  timezone: string;
  /** Solo el administrador principal administra la activación. */
  owner: boolean;
  manageBackups?: boolean;
}) {
  const [status, setStatus] = useState<Status | null>(null),
    [info, setInfo] = useState<{ version: string; desktop: boolean } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<Preview | null>(null),
    [restored, setRestored] = useState<string | null>(null),
    [transferError, setTransferError] = useState(''),
    [operation, setOperation] = useState(''),
    [importFile, setImportFile] = useState<File | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const actionPending = useRef(false);
  async function load() {
    if (!manageBackups) return;
    try {
      setStatus(await api<Status>('backups'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    api('system-info')
      .then(setInfo)
      .catch((e) => notify(e.message, true));
  }, []);
  async function run(action: () => Promise<void>, name = '') {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setOperation(name);
    setTransferError('');
    try {
      await action();
    } catch (e) {
      setTransferError((e as Error).message);
      notify((e as Error).message, true);
    } finally {
      actionPending.current = false;
      setBusy(false);
      setOperation('');
    }
  }
  async function binaryResponse(response: Response) {
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      if (response.status === 401) window.dispatchEvent(new Event('session-expired'));
      throw Error(result?.error || 'No se pudo transferir el respaldo. Vuelve a intentarlo.');
    }
    return response;
  }
  return (
    <div className="system-settings">
      <section className="settings-system-section system-installation" aria-labelledby="system-installation-title">
        <div className="system-section-heading">
          <div>
            <h3 id="system-installation-title">Versión y actualizaciones</h3>
            <p>El respaldo de tu instalación se crea antes de abrir el instalador.</p>
          </div>
        </div>
        <div className="system-version">
          <strong>GymPASS {info ? `v${info.version}` : ''}</strong>
          <Badge tone="gray">
            {info ? (info.desktop ? 'Aplicación de escritorio' : 'Servidor web') : 'Consultando versión…'}
          </Badge>
        </div>
        <div className="system-actions">
          <button
            className="btn secondary"
            disabled={busy || !info?.desktop || (manageBackups && !status) || !!restored}
            onClick={() =>
              void run(async () => {
                await api('system/update', 'POST', {});
                await load();
                notify('Elige el instalador en la ventana de Windows.');
              })
            }
          >
            <Download size={17} /> Actualizar GymPASS
          </button>
          {info?.desktop && (
            <button
              className="btn secondary"
              disabled={busy || !!restored}
              onClick={() =>
                void run(async () => {
                  await api('system/open-data', 'POST');
                })
              }
            >
              <FolderOpen size={17} /> Abrir carpeta de datos
            </button>
          )}
        </div>
        <p className="helper">
          {info?.desktop
            ? 'Selecciona el archivo GymPASS-Setup de la nueva versión que recibiste de tu proveedor.'
            : 'Para instalar una actualización, abre GymPASS desde la aplicación de escritorio de esta computadora.'}
        </p>
      </section>
      {!restored && (
        <div className="settings-system-tools">
          {owner ? (
            <SystemTools notify={notify} section="activation" />
          ) : (
            <section className="panel padded">
              <div className="section-heading">
                <div>
                  <h2>
                    <KeyRound size={21} /> Activación de GymPASS
                  </h2>
                  <p>La administra el administrador principal de esta instalación.</p>
                </div>
              </div>
              <p className="helper">
                Si la licencia está por vencer, pídele a quien instaló GymPASS que canjee la clave desde esta
                computadora. Las actualizaciones se administran desde aquí.
              </p>
            </section>
          )}
        </div>
      )}
      {manageBackups && (error ? (
        <div role="alert" className="error-message system-load-error">
          <p>{error}</p>
          <button className="btn secondary" onClick={() => void load()}>
            Volver a consultar respaldos
          </button>
        </div>
      ) : !status ? (
        <Skeleton rows={4} />
      ) : (
        <>
          <section className="settings-system-section" aria-labelledby="system-backups-title">
            <div className="system-section-heading">
              <div>
                <h3 id="system-backups-title">Respaldos</h3>
                <p>
                  {status.last
                    ? `Última copia: ${stamp(status.last.created_at, timezone, true)}`
                    : 'Todavía no se creó una copia.'}
                </p>
              </div>
              <button
                className="btn primary"
                disabled={busy || !!restored}
                onClick={() =>
                  void run(async () => {
                    await api('backups', 'POST', {});
                    await load();
                    notify('Respaldo completo creado');
                  })
                }
              >
                <ArchiveRestore size={17} /> Crear respaldo ahora
              </button>
            </div>
            <p>Guarda registros, claves de los QR, fotos, fondos, logos y configuración de conexión.</p>
            <dl className="system-backup-location">
              <dt>Carpeta de respaldos</dt>
              <dd>{status.directory}</dd>
            </dl>
            <p className="helper">
              Puedes guardar las copias en otro disco o en una unidad externa conectada a la computadora que ejecuta
              GymPASS. La ubicación se conserva al reiniciar.
            </p>
            {transferError && (
              <p className="error-message" role="alert">
                {transferError}
              </p>
            )}
            {status.error && (
              <p className="error-message" role="alert">
                El último intento falló: {status.error}
              </p>
            )}
            {!restored && (
              <div className="backup-destination">
                <h4>Ubicación de las copias</h4>
                <Form
                  key={status.directory}
                  label={operation === 'directory' ? 'Guardando ubicación…' : 'Guardar ubicación de respaldos'}
                  disabled={busy}
                  onSubmit={async (form) => {
                    await run(async () => {
                      await api('backups/settings', 'PATCH', { directory: String(form.get('directory') || '').trim() });
                      await load();
                      notify('Ubicación guardada. Las copias anteriores se conservaron en su carpeta original.');
                    }, 'directory');
                  }}
                >
                  <Field
                    label="Ruta de la carpeta de respaldos"
                    hint="Escribe una ruta completa del servidor, por ejemplo E:\\Respaldos GymPASS. Las copias existentes se copian y verifican antes de cambiar de ubicación; los originales se conservan."
                  >
                    <input
                      name="directory"
                      defaultValue={status.directory}
                      required
                      maxLength={4096}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                </Form>
              </div>
            )}
            {!restored && (
              <div className="system-backup-schedule">
                <h4>Copias automáticas</h4>
                <p className="helper">Elige cada cuánto guardar y cuántas copias mantener.</p>
                <Form
                  key={JSON.stringify(status.settings)}
                  label="Guardar frecuencia de respaldos"
                  disabled={busy}
                  onSubmit={async (f) => {
                    await api('backups/settings', 'PATCH', {
                      enabled: f.get('enabled') === 'yes',
                      interval_hours: Number(f.get('interval_hours')),
                      keep: Number(f.get('keep')),
                    });
                    await load();
                    notify('Respaldos automáticos configurados');
                  }}
                >
                  <div className="form-grid">
                    <Field label="Respaldos automáticos">
                      <select name="enabled" defaultValue={status.settings.enabled ? 'yes' : 'no'}>
                        <option value="yes">Activados</option>
                        <option value="no">Desactivados</option>
                      </select>
                    </Field>
                    <Field label="Frecuencia mientras GymPASS está abierto">
                      <select name="interval_hours" defaultValue={status.settings.interval_hours}>
                        {[6, 12, 24].map((hours) => (
                          <option key={hours} value={hours}>
                            Cada {hours} horas
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field
                      label="Copias automáticas que se conservan"
                      hint="Las copias manuales y las previas a restaurar o actualizar se conservan."
                    >
                      <input name="keep" type="number" min={3} max={60} defaultValue={status.settings.keep} required />
                    </Field>
                  </div>
                </Form>
              </div>
            )}
          </section>
          {!restored && (
            <section className="settings-system-section backup-transfer" aria-labelledby="backup-transfer-title">
              <h3 id="backup-transfer-title">Traer una copia externa</h3>
              <p>
                Importa un archivo .gympassbackup exportado desde GymPASS. Se comprobarán su integridad, base de datos y
                clave de los QR antes de añadirlo a la lista.
              </p>
              <p className="helper">
                Importar no reemplaza tus datos. Después podrás verificar la copia y confirmar su restauración. La
                licencia de esta computadora se conserva. Máximo: 256 MiB.
              </p>
              <Field label="Archivo de respaldo">
                <input
                  ref={importInput}
                  type="file"
                  accept=".gympassbackup"
                  disabled={busy}
                  onChange={(event) => {
                    setImportFile(event.target.files?.[0] || null);
                    setTransferError('');
                  }}
                />
              </Field>
              <button
                className="btn secondary"
                disabled={busy || !importFile}
                onClick={() =>
                  void run(async () => {
                    if (!importFile || !/\.gympassbackup$/i.test(importFile.name))
                      throw Error('Selecciona un archivo .gympassbackup.');
                    if (!importFile.size || importFile.size > 256 * 1024 * 1024)
                      throw Error('El archivo debe contener una copia de hasta 256 MiB.');
                    const response = await binaryResponse(
                      await fetch('/api/backups/import', {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'GymPASS' },
                        body: importFile,
                        signal: AbortSignal.timeout(120000),
                      }),
                    );
                    const imported = (await response.json()) as Preview;
                    await load();
                    setImportFile(null);
                    if (importInput.current) importInput.current.value = '';
                    setPreview(imported);
                    notify('Copia importada y verificada. Los datos actuales siguen intactos.');
                  }, 'import')
                }
              >
                <Upload size={17} />{' '}
                {operation === 'import' ? 'Importando y verificando…' : 'Importar y verificar archivo'}
              </button>
            </section>
          )}
          <section className="settings-system-section" aria-labelledby="system-backup-history-title">
            <div className="system-section-heading">
              <div>
                <h3 id="system-backup-history-title">Recuperar un respaldo</h3>
                <p>Verifica su contenido antes de reemplazar los datos actuales.</p>
              </div>
              <button className="btn secondary small" disabled={busy} onClick={() => void load()}>
                <RefreshCw size={15} /> Actualizar
              </button>
            </div>
            {restored && (
              <p className="success-message" role="status">
                {restored}
              </p>
            )}
            {!status.copies.length ? (
              <div className="system-backup-empty">
                <ArchiveRestore size={24} aria-hidden="true" />
                <p>Aún no hay respaldos. Crea el primero con «Crear respaldo ahora».</p>
              </div>
            ) : (
              <div className="table-scroll">
                <table className="system-backup-table">
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Tipo</th>
                      <th>Versión</th>
                      <th>Tamaño</th>
                      <th>Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.copies.slice(0, 100).map((copy) => (
                      <tr key={copy.id}>
                        <td data-label="Fecha">{stamp(copy.created_at, timezone, true)}</td>
                        <td data-label="Tipo">{kinds[copy.kind] || copy.kind}</td>
                        <td data-label="Versión">{copy.version}</td>
                        <td data-label="Tamaño">{(copy.bytes / 1024 / 1024).toFixed(1)} MB</td>
                        <td className="system-backup-restore">
                          <button
                            className="btn secondary small"
                            disabled={busy || !!restored}
                            onClick={() =>
                              void run(async () => {
                                const response = await binaryResponse(
                                  await fetch(`/api/backups/${encodeURIComponent(copy.id)}/export`, {
                                    credentials: 'same-origin',
                                    headers: { 'X-Requested-With': 'GymPASS' },
                                    signal: AbortSignal.timeout(120000),
                                  }),
                                );
                                const url = URL.createObjectURL(await response.blob());
                                try {
                                  const link = document.createElement('a');
                                  link.href = url;
                                  link.download = copy.id + '.gympassbackup';
                                  link.click();
                                } finally {
                                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                                }
                                notify(
                                  'Respaldo exportado. Guárdalo en un lugar seguro: incluye datos y claves de acceso.',
                                );
                              }, 'export:' + copy.id)
                            }
                          >
                            <Download size={15} />{' '}
                            {operation === 'export:' + copy.id ? 'Exportando…' : 'Exportar archivo'}
                          </button>
                          <button
                            className="btn secondary small"
                            disabled={busy || !!restored}
                            onClick={() =>
                              void run(async () => {
                                setPreview(await api<Preview>(`backups/${copy.id}/inspect`));
                              })
                            }
                          >
                            Verificar copia
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ))}
      {!restored && (
        <div className="settings-system-tools settings-reset-tools">
          <SystemTools notify={notify} section="reset" />
        </div>
      )}
      {manageBackups && preview && (
        <RestoreWizard
          preview={preview}
          timezone={timezone}
          onClose={() => setPreview(null)}
          onRestore={async () => {
            const result = await api<{ restart: boolean; safety: string }>(`backups/${preview.id}/restore`, 'POST', {
              confirm: 'RESTAURAR',
            });
            setPreview(null);
            setRestored(
              result.restart
                ? 'La copia está verificada. GymPASS se reiniciará para restaurarla.'
                : 'La copia está verificada. Cierra el servidor y vuelve a abrir GymPASS para terminar la restauración.',
            );
            notify('Se creó una copia del estado anterior y se preparó la restauración.');
            await load();
          }}
        />
      )}
    </div>
  );
}
function RestoreWizard({
  preview,
  timezone,
  onClose,
  onRestore,
}: {
  preview: Preview;
  timezone: string;
  onClose: () => void;
  onRestore: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(''),
    [step, setStep] = useState(1);
  return (
    <Modal title={`Restaurar respaldo · paso ${step} de 2`} onClose={onClose}>
      {step === 1 ? (
        <>
          <Badge tone="green">Copia verificada</Badge>
          <p>
            Respaldo del {stamp(preview.created_at, timezone, true)}. Incluye {preview.people} personas y{' '}
            {preview.events} movimientos. También conserva datos históricos de versiones anteriores.
          </p>
          <p>
            Al continuar, los datos actuales serán reemplazados por esta copia. GymPASS conservará primero un respaldo
            completo del estado actual.
          </p>
          <button className="btn primary" onClick={() => setStep(2)}>
            Continuar con esta copia
          </button>
        </>
      ) : (
        <Form
          label="Crear copia previa y restaurar"
          submitDisabled={confirm !== 'RESTAURAR'}
          onCancel={onClose}
          onSubmit={onRestore}
        >
          <p>Se reiniciará GymPASS para aplicar el respaldo. Los teléfonos deberán reconectarse.</p>
          <Field label="Escribe RESTAURAR para confirmar">
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" data-autofocus />
          </Field>
        </Form>
      )}
    </Modal>
  );
}
