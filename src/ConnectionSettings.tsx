import { useState } from 'react';
import { HardDrive, Server } from 'lucide-react';
import { Field, Form } from './ui';
import { connectionDestination, connectionMode } from './connection-mode';
import { api } from './api';

export default function ConnectionSettings({ platform }: { platform: boolean }) {
  const desktop = /GymPASSConnection\//.test(navigator.userAgent);
  const current = desktop ? connectionMode(navigator.userAgent, location.hostname) : platform ? 'remote' : 'local';
  const savedWork = /GymPASSWork\/(local|server)\b/.exec(navigator.userAgent)?.[1];
  const [mode, setMode] = useState<'local' | 'remote'>(savedWork === 'local' || current === 'local' ? 'local' : 'remote');
  const nativeServer = /GymPASSServer\/([^\s]+)/.exec(navigator.userAgent)?.[1];
  const [server, setServer] = useState(
    nativeServer ? decodeURIComponent(nativeServer) : current === 'remote' ? location.origin : 'https://gympass.site',
  );
  const [local, setLocal] = useState(current === 'local' ? location.origin : 'http://localhost:3000');
  return (
    <section className="panel padded connection-settings" aria-labelledby="connection-mode-title">
      <h3 id="connection-mode-title">Servidor y copia local de tu gimnasio</h3>
      <p>Usa los mismos socios, planes, cobros y credenciales en los dos modos. La aplicación guarda una copia automáticamente para seguir trabajando sin Internet.</p>
      <p className="helper">
        Conexión actual:{' '}
        <strong>
          {current === 'local' ? 'Base local anterior' : current === 'replica' ? savedWork === 'local' ? 'Copia local sincronizada' : 'Servidor con copia automática' : 'Servidor'}
        </strong>
        .
      </p>
      <Form
        label={desktop ? 'Guardar conexión y reiniciar' : 'Abrir conexión'}
        onSubmit={async () => {
          if (desktop && current === 'replica') {
            const status = await api<{ conflict?: string; revoked?: boolean; pending: number; error?: string }>('cloud-sync/run', 'POST');
            if (status.conflict || status.revoked) throw Error(status.conflict || 'Vuelve a vincular esta copia con tu cuenta antes de cambiar la conexión.');
            if (mode === 'remote' && status.pending) throw Error('Conecta esta computadora a Internet para enviar sus cambios pendientes antes de abrir el servidor.');
          }
          location.assign(
            connectionDestination(
              desktop ? 'replica' : mode === 'local' ? 'local' : 'remote',
              server,
              local,
              desktop,
              mode === 'local' ? 'local' : 'server',
            ),
          );
        }}
      >
        <fieldset className="connection-options">
          <legend>Modo de trabajo</legend>
          <label className="connection-option">
            <input
              type="radio"
              name="mode"
              value="local"
              checked={mode === 'local'}
              onChange={() => setMode('local')}
            />
            <HardDrive size={22} aria-hidden="true" />
            <span>
              <strong>Copia local de este gimnasio</strong>
              <small>Conserva los datos del servidor y permite trabajar sin Internet. Los cambios se envían al reconectar.</small>
            </span>
          </label>
          <label className="connection-option">
            <input
              type="radio"
              name="mode"
              value="remote"
              checked={mode === 'remote'}
              onChange={() => setMode('remote')}
            />
            <Server size={22} aria-hidden="true" />
            <span>
              <strong>Servidor y copia automática</strong>
              <small>Trabaja conectado y mantén una copia del mismo gimnasio en esta computadora.</small>
            </span>
          </label>
        </fieldset>
        {mode === 'remote' ? (
          <>
            <Field label="Dirección del servidor">
              <input
                type="url"
                required
                value={server}
                onChange={(e) => setServer(e.target.value)}
                placeholder="https://gympass.site"
                autoComplete="url"
              />
            </Field>
            {desktop && <p className="helper">La copia local está incluida y se mantiene actualizada automáticamente.</p>}
          </>
        ) : (
          !desktop && (
            <Field
              label="Dirección local"
              hint="GymPASS de escritorio o su servidor local debe estar abierto en esta computadora."
            >
              <input
                type="url"
                required
                value={local}
                onChange={(e) => setLocal(e.target.value)}
                placeholder="http://localhost:3000"
              />
            </Field>
          )
        )}
        <p className="helper">
          {desktop
            ? 'Los dos modos utilizan la misma copia del gimnasio. En el primer acceso, inicia sesión con tu cuenta administradora del servidor: los datos se descargarán antes de entrar. La base independiente de versiones anteriores se conserva aparte.'
            : 'Esta página trabaja con el servidor. Para usar su copia local, abre GymPASS para Windows en esta computadora e inicia sesión allí una vez con Internet. Después puedes abrir esa misma copia desde este navegador.'}
        </p>
      </Form>
    </section>
  );
}
