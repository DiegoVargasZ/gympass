export const gympassVoices = [
  { preset: 'F1', name: 'Lucía', gender: 'female' },
  { preset: 'F2', name: 'Sofía', gender: 'female' },
  { preset: 'F3', name: 'Valeria', gender: 'female' },
  { preset: 'F4', name: 'Elena', gender: 'female' },
  { preset: 'F5', name: 'Camila', gender: 'female' },
  { preset: 'M1', name: 'Mateo', gender: 'male' },
  { preset: 'M2', name: 'Diego', gender: 'male' },
  { preset: 'M3', name: 'Javier', gender: 'male' },
  { preset: 'M4', name: 'Nicolás', gender: 'male' },
  { preset: 'M5', name: 'Adrián', gender: 'male' },
] as const;

export type GympassVoice = (typeof gympassVoices)[number];
export const gympassVoiceId = (voice: GympassVoice) => 'gympass:' + voice.preset;
export const findGympassVoice = (id: string) => gympassVoices.find((voice) => gympassVoiceId(voice) === id);
