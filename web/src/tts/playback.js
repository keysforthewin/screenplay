// Gapless scheduler for streamed PCM chunks. Each chunk becomes an
// AudioBuffer scheduled at the cumulative end time of everything before it,
// clamped to ctx.currentTime when synthesis falls behind playback (brief
// silence, never overlap). The AudioContext resamples 24kHz output to the
// device rate for us.
//
// Buffered start: after hold(), enqueue() banks chunks instead of scheduling
// them; release() schedules the bank and lets later chunks flow straight
// through. If the listener still catches up with the generator (every
// scheduled source ended, input not finished), onUnderrun fires and the player
// re-holds itself so the controller can re-bank rather than stutter through
// one gap per segment.
//
// Pause is AudioContext.suspend(): it freezes ctx.currentTime, so everything
// already scheduled stays aligned and chunks arriving while paused schedule
// normally against the frozen clock. Synthesis keeps running during a pause.
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
    this.held = false;
    this.bank = []; // chunks waiting for release(): [{samples, sampleRate}]
    this.paused = false;
    this.onUnderrun = null;
  }

  hold() { this.held = true; }

  release() {
    this.held = false;
    for (const c of this.bank.splice(0)) this.#schedule(c.samples, c.sampleRate);
  }

  // Seconds of audio not yet heard: the unscheduled bank plus whatever is
  // scheduled beyond the playhead.
  unplayedSec() {
    const banked = this.bank.reduce((n, c) => n + c.samples.length / c.sampleRate, 0);
    const scheduled = this.ctx ? Math.max(0, this.nextTime - this.ctx.currentTime) : 0;
    return banked + scheduled;
  }

  pause() {
    this.paused = true;
    this.ctx?.suspend?.()?.catch?.(() => {});
  }

  resume() {
    this.paused = false;
    this.ctx?.resume?.()?.catch?.(() => {});
  }

  // Create (or adopt) the context and kick a suspended one — must be called
  // synchronously within a user gesture for audio to be audible on iOS.
  unlock() {
    // iOS mutes Web Audio under the ringer/silent switch unless the page
    // declares itself media playback (iOS 17+). Harmless elsewhere.
    try {
      const session = globalThis.navigator?.audioSession;
      if (session) session.type = 'playback';
    } catch { /* not supported */ }
    const ctx = (this.ctx ||= this.createContext());
    if (ctx.state === 'suspended' && !this.paused) ctx.resume?.()?.catch?.(() => {});
    return ctx;
  }

  // 'running' | 'suspended' | 'interrupted' | 'closed' | null — lets the UI
  // say WHY nothing is audible instead of playing convincing silence.
  contextState() {
    return this.ctx?.state || null;
  }

  enqueue(samples, sampleRate) {
    if (this.held) this.bank.push({ samples, sampleRate });
    else this.#schedule(samples, sampleRate);
  }

  #schedule(samples, sampleRate) {
    const ctx = this.unlock();
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      this.sources.delete(source);
      if (!this.sources.size && !this.ended && !this.held) {
        this.held = true;
        this.onUnderrun?.();
      }
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
    if (this.held) this.release(); // nothing more is coming — play what's banked
    if (!this.sources.size) return Promise.resolve();
    return new Promise((resolve) => this.drainResolvers.push(resolve));
  }

  stop() {
    for (const s of [...this.sources]) {
      s.onended = null;
      try { s.stop(); } catch { /* already ended */ }
    }
    this.sources.clear();
    this.bank = [];
    this.ended = true;
    // A paused player leaves the SHARED context suspended — hand it back
    // running, or the next player's audio is silent until someone resumes it.
    if (this.paused) this.resume();
    this.#maybeDrain();
    this.ctx = null; // the shared context stays open for the next player
  }

  #maybeDrain() {
    if (!this.ended || this.sources.size) return;
    for (const resolve of this.drainResolvers.splice(0)) resolve();
  }
}
