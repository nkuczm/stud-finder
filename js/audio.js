// Mic capture into a ring buffer indexed by AudioContext frame, plus playback helpers.

export const AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.listeners = new Set();
    this.waiters = [];
    this.writeFrame = 0;
    this.level = -100;
    this.attached = false;
  }

  /** Create/resume the context. Call synchronously inside a user gesture (iOS). */
  createContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.sr = this.ctx.sampleRate;
      this.buf = new Float32Array(Math.round(this.sr * 4));
    }
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  async attach(stream) {
    if (this.attached) return;
    const ctx = this.createContext();
    this.source = ctx.createMediaStreamSource(stream);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    let node = null;
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
        node = new AudioWorkletNode(ctx, 'stud-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        node.port.onmessage = (e) => this.push(e.data.samples, e.data.frame);
      } catch (err) {
        console.warn('AudioWorklet unavailable, falling back', err);
        node = null;
      }
    }
    if (!node) {
      const size = 2048;
      node = ctx.createScriptProcessor(size, 1, 1);
      node.onaudioprocess = (e) => {
        const d = e.inputBuffer.getChannelData(0);
        this.push(new Float32Array(d), Math.max(0, Math.round(e.playbackTime * this.sr) - size));
      };
    }
    this.source.connect(node);
    node.connect(sink);
    this.node = node;
    this.stream = stream;
    this.attached = true;
  }

  push(samples, frame) {
    const N = this.buf.length;
    let e = 0;
    for (let i = 0; i < samples.length; i++) {
      this.buf[(frame + i) % N] = samples[i];
      e += samples[i] * samples[i];
    }
    this.writeFrame = frame + samples.length;
    const db = 10 * Math.log10(e / samples.length + 1e-12);
    this.level = Math.max(db, this.level - 1.5);
    for (const fn of this.listeners) fn(samples, frame);
    if (this.waiters.length) {
      this.waiters = this.waiters.filter((w) => {
        if (this.writeFrame >= w.frame) { w.resolve(true); return false; }
        return true;
      });
    }
  }

  onChunk(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  waitForFrame(frame, timeoutMs = 2000) {
    if (this.writeFrame >= frame) return Promise.resolve(true);
    return new Promise((resolve) => {
      const w = { frame, resolve };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); resolve(false); }, timeoutMs);
    });
  }

  /** Copy samples for absolute frames [a, b). Null if not (or no longer) in the buffer. */
  getRange(a, b) {
    const N = this.buf.length;
    a = Math.round(a); b = Math.round(b);
    if (a < 0 || b > this.writeFrame || a < this.writeFrame - N || b <= a) return null;
    const out = new Float32Array(b - a);
    for (let i = 0; i < out.length; i++) out[i] = this.buf[(a + i) % N];
    return out;
  }

  /** Schedule a buffer for playback at context time `when`. */
  play(samples, when, gain = 1) {
    const ctx = this.ctx;
    const b = ctx.createBuffer(1, samples.length, this.sr);
    b.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = b;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(ctx.destination);
    src.start(when);
    return src;
  }

  /** Short UI blip (metal-detector clicks). */
  blip(freq = 1400, dur = 0.018, vol = 0.25) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.01);
  }
}
