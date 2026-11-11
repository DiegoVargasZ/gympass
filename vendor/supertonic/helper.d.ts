import type { InferenceSession, Tensor } from 'onnxruntime-web/wasm';

export class UnicodeProcessor {
  constructor(indexer: ArrayLike<number>);
}
export class Style {
  constructor(ttlTensor: Tensor, dpTensor: Tensor);
}
export class TextToSpeech {
  readonly sampleRate: number;
  constructor(cfgs: unknown, processor: UnicodeProcessor, ...sessions: InferenceSession[]);
  call(text: string, lang: string, style: Style, steps: number, speed: number): Promise<{ wav: Float32Array | number[]; duration: number[] }>;
}
