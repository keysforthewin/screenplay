import { describe, it, expect } from 'vitest';
import { createTtsTransport } from '../web/src/tts/ttsTransport.js';

class FakeWorker {
  constructor() { this.posted = []; this.onmessage = null; this.terminated = false; }
  postMessage(msg) {
    this.posted.push(msg);
    if (msg.type === 'gpucheck') this.onmessage?.({ data: { type: 'gpucaps', webgpu: this.webgpu } });
  }
  terminate() { this.terminated = true; }
  emit(msg) { this.onmessage?.({ data: msg }); }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function make({ workerGpu, mainGpu, mainAdapter }) {
  const worker = new FakeWorker();
  worker.webgpu = workerGpu;
  const engineMsgs = [];
  const engine = { handle: (m) => engineMsgs.push(m) };
  const transport = createTtsTransport({
    createWorker: () => worker,
    loadEngine: async () => engine,
    hasMainGpu: () => mainGpu,
    probeMainAdapter: async () => (mainAdapter ? {} : null),
    capsTimeoutMs: 20,
  });
  return { worker, engine, engineMsgs, transport };
}

describe('createTtsTransport', () => {
  it('uses the worker when the worker has WebGPU', async () => {
    const { worker, engineMsgs, transport } = make({ workerGpu: true, mainGpu: true, mainAdapter: true });
    transport.postMessage({ type: 'speak', id: 1 });
    await tick();
    expect(worker.posted).toContainEqual({ type: 'speak', id: 1 });
    expect(worker.terminated).toBe(false);
    expect(engineMsgs).toHaveLength(0);
  });

  it('uses the worker when the main thread has no WebGPU either', async () => {
    const { worker, transport } = make({ workerGpu: false, mainGpu: false, mainAdapter: false });
    transport.postMessage({ type: 'speak', id: 1 });
    await tick();
    expect(worker.posted).toContainEqual({ type: 'speak', id: 1 });
    expect(worker.terminated).toBe(false);
  });

  it('runs the engine inline when only the main thread can get an adapter', async () => {
    const { worker, engineMsgs, transport } = make({ workerGpu: false, mainGpu: true, mainAdapter: true });
    transport.postMessage({ type: 'speak', id: 1 }); // buffered until the choice resolves
    await tick();
    expect(worker.terminated).toBe(true);
    expect(engineMsgs).toContainEqual({ type: 'speak', id: 1 });
    expect(worker.posted.filter((m) => m.type === 'speak')).toHaveLength(0);
  });

  it('stays on the worker when the main-thread adapter probe fails', async () => {
    const { worker, engineMsgs, transport } = make({ workerGpu: false, mainGpu: true, mainAdapter: false });
    transport.postMessage({ type: 'speak', id: 1 });
    await tick();
    expect(worker.terminated).toBe(false);
    expect(worker.posted).toContainEqual({ type: 'speak', id: 1 });
    expect(engineMsgs).toHaveLength(0);
  });

  it('routes inline engine output through facade.onmessage', async () => {
    const worker = new FakeWorker();
    worker.webgpu = false;
    let post;
    const transport = createTtsTransport({
      createWorker: () => worker,
      loadEngine: async (p) => { post = p; return { handle: () => {} }; },
      hasMainGpu: () => true,
      probeMainAdapter: async () => ({}),
      capsTimeoutMs: 20,
    });
    const received = [];
    transport.onmessage = (e) => received.push(e.data);
    await tick();
    post({ type: 'status', text: 'hi' });
    expect(received).toEqual([{ type: 'status', text: 'hi' }]);
  });
});
