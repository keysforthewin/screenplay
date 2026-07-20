import { describe, it, expect } from 'vitest';
import { TtsController } from '../web/src/tts/controller.js';

// Fake client: capture callbacks so the test drives chunk/progress/done.
class FakeClient {
  speak(opts) {
    this.opts = opts;
    return new Promise((resolve) => { this.resolve = resolve; });
  }
  stop() { this.stopped = true; this.resolve?.({ status: 'stopped' }); }
}

class FakePlayer {
  constructor() { this.chunks = []; }
  enqueue(s, r) { this.chunks.push([s, r]); }
  finished() { return (this.fin = new Promise((res) => { this.finish = res; })); }
  stop() { this.stoppedPlayer = true; this.finish?.(); }
}

function make() {
  const client = new FakeClient();
  const players = [];
  const controller = new TtsController({
    client,
    createPlayer: () => { const p = new FakePlayer(); players.push(p); return p; },
  });
  return { client, players, controller };
}

describe('TtsController', () => {
  it('walks idle → generating → playing → idle and resolves true', async () => {
    const { client, players, controller } = make();
    const seen = [];
    controller.subscribe((s) => seen.push(s.status));
    const p = controller.play('hello', 'af_heart');
    expect(controller.getState().status).toBe('generating');
    client.opts.onChunk(new Float32Array(4), 24000);
    expect(controller.getState().status).toBe('playing');
    expect(players[0].chunks).toHaveLength(1);
    client.resolve({ status: 'done' });
    await Promise.resolve(); await Promise.resolve();
    players[0].finish();
    expect(await p).toBe(true);
    expect(controller.getState().status).toBe('idle');
    expect(seen).toEqual(['generating', 'playing', 'idle']);
  });

  it('reports download progress while loading', async () => {
    const { client, controller } = make();
    controller.play('hello', 'af_heart');
    client.opts.onProgress(155, 310);
    expect(controller.getState()).toMatchObject({ status: 'loading', progress: 0.5 });
    client.opts.onChunk(new Float32Array(4), 24000);
    expect(controller.getState().status).toBe('playing');
  });

  it('stop() halts playback and play resolves false', async () => {
    const { client, players, controller } = make();
    const p = controller.play('hello', 'af_heart');
    client.opts.onChunk(new Float32Array(4), 24000);
    controller.stop();
    expect(client.stopped).toBe(true);
    expect(players[0].stoppedPlayer).toBe(true);
    expect(await p).toBe(false);
    expect(controller.getState().status).toBe('idle');
  });

  it('surfaces worker errors as error state, resolves false', async () => {
    const { client, controller } = make();
    const p = controller.play('hello', 'af_heart');
    client.resolve({ status: 'error', message: 'no model' });
    expect(await p).toBe(false);
    expect(controller.getState()).toMatchObject({ status: 'error', error: 'no model' });
  });

  it('empty text is a no-op resolving true', async () => {
    const { controller } = make();
    expect(await controller.play('   ', 'af_heart')).toBe(true);
    expect(controller.getState().status).toBe('idle');
  });

  it('stop() during the final drain resolves play false', async () => {
    const { client, players, controller } = make();
    const p = controller.play('hello', 'af_heart');
    client.opts.onChunk(new Float32Array(4), 24000);
    client.resolve({ status: 'done' });
    await Promise.resolve(); await Promise.resolve(); // play() now awaits finished()
    controller.stop(); // FakePlayer.stop resolves the pending finished()
    expect(await p).toBe(false);
    expect(controller.getState().status).toBe('idle');
  });

  it('a newer play() supersedes the old one, which resolves false', async () => {
    const { client, players, controller } = make();
    const first = controller.play('one', 'af_heart');
    const second = controller.play('two', 'af_heart'); // stops the first
    expect(await first).toBe(false);
    client.opts.onChunk(new Float32Array(4), 24000);
    client.resolve({ status: 'done' });
    await Promise.resolve(); await Promise.resolve();
    players[1].finish();
    expect(await second).toBe(true);
  });
});
