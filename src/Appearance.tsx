import { Field } from './ui';
import { usePreferences, updatePreferences } from './preferences';
import { accessFeedback, prepareAudio } from './feedback';

export default function Appearance() {
  const preferences = usePreferences();
  return (
    <section className="panel padded appearance-panel">
      <div className="form-grid">
        <Field label="Tema">
          <select
            value={preferences.theme}
            onChange={(event) => updatePreferences({ theme: event.target.value as typeof preferences.theme })}
          >
            <option value="light">Claro</option>
            <option value="dark">Negro</option>
          </select>
        </Field>
        <Field label="Densidad de las tablas" hint="Se recuerda para tu usuario en este navegador.">
          <select
            value={preferences.density}
            onChange={(event) => updatePreferences({ density: event.target.value as typeof preferences.density })}
          >
            <option value="comfortable">Cómoda</option>
            <option value="compact">Compacta</option>
          </select>
        </Field>
      </div>
      <div className="check-list">
        <label>
          <input
            type="checkbox"
            checked={preferences.sound}
            onChange={(event) => {
              prepareAudio();
              updatePreferences({ sound: event.target.checked });
            }}
          />{' '}
          Voz al registrar entrada y salida
        </label>
        <label>
          <input
            type="checkbox"
            checked={preferences.vibration}
            onChange={(event) => updatePreferences({ vibration: event.target.checked })}
          />{' '}
          Vibración al registrar acceso
        </label>
      </div>
      <button
        type="button"
        className="btn secondary"
        onClick={() => {
          prepareAudio();
          accessFeedback(true, preferences.sound, preferences.vibration, 'entry', 'María Pérez');
        }}
      >
        Probar confirmación
      </button>
      <p className="helper">
        Las señales dependen de los permisos y capacidades del dispositivo. Los cambios se aplican en este navegador.
      </p>
    </section>
  );
}
