// Gapless scheduler for streamed PCM chunks. Each chunk becomes an
// AudioBuffer scheduled at the cumulative end time of everything before it,
// clamped to ctx.currentTime when synthesis falls behind playback (brief
// silence, never overlap). The AudioContext resamples 24kHz output to the
// device rate for us.
//
// All players share ONE AudioContext, created on demand and never closed:
// iOS caps concurrent AudioContexts (~4) and only plays audio from a context
// created/resumed inside a user gesture. Controllers call unlock() while the
// Play tap is still on the stack; later plays reuse the already-unlocked ctx.

let sharedCtx = null;
function sharedAudioContext() {
  return (sharedCtx ||= new AudioContext());
}

export class ChunkPlayer {
  constructor(createContext = sharedAudioContext) {
    this.createContext = createContext;
    this.ctx = null;
    this.sources = new Set();
    this.nextTime = 0;
    this.ended = false;
    this.drainResolvers = [];
  }

  // Create (or adopt) the context and kick a suspended one — must be called
  // synchronously within a user gesture for audio to be audible on iOS.
  unlock() {
    const ctx = (this.ctx ||= this.createContext());
    if (ctx.state === 'suspended') ctx.resume?.()?.catch?.(() => {});
    return ctx;
  }

  enqueue(samples, sampleRate) {
    const ctx = this.unlock();
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      this.sources.delete(source);
      this.#maybeDrain();
    };
    const startAt = Math.max(ctx.currentTime, this.nextTime);
    source.start(startAt);
    this.nextTime = startAt + buffer.duration;
    this.sources.add(source);
  }

  // Mark end-of-input; resolves once every scheduled chunk has finished
  // playing (immediately if nothing is queued).
  finished() {
    this.ended = true;
    if (!this.sources.size) return Promise.resolve();
    return new Promise((resolve) => this.drainResolvers.push(resolve));
  }

  stop() {
    for (const s of [...this.sources]) {
      s.onended = null;
      try { s.stop(); } catch { /* already ended */ }
    }
    this.sources.clear();
    this.ended = true;
    this.#maybeDrain();
    this.ctx = null; // the shared context stays open for the next player
  }

  #maybeDrain() {
    if (!this.ended || this.sources.size) return;
    for (const resolve of this.drainResolvers.splice(0)) resolve();
  }
}
