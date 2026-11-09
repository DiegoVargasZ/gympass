import { feedbackSound } from '../lib/access-feedback';
let context: AudioContext | undefined;
const buffers = new Map<string, Promise<AudioBuffer>>();
let playing: AudioBufferSourceNode | undefined;
let sequence = 0;

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
    context ||= new AudioContext();
    if (context.state === 'suspended') void context.resume().catch(() => {});
    for (const name of ['entry', 'exit', 'denied']) void buffer(name).catch(() => {});
  } catch {
    /* Audio is optional. */
  }
}
export function accessFeedback(allowed: boolean, sound: boolean, vibration: boolean, direction = 'entry') {
  if (vibration) {
    try {
      navigator.vibrate?.(allowed ? [80] : [100, 60, 100]);
    } catch {}
  }
  if (!sound) return;
  prepareAudio();
  const current = ++sequence;
  void (async () => {
    try {
      if (!context) return;
      const decoded = await buffer(feedbackSound({ allowed: Number(allowed), direction }));
      if (current !== sequence || context.state !== 'running') return;
      playing?.stop();
      playing = context.createBufferSource();
      playing.buffer = decoded;
      playing.connect(context.destination);
      playing.start();
    } catch {
      /* Audio failure must never interrupt access registration. */
    }
  })();
}
