import { describe, it, expect } from 'vitest';
import { createKokoroEngine } from '../web/src/tts/kokoroEngine.js';

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
