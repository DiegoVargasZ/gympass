import { useEffect, useState } from 'react';
import { isNaturalVoice, voiceGender, voiceIdentity, type VoiceGender, type VoiceSettings } from '../lib/access-feedback';
import { Field } from './ui';
import { usePreferences, updatePreferences } from './preferences';
import { accessFeedback, prepareAudio, stopFeedback, subscribeAccessVoices } from './feedback';
import './styles/appearance.css';

const voiceGroups = [
  { gender: 'female', label: 'Femeninas' },
  { gender: 'male', label: 'Masculinas' },
  { gender: 'auto', label: 'Otras voces en español' },
] as const;

export default function Appearance() {
  const preferences = usePreferences();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [sampleName, setSampleName] = useState('María Pérez');
  useEffect(() => {
    const unsubscribe = subscribeAccessVoices(setVoices);
    return () => {
      unsubscribe();
      stopFeedback();
    };
  }, []);

  const choices = voices.filter((voice) => preferences.voiceGender === 'auto' || voiceGender(voice) === preferences.voiceGender);
  const selected = choices.some((voice) => voiceIdentity(voice) === preferences.voiceURI);
  const voiceHint = !voices.length
    ? 'No se detectaron voces en español. Puedes probar la voz predeterminada del dispositivo.'
    : !choices.length || (preferences.voiceURI && !selected)
      ? 'La voz guardada no está disponible. Se usará la mejor voz en español disponible.'
      : 'Las voces naturales se priorizan en el modo automático.';
  const changeVoice = (change: Partial<VoiceSettings>) => {
    stopFeedback();
    updatePreferences(change);
  };
  const preview = (direction: 'entry' | 'exit') => {
    accessFeedback(true, true, false, direction, sampleName.trim() || 'María Pérez', preferences);
  };
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
              if (event.target.checked) prepareAudio();
              else stopFeedback();
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
      <section className="access-voice-settings" aria-label="Avisos de voz">
        <h3>Personaliza la voz</h3>
        <div className="form-grid">
          <Field label="Tipo de voz">
            <select value={preferences.voiceGender} onChange={(event) => changeVoice({ voiceGender: event.target.value as VoiceGender, voiceURI: '' })}>
              <option value="auto">Cualquier voz en español</option>
              <option value="female" disabled={!voices.some((voice) => voiceGender(voice) === 'female')}>Femenina</option>
              <option value="male" disabled={!voices.some((voice) => voiceGender(voice) === 'male')}>Masculina</option>
            </select>
          </Field>
          <Field label="Voz de los avisos" hint={voiceHint}>
            <select value={selected ? preferences.voiceURI : ''} disabled={!choices.length} onChange={(event) => changeVoice({ voiceURI: event.target.value })}>
              <option value="">Automática (más natural disponible)</option>
              {voiceGroups.map(({ gender, label }) => {
                const group = choices.filter((voice) => voiceGender(voice) === gender);
                return group.length > 0 && (
                  <optgroup key={gender} label={label}>
                    {group.map((voice) => (
                      <option key={voiceIdentity(voice)} value={voiceIdentity(voice)}>
                        {voice.name} · {voice.lang}{isNaturalVoice(voice) && !/natural/i.test(voice.name) ? ' · Natural' : ''}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </Field>
          <Field label={`Velocidad de voz (${Math.round(preferences.voiceRate * 100)} %)`}>
            <input type="range" min="0.8" max="1.2" step="0.01" value={preferences.voiceRate} onChange={(event) => changeVoice({ voiceRate: event.target.valueAsNumber })} />
          </Field>
          <Field label="Nombre para probar">
            <input value={sampleName} maxLength={80} onChange={(event) => setSampleName(event.target.value)} />
          </Field>
        </div>
        <div className="voice-preview-actions">
          <button type="button" className="btn secondary" onClick={() => preview('entry')}>Probar entrada</button>
          <button type="button" className="btn secondary" onClick={() => preview('exit')}>Probar salida</button>
        </div>
        <p className="helper">Las voces disponibles dependen de tu dispositivo y navegador. La elección se guarda en este navegador.</p>
      </section>
    </section>
  );
}
