import { feedbackAnnouncement, feedbackSound, preferredSpanishVoice } from '../lib/access-feedback';
let context: AudioContext | undefined;
const buffers = new Map<string, Promise<AudioBuffer>>();
let playing: AudioBufferSourceNode | undefined;
let sequence = 0;
let activeSpeech: { utterance: SpeechSynthesisUtterance; stop: () => void } | undefined;

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

async function announce(direction: string, personName: string, current: number): Promise<boolean> {
  try {
    const engine = speechEngine();
    if (!engine) return false;
    const voices = await availableVoices(engine);
    if (current !== sequence) return true;
    const voice = preferredSpanishVoice(voices, navigator.onLine !== false);
    const utterance = new SpeechSynthesisUtterance(feedbackAnnouncement(direction, personName));
    utterance.lang = voice?.lang.replaceAll('_', '-') || 'es-BO';
    if (voice) utterance.voice = voice;
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;
    return await new Promise<boolean>((resolve) => {
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
export function prepareAudio() {
  try {
    // Start loading voices during the user's interaction, before a scan completes.
    speechEngine()?.getVoices();
  } catch {}
  try {
    context ||= new AudioContext();
    if (context.state === 'suspended') void context.resume().catch(() => {});
    for (const name of ['entry', 'exit', 'denied']) void buffer(name).catch(() => {});
  } catch {
    /* Audio is optional. */
  }
}
export function accessFeedback(allowed: boolean, sound: boolean, vibration: boolean, direction = 'entry', personName = '') {
  if (vibration) {
    try {
      navigator.vibrate?.(allowed ? [80] : [100, 60, 100]);
    } catch {}
  }
  const current = ++sequence;
  activeSpeech?.stop();
  try { speechEngine()?.cancel(); } catch {}
  try { playing?.stop(); } catch {}
  playing = undefined;
  if (!sound) return;
  prepareAudio();
  void (async () => {
    try {
      if (allowed && await announce(direction, personName, current)) return;
      if (current !== sequence) return;
      if (!context) return;
      const decoded = await buffer(feedbackSound({ allowed: Number(allowed), direction }));
      if (current !== sequence || context.state !== 'running') return;
      playing = context.createBufferSource();
      playing.buffer = decoded;
      playing.connect(context.destination);
      playing.start();
    } catch {
      /* Audio failure must never interrupt access registration. */
    }
  })();
}
