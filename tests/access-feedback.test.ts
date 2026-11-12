import assert from 'node:assert/strict';
import test from 'node:test';
import { componentHarness } from './component-harness.ts';
import { defaultVoiceSettings, recordedAccessVoice } from '../lib/access-feedback.ts';

function fixture(t: test.TestContext, options: { speech?: boolean; audio?: boolean; delayedVoices?: boolean; silent?: boolean; recordingDelay?: Promise<void>; recordingsFail?: boolean } = {}) {
  const spoken: any[] = [];
  const tones: string[] = [];
  const vibration: unknown[] = [];
  const voice = { name: 'Microsoft Dalia Online (Natural)', lang: 'es-MX', localService: false, default: false, voiceURI: 'dalia' };
  let voices = options.delayedVoices ? [] : [voice];
  let cancellations = 0;
  const engine = Object.assign(new EventTarget(), {
    getVoices: () => voices,
    cancel: () => { cancellations++; },
    speak: (utterance: any) => {
      spoken.push(utterance);
      if (!options.silent) utterance.onstart?.();
    },
  });
  class Utterance {
    text: string;
    constructor(text: string) { this.text = text; }
  }
  class Audio {
    state = 'running';
    destination = {};
    decodeAudioData = async (bytes: { name: string }) => bytes;
    createBufferSource() {
      return {
        buffer: { name: '' },
        connect() {},
        start() { tones.push(this.buffer.name); },
        stop() {},
      };
    }
  }
  const h = componentHarness({
    window: options.speech === false ? {} : { speechSynthesis: engine },
    SpeechSynthesisUtterance: options.speech === false ? undefined : Utterance,
    AudioContext: options.audio === false ? undefined : Audio,
    navigator: { onLine: true, vibrate: (pattern: unknown) => vibration.push(pattern) },
    fetch: async (name: string) => ({
      ok: !options.recordingsFail || !name.includes('-recorded'),
      arrayBuffer: async () => {
        if (name.includes('-recorded')) await options.recordingDelay;
        return { name };
      },
    }),
  });
  const api = h.load('../src/feedback.ts');
  t.after(() => api.accessFeedback(false, false, false));
  return {
    api, engine, spoken, tones, vibration, voice,
    settle: () => h.settle(),
    get cancellations() { return cancellations; },
    loadVoices(next = [voice]) {
      voices = next;
      engine.dispatchEvent(new Event('voiceschanged'));
    },
  };
}

test('entrada y salida pronuncian el nombre con voz española y conservan la vibración', async (t) => {
  const f = fixture(t);
  f.api.accessFeedback(true, true, true, 'entry', 'Ana Pérez');
  await f.settle();
  assert.equal(f.spoken[0].text, 'Entrando, Ana Pérez.');
  assert.equal(f.spoken[0].voice, f.voice);
  assert.equal(f.spoken[0].lang, 'es-MX');
  f.api.accessFeedback(true, true, false, 'exit', 'José Núñez');
  await f.settle();
  assert.equal(f.spoken[1].text, 'Saliendo, José Núñez.');
  assert.ok(f.cancellations >= 2);
  assert.deepEqual(f.vibration.map(String), ['80']);
  assert.deepEqual(f.tones, []);
});

test('los audios grabados distinguen el acceso permitido del denegado sin añadir una voz sintetizada', async t => {
  const f = fixture(t);
  const settings = { ...defaultVoiceSettings, voiceURI: recordedAccessVoice };
  assert.equal(await f.api.accessFeedback(true, true, false, 'entry', 'Ana', settings), 'recorded');
  assert.equal(await f.api.accessFeedback(true, true, false, 'exit', 'Ana', settings), 'recorded');
  assert.equal(await f.api.accessFeedback(false, true, false, 'entry', 'Ana', settings), 'recorded');
  assert.deepEqual(f.tones, ['/sounds/allowed-recorded.wav', '/sounds/allowed-recorded.wav', '/sounds/denied-recorded.wav']);
  assert.deepEqual(f.spoken, []);
});

test('un audio grabado que llega tarde no tapa el último movimiento ni ignora el silencio', async t => {
  let ready!: () => void;
  const f = fixture(t, { recordingDelay: new Promise<void>(resolve => { ready = resolve; }) });
  const settings = { ...defaultVoiceSettings, voiceURI: recordedAccessVoice };
  const first = f.api.accessFeedback(true, true, false, 'entry', 'Ana', settings);
  const last = f.api.accessFeedback(false, true, false, 'exit', 'Ana', settings);
  ready();
  assert.deepEqual(await Promise.all([first, last]), ['none', 'recorded']);
  assert.deepEqual(f.tones, ['/sounds/denied-recorded.wav']);
  assert.equal(await f.api.accessFeedback(true, false, false, 'entry', 'Ana', settings), 'none');
  assert.deepEqual(f.spoken, []);
});

test('si no se carga una grabación se conserva el tono de confirmación', async t => {
  const f = fixture(t, { recordingsFail: true });
  assert.equal(await f.api.accessFeedback(true, true, false, 'entry', 'Ana', { ...defaultVoiceSettings, voiceURI: recordedAccessVoice }), 'tone');
  assert.deepEqual(f.tones, ['/sounds/entry.wav']);
  assert.deepEqual(f.spoken, []);
});

test('el aviso usa la voz exacta y la velocidad seleccionadas', async (t) => {
  const f = fixture(t);
  const jorge = { ...f.voice, name: 'Microsoft Jorge Online (Natural)', voiceURI: 'jorge' };
  const raul = { ...f.voice, name: 'Raúl', voiceURI: 'raul', localService: true };
  f.loadVoices([f.voice, jorge, raul]);
  f.api.accessFeedback(true, true, false, 'exit', 'José Núñez', { voiceURI: 'raul', voiceGender: 'male', voiceRate: 0.87 });
  await f.settle();
  assert.equal(f.spoken[0].voice, raul);
  assert.equal(f.spoken[0].rate, 0.87);
  assert.equal(f.spoken[0].text, 'Saliendo, José Núñez.');
  f.api.accessFeedback(true, true, false, 'entry', 'José Núñez', { voiceURI: '', voiceGender: 'male', voiceRate: 0.98 });
  await f.settle();
  assert.equal(f.spoken[1].voice, jorge);
});

test('si falla la voz en línea, intenta una voz local del mismo tipo antes de usar el tono', async (t) => {
  const f = fixture(t);
  const jorge = { ...f.voice, name: 'Microsoft Jorge Online (Natural)', voiceURI: 'jorge' };
  const raul = { ...f.voice, name: 'Raúl', voiceURI: 'raul', localService: true };
  const helena = { ...f.voice, name: 'Helena', voiceURI: 'helena', localService: true, default: true };
  f.loadVoices([f.voice, jorge, helena, raul]);
  f.api.accessFeedback(true, true, false, 'entry', 'José', { voiceURI: 'jorge', voiceGender: 'auto', voiceRate: 1 });
  await f.settle();
  assert.equal(f.spoken[0].voice, jorge);
  f.spoken[0].onerror();
  await f.settle();
  assert.equal(f.spoken[1].voice, raul);
  assert.deepEqual(f.tones, []);
  f.spoken[1].onerror();
  await f.settle();
  assert.deepEqual(f.tones, ['/sounds/entry.wav']);
});

test('las voces tardías sólo anuncian el último acceso y silenciar cancela el aviso', async (t) => {
  const f = fixture(t, { delayedVoices: true });
  f.api.accessFeedback(true, true, false, 'entry', 'Ana');
  f.api.accessFeedback(true, true, false, 'exit', 'José');
  f.loadVoices();
  await f.settle();
  assert.equal(f.spoken.length, 1);
  assert.equal(f.spoken[0].text, 'Saliendo, José.');
  const before = f.cancellations;
  f.api.accessFeedback(true, false, false, 'entry', 'María');
  await f.settle();
  assert.equal(f.cancellations, before + 1);
  assert.equal(f.spoken.length, 1);
  assert.deepEqual(f.tones, []);
});

test('el acceso denegado conserva su tono y nunca anuncia una entrada', async (t) => {
  const f = fixture(t);
  f.api.accessFeedback(false, true, true, 'entry', 'Ana');
  await f.settle();
  assert.deepEqual(f.spoken, []);
  assert.deepEqual(f.tones, ['/sounds/denied.wav']);
  assert.deepEqual(f.vibration.map(String), ['100,60,100']);
});

test('sin síntesis de voz se usan los tonos correspondientes a entrada y salida', async (t) => {
  const f = fixture(t, { speech: false });
  f.api.accessFeedback(true, true, false, 'entry', 'Ana');
  await f.settle();
  f.api.accessFeedback(true, true, false, 'exit', 'Ana');
  await f.settle();
  assert.deepEqual(f.tones, ['/sounds/entry.wav', '/sounds/exit.wav']);
});

test('un fallo de voz usa el tono, sin reproducir avisos antiguos cancelados', async (t) => {
  const f = fixture(t);
  f.api.accessFeedback(true, true, false, 'entry', 'Ana');
  await f.settle();
  const oldError = f.spoken[0].onerror;
  f.api.accessFeedback(true, true, false, 'exit', 'José');
  await f.settle();
  oldError();
  await f.settle();
  assert.deepEqual(f.tones, []);
  f.spoken[1].onerror();
  await f.settle();
  assert.deepEqual(f.tones, ['/sounds/exit.wav']);
});

test('la voz funciona aunque Web Audio no esté disponible', async (t) => {
  const f = fixture(t, { audio: false });
  f.api.accessFeedback(true, true, false, 'entry', 'María');
  await f.settle();
  assert.equal(f.spoken[0].text, 'Entrando, María.');
});

test('un motor que falla sin avisar se cancela y reproduce el tono de confirmación', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { silent: true });
  f.api.accessFeedback(true, true, false, 'entry', 'Ana');
  await f.settle();
  assert.deepEqual(f.tones, []);
  const before = f.cancellations;
  t.mock.timers.tick(3000);
  await f.settle();
  assert.equal(f.cancellations, before + 1);
  assert.deepEqual(f.tones, ['/sounds/entry.wav']);
});

test('si la lista de voces no carga, se intenta la voz predeterminada en español', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { delayedVoices: true });
  f.api.accessFeedback(true, true, false, 'exit', 'Ana');
  t.mock.timers.tick(700);
  await f.settle();
  assert.equal(f.spoken[0].text, 'Saliendo, Ana.');
  assert.equal(f.spoken[0].lang, 'es-BO');
  assert.deepEqual(f.tones, []);
});
