import { serverOrigin } from './connection-mode';

export default function ServerAccessLink() {
  const desktop = /GymPASSConnection\//.test(navigator.userAgent);
  const configured = /GymPASSServer\/([^\s]+)/.exec(navigator.userAgent)?.[1];
  let server = 'https://gympass.site';
  try {
    if (configured) server = serverOrigin(decodeURIComponent(configured));
  } catch {}
  const destination = desktop
    ? 'gympass-connection://apply/?' + new URLSearchParams({ mode: 'remote', server })
    : server + '/';
  return (
    <div className="server-access">
      <p className="helper">Este inicio de sesión usa la base de esta computadora. Si creaste tu gimnasio en el servidor, entra con tu cuenta allí.</p>
      <a className="btn secondary" href={destination}>Usar mi cuenta del servidor</a>
    </div>
  );
}
