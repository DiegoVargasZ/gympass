import { useEffect, useRef, useState } from 'react';
import { isNaturalVoice, voiceGender, voiceIdentity, type VoiceSettings } from '../lib/access-feedback';
import { findGympassVoice, gympassVoiceId, gympassVoices } from '../lib/voice-catalog';
import { Field } from './ui';
import { usePreferences, updatePreferences } from './preferences';
import { accessFeedback, prepareAudio, stopFeedback, subscribeAccessVoices } from './feedback';
import './styles/appearance.css';

const voiceGroups = [
  { gender: 'female', label: 'Voces femeninas de GymPASS' },
  { gender: 'male', label: 'Voces masculinas de GymPASS' },
] as const;

export default function Appearance() {
  const preferences = usePreferences();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [sampleName, setSampleName] = useState('María Pérez');
  const [testing, setTesting] = useState(false);
  const [previewMessage, setPreviewMessage] = useState('');
  const previewId = useRef(0);
  useEffect(() => {
    const unsubscribe = subscribeAccessVoices(setVoices);
    return () => {
      unsubscribe();
      previewId.current++;
      stopFeedback();
    };
  }, []);

  const gympassVoice = findGympassVoice(preferences.voiceURI);
  const selected = gympassVoice || voices.some((voice) => voiceIdentity(voice) === preferences.voiceURI);
  const voiceHint = gympassVoice
    ? 'La primera prueba descarga unos 110 MB. Después, la voz se genera en este dispositivo.'
    : 'Elige una voz de GymPASS o usa las voces en español de tu dispositivo.';
  const cancelPreview = () => {
    previewId.current++;
    setTesting(false);
    setPreviewMessage('');
    stopFeedback();
  };
  const changeVoice = (change: Partial<VoiceSettings>) => {
    cancelPreview();
    updatePreferences(change);
  };
  const selectVoice = (id: string) => {
    const voice = voices.find((choice) => voiceIdentity(choice) === id);
    changeVoice({ voiceURI: id, voiceGender: findGympassVoice(id)?.gender ?? (voice ? voiceGender(voice) : 'auto') });
  };
  const preview = async (direction: 'entry' | 'exit') => {
    const id = ++previewId.current;
    setTesting(true);
    setPreviewMessage(gympassVoice ? `Preparando la voz de ${gympassVoice.name}…` : 'Probando la voz…');
    const played = await accessFeedback(true, true, false, direction, sampleName.trim() || 'María Pérez', preferences, true);
    if (id !== previewId.current) return;
    setTesting(false);
    setPreviewMessage(played === 'none' ? 'No se pudo reproducir el aviso. Comprueba el audio del dispositivo.'
      : played === 'tone' ? 'No se pudo reproducir la voz. Se usó el tono de confirmación.'
      : gympassVoice && played === 'device' ? 'No se pudo cargar esta voz. Se usó una voz del dispositivo.' : '');
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
              else cancelPreview();
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
          <Field label="Voz de los avisos" hint={voiceHint}>
            <select value={selected ? preferences.voiceURI : ''} onChange={(event) => selectVoice(event.target.value)}>
              <option value="">Automática (voz del dispositivo)</option>
              {voiceGroups.map(({ gender, label }) => (
                <optgroup key={gender} label={label}>
                  {gympassVoices.filter((voice) => voice.gender === gender).map((voice) => (
                    <option key={gympassVoiceId(voice)} value={gympassVoiceId(voice)}>{voice.name}</option>
                  ))}
                </optgroup>
              ))}
              {voices.length > 0 && (
                <optgroup label="Voces del dispositivo">
                  {voices.map((voice) => (
                    <option key={voiceIdentity(voice)} value={voiceIdentity(voice)}>
                      {voice.name} · {voice.lang}{isNaturalVoice(voice) && !/natural/i.test(voice.name) ? ' · Natural' : ''}
                    </option>
                  ))}
                </optgroup>
              )}
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
          <button type="button" className="btn secondary" disabled={testing} onClick={() => void preview('entry')}>Probar entrada</button>
          <button type="button" className="btn secondary" disabled={testing} onClick={() => void preview('exit')}>Probar salida</button>
          {testing && <button type="button" className="btn secondary" onClick={cancelPreview}>Detener prueba</button>}
        </div>
        {previewMessage && <p className="helper" role="status">{previewMessage}</p>}
        <p className="helper">La elección se guarda en este navegador.</p>
      </section>
    </section>
  );
}
