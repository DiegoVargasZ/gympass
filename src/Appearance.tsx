import { useState, type CSSProperties } from 'react';
import { accentButtonColor, accentPresets } from '../lib/accent';
import { Field } from './ui';
import { usePreferences, saveAppearance, type Preferences } from './preferences';
import './styles/appearance.css';

export default function Appearance() {
  const preferences = usePreferences();
  const [changes, setChanges] = useState<Partial<Preferences>>({});
  const [saveMessage, setSaveMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const editable = preferences.appearanceEditable !== false;
  const draft = { ...preferences, ...changes };
  const dirty = Object.entries(changes).some(([key, value]) => preferences[key as keyof Preferences] !== value);
  const edit = (change: Partial<Preferences>) => {
    setSaveMessage('');
    setChanges((current) => ({ ...current, ...change }));
  };
  const save = async () => {
    if (!dirty || saving || !editable) return;
    setSaving(true);
    try {
      await saveAppearance(changes);
      setChanges({});
      setSaveMessage('Apariencia guardada para este gimnasio. Se comparte al sincronizar los dispositivos.');
    } catch (cause) { setSaveMessage((cause as Error).message); }
    finally { setSaving(false); }
  };
  return (
    <section
      className="panel padded appearance-panel"
      style={{ '--brand-base': accentButtonColor(draft.accent) } as CSSProperties}
    >
      <fieldset className="appearance-themes" disabled={!editable || saving}>
        <legend>Tema de la interfaz</legend>
        <p className="helper">Tema compartido por todos los dispositivos de este gimnasio.</p>
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
      <fieldset className="appearance-accent-picker" disabled={!editable || saving}>
        <legend>Color de acento</legend>
        <p className="helper">Se usa en los botones, el menú activo y los enlaces del gimnasio, en ambos temas.</p>
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
        <Field label="Densidad de las tablas" hint="Se comparte con los dispositivos de este gimnasio.">
          <select
            disabled={!editable || saving}
            value={draft.density}
            onChange={(event) => edit({ density: event.target.value as Preferences['density'] })}
          >
            <option value="comfortable">Cómoda</option>
            <option value="compact">Compacta</option>
          </select>
        </Field>
      </div>
      <div className="appearance-save">
        <button type="button" className="btn primary" disabled={!dirty || saving || !editable} onClick={() => void save()}>{saving ? 'Guardando…' : 'Guardar cambios'}</button>
        <p className="helper" role="status">{saveMessage || (!editable ? 'Un administrador puede cambiar la apariencia del gimnasio.' : dirty ? 'Tienes cambios sin guardar.' : 'Los ajustes pertenecen a este gimnasio, también en las copias sin conexión.')}</p>
      </div>
    </section>
  );
}
