// Gapless scheduler for streamed PCM chunks. Each chunk becomes an
// AudioBuffer scheduled at the cumulative end time of everything before it,
// clamped to ctx.currentTime when synthesis falls behind playback (brief
// silence, never overlap). The AudioContext resamples 24kHz output to the
// device rate for us.

export class ChunkPlayer {
  constructor(createContext = () => new AudioContext()) {
    this.createContext = createContext;
    this.ctx = null;
    this.sources = new Set();
    this.nextTime = 0;
    this.ended = false;
    this.drainResolvers = [];
  }

  enqueue(samples, sampleRate) {
    const ctx = (this.ctx ||= this.createContext());
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
    try { this.ctx?.close(); } catch { /* already closed */ }
    this.ctx = null;
  }

  #maybeDrain() {
    if (!this.ended || this.sources.size) return;
    for (const resolve of this.drainResolvers.splice(0)) resolve();
  }
}
