import {
  defaultVoiceSettings, feedbackAnnouncement, feedbackSound, normalizeVoiceSettings, preferredSpanishVoice,
  recordedAccessSound, recordedAccessVoice, voiceGender, voiceIdentity, type VoiceSettings,
} from '../lib/access-feedback';
import { findGympassVoice, type GympassVoice } from '../lib/voice-catalog';
let context: AudioContext | undefined;
const buffers = new Map<string, Promise<AudioBuffer>>();
let playing: AudioBufferSourceNode | undefined;
let sequence = 0;
let activeSpeech: { utterance: SpeechSynthesisUtterance; stop: () => void } | undefined;

function deadline<T>(work: Promise<T>, milliseconds: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), milliseconds);
    void work.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

async function playGympassVoice(voice: GympassVoice, text: string, rate: number, current: number, preview: boolean) {
  try {
    if (!context || typeof Worker === 'undefined') return false;
    const engine = await import('./voice-engine');
    const ready = engine.prepareGympassVoice(voice.preset).then(() => true);
    if (!(preview ? await ready : await deadline(ready, 1800)) || current !== sequence) return false;
    const work = engine.renderGympassVoice(voice.preset, text, rate);
    const audio = preview ? await work : await deadline(work, 3000);
    if (!audio || current !== sequence || context.state !== 'running') return false;
    const decoded = context.createBuffer(1, audio.samples.length, audio.sampleRate);
    decoded.copyToChannel(audio.samples, 0);
    return playBuffer(decoded);
  } catch {
    return false;
  }
}

function speechEngine() {
  return typeof window !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined'
    ? window.speechSynthesis
    : undefined;
}

function availableVoices(engine: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const voices = engine.getVoices();
  if (voices.length) return Promise.resolve(voices);
  return new Promise((resolve) => {
    const ready = () => {
      clearTimeout(timer);
      engine.removeEventListener('voiceschanged', ready);
      resolve(engine.getVoices());
    };
    const timer = setTimeout(ready, 700);
    engine.addEventListener('voiceschanged', ready);
  });
}

export function subscribeAccessVoices(listener: (voices: SpeechSynthesisVoice[]) => void) {
  const engine = speechEngine();
  const update = () => {
    let voices: SpeechSynthesisVoice[] = [];
    try { voices = engine?.getVoices() || []; } catch {}
    const seen = new Set<string>();
    listener(voices.filter((voice) => {
      const id = voiceIdentity(voice);
      if (!/^es(?:[-_]|$)/i.test(voice.lang) || seen.has(id)) return false;
      seen.add(id);
      return true;
    }));
  };
  update();
  engine?.addEventListener('voiceschanged', update);
  return () => engine?.removeEventListener('voiceschanged', update);
}

function speak(engine: SpeechSynthesis, text: string, rate: number, voice?: SpeechSynthesisVoice) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = voice?.lang.replaceAll('_', '-') || 'es-BO';
  if (voice) utterance.voice = voice;
  utterance.rate = rate;
  return new Promise<boolean>((resolve) => {
    const finish = (spoken: boolean) => {
      clearTimeout(timer);
      utterance.onstart = utterance.onend = utterance.onerror = null;
      if (activeSpeech?.utterance === utterance) activeSpeech = undefined;
      resolve(spoken);
    };
    // Some engines fail silently: keep an audible confirmation if speech never starts.
    const timer = setTimeout(() => {
      finish(false);
      try { engine.cancel(); } catch {}
    }, 3000);
    activeSpeech = { utterance, stop: () => finish(true) };
    utterance.onstart = () => clearTimeout(timer);
    utterance.onend = () => finish(true);
    utterance.onerror = () => finish(false);
    try {
      engine.speak(utterance);
    } catch {
      finish(false);
    }
  });
}

async function announce(direction: string, personName: string, current: number, settings: VoiceSettings): Promise<boolean> {
  try {
    const engine = speechEngine();
    if (!engine) return false;
    const voices = await availableVoices(engine);
    if (current !== sequence) return true;
    const voice = preferredSpanishVoice(voices, navigator.onLine !== false, settings);
    const text = feedbackAnnouncement(direction, personName);
    if (await speak(engine, text, settings.voiceRate, voice)) return true;
    if (current !== sequence) return true;
    if (voice && !voice.localService) {
      const gender = voiceGender(voice);
      const local = preferredSpanishVoice(voices, false, { ...settings, voiceGender: gender === 'auto' ? settings.voiceGender : gender });
      if (local) return await speak(engine, text, settings.voiceRate, local);
    }
    return false;
  } catch {
    return false;
  }
}

function buffer(name: string) {
  if (!buffers.has(name)) {
    const work = fetch(`/sounds/${name}.wav`)
      .then((response) => {
        if (!response.ok) throw Error('Audio no disponible.');
        return response.arrayBuffer();
      })
      .then((bytes) => context!.decodeAudioData(bytes));
    buffers.set(name, work);
    void work.catch(() => buffers.delete(name));
  }
  return buffers.get(name)!;
}
export function prepareAccessVoice(voiceURI: string) {
  const voice = findGympassVoice(voiceURI);
  if (voice && typeof Worker !== 'undefined')
    void import('./voice-engine').then((engine) => engine.prepareGympassVoice(voice.preset)).catch(() => {});
}

export function prepareAudio() {
  try {
    // Start loading voices during the user's interaction, before a scan completes.
    speechEngine()?.getVoices();
  } catch {}
  try {
    context ||= new AudioContext();
    if (context.state === 'suspended') void context.resume().catch(() => {});
    for (const name of ['entry', 'exit', 'denied', 'entry-recorded', 'exit-recorded']) void buffer(name).catch(() => {});
  } catch {
    /* Audio is optional. */
  }
}
function playBuffer(decoded: AudioBuffer) {
  if (!context || context.state !== 'running') return false;
  playing = context.createBufferSource();
  playing.buffer = decoded;
  playing.connect(context.destination);
  playing.start();
  return true;
}
export function stopFeedback() {
  ++sequence;
  activeSpeech?.stop();
  try { speechEngine()?.cancel(); } catch {}
  try { playing?.stop(); } catch {}
  playing = undefined;
}

export async function accessFeedback(
  allowed: boolean, sound: boolean, vibration: boolean, direction = 'entry', personName = '',
  settings: VoiceSettings = defaultVoiceSettings, preview = false,
): Promise<'gympass' | 'device' | 'recorded' | 'tone' | 'none'> {
  if (vibration) {
    try {
      navigator.vibrate?.(allowed ? [80] : [100, 60, 100]);
    } catch {}
  }
  stopFeedback();
  const current = sequence;
  if (!sound) return 'none';
  prepareAudio();
  try {
    if (allowed) {
      const options = normalizeVoiceSettings(settings);
      if (options.voiceURI === recordedAccessVoice) {
        try {
          const decoded = await buffer(recordedAccessSound(direction));
          if (current === sequence && playBuffer(decoded)) return 'recorded';
        } catch {
          // Keep the original confirmation tone if a recording cannot be loaded.
        }
      } else {
        const voice = findGympassVoice(options.voiceURI);
        if (voice && await playGympassVoice(voice, feedbackAnnouncement(direction, personName), options.voiceRate, current, preview))
          return 'gympass';
        if (current !== sequence) return 'none';
        if (await announce(direction, personName, current, options)) return current === sequence ? 'device' : 'none';
      }
    }
    if (current !== sequence || !context) return 'none';
    const decoded = await buffer(feedbackSound({ allowed: Number(allowed), direction }));
    if (current === sequence && playBuffer(decoded)) return 'tone';
  } catch {
    /* Audio failure must never interrupt access registration. */
  }
  return 'none';
}
