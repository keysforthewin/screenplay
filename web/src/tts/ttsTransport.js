// Chooses where the Kokoro engine runs and hides the choice behind a
// Worker-shaped facade (postMessage/onmessage/onerror/terminate), so
// TtsClient doesn't care which it got.
//
// Default home is a dedicated worker. But some WebKit builds expose WebGPU on
// the main thread and not in workers — when the worker reports no
// navigator.gpu while the main thread can actually obtain an adapter, the
// engine runs inline on the main thread instead: some jank during synthesis
// beats CPU-only synthesis that can't keep up at all.
//
// Messages posted before the placement resolves are buffered and flushed.

export function createTtsTransport(deps = {}) {
  const {
    createWorker = () => new Worker(new URL('./kokoroWorker.js', import.meta.url), { type: 'module' }),
    loadEngine = async (post) => (await import('./kokoroEngine.js')).createKokoroEngine(post),
    hasMainGpu = () => !!globalThis.navigator?.gpu,
    probeMainAdapter = async () => {
      try {
        return await Promise.race([
          Promise.resolve(globalThis.navigator?.gpu?.requestAdapter() ?? null),
          new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
        ]);
      } catch {
        return null;
      }
    },
    capsTimeoutMs = 2000,
  } = deps;

  let target = null;
  let terminated = false;
  const pending = [];
  const facade = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(msg) {
      if (target) target.post(msg);
      else pending.push(msg);
    },
    terminate() {
      terminated = true;
      target?.terminate();
    },
  };

  (async () => {
    const worker = createWorker();
    let resolveCaps;
    const capsPromise = new Promise((resolve) => { resolveCaps = resolve; });
    worker.onmessage = (e) => {
      if (e?.data?.type === 'gpucaps') {
        resolveCaps(e.data);
        return;
      }
      facade.onmessage?.(e);
    };
    worker.onerror = (e) => facade.onerror?.(e);
    worker.onmessageerror = (e) => facade.onmessageerror?.(e);
    const workerTarget = { post: (m) => worker.postMessage(m), terminate: () => worker.terminate() };

    let choice = workerTarget;
    if (hasMainGpu()) {
      worker.postMessage({ type: 'gpucheck' });
      const caps = await Promise.race([
        capsPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), capsTimeoutMs)),
      ]);
      // No/late reply → assume the worker is fine (don't punish a slow start).
      if (caps && caps.webgpu === false && (await probeMainAdapter())) {
        worker.terminate();
        const engine = await loadEngine((msg) => facade.onmessage?.({ data: msg }));
        choice = { post: (m) => engine.handle(m), terminate: () => {} };
      }
    }
    if (terminated) {
      choice.terminate();
      return;
    }
    target = choice;
    for (const m of pending.splice(0)) target.post(m);
  })();

  return facade;
}
