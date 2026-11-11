import { useEffect, useRef, useState } from 'react';
import { isNaturalVoice, voiceGender, voiceIdentity, voiceRateLimits } from '../lib/access-feedback';
import { findGympassVoice, gympassVoiceId, gympassVoices } from '../lib/voice-catalog';
import { Field } from './ui';
import { usePreferences, updatePreferences, type Preferences } from './preferences';
import { accessFeedback, prepareAccessVoice, prepareAudio, stopFeedback, subscribeAccessVoices } from './feedback';
import './styles/appearance.css';

const voiceGroups = [
  { gender: 'female', label: 'Voces femeninas de GymPASS' },
  { gender: 'male', label: 'Voces masculinas de GymPASS' },
] as const;

export default function Appearance() {
  const preferences = usePreferences();
  const [changes, setChanges] = useState<Partial<Preferences>>({});
  const [saveMessage, setSaveMessage] = useState('');
  const draft = { ...preferences, ...changes };
  const dirty = Object.entries(changes).some(([key, value]) => preferences[key as keyof Preferences] !== value);
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

  const gympassVoice = findGympassVoice(draft.voiceURI);
  const selected = gympassVoice || voices.some((voice) => voiceIdentity(voice) === draft.voiceURI);
  const voiceHint = gympassVoice
    ? 'La primera prueba descarga unos 110 MB. Después, la voz se genera en este dispositivo.'
    : 'Elige una voz de GymPASS o usa las voces en español de tu dispositivo.';
  const cancelPreview = () => {
    previewId.current++;
    setTesting(false);
    setPreviewMessage('');
    stopFeedback();
  };
  const edit = (change: Partial<Preferences>) => {
    setSaveMessage('');
    setChanges((current) => ({ ...current, ...change }));
  };
  const changeVoice = (change: Partial<Preferences>) => {
    cancelPreview();
    edit(change);
  };
  const save = () => {
    if (!dirty) return;
    if (!draft.sound) cancelPreview();
    else {
      prepareAudio();
      prepareAccessVoice(draft.voiceURI);
    }
    const stored = updatePreferences(changes);
    setChanges({});
    setSaveMessage(stored ? 'Cambios guardados en este navegador.' : 'Cambios aplicados durante esta sesión.');
  };
  const selectVoice = (id: string) => {
    const voice = voices.find((choice) => voiceIdentity(choice) === id);
    changeVoice({ voiceURI: id, voiceGender: findGympassVoice(id)?.gender ?? (voice ? voiceGender(voice) : 'auto') });
  };
  const preview = async (direction: 'entry' | 'exit') => {
    const id = ++previewId.current;
    setTesting(true);
    setPreviewMessage(gympassVoice ? `Preparando la voz de ${gympassVoice.name}…` : 'Probando la voz…');
    const played = await accessFeedback(true, true, false, direction, sampleName.trim() || 'María Pérez', draft, true);
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
            value={draft.theme}
            onChange={(event) => edit({ theme: event.target.value as Preferences['theme'] })}
          >
            <option value="light">Claro</option>
            <option value="dark">Negro</option>
          </select>
        </Field>
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
      <div className="check-list">
        <label>
          <input
            type="checkbox"
            checked={draft.sound}
            onChange={(event) => edit({ sound: event.target.checked })}
          />{' '}
          Voz al registrar entrada y salida
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.vibration}
            onChange={(event) => edit({ vibration: event.target.checked })}
          />{' '}
          Vibración al registrar acceso
        </label>
      </div>
      <section className="access-voice-settings" aria-label="Avisos de voz">
        <h3>Personaliza la voz</h3>
        <div className="form-grid">
          <Field label="Voz de los avisos" hint={voiceHint}>
            <select value={selected ? draft.voiceURI : ''} onChange={(event) => selectVoice(event.target.value)}>
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
          <Field label={`Velocidad de voz (${Math.round(draft.voiceRate * 100)} %)`} hint="De 50 % a 300 %. 100 % es la velocidad normal.">
            <input type="range" {...voiceRateLimits} value={draft.voiceRate} onChange={(event) => changeVoice({ voiceRate: event.target.valueAsNumber })} />
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
        <div className="appearance-save">
          <button type="button" className="btn primary" disabled={!dirty} onClick={save}>Guardar cambios</button>
          <p className="helper" role="status">{saveMessage || (dirty ? 'Tienes cambios sin guardar.' : 'Los ajustes se guardan en este navegador.')}</p>
        </div>
      </section>
    </section>
  );
}
