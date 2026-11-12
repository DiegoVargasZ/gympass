import { useState, type CSSProperties } from 'react';
import { accentButtonColor, accentPresets } from '../lib/accent';
import { Field } from './ui';
import { usePreferences, updatePreferences, type Preferences } from './preferences';
import './styles/appearance.css';

export default function Appearance() {
  const preferences = usePreferences();
  const [changes, setChanges] = useState<Partial<Preferences>>({});
  const [saveMessage, setSaveMessage] = useState('');
  const draft = { ...preferences, ...changes };
  const dirty = Object.entries(changes).some(([key, value]) => preferences[key as keyof Preferences] !== value);
  const edit = (change: Partial<Preferences>) => {
    setSaveMessage('');
    setChanges((current) => ({ ...current, ...change }));
  };
  const save = () => {
    if (!dirty) return;
    const stored = updatePreferences(changes);
    setChanges({});
    setSaveMessage(stored ? 'Cambios guardados en este navegador.' : 'Cambios aplicados durante esta sesión.');
  };
  return (
    <section
      className="panel padded appearance-panel"
      style={{ '--brand-base': accentButtonColor(draft.accent) } as CSSProperties}
    >
      <fieldset className="appearance-themes">
        <legend>Tema de la interfaz</legend>
        <p className="helper">Elige cómo quieres ver GymPASS en este dispositivo.</p>
        <div className="appearance-theme-options">
          {([
            ['light', 'Claro', 'Superficies claras y fondo suave.'],
            ['dark', 'Oscuro', 'Fondos grises oscuros y superficies suaves.'],
          ] as const).map(([theme, label, description]) => (
            <button
              key={theme}
              type="button"
              className="appearance-theme-option"
              aria-pressed={draft.theme === theme}
              onClick={() => edit({ theme })}
            >
              <span className={`appearance-theme-preview ${theme}`} aria-hidden="true">
                <span className="appearance-preview-sidebar"><i /><i /><i /></span>
                <span className="appearance-preview-content"><i /><i /><span /></span>
              </span>
              <span className="appearance-theme-caption">
                <strong>{label}</strong>
                <span className="appearance-theme-check" aria-hidden="true">{draft.theme === theme ? '✓' : ''}</span>
                <small>{description}</small>
              </span>
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="appearance-accent-picker">
        <legend>Color de acento</legend>
        <p className="helper">Se usa en los botones, el menú activo y los enlaces de este dispositivo, en ambos temas.</p>
        <div className="appearance-accent-options">
          {accentPresets.map((preset) => (
            <button
              key={preset.color}
              type="button"
              className="appearance-accent-swatch"
              style={{ background: preset.color }}
              aria-label={preset.name}
              title={preset.name}
              aria-pressed={draft.accent === preset.color}
              onClick={() => edit({ accent: preset.color })}
            />
          ))}
          <label className="appearance-accent-custom">
            Otro color
            <input
              type="color"
              value={draft.accent}
              onChange={(event) => edit({ accent: event.target.value })}
            />
          </label>
        </div>
      </fieldset>
      <div className="form-grid appearance-density">
        <Field label="Densidad de las tablas" hint="Se recuerda para tu usuario en este navegador.">
          <select
            value={draft.density}
            onChange={(event) => edit({ density: event.target.value as Preferences['density'] })}
          >
            <option value="comfortable">Cómoda</option>
            <option value="compact">Compacta</option>
          </select>
        </Field>
      </div>
      <div className="appearance-save">
        <button type="button" className="btn primary" disabled={!dirty} onClick={save}>Guardar cambios</button>
        <p className="helper" role="status">{saveMessage || (dirty ? 'Tienes cambios sin guardar.' : 'Los ajustes se guardan en este navegador.')}</p>
      </div>
    </section>
  );
}
