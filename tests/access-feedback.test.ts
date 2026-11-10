import assert from 'node:assert/strict';
import test from 'node:test';
import { componentHarness } from './component-harness.ts';

function fixture(t: test.TestContext, options: { speech?: boolean; audio?: boolean; delayedVoices?: boolean; silent?: boolean } = {}) {
  const spoken: any[] = [];
  const tones: string[] = [];
  const vibration: unknown[] = [];
  const voice = { name: 'Microsoft Dalia Online (Natural)', lang: 'es-MX', localService: false, default: false };
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
    fetch: async (name: string) => ({ ok: true, arrayBuffer: async () => ({ name }) }),
  });
  const api = h.load('../src/feedback.ts');
  t.after(() => api.accessFeedback(false, false, false));
  return {
    api, engine, spoken, tones, vibration, voice,
    settle: () => h.settle(),
    get cancellations() { return cancellations; },
    loadVoices() {
      voices = [voice];
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
