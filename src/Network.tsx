import { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  Copy,
  Eye,
  EyeOff,
  LoaderCircle,
  Monitor,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Wifi,
} from 'lucide-react';
import { api } from './api';
import { connectionQr } from '../lib/connection-qr';
import type { CameraLinkReport } from '../lib/client-types';
import { copyText } from './browser';
import { Badge, Field, Form, type Notify } from './ui';

export type NetworkInfo = {
  computerName: string;
  computerIp: string | null;
  phoneHttpUrl: string | null;
  phoneHttpsUrl: string | null;
  local: string;
  httpUrls: string[];
  httpsUrls: string[];
  setupUrls: string[];
  listensOnNetwork: boolean;
  https: boolean;
  httpsReady: boolean;
  desktop: boolean;
  camera: CameraLinkReport;
  direct: { state: string; network: string; password?: string; computerIp: string; detail: string } | null;
  certificate: { name: string; fingerprint: string } | null;
  wifi: { ssid: string | null; access: string; blocked: number[]; detail: string } | null;
};

function useNetworkInfo() {
  const [info, setInfo] = useState<NetworkInfo | null>(null),
    [error, setError] = useState('');
  async function refresh() {
    try {
      setInfo(await api<NetworkInfo>('network'));
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    }
  }
  useEffect(() => {
    let live = true;
    const update = () => {
      if (live) void refresh();
    };
    update();
    const interval = setInterval(update, 5000);
    window.addEventListener('online', update);
    window.addEventListener('focus', update);
    return () => {
      live = false;
      clearInterval(interval);
      window.removeEventListener('online', update);
      window.removeEventListener('focus', update);
    };
  }, []);
  return { info, error, refresh };
}
function CopyButton({ value, label, notify }: { value: string; label: string; notify: Notify }) {
  return (
    <button
      className="icon-btn"
      type="button"
      aria-label={label}
      onClick={async () => {
        try {
          await copyText(value);
          notify('Copiado');
        } catch {
          notify('Selecciona y copia el texto.', true);
        }
      }}
    >
      <Copy size={16} />
    </button>
  );
}
function Qr({ value, label }: { value: string; label: string }) {
  return value.length <= 1024 ? (
    <img
      className="phone-qr-image"
      src={'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(connectionQr(value))}
      alt={label}
    />
  ) : null;
}

function AutomaticCamera({
  info,
  admin,
  notify,
  refresh,
}: {
  info: NetworkInfo;
  admin: boolean;
  notify: Notify;
  refresh: () => Promise<void>;
}) {
  const camera = info.camera;
  const [busy, setBusy] = useState(false);
  return (
    <section className="automatic-camera panel padded">
      <div className="section-heading">
        <div>
          <h2>Escanea, permite la cámara y listo.</h2>
        </div>
        <Badge tone={camera?.state === 'ready' ? 'green' : 'blue'}>
          {camera?.state === 'ready' ? 'Enlace listo' : camera?.state === 'starting' ? 'Preparando…' : 'Sin conexión'}
        </Badge>
      </div>
      {camera?.state === 'ready' && camera.url ? (
        <div className="automatic-camera-grid">
          <div className="automatic-camera-qr">
            <Qr value={camera.url} label="QR para abrir la cámara sin instalar certificados" />
          </div>
          <div>
            <ol>
              <li>Abre este QR con la cámara del teléfono.</li>
              <li>Inicia sesión en GymPASS.</li>
              <li>
                Pulsa <strong>Permitir</strong> cuando el navegador solicite la cámara.
              </li>
            </ol>
            <p>No necesitas instalar certificados ni perfiles.</p>
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  await copyText(camera.url!);
                  notify('Enlace de cámara copiado');
                } catch {
                  notify('No se pudo copiar el enlace.', true);
                }
              }}
            >
              <Copy size={16} /> Copiar enlace de cámara
            </button>
          </div>
        </div>
      ) : (
        <div className="phone-preparing" role="status">
          {camera?.state === 'starting' && <LoaderCircle size={28} className="spin" />}
          <strong>{camera?.detail || 'Abre el portable actualizado para preparar la conexión automática.'}</strong>
          <p>
            La computadora y el teléfono necesitan internet. GymPASS volverá a intentar la conexión automáticamente.
          </p>
          {admin && camera?.state !== 'disabled' && (
            <button
              className="btn secondary"
              disabled={busy || camera?.state === 'starting'}
              onClick={async () => {
                setBusy(true);
                try {
                  await api('network/camera', 'POST', {});
                  await refresh();
                } catch (reason) {
                  notify((reason as Error).message, true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <RefreshCw size={16} /> Reintentar conexión
            </button>
          )}
        </div>
      )}
      <p className="helper">
        Conexión por internet mediante Cloudflare. Mantén GymPASS abierto. El enlace cambia al reiniciar o reconectar:
        usa el QR actual. Si el servicio no responde, la conexión local sigue disponible abajo.
      </p>
    </section>
  );
}
export default function Network({ notify, admin = false }: { notify: Notify; admin?: boolean }) {
  const { info, error, refresh } = useNetworkInfo();
  const [visible, setVisible] = useState(false),
    [busy, setBusy] = useState(false);
  const direct = info?.direct,
    ready = direct?.state === 'on',
    starting = direct?.state === 'starting';
  const phoneUrl = info?.phoneHttpUrl ? info.phoneHttpUrl + '/#access' : '';
  const escaped = (value: string) => value.replace(/[\\;,:\"]/g, '\\$&');
  const wifiQr =
    ready && direct.password ? `WIFI:T:WPA;S:${escaped(direct.network)};P:${escaped(direct.password)};;` : '';
  async function retry() {
    setBusy(true);
    try {
      await api('network/direct', 'POST', {});
      notify('Preparando la conexión directa');
      await refresh();
    } catch (reason) {
      notify((reason as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="phone-workspace">
      <section className="phone-intro">
        <div className="phone-intro-icon">
          <Smartphone size={30} />
        </div>
        <div>
          <h2>Tu celular también es un lector.</h2>
          <p>Abre el enlace seguro del teléfono y permite la cámara. Todos trabajan con los mismos datos.</p>
        </div>
        <Badge tone={info?.camera?.state === 'ready' ? 'green' : info?.camera?.state === 'starting' ? 'blue' : 'gray'}>
          {info?.camera?.state === 'ready' ? (
            <>
              <Check size={14} /> Conexión lista
            </>
          ) : info?.camera?.state === 'starting' ? (
            <>
              <LoaderCircle size={14} className="spin" /> Preparando
            </>
          ) : (
            'Servidor local'
          )}
        </Badge>
      </section>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {!info ? (
        <div className="panel padded">
          <LoaderCircle className="spin" size={22} /> Consultando conexión…
        </div>
      ) : (
        <>
          <AutomaticCamera info={info} admin={admin} notify={notify} refresh={refresh} />
          {admin && <FixedCameraSettings notify={notify} refresh={refresh} />}
          <details className="panel padded phone-details">
            <summary>Conexión local avanzada por Wi-Fi</summary>
            <div className="phone-steps">
              <section className="phone-step">
                <div className="phone-step-title">
                  <span>1</span>
                  <div>
                    <h3>Conéctate a la red de la PC</h3>
                    <p>Desde los ajustes Wi-Fi de tu teléfono.</p>
                  </div>
                </div>
                {ready ? (
                  <>
                    <div className="phone-value">
                      <label>RED WI-FI</label>
                      <div>
                        <strong>{direct.network}</strong>
                        <CopyButton value={direct.network} label="Copiar nombre de Wi-Fi" notify={notify} />
                      </div>
                    </div>
                    {direct.password && (
                      <div className="phone-value">
                        <label>CONTRASEÑA</label>
                        <div>
                          <code>{visible ? direct.password : '••••••••••••••••'}</code>
                          <button
                            className="icon-btn"
                            type="button"
                            aria-label={visible ? 'Ocultar contraseña Wi-Fi' : 'Mostrar contraseña Wi-Fi'}
                            onClick={() => setVisible((value) => !value)}
                          >
                            {visible ? <EyeOff size={16} /> : <Eye size={16} />}
                          </button>
                          <CopyButton value={direct.password} label="Copiar contraseña Wi-Fi" notify={notify} />
                        </div>
                      </div>
                    )}
                    {wifiQr && wifiQr.length <= 1024 && (
                      <div className="phone-qr-block">
                        <Qr value={wifiQr} label="QR para conectarte al Wi-Fi de GymPASS" />
                        <div>
                          <strong>También puedes escanearlo</strong>
                          <p>La cámara del teléfono puede reconocer esta red y completar la contraseña.</p>
                        </div>
                      </div>
                    )}
                  </>
                ) : starting ? (
                  <div className="phone-preparing">
                    <LoaderCircle size={28} className="spin" />
                    <strong>Creando la red de GymPASS…</strong>
                    <p>Puedes seguir trabajando mientras termina.</p>
                  </div>
                ) : (
                  <>
                    <div className="phone-fallback">
                      <Wifi size={25} />
                      <strong>{info.wifi?.ssid || 'La misma red de la computadora'}</strong>
                      <p>
                        {direct?.detail ||
                          'Conecta el teléfono al mismo Wi-Fi de la PC. La conexión directa se prepara al abrir la aplicación de escritorio.'}
                      </p>
                    </div>
                    {info.desktop && admin && (
                      <button className="btn secondary" disabled={busy} onClick={() => void retry()}>
                        <RefreshCw size={16} />
                        {busy ? 'Preparando…' : 'Preparar red directa'}
                      </button>
                    )}
                  </>
                )}
              </section>
              <section className="phone-step">
                <div className="phone-step-title">
                  <span>2</span>
                  <div>
                    <h3>Abre GymPASS en el celular</h3>
                    <p>Escanea este QR después de conectarte.</p>
                  </div>
                </div>
                {phoneUrl ? (
                  <>
                    <div className="phone-address-qr">
                      <Qr value={phoneUrl} label="QR para abrir GymPASS en el teléfono" />
                    </div>
                    <div className="phone-value">
                      <label>DIRECCIÓN DEL SISTEMA</label>
                      <div>
                        <code>{phoneUrl}</code>
                        <CopyButton value={phoneUrl} label="Copiar dirección de GymPASS" notify={notify} />
                      </div>
                    </div>
                    <p className="helper">
                      Guarda esta página en la pantalla de inicio del teléfono para volver a abrirla fácilmente.
                    </p>
                  </>
                ) : (
                  <div className="phone-fallback">
                    <Monitor size={28} />
                    <strong>Conecta la computadora a una red</strong>
                    <p>La dirección del sistema aparecerá aquí automáticamente.</p>
                  </div>
                )}
              </section>
            </div>
            <section className="phone-camera-note">
              <ShieldCheck size={26} />
              <div>
                <h3>Cámara local sin internet</h3>
                <p>
                  Para escanear con la cámara del teléfono, instala el certificado de esta PC siguiendo la guía. Después
                  podrás volver a entrar con la conexión segura.
                </p>
              </div>
              {info.phoneHttpUrl && info.https && (
                <a className="btn secondary" href={info.phoneHttpUrl + '/conectar'} target="_blank" rel="noreferrer">
                  Abrir guía del teléfono <ArrowUpRight size={17} />
                </a>
              )}
            </section>
          </details>
          <p className="helper">
            Mantén la computadora encendida y GymPASS abierto. La red directa se prepara desde el portable y la
            aplicación instalada.
          </p>
          <details className="panel padded phone-details">
            <summary>Información de la computadora y la red</summary>
            <p>
              <strong>{info.computerName}</strong> · IP {info.computerIp || 'Sin red'}
            </p>
            {info.httpsUrls.map((url) => (
              <div className="address-row" key={url}>
                <code>{url}</code>
                <CopyButton value={url} label={'Copiar ' + url} notify={notify} />
              </div>
            ))}
            <p className="helper">
              {info.wifi?.access === 'abierto'
                ? 'Windows permite el acceso a GymPASS desde la red local.'
                : info.wifi?.detail || 'Puedes revisar el acceso de Windows si otro dispositivo no conecta.'}
            </p>
            {admin && (
              <button
                className="btn secondary small"
                onClick={async () => {
                  try {
                    await api('network/check', 'POST', {});
                    await refresh();
                    notify('Red comprobada');
                  } catch (reason) {
                    notify((reason as Error).message, true);
                  }
                }}
              >
                Comprobar acceso
              </button>
            )}
            {info.certificate && (
              <code>
                {info.certificate.name} · SHA-256 {info.certificate.fingerprint}
              </code>
            )}
          </details>
        </>
      )}
    </div>
  );
}
function FixedCameraSettings({ notify, refresh }: { notify: Notify; refresh: () => Promise<void> }) {
  const [config, setConfig] = useState<{ mode: string; hostname: string; port: number } | null>(null),
    [mode, setMode] = useState('automatic'),
    [error, setError] = useState('');
  useEffect(() => {
    api('network/camera-config')
      .then((value) => {
        setConfig(value);
        setMode(value.mode);
      })
      .catch((e) => setError(e.message));
  }, []);
  return (
    <details className="panel padded phone-details">
      <summary>Dirección fija del teléfono (opcional)</summary>
      <p>
        El enlace automático funciona sin cuenta ni dominio. Para conservar la misma dirección al volver a abrir
        GymPASS, configura aquí un túnel de tu cuenta de Cloudflare.
      </p>
      {error ? (
        <p className="helper">{error}</p>
      ) : (
        config && (
          <Form
            label="Guardar conexión del teléfono"
            onSubmit={async (f) => {
              const value = await api('network/camera-config', 'PATCH', {
                mode,
                hostname: f.get('hostname') || undefined,
                port: Number(f.get('port') || 3489),
                token: f.get('token') || undefined,
              });
              setConfig(value);
              notify(
                mode === 'fixed'
                  ? 'Dirección fija guardada. Se comprobará la conexión.'
                  : 'Conexión automática activada.',
              );
              await refresh();
            }}
          >
            <Field label="Tipo de dirección">
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="automatic">Automática · sin cuenta ni dominio</option>
                <option value="fixed">Fija · mi dominio y túnel Cloudflare</option>
              </select>
            </Field>
            {mode === 'fixed' && (
              <>
                <p className="helper">
                  En Cloudflare, crea un túnel administrado y publica tu subdominio apuntando a HTTP, 127.0.0.1 y el
                  puerto indicado abajo. Después copia el token del túnel en este formulario.
                </p>
                <Field label="Nombre de dominio del teléfono">
                  <input
                    name="hostname"
                    defaultValue={config.hostname}
                    placeholder="acceso.tudominio.com"
                    required
                    maxLength={253}
                  />
                </Field>
                <Field label="Puerto local del túnel">
                  <input name="port" type="number" defaultValue={config.port} min={1024} max={65535} required />
                </Field>
                <Field
                  label="Token del túnel"
                  hint={
                    config.mode === 'fixed'
                      ? 'Déjalo vacío para conservar el token guardado.'
                      : 'Pega solo el token; se guardará cifrado en esta computadora.'
                  }
                >
                  <input
                    name="token"
                    type="password"
                    autoComplete="off"
                    required={config.mode !== 'fixed'}
                    maxLength={8192}
                  />
                </Field>
                <a href="https://developers.cloudflare.com/tunnel/get-started/" target="_blank" rel="noreferrer">
                  Guía de configuración de Cloudflare
                </a>
              </>
            )}
          </Form>
        )
      )}
    </details>
  );
}
