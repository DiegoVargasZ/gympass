import assert from 'node:assert/strict';
import test from 'node:test';
import { componentHarness } from './component-harness.ts';

test('los avisos repetidos reutilizan audio y separan nombres, voces y velocidades', async () => {
  const requests: { id: number; preset: string; text?: string; rate?: number }[] = [];
  class Worker {
    onmessage?: (event: { data: { id: number; audio: { samples: Float32Array; sampleRate: number } } }) => void;
    postMessage(request: (typeof requests)[number]) {
      requests.push(request);
      queueMicrotask(() => this.onmessage?.({ data: {
        id: request.id, audio: { samples: Float32Array.of(requests.length), sampleRate: 44100 },
      } }));
    }
  }
  const { renderGympassVoice } = componentHarness({ URL, Worker }).load('../src/voice-engine.ts');
  const phrase = 'Entrando, María Pérez.';
  const [first, parallel] = await Promise.all([
    renderGympassVoice('F1', phrase, 3),
    renderGympassVoice('F1', phrase, 3),
  ]);
  assert.equal(parallel, first);
  assert.equal(await renderGympassVoice('F1', phrase, 3), first);
  assert.equal(requests.length, 1);
  assert.notEqual(await renderGympassVoice('F1', phrase, 1), first);
  assert.notEqual(await renderGympassVoice('M1', phrase, 3), first);
  assert.notEqual(await renderGympassVoice('F1', 'Saliendo, María Pérez.', 3), first);
  assert.equal(requests.length, 4);
});
