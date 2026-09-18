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
  unlock() { this.unlocked = true; }
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
    // Status transitions only — other fields (canSave, detail) emit too.
    controller.subscribe((s) => { if (seen.at(-1) !== s.status) seen.push(s.status); });
    const p = controller.play('hello', 'af_heart');
    expect(controller.getState().status).toBe('generating');
    // unlock must happen synchronously inside play() — that call is the only
    // moment still inside the user gesture, which iOS requires for audio.
    expect(players[0].unlocked).toBe(true);
    client.opts.onChunk(new Float32Array(4), 24000);
    expect(controller.getState().status).toBe('playing');
    expect(players[0].chunks).toHaveLength(1);
    client.resolve({ status: 'done' });
    await Promise.resolve(); await Promise.resolve();
    players[0].finish();
    expect(await p).toBe(true);
    expect(players[0].stoppedPlayer).toBe(true); // released on natural completion
    expect(controller.getState().status).toBe('idle');
    expect(seen).toEqual(['generating', 'playing', 'idle']);
  });

  it('exposes worker stage detail while generating, clears it once playing', async () => {
    const { client, controller } = make();
    controller.play('hello', 'af_heart');
    client.opts.onStatus('loading TTS engine');
    expect(controller.getState()).toMatchObject({ status: 'generating', detail: 'loading TTS engine' });
    client.opts.onChunk(new Float32Array(4), 24000);
    expect(controller.getState()).toMatchObject({ status: 'playing', detail: null });
  });

  it('flags a non-running audio context in the playing detail', async () => {
    const client = new FakeClient();
    const player = new FakePlayer();
    player.contextState = () => 'suspended';
    const controller = new TtsController({ client, createPlayer: () => player });
    controller.play('hello', 'af_heart');
    client.opts.onChunk(new Float32Array(4), 24000);
    expect(controller.getState()).toMatchObject({
      status: 'playing',
      detail: 'no sound? audio context is suspended',
    });
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

// A player that really holds, like ChunkPlayer: banks chunks until release().
class HoldingPlayer extends FakePlayer {
  constructor() { super(); this.held = false; this.played = 0; }
  hold() { this.held = true; }
  release() { this.held = false; this.released = (this.released || 0) + 1; }
  unplayedSec() { return this.chunks.reduce((n, [s, r]) => n + s.length / r, 0) - this.played; }
  pause() { this.pausedPlayer = true; }
  resume() { this.pausedPlayer = false; }
  finished() { this.held = false; return super.finished(); }
}

function makeHolding() {
  const client = new FakeClient();
  const player = new HoldingPlayer();
  const controller = new TtsController({ client, createPlayer: () => player });
  return { client, player, controller };
}

const sec = (n) => new Float32Array(24000 * n);

describe('TtsController buffered start', () => {
  it('slower-than-realtime synthesis buffers until the bank covers the shortfall', () => {
    const { client, player, controller } = makeHolding();
    controller.play('long text', 'af_heart');
    client.opts.onPlan({ segments: 10, totalChars: 1000 });
    // 100 chars → 5s of audio in 10s of synthesis: 0.5× realtime, ~50s total.
    client.opts.onChunk(sec(5), 24000, 't', { index: 0, total: 10, chars: 100, synthMs: 10_000 });
    expect(controller.getState().status).toBe('buffering');
    expect(player.held).toBe(true);
    expect(controller.getState().detail).toMatch(/0\.5× realtime/);
    for (let i = 1; i < 6; i++) {
      client.opts.onChunk(sec(5), 24000, 't', { index: i, total: 10, chars: 100, synthMs: 10_000 });
    }
    // 30s banked of ~50s at an assumed 0.425×: needs 50·(1−0.425) ≈ 28.75s.
    expect(player.held).toBe(false);
    expect(controller.getState().status).toBe('playing');
  });

  it('faster-than-realtime synthesis starts as soon as the floor is banked', () => {
    const { client, player, controller } = makeHolding();
    controller.play('long text', 'af_heart');
    client.opts.onPlan({ segments: 10, totalChars: 1000 });
    client.opts.onChunk(sec(5), 24000, 't', { index: 0, total: 10, chars: 100, synthMs: 1000 });
    expect(player.held).toBe(false);
    expect(controller.getState().status).toBe('playing');
  });

  it('an underrun drops back to buffering', () => {
    const { client, player, controller } = makeHolding();
    controller.play('long text', 'af_heart');
    client.opts.onPlan({ segments: 10, totalChars: 1000 });
    client.opts.onChunk(sec(5), 24000, 't', { index: 0, total: 10, chars: 100, synthMs: 1000 });
    client.opts.onChunk(sec(5), 24000, 't', { index: 1, total: 10, chars: 100, synthMs: 20_000 });
    expect(controller.getState().status).toBe('playing');
    player.played = 10; // listener caught up; ChunkPlayer re-holds itself
    player.held = true;
    player.onUnderrun();
    expect(controller.getState().status).toBe('buffering');
  });

  it('pause/resume toggle the player without stopping synthesis', () => {
    const { client, player, controller } = makeHolding();
    controller.play('hello', 'af_heart');
    controller.pause();
    expect(player.pausedPlayer).toBe(true);
    expect(controller.getState().paused).toBe(true);
    expect(client.stopped).toBeUndefined();
    client.opts.onChunk(sec(1), 24000, 't', {});
    expect(player.chunks).toHaveLength(1); // still accepting audio
    controller.resume();
    expect(player.pausedPlayer).toBe(false);
    expect(controller.getState().paused).toBe(false);
  });

  it('replays a finished read-through from the recording without synthesizing', async () => {
    const client = new FakeClient();
    const players = [];
    const controller = new TtsController({
      client,
      createPlayer: () => { const p = new HoldingPlayer(); players.push(p); return p; },
    });
    const first = controller.play('hello', 'af_heart');
    client.opts.onChunk(sec(1), 24000, 't', {});
    client.resolve({ status: 'done' });
    await Promise.resolve(); await Promise.resolve();
    players[0].finish();
    expect(await first).toBe(true);
    expect(controller.getState().canSave).toBe(true);
    expect(controller.getRecordingBlob().size).toBe(44 + 24000 * 2);

    client.opts = null;
    const again = controller.play('hello', 'af_heart');
    expect(client.opts).toBeNull(); // no speak()
    expect(players[1].chunks).toHaveLength(1);
    expect(controller.getState().status).toBe('playing');
    players[1].finish();
    expect(await again).toBe(true);
  });
});
