import { describe, it, expect } from 'vitest';
import { startPlayAll } from '../web/src/tts/playAll.js';

// Fake controller whose play() resolution the test controls per call.
function makeController() {
  const calls = [];
  return {
    calls,
    play(text, voice) {
      const call = { text, voice };
      calls.push(call);
      return new Promise((resolve) => { call.finish = resolve; });
    },
    stop() { this.stoppedCount = (this.stoppedCount || 0) + 1; calls.at(-1)?.finish?.(false); },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('startPlayAll', () => {
  it('announces and plays beats in order, prefetching the next body', async () => {
    const controller = makeController();
    const fetched = [];
    const run = startPlayAll({
      items: [
        { order: 1, name: 'Opening' },
        { order: 2, name: 'The Heist' },
      ],
      fetchBody: async (order) => { fetched.push(order); return `body ${order}`; },
      controller,
      voice: 'af_heart',
      toText: (md) => md,
      onBeat: () => {},
    });
    await tick();
    expect(controller.calls).toHaveLength(1);
    expect(controller.calls[0].text).toBe('Beat 1: Opening.\n\nbody 1');
    expect(controller.calls[0].voice).toBe('af_heart');
    expect(fetched).toEqual([1, 2]); // beat 2 prefetched while beat 1 plays
    controller.calls[0].finish(true);
    await tick();
    expect(controller.calls[1].text).toBe('Beat 2: The Heist.\n\nbody 2');
    controller.calls[1].finish(true);
    await run.promise;
  });

  it('reports the current beat via onBeat and null at the end', async () => {
    const controller = makeController();
    const seen = [];
    const run = startPlayAll({
      items: [{ order: 3, name: 'X' }],
      fetchBody: async () => 'b',
      controller,
      voice: 'af_heart',
      toText: (md) => md,
      onBeat: (o) => seen.push(o),
    });
    await tick();
    controller.calls[0].finish(true);
    await run.promise;
    expect(seen).toEqual([3, null]);
  });

  it('skips beats whose fetch fails or whose text is empty', async () => {
    const controller = makeController();
    const run = startPlayAll({
      items: [
        { order: 1, name: 'A' },  // fetch fails
        { order: 2, name: 'B' },  // empty text
        { order: 3, name: 'C' },  // plays
      ],
      fetchBody: async (order) => {
        if (order === 1) throw new Error('nope');
        return order === 2 ? '   ' : 'body';
      },
      controller,
      voice: 'af_heart',
      toText: (md) => md.trim(),
      onBeat: () => {},
    });
    await tick(); await tick();
    expect(controller.calls).toHaveLength(1);
    expect(controller.calls[0].text).toContain('Beat 3: C.');
    controller.calls[0].finish(true);
    await run.promise;
  });

  it('skip() advances to the next beat; stop() ends the run', async () => {
    const controller = makeController();
    const run = startPlayAll({
      items: [
        { order: 1, name: 'A' },
        { order: 2, name: 'B' },
        { order: 3, name: 'C' },
      ],
      fetchBody: async () => 'body',
      controller,
      voice: 'af_heart',
      toText: (md) => md,
      onBeat: () => {},
    });
    await tick();
    run.skip();               // aborts beat 1, loop advances
    await tick();
    expect(controller.calls).toHaveLength(2);
    run.stop();               // ends the whole run during beat 2
    await run.promise;
    expect(controller.calls).toHaveLength(2); // beat 3 never started
  });
});
