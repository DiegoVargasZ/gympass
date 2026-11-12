import { Download, Monitor, Smartphone } from 'lucide-react';
import './styles/app-downloads.css';

const release = 'https://github.com/DiegoVargasZ/gympass/releases/download/v5.1.0/';
const androidApk = release + 'GymPASS-Android-5.1.0.apk';

export default function AppDownloads() {
  if (
    /GymPASSConnection\/|GymPASS-(?:Android|iOS)\/|Electron\//.test(navigator.userAgent) ||
    'ReactNativeWebView' in window
  )
    return null;

  return (
    <section className="app-downloads" aria-labelledby="app-downloads-title">
      <h3 id="app-downloads-title">
        <Download size={18} aria-hidden="true" /> Descarga GymPASS
      </h3>
      <p>También puedes usar la aplicación en tu celular o computadora.</p>
      <div className="app-download-options">
        <a className="app-download" href={androidApk} target="_blank" rel="noopener noreferrer">
          <Smartphone size={24} aria-hidden="true" />
          <span>
            <strong>Móvil Android</strong>
            <small>Descargar APK · v5.1.0</small>
          </span>
          <Download size={16} aria-hidden="true" />
        </a>
        <a
          className="app-download"
          href={release + 'GymPASS-Setup-5.1.0.exe'}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Monitor size={24} aria-hidden="true" />
          <span>
            <strong>Escritorio Windows</strong>
            <small>Descargar instalador · v5.1.0</small>
          </span>
          <Download size={16} aria-hidden="true" />
        </a>
      </div>
    </section>
  );
}
