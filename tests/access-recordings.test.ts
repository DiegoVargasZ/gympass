import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { recordedAccessVoice } from '../lib/access-feedback.ts';
import { componentHarness } from './component-harness.ts';

test('los dos audios proporcionados se distribuyen como WAV mono con el orden correcto', () => {
  for (const [name, hash] of [
    ['allowed-recorded', '68570a8d9b9a8db7159f5d46b6d1c7410763ed16475d949a8d4e89fa57249306'],
    ['denied-recorded', 'c6e877fc44ed2a5185590125ba9a73a8d22b08fd4a725c0da179613ee04349a7'],
  ]) {
    const bytes = readFileSync(new URL(`../public/sounds/${name}.wav`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, name);
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
    assert.equal(bytes.readUInt16LE(22), 1);
    assert.equal(bytes.readUInt32LE(24), 44100);
    assert.equal(bytes.readUInt16LE(34), 16);
    assert.ok(bytes.readUInt32LE(40) / 88200 > 1);
  }
});

for (const [saved, expected] of [
  [{}, recordedAccessVoice],
  [{ version: 3, voiceURI: '', sound: true }, recordedAccessVoice],
  [{ version: 3, voiceURI: 'gympass:F3', sound: false }, 'gympass:F3'],
  [{ version: 4, voiceURI: '', sound: true }, ''],
] as const) {
  test(`la selección de audio respeta las preferencias guardadas: ${JSON.stringify(saved)}`, t => {
    let stored: Record<string, unknown> = {};
    const h = componentHarness({
      localStorage: { getItem: () => JSON.stringify(saved), setItem: (_key: string, value: string) => { stored = JSON.parse(value); } },
      document: { documentElement: { dataset: {} }, querySelector: () => null },
    });
    t.after(() => h.cleanup());
    const preferences = h.load('../src/preferences.ts');
    const value = h.render(preferences.usePreferences) as { voiceURI: string; sound: boolean };
    assert.equal(value.voiceURI, expected);
    assert.equal(value.sound, 'sound' in saved && saved.sound);
    preferences.updatePreferences({ voiceURI: recordedAccessVoice });
    assert.equal(stored.version, 4);
    assert.equal(stored.voiceURI, recordedAccessVoice);
  });
}
