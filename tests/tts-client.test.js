import { describe, it, expect, vi } from 'vitest';
import { TtsClient } from '../web/src/tts/ttsClient.js';

class FakeWorker {
  constructor() { this.posted = []; this.onmessage = null; this.onerror = null; }
  postMessage(msg) { this.posted.push(msg); }
  terminate() { this.terminated = true; }
  emit(msg) { this.onmessage?.({ data: msg }); }
}

function make() {
  const worker = new FakeWorker();
  const client = new TtsClient(() => worker);
  return { worker, client };
}

describe('TtsClient', () => {
  it('creates the worker lazily and posts a speak message with an id', () => {
    const { worker, client } = make();
    client.speak({ text: 'hi', voice: 'af_heart', onChunk: () => {} });
    expect(worker.posted).toEqual([{ type: 'speak', id: 1, text: 'hi', voice: 'af_heart' }]);
  });

  it('routes chunks/progress and resolves on done', async () => {
    const { worker, client } = make();
    const chunks = [];
    const progress = [];
    const p = client.speak({
      text: 'hi', voice: 'af_heart',
      onChunk: (samples, rate, text) => chunks.push({ samples, rate, text }),
      onProgress: (loaded, total) => progress.push([loaded, total]),
    });
    worker.emit({ type: 'progress', loaded: 50, total: 100 });
    const samples = new Float32Array([0.1, 0.2]);
    worker.emit({ type: 'chunk', id: 1, samples, sampleRate: 24000, text: 'hi' });
    worker.emit({ type: 'done', id: 1 });
    expect(await p).toEqual({ status: 'done' });
    expect(progress).toEqual([[50, 100]]);
    expect(chunks).toEqual([{ samples, rate: 24000, text: 'hi' }]);
  });

  it('stop() resolves the in-flight speak as stopped and notifies the worker', async () => {
    const { worker, client } = make();
    const p = client.speak({ text: 'hi', voice: 'af_heart', onChunk: () => {} });
    client.stop();
    expect(await p).toEqual({ status: 'stopped' });
    expect(worker.posted).toContainEqual({ type: 'stop', id: 1 });
  });

  it('drops messages from a stale generation', async () => {
    const { worker, client } = make();
    const first = client.speak({ text: 'one', voice: 'af_heart', onChunk: () => {} });
    const chunks = [];
    const second = client.speak({ text: 'two', voice: 'af_heart', onChunk: (s) => chunks.push(s) });
    expect(await first).toEqual({ status: 'stopped' }); // superseded
    worker.emit({ type: 'chunk', id: 1, samples: new Float32Array(1), sampleRate: 24000 }); // stale
    expect(chunks).toHaveLength(0);
    worker.emit({ type: 'done', id: 2 });
    expect(await second).toEqual({ status: 'done' });
  });

  it('resolves with error status on worker error', async () => {
    const { worker, client } = make();
    const p = client.speak({ text: 'hi', voice: 'af_heart', onChunk: () => {} });
    worker.emit({ type: 'error', id: 1, message: 'boom' });
    expect(await p).toEqual({ status: 'error', message: 'boom' });
  });

  it('worker crash (onerror) resolves the speak as error and discards the worker', async () => {
    const workers = [];
    const client = new TtsClient(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    });
    const p = client.speak({ text: 'hi', voice: 'af_heart', onChunk: () => {} });
    workers[0].onerror?.({ message: 'worker died' });
    expect(await p).toEqual({ status: 'error', message: 'worker died' });
    expect(workers[0].terminated).toBe(true);
    client.speak({ text: 'again', voice: 'af_heart', onChunk: () => {} });
    expect(workers).toHaveLength(2); // fresh worker after the crash
  });

  it('worker messageerror resolves the speak as error', async () => {
    const { worker, client } = make();
    const p = client.speak({ text: 'hi', voice: 'af_heart', onChunk: () => {} });
    worker.onmessageerror?.({});
    expect((await p).status).toBe('error');
  });

  it('routes status messages to onStatus', () => {
    const { worker, client } = make();
    const stages = [];
    client.speak({ text: 'hi', voice: 'af_heart', onChunk: () => {}, onStatus: (t) => stages.push(t) });
    worker.emit({ type: 'status', text: 'loading TTS engine' });
    worker.emit({ type: 'status', text: 'synthesizing' });
    expect(stages).toEqual(['loading TTS engine', 'synthesizing']);
  });

  it('watchdog: total silence resolves as an error naming the last stage', async () => {
    vi.useFakeTimers();
    try {
      const { worker, client } = make();
      const p = client.speak({ text: 'hi', voice: 'af_heart', onChunk: () => {} });
      worker.emit({ type: 'status', text: 'loading model' });
      vi.advanceTimersByTime(89_000); // messages reset the timer — not yet
      worker.emit({ type: 'status', text: 'synthesizing' });
      vi.advanceTimersByTime(89_000);
      expect(client.active).not.toBe(null); // still waiting, watchdog kept resetting
      vi.advanceTimersByTime(2_000); // 91s since the last message
      const result = await p;
      expect(result.status).toBe('error');
      expect(result.message).toContain('synthesizing');
    } finally {
      vi.useRealTimers();
    }
  });

  it('watchdog does not fire after done/stop', async () => {
    vi.useFakeTimers();
    try {
      const { worker, client } = make();
      const p = client.speak({ text: 'hi', voice: 'af_heart', onChunk: () => {} });
      worker.emit({ type: 'done', id: 1 });
      expect(await p).toEqual({ status: 'done' });
      vi.advanceTimersByTime(200_000); // must not throw / resolve anything else
      const p2 = client.speak({ text: 'again', voice: 'af_heart', onChunk: () => {} });
      client.stop();
      expect(await p2).toEqual({ status: 'stopped' });
      vi.advanceTimersByTime(200_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
