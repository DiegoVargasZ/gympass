import { env, InferenceSession, Tensor } from 'onnxruntime-web/wasm';
import wasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import wasmModule from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import { Style, TextToSpeech, UnicodeProcessor } from '../vendor/supertonic/helper.js';
import { gympassVoices, type GympassVoice } from '../lib/voice-catalog';

const quantized = 'https://huggingface.co/csukuangfj2/sherpa-onnx-supertonic-tts-int8-2026-03-06/resolve/5dec5897b86e2b293790eedb5e1f561a3295651f/';
const original = 'https://huggingface.co/Supertone/supertonic-2/resolve/75e6727618a02f323c720cba9478152d4bc16ca4/';
const cacheName = 'gympass-voices-supertonic-2-int8-v1';
env.wasm.numThreads = 1;
env.wasm.wasmPaths = { wasm: new URL(wasm, self.location.href).href, mjs: new URL(wasmModule, self.location.href).href };

async function asset(url: string) {
  const cache = await globalThis.caches?.open(cacheName).catch(() => undefined);
  const stored = await cache?.match(url).catch(() => undefined);
  if (stored) return stored;
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error('Recurso de voz no disponible.');
  if (cache) void cache.put(url, response.clone()).catch(() => {});
  return response;
}

let model: Promise<TextToSpeech> | undefined;
async function loadModel() {
  const names = ['tts.json', 'unicode_indexer.bin', ...['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder'].map((name) => name + '.int8.onnx')];
  // Start all downloads together; compile sessions in order without retaining all model buffers.
  const [cfg, index, ...models] = await Promise.all(names.map((name) => asset(quantized + name)));
  const processor = new UnicodeProcessor(new Int32Array(await index.arrayBuffer()));
  const sessions: InferenceSession[] = [];
  try {
    for (const response of models) {
      const bytes = await response.arrayBuffer();
      sessions.push(await InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }));
    }
    return new TextToSpeech(await cfg.json(), processor, ...sessions);
  } catch (error) {
    for (const session of sessions) await session.release();
    throw error;
  }
}

type Preset = GympassVoice['preset'];
const styles = new Map<Preset, Promise<Style>>();
async function style(preset: Preset) {
  let work = styles.get(preset);
  if (!work) {
    work = (async () => {
      const voice = await (await asset(original + 'voice_styles/' + preset + '.json')).json();
      const tensor = (value: { data: number[][][]; dims: number[] }) =>
        new Tensor('float32', Float32Array.from(value.data.flat(2)), value.dims);
      return new Style(tensor(voice.style_ttl), tensor(voice.style_dp));
    })();
    styles.set(preset, work);
    void work.catch(() => styles.delete(preset));
  }
  return await work;
}

type Request = { id: number; preset: Preset; text?: string; rate?: number };
let queue = Promise.resolve();
let latestRender = 0;
self.onmessage = ({ data }: MessageEvent<Request>) => {
  if (data.text) latestRender = data.id;
  queue = queue.then(async () => {
    try {
      if (!gympassVoices.some((voice) => voice.preset === data.preset)) throw new Error('Voz desconocida.');
      if (!model) {
        model = loadModel();
        void model.catch(() => { model = undefined; });
      }
      const [tts, voice] = await Promise.all([model, style(data.preset)]);
      if (data.text) {
        if (data.id !== latestRender) {
          self.postMessage({ id: data.id, error: true });
          return;
        }
        const { wav, duration } = await tts.call(data.text.slice(0, 180), 'es', voice, 6, data.rate ?? 0.98);
        const length = Math.min(wav.length, Math.ceil(duration[0] * tts.sampleRate));
        if (!(length > 0)) throw new Error('La voz no produjo audio.');
        const samples = new Float32Array(length);
        if (wav instanceof Float32Array) samples.set(wav.subarray(0, length));
        else for (let i = 0; i < length; i++) samples[i] = wav[i];
        (self as unknown as Worker).postMessage({ id: data.id, audio: { samples, sampleRate: tts.sampleRate } }, [samples.buffer]);
      } else {
        self.postMessage({ id: data.id });
      }
    } catch (error) {
      console.warn('No se pudo generar el aviso de voz.', error instanceof Error ? error.message : '');
      self.postMessage({ id: data.id, error: true });
    }
  });
};
