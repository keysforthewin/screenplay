// Main-thread side of the worker-context TTS debug harness.
const out = [];
window.__log = out;
const log = (m) => {
  out.push(`${(performance.now() / 1000).toFixed(1)}s ${m}`);
  document.getElementById('out').textContent = out.join('\n');
  console.log(m);
};
let beats = 0;
setInterval(() => {
  beats += 1;
  document.getElementById('hb').textContent = `heartbeat: ${beats}s (main thread alive)`;
}, 1000);

const w = new Worker(new URL('./ttsdebug.worker.js', import.meta.url), { type: 'module' });
w.onmessage = (e) => log(e.data.log);
w.onerror = (e) => log(`WORKER ONERROR: ${e.message || '?'} @ ${e.filename || ''}:${e.lineno || ''}`);
w.onmessageerror = () => log('WORKER MESSAGEERROR');
log(`worker spawned; main-thread gpu: ${!!navigator.gpu}`);
