import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultVoiceSettings, type VoiceSettings } from '../lib/access-feedback.ts';
import { componentHarness, elementText, findElement } from './component-harness.ts';

test('Apariencia prueba voces sin guardarlas y confirma ajustes de hasta 300 %', async (t) => {
  const h = componentHarness();
  t.after(() => h.cleanup());
  const preferences = { ...defaultVoiceSettings, sound: false, vibration: false, theme: 'light', density: 'comfortable' };
  const calls: Array<{ direction: string; name: string; voice: string; preview: boolean; rate: number }> = [];
  const { default: Appearance } = h.load('../src/Appearance.tsx', {
    './preferences': {
      usePreferences: () => preferences,
      updatePreferences: (change: Partial<VoiceSettings>) => { Object.assign(preferences, change); return true; },
    },
    './feedback': {
      subscribeAccessVoices: (listener: (voices: unknown[]) => void) => { listener([]); return () => {}; },
      prepareAudio() {},
      prepareAccessVoice() {},
      stopFeedback() {},
      accessFeedback: async (_allowed: boolean, sound: boolean, _vibration: boolean, direction: string, name: string, options: VoiceSettings, preview: boolean) => {
        assert.equal(sound, true);
        calls.push({ direction, name, voice: options.voiceURI, preview, rate: options.voiceRate });
        return 'gympass';
      },
    },
    './ui': { Field: 'Field' },
    './styles/appearance.css': {},
  });
  h.render(Appearance);
  const picker = (tree: unknown) => findElement(tree, (element) => element.type === 'Field' && element.props.label === 'Voz de los avisos').props.children;
  const initial = picker(await h.settle());
  assert.notEqual(initial.props.disabled, true);
  for (const gender of ['femeninas', 'masculinas']) {
    const group = findElement(initial, (element) => element.type === 'optgroup' && element.props.label.includes(gender));
    assert.equal(group.props.children.length, 5);
    assert.ok(group.props.children.every((option: { props: { disabled?: boolean } }) => !option.props.disabled));
  }
  initial.props.onChange({ target: { value: 'gympass:F3' } });
  assert.equal(preferences.voiceURI, '');
  let tree = h.render(Appearance);
  assert.equal(picker(tree).props.value, 'gympass:F3');
  findElement(tree, (element) => element.type === 'button' && elementText(element) === 'Probar entrada').props.onClick();
  tree = await h.settle();
  picker(tree).props.onChange({ target: { value: 'gympass:M4' } });
  tree = h.render(Appearance);
  assert.equal(picker(tree).props.value, 'gympass:M4');
  const rate = findElement(tree, (element) => element.type === 'input' && element.props.type === 'range');
  assert.equal(rate.props.max, 3);
  rate.props.onChange({ target: { valueAsNumber: 3 } });
  tree = await h.settle();
  findElement(tree, (element) => element.type === 'button' && elementText(element) === 'Probar salida').props.onClick();
  tree = await h.settle();
  assert.deepEqual(calls, [
    { direction: 'entry', name: 'María Pérez', voice: 'gympass:F3', preview: true, rate: 0.98 },
    { direction: 'exit', name: 'María Pérez', voice: 'gympass:M4', preview: true, rate: 3 },
  ]);
  assert.equal(preferences.voiceURI, '');
  assert.equal(preferences.voiceRate, 0.98);
  findElement(tree, (element) => element.type === 'button' && elementText(element) === 'Guardar cambios').props.onClick();
  tree = await h.settle();
  assert.equal(preferences.voiceURI, 'gympass:M4');
  assert.equal(preferences.voiceGender, 'male');
  assert.equal(preferences.voiceRate, 3);
  assert.match(elementText(tree), /Cambios guardados en este navegador/);
});
