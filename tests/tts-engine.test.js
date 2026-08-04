import { describe, it, expect } from 'vitest';
import { createKokoroEngine, hasAudibleSignal } from '../web/src/tts/kokoroEngine.js';

describe('hasAudibleSignal', () => {
  it('rejects all-zero, NaN, and sub-noise-floor buffers', () => {
    expect(hasAudibleSignal(new Float32Array(1000))).toBe(false);
    expect(hasAudibleSignal(Float32Array.from({ length: 100 }, () => NaN))).toBe(false);
    expect(hasAudibleSignal(Float32Array.from({ length: 100 }, () => 1e-6))).toBe(false);
  });

  it('accepts a buffer with real signal in it', () => {
    const s = new Float32Array(1000);
    s[500] = 0.2;
    expect(hasAudibleSignal(s)).toBe(true);
  });
});

// Only the cheap protocol paths — speak() dynamically imports kokoro-js and is
// exercised in the browser, not here.
describe('createKokoroEngine protocol', () => {
  it('answers gpucheck with the worker-context WebGPU capability', () => {
    const posted = [];
    const engine = createKokoroEngine((m) => posted.push(m));
    engine.handle({ type: 'gpucheck' });
    expect(posted).toEqual([{ type: 'gpucaps', webgpu: !!globalThis.navigator?.gpu }]);
  });

  it('ignores stop for a non-active id without posting', () => {
    const posted = [];
    const engine = createKokoroEngine((m) => posted.push(m));
    engine.handle({ type: 'stop', id: 42 });
    expect(posted).toEqual([]);
  });
});
