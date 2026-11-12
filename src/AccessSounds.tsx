import { useEffect, useRef, useState } from 'react';
import { isNaturalVoice, recordedAccessVoice, voiceGender, voiceIdentity, voiceRateLimits } from '../lib/access-feedback';
import { findGympassVoice, gympassVoiceId, gympassVoices } from '../lib/voice-catalog';
import { Field } from './ui';
import { usePreferences, updatePreferences, type Preferences } from './preferences';
import { accessFeedback, prepareAccessVoice, prepareAudio, stopFeedback, subscribeAccessVoices } from './feedback';
import './styles/appearance.css';

const voiceGroups = [
  { gender: 'female', label: 'Voces femeninas de GymPASS' },
  { gender: 'male', label: 'Voces masculinas de GymPASS' },
] as const;

/** Avisos de entrada y salida: audios, voces y vibración de este dispositivo. */
export default function AccessSounds() {
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
  const recorded = draft.voiceURI === recordedAccessVoice;
  const selected = recorded || gympassVoice || voices.some((voice) => voiceIdentity(voice) === draft.voiceURI);
  const voiceHint = recorded
    ? 'Tus grabaciones: «Acceso permitido» cuando el código es válido y «Acceso denegado» cuando no lo es o está vencido. Se reproducen sin añadir nombres.'
    : gympassVoice
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
  const preview = async (direction: 'entry' | 'exit', allowed = true) => {
    const id = ++previewId.current;
    setTesting(true);
    setPreviewMessage(recorded ? 'Reproduciendo el audio…' : gympassVoice ? `Preparando la voz de ${gympassVoice.name}…` : 'Probando la voz…');
    const played = await accessFeedback(allowed, true, false, direction, sampleName.trim() || 'María Pérez', draft, true);
    if (id !== previewId.current) return;
    setTesting(false);
    setPreviewMessage(played === 'none' ? 'No se pudo reproducir el aviso. Comprueba el audio del dispositivo.'
      : played === 'tone' ? 'No se pudo reproducir el aviso seleccionado. Se usó el tono de confirmación.'
      : played === 'recorded' ? `Audio de acceso ${allowed ? 'permitido' : 'denegado'} reproducido.`
      : gympassVoice && played === 'device' ? 'No se pudo cargar esta voz. Se usó una voz del dispositivo.' : '');
  };
  return (
    <section className="panel padded appearance-panel">
      <section className="access-voice-settings" aria-label="Avisos de acceso">
        <h3>Avisos de acceso</h3>
        <div className="check-list">
        <label>
          <input
            type="checkbox"
            checked={draft.sound}
            onChange={(event) => edit({ sound: event.target.checked })}
          />{' '}
          Reproducir avisos de entrada y salida
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
      </section>
      <section className="access-voice-settings" aria-label="Avisos de voz">
        <h3>Sonidos y voces</h3>
        <div className="form-grid">
          <Field label="Voz de los avisos" hint={voiceHint}>
            <select value={selected ? draft.voiceURI : ''} onChange={(event) => selectVoice(event.target.value)}>
              <option value={recordedAccessVoice}>Audios de acceso permitido y denegado</option>
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
          {!recorded && <Field label={`Velocidad de voz (${Math.round(draft.voiceRate * 100)} %)`} hint="De 50 % a 300 %. 100 % es la velocidad normal.">
            <input type="range" {...voiceRateLimits} value={draft.voiceRate} onChange={(event) => changeVoice({ voiceRate: event.target.valueAsNumber })} />
          </Field>}
          {!recorded && <Field label="Nombre para probar">
            <input value={sampleName} maxLength={80} onChange={(event) => setSampleName(event.target.value)} />
          </Field>}
        </div>
        <div className="voice-preview-actions">
          {recorded ? (
            <>
              <button type="button" className="btn secondary" disabled={testing} onClick={() => void preview('entry')}>Probar acceso permitido</button>
              <button type="button" className="btn secondary" disabled={testing} onClick={() => void preview('entry', false)}>Probar acceso denegado</button>
            </>
          ) : (
            <>
              <button type="button" className="btn secondary" disabled={testing} onClick={() => void preview('entry')}>Probar entrada</button>
              <button type="button" className="btn secondary" disabled={testing} onClick={() => void preview('exit')}>Probar salida</button>
            </>
          )}
          {testing && <button type="button" className="btn secondary" onClick={cancelPreview}>Detener prueba</button>}
        </div>
        {previewMessage && <p className="helper" role="status">{previewMessage}</p>}
      </section>
      <div className="appearance-save">
        <button type="button" className="btn primary" disabled={!dirty} onClick={save}>Guardar cambios</button>
        <p className="helper" role="status">{saveMessage || (dirty ? 'Tienes cambios sin guardar.' : 'Los ajustes se guardan en este navegador.')}</p>
      </div>
    </section>
  );
}
