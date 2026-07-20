import { describe, it, expect } from 'vitest';
import { TtsClient } from '../web/src/tts/ttsClient.js';

class FakeWorker {
  constructor() { this.posted = []; this.onmessage = null; }
  postMessage(msg) { this.posted.push(msg); }
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
});
