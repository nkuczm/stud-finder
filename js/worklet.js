// AudioWorklet: forwards raw mic samples to the main thread in 1024-sample chunks, tagged with
// the context frame index of their first sample (so playback and capture share a timeline).
class StudTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 1024;
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.start = 0;
  }

  flush() {
    if (!this.n) return;
    const out = this.n === this.size ? this.buf : this.buf.slice(0, this.n);
    this.port.postMessage({ frame: this.start, samples: out }, [out.buffer]);
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.n && currentFrame !== this.start + this.n) this.flush();
    if (!this.n) this.start = currentFrame;
    this.buf.set(ch, this.n);
    this.n += ch.length;
    if (this.n + ch.length > this.size) this.flush();
    return true;
  }
}
registerProcessor('stud-tap', StudTap);
