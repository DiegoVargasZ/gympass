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
const rendered = new Map<string, VoiceAudio>();
const rendering = new Map<string, Promise<VoiceAudio | undefined>>();
const maxCacheBytes = 16 * 1024 * 1024;
let cachedBytes = 0;

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
  const key = JSON.stringify([preset, text, rate]);
  const cached = rendered.get(key);
  if (cached) {
    rendered.delete(key);
    rendered.set(key, cached);
    return cached;
  }
  const active = rendering.get(key);
  if (active) return await active;
  const work = send({ preset, text, rate }).then((audio) => {
    if (audio && audio.samples.byteLength <= maxCacheBytes) {
      while (rendered.size && (rendered.size >= 64 || cachedBytes + audio.samples.byteLength > maxCacheBytes)) {
        const oldest = rendered.keys().next().value!;
        cachedBytes -= rendered.get(oldest)!.samples.byteLength;
        rendered.delete(oldest);
      }
      rendered.set(key, audio);
      cachedBytes += audio.samples.byteLength;
    }
    return audio;
  }).finally(() => rendering.delete(key));
  rendering.set(key, work);
  return await work;
}
