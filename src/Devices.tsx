import { useEffect, useRef, useState } from 'react';
import { Ban, Copy, Download, KeyRound, RefreshCw } from 'lucide-react';
import { type Bootstrap, type Device, kindLabels } from '../lib/domain';
import { Badge, Empty, Field, Form, Modal, stamp, type Notify } from './ui';
import { api } from './api';
import { apiUrl } from './platform-context';
import { copyText } from './browser';
import { directionLabel } from './access-submit';
import {
  checkReaderConnection,
  readerConfiguration,
  saveReaderConfiguration,
  type ReaderSetup,
} from './reader-connection';
import './styles/readers.css';

export default function Devices({
  data,
  devices,
  saved,
  notify,
}: {
  data: Bootstrap;
  devices: Device[];
  saved: () => Promise<void>;
  notify: Notify;
}) {
  const [mode, setMode] = useState<'keyboard' | 'api'>('keyboard'),
    [connection, setConnection] = useState<ReaderSetup | null>(null),
    [showKey, setShowKey] = useState(false),
    [checking, setChecking] = useState(false),
    [checked, setChecked] = useState(false),
    [error, setError] = useState('');
  const checkRequest = useRef<AbortController | null>(null);
  const settings = connection ? readerConfiguration(location.origin, apiUrl('device-access'), connection) : null;
  useEffect(() => {
    setConnection(null);
    return () => checkRequest.current?.abort();
  }, [data.installation_id, data.platform?.gym_id, data.user.id]);
  function openConnection(reader: ReaderSetup) {
    checkRequest.current?.abort();
    setConnection(reader);
    setShowKey(false);
    setChecking(false);
    setChecked(false);
    setError('');
  }
  function closeConnection() {
    checkRequest.current?.abort();
    setConnection(null);
    setChecked(false);
    setError('');
  }
  async function copy(value: string) {
    try {
      await copyText(value);
      notify('Copiado');
    } catch {
      notify('No se pudo copiar. Selecciona el texto y cópialo manualmente.', true);
    }
  }
  return (
    <div className="readers-settings">
      <section className="panel" aria-labelledby="reader-setup-title">
        <h2 id="reader-setup-title">Conectar un lector</h2>
        <p>Elige cómo entrega las lecturas tu equipo. Puedes consultar esta guía antes de comprarlo.</p>
        <div className="reader-modes" aria-label="Cómo se conecta el lector">
          <button
            type="button"
            className={'btn ' + (mode === 'keyboard' ? 'primary' : 'secondary')}
            aria-pressed={mode === 'keyboard'}
            onClick={() => setMode('keyboard')}
          >
            USB que funciona como teclado
          </button>
          <button
            type="button"
            className={'btn ' + (mode === 'api' ? 'primary' : 'secondary')}
            aria-pressed={mode === 'api'}
            onClick={() => setMode('api')}
          >
            Equipo por red o programa externo
          </button>
        </div>
        {mode === 'keyboard' ? (
          <div className="reader-guide">
            <h3>QR o tarjeta que escribe un código</h3>
            <ol>
              <li>Conecta el lector al USB de la computadora e instala su controlador si lo necesita.</li>
              <li>
                En el manual del equipo, busca el modo <strong>teclado USB / HID</strong> y configura{' '}
                <strong>Enter</strong> al final de cada lectura.
              </li>
              <li>
                Abre Recepción y deja seleccionado el campo «Código de credencial». Escanea una credencial del socio.
              </li>
              <li>Comprueba que aparece su nombre y el resultado de la entrada o salida.</li>
            </ol>
            <p>Este modo utiliza tu sesión de recepción y no necesita crear una clave de lector.</p>
            <p>
              Para una tarjeta NFC, vincula primero el código que escribe el equipo al socio. Un lector de huella
              necesita un equipo o programa que reconozca la huella; consulta la opción de equipo externo.
            </p>
            <a className="btn primary" href="#access?mode=reader">
              Abrir Recepción con lector
            </a>
          </div>
        ) : (
          <div className="reader-guide">
            <h3>Prepara la conexión del equipo</h3>
            <p>
              El lector o su programa debe poder enviar solicitudes HTTPS con una clave de acceso. Si usa un SDK propio,
              hará falta un conector compatible con ese modelo.
            </p>
            <Form
              label="Crear conexión"
              onSubmit={async (form) => {
                const body = Object.fromEntries(form) as Record<string, string>;
                const created = await api<{ id: string; token: string }>('devices', 'POST', body);
                openConnection({
                  id: created.id,
                  token: created.token,
                  name: body.name,
                  kind: body.kind,
                  direction: body.direction,
                  zone_id: body.zone_id,
                });
                try {
                  await saved();
                } catch {
                  notify('La conexión se creó. Guarda su clave y actualiza la lista de lectores.', true);
                }
              }}
            >
              <Field label="Nombre del lector">
                <input name="name" required maxLength={120} placeholder="Ej. Huella de recepción" />
              </Field>
              <div className="form-grid">
                <Field label="Qué identifica">
                  <select name="kind">
                    <option value="qr">Código QR</option>
                    <option value="nfc">Tarjeta NFC</option>
                    <option value="biometric">Huella o biometría validada por el equipo</option>
                  </select>
                </Field>
                <Field label="Qué registra">
                  <select name="direction">
                    <option value="entry">Entrada</option>
                    <option value="exit">Salida</option>
                    <option value="auto">Alternar entrada y salida</option>
                  </select>
                </Field>
                <Field label="Zona de acceso">
                  <select name="zone_id" defaultValue="general">
                    {data.zones
                      .filter((zone) => zone.active)
                      .map((zone) => (
                        <option key={zone.id} value={zone.id}>
                          {zone.name}
                        </option>
                      ))}
                  </select>
                </Field>
              </div>
            </Form>
          </div>
        )}
      </section>
      <section className="panel" aria-labelledby="readers-list-title">
        <div className="panel-heading">
          <div>
            <h2 id="readers-list-title">Conexiones de equipos externos</h2>
            <p>
              La última lectura indica cuándo el equipo envió un movimiento. Una clave habilitada no confirma que el
              equipo esté conectado.
            </p>
          </div>
          <button
            type="button"
            className="btn secondary small"
            onClick={async () => {
              try {
                await saved();
              } catch {
                notify('No se pudo actualizar la lista.', true);
              }
            }}
          >
            <RefreshCw size={16} /> Actualizar lectores
          </button>
        </div>
        {!devices.length ? (
          <Empty text="Todavía no hay conexiones de equipos externos. Los lectores USB en modo teclado no aparecen en esta lista." />
        ) : (
          <ul className="reader-list">
            {devices.map((device) => (
              <li key={device.id}>
                <div>
                  <strong>{device.name}</strong>
                  <p>
                    {kindLabels[device.kind]} · {directionLabel(device.direction)} · {device.zone_name}
                  </p>
                  <p className="helper">
                    Última lectura:{' '}
                    {device.last_seen
                      ? stamp(device.last_seen, data.settings.timezone, true)
                      : 'Todavía no se recibió ninguna'}
                  </p>
                  <Badge tone={device.active ? 'blue' : 'gray'}>
                    {device.active ? 'Clave habilitada' : 'Clave revocada'}
                  </Badge>
                </div>
                {!!device.active && (
                  <div className="button-row">
                    <button
                      type="button"
                      className="btn secondary small"
                      onClick={() => openConnection({ ...device, token: '' })}
                    >
                      <KeyRound size={16} /> Ver conexión
                    </button>
                    <button
                      type="button"
                      className="btn secondary small"
                      onClick={async () => {
                        if (
                          !confirm(
                            '¿Revocar la clave de ' + device.name + '? El equipo dejará de registrar movimientos.',
                          )
                        )
                          return;
                        try {
                          await api('devices/' + device.id, 'PATCH', {});
                          await saved();
                        } catch (reason) {
                          notify((reason as Error).message, true);
                        }
                      }}
                    >
                      <Ban size={16} /> Revocar
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {settings && connection && (
        <Modal title={'Conectar ' + connection.name} wide onClose={closeConnection}>
          <div className="reader-connection">
            <p>
              Guarda esta configuración para el equipo o el programa que enviará sus lecturas. GymPASS no vuelve a
              mostrar la clave después de cerrar.
            </p>
            <Field label="Dirección para enviar lecturas">
              <input readOnly value={settings.access_url} onFocus={(event) => event.currentTarget.select()} />
            </Field>
            <button type="button" className="btn secondary small" onClick={() => void copy(settings.access_url)}>
              <Copy size={16} /> Copiar dirección
            </button>
            <Field
              label="Clave del lector"
              hint="Si ya cerraste la entrega original, pega la clave que guardaste. Si la perdiste, revoca la conexión y crea otra."
            >
              <input
                type={showKey ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                value={connection.token}
                disabled={checking}
                onChange={(event) => {
                  setConnection({ ...connection, token: event.target.value });
                  setChecked(false);
                  setError('');
                }}
              />
            </Field>
            <div className="button-row">
              <button type="button" className="btn secondary small" onClick={() => setShowKey(!showKey)}>
                {showKey ? 'Ocultar clave' : 'Mostrar clave'}
              </button>
              <button
                type="button"
                className="btn secondary small"
                disabled={!settings.token}
                onClick={() => void copy(settings.token)}
              >
                <Copy size={16} /> Copiar clave
              </button>
            </div>
            <div className="button-row">
              <button
                type="button"
                className="btn primary"
                disabled={!settings.token}
                onClick={() => {
                  try {
                    saveReaderConfiguration(settings);
                  } catch (reason) {
                    setError((reason as Error).message);
                  }
                }}
              >
                <Download size={16} /> Guardar configuración
              </button>
              <button
                type="button"
                className="btn secondary"
                disabled={checking || !settings.token}
                onClick={async () => {
                  checkRequest.current?.abort();
                  const controller = new AbortController();
                  checkRequest.current = controller;
                  setChecking(true);
                  setChecked(false);
                  setError('');
                  try {
                    await checkReaderConnection(settings, controller.signal);
                    if (!controller.signal.aborted) setChecked(true);
                  } catch (reason) {
                    if (!controller.signal.aborted) setError((reason as Error).message);
                  } finally {
                    if (!controller.signal.aborted) setChecking(false);
                  }
                }}
              >
                <RefreshCw size={16} /> {checking ? 'Comprobando…' : 'Comprobar conexión'}
              </button>
            </div>
            <p className="helper">
              El archivo contiene la clave: guárdalo en el equipo que usará el lector. La comprobación sólo valida la
              clave y el servidor; no registra entradas ni salidas.
            </p>
            {checked && <p role="status">Clave y servidor verificados. Falta probar una lectura real del equipo.</p>}
            {error && (
              <p className="error-message" role="alert">
                {error}
              </p>
            )}
            <h3>Vincular las lecturas a cada socio</h3>
            {connection.kind === 'qr' ? (
              <p>El lector debe enviar el contenido completo del QR activo del socio.</p>
            ) : (
              <ol>
                <li>
                  {connection.kind === 'biometric'
                    ? 'Registra la huella con el equipo o programa del fabricante y anota el identificador de usuario que devuelve al reconocerla.'
                    : 'Lee la tarjeta y anota el identificador exacto que devuelve el equipo.'}
                </li>
                <li>
                  En Socios, abre su Credencial QR y elige el método{' '}
                  {connection.kind === 'biometric' ? '«Identificador biométrico externo»' : '«Tarjeta NFC»'}. Guarda el
                  mismo identificador que envía el lector.
                </li>
                <li>
                  Realiza una lectura real y comprueba el nombre del socio y si se permitió el acceso. Necesita un plan
                  vigente.
                </li>
              </ol>
            )}
            <a className="text-link" href="#people" onClick={closeConnection}>
              Ir a Socios
            </a>
            {connection.kind !== 'qr' && (
              <p className="helper">
                El identificador debe tener entre 4 y 200 caracteres. Si el equipo devuelve uno corto, el conector puede
                añadir un prefijo, por ejemplo «bio:42»; registra y envía exactamente el mismo valor.
              </p>
            )}
            {connection.kind === 'biometric' && (
              <p className="helper">
                La huella se captura y reconoce en el equipo o programa del fabricante. Crear esta conexión no instala
                su controlador ni su SDK.
              </p>
            )}
            <details className="reader-technical">
              <summary>Datos para el instalador o programa del lector</summary>
              <p>
                Envía un POST a la dirección indicada, con Content-Type: application/json y Authorization: Bearer
                seguido de la clave.
              </p>
              <p>
                El JSON debe incluir «code» con el identificador o QR y «request_id» con un UUID nuevo por lectura.
                Reutiliza el UUID si reintentas esa misma lectura.
              </p>
              <p>
                La respuesta incluye «allowed», «reason», «message» y «person_name». Autoriza la entrada sólo cuando
                «allowed» sea true; una respuesta HTTP 200 también puede indicar acceso denegado.
              </p>
              <p>La prueba de conexión utiliza GET en esta dirección:</p>
              <code>{settings.check_url}</code>
              <p>
                Un equipo que sólo entrega datos a su software o SDK necesita un conector que haga estas solicitudes. Un
                lector no conecta directamente un torniquete desde esta pantalla.
              </p>
            </details>
            <button type="button" className="btn secondary" onClick={closeConnection}>
              Cerrar configuración
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
