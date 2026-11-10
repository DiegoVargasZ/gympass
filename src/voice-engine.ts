import type { GympassVoice } from '../lib/voice-catalog';

export type VoiceAudio = { samples: Float32Array<ArrayBuffer>; sampleRate: number };
type Preset = GympassVoice['preset'];
type Request = { preset: Preset; text?: string; rate?: number };
type Reply = { id: number; audio?: VoiceAudio; error?: true };
type Pending = { resolve: (audio?: VoiceAudio) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, Pending>();
const prepared = new Map<Preset, Promise<void>>();

function reset() {
  worker?.terminate();
  worker = undefined;
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error('No se pudo preparar la voz.'));
  }
  pending.clear();
  prepared.clear();
}

function engine() {
  if (!worker) {
    worker = new Worker(new URL('./voice-worker.ts', import.meta.url), { type: 'module' });
    worker.onerror = reset;
    worker.onmessage = ({ data }: MessageEvent<Reply>) => {
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      clearTimeout(request.timer);
      if (data.error) request.reject(new Error('No se pudo reproducir la voz.'));
      else request.resolve(data.audio);
    };
  }
  return worker;
}

function send(request: Request) {
  const target = engine();
  return new Promise<VoiceAudio | undefined>((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(reset, 180_000);
    pending.set(id, { resolve, reject, timer });
    try {
      target.postMessage({ id, ...request });
    } catch {
      reset();
    }
  });
}

export async function prepareGympassVoice(preset: Preset) {
  let work = prepared.get(preset);
  if (!work) {
    work = send({ preset }).then(() => undefined);
    prepared.set(preset, work);
    void work.catch(() => { if (prepared.get(preset) === work) prepared.delete(preset); });
  }
  await work;
}

export async function renderGympassVoice(preset: Preset, text: string, rate: number) {
  return await send({ preset, text, rate });
}
