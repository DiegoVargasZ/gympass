import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultVoiceSettings, type VoiceSettings } from '../lib/access-feedback.ts';
import { componentHarness, elementText, findElement } from './component-harness.ts';

test('Apariencia permite escoger voces femeninas y masculinas incluso sin voces instaladas', async (t) => {
  const h = componentHarness();
  t.after(() => h.cleanup());
  const preferences = { ...defaultVoiceSettings, sound: false, vibration: false, theme: 'light', density: 'comfortable' };
  const calls: Array<{ direction: string; name: string; voice: string; preview: boolean }> = [];
  const { default: Appearance } = h.load('../src/Appearance.tsx', {
    './preferences': {
      usePreferences: () => preferences,
      updatePreferences: (change: Partial<VoiceSettings>) => Object.assign(preferences, change),
    },
    './feedback': {
      subscribeAccessVoices: (listener: (voices: unknown[]) => void) => { listener([]); return () => {}; },
      prepareAudio() {},
      stopFeedback() {},
      accessFeedback: async (_allowed: boolean, sound: boolean, _vibration: boolean, direction: string, name: string, options: VoiceSettings, preview: boolean) => {
        assert.equal(sound, true);
        calls.push({ direction, name, voice: options.voiceURI, preview });
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
  assert.equal(preferences.voiceGender, 'female');
  let tree = h.render(Appearance);
  assert.equal(picker(tree).props.value, 'gympass:F3');
  findElement(tree, (element) => element.type === 'button' && elementText(element) === 'Probar entrada').props.onClick();
  tree = await h.settle();
  picker(tree).props.onChange({ target: { value: 'gympass:M4' } });
  assert.equal(preferences.voiceGender, 'male');
  tree = h.render(Appearance);
  assert.equal(picker(tree).props.value, 'gympass:M4');
  findElement(tree, (element) => element.type === 'button' && elementText(element) === 'Probar salida').props.onClick();
  await h.settle();
  assert.deepEqual(calls, [
    { direction: 'entry', name: 'María Pérez', voice: 'gympass:F3', preview: true },
    { direction: 'exit', name: 'María Pérez', voice: 'gympass:M4', preview: true },
  ]);
});
