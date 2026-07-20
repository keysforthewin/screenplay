import { describe, it, expect } from 'vitest';
import { ChunkPlayer } from '../web/src/tts/playback.js';

class FakeSource {
  constructor(ctx) { this.ctx = ctx; this.onended = null; }
  connect() {}
  start(t) { this.startedAt = t; this.ctx.started.push(this); }
  stop() { this.stopped = true; }
  end() { this.onended?.(); }
}

class FakeCtx {
  constructor() { this.currentTime = 0; this.started = []; this.destination = {}; }
  createBuffer(_ch, length, rate) { return { duration: length / rate, copyToChannel() {} }; }
  createBufferSource() { const s = new FakeSource(this); s.buffer = null; return s; }
}

describe('ChunkPlayer', () => {
  it('schedules chunks back-to-back with no gap', () => {
    const ctx = new FakeCtx();
    const p = new ChunkPlayer(() => ctx);
    p.enqueue(new Float32Array(24000), 24000);   // 1.0s
    p.enqueue(new Float32Array(12000), 24000);   // 0.5s
    expect(ctx.started).toHaveLength(2);
    expect(ctx.started[0].startedAt).toBe(0);
    expect(ctx.started[1].startedAt).toBe(1.0);
  });

  it('clamps to currentTime when generation falls behind', () => {
    const ctx = new FakeCtx();
    const p = new ChunkPlayer(() => ctx);
    p.enqueue(new Float32Array(24000), 24000);   // ends at t=1
    ctx.currentTime = 5;                          // playback drained long ago
    p.enqueue(new Float32Array(24000), 24000);
    expect(ctx.started[1].startedAt).toBe(5);
  });

  it('finished() resolves only after the last source ends', async () => {
    const ctx = new FakeCtx();
    const p = new ChunkPlayer(() => ctx);
    p.enqueue(new Float32Array(10), 24000);
    let done = false;
    const fin = p.finished().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    ctx.started[0].end();
    await fin;
    expect(done).toBe(true);
  });

  it('finished() resolves immediately when nothing was enqueued', async () => {
    const p = new ChunkPlayer(() => new FakeCtx());
    await p.finished(); // must not hang
  });

  it('stop() stops sources and resolves pending finished()', async () => {
    const ctx = new FakeCtx();
    const p = new ChunkPlayer(() => ctx);
    p.enqueue(new Float32Array(10), 24000);
    const fin = p.finished();
    p.stop();
    expect(ctx.started[0].stopped).toBe(true);
    await fin; // must not hang
  });
});
