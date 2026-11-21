// Pure signal-processing helpers. No DOM access, so everything here is unit-testable in Node.

export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** In-place iterative radix-2 FFT. `re` and `im` must have the same power-of-two length. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

export const hann = (i, L) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, L - 1));

/** One-sided power spectrum (length n/2+1) of `x`, zero padded to `n`. */
export function powerSpectrum(x, n = nextPow2(x.length), windowFn = null) {
  const re = new Float64Array(n), im = new Float64Array(n);
  const L = Math.min(x.length, n);
  for (let i = 0; i < L; i++) re[i] = windowFn ? x[i] * windowFn(i, L) : x[i];
  fft(re, im);
  const p = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k];
  return p;
}

export function bandSum(p, binHz, lo, hi) {
  const a = Math.max(1, Math.ceil(lo / binHz));
  const b = Math.min(p.length - 1, Math.floor(hi / binHz));
  let s = 0;
  for (let k = a; k <= b; k++) s += p[k];
  return s;
}

/**
 * Extract amplitude-independent features from a knock recording.
 *
 * Physics: a knock over a hollow cavity excites the drywall panel as a drum skin, which
 * produces a low (≈100–400 Hz), slowly-decaying "boom". Over a stud the panel is pinned,
 * so the sound is a short, brighter "tock" with less low-frequency energy.
 */
export function analyzeKnock(samples, sr) {
  let pk = 0, pi = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > pk) { pk = a; pi = i; }
  }
  if (pk < 1e-4) return null;

  const start = Math.max(0, pi - Math.round(0.002 * sr));
  const n = nextPow2(Math.round(0.085 * sr));
  const avail = Math.min(n, samples.length - start);
  if (avail < n / 4) return null;

  // Taper: very short fade-in (keep the transient), cosine fade-out over the last 15%.
  const seg = new Float64Array(avail);
  const fadeIn = Math.max(1, Math.round(0.0005 * sr));
  const fadeOut = Math.max(1, Math.round(avail * 0.15));
  for (let i = 0; i < avail; i++) {
    let w = 1;
    if (i < fadeIn) w = i / fadeIn;
    else if (i > avail - fadeOut) w = 0.5 * (1 + Math.cos((Math.PI * (i - (avail - fadeOut))) / fadeOut));
    seg[i] = samples[start + i] * w;
  }
  const p = powerSpectrum(seg, n);
  const binHz = sr / n;
  const total = bandSum(p, binHz, 60, 8000) + 1e-20;
  const low = bandSum(p, binHz, 60, 400);
  const mid = bandSum(p, binHz, 400, 1500);
  const high = bandSum(p, binHz, 1500, 8000);

  let num = 0, den = 0, domK = 0, domP = -1;
  const k0 = Math.ceil(60 / binHz), k1 = Math.min(p.length - 1, Math.floor(8000 / binHz));
  const kDom = Math.floor(1500 / binHz);
  for (let k = k0; k <= k1; k++) {
    num += k * binHz * p[k];
    den += p[k];
    if (k <= kDom && p[k] > domP) { domP = p[k]; domK = k; }
  }
  const centroid = den > 0 ? num / den : 1000;
  const domFreq = Math.max(60, domK * binHz);

  // Decay: 1 ms RMS envelope, time from the envelope peak to −20 dB.
  const hop = Math.max(1, Math.round(0.001 * sr));
  const env = [];
  const maxLen = Math.min(samples.length, start + Math.round(0.16 * sr));
  for (let i = start; i + hop <= maxLen; i += hop) {
    let s = 0;
    for (let j = 0; j < hop; j++) s += samples[i + j] * samples[i + j];
    env.push(Math.sqrt(s / hop));
  }
  let ePk = 0, eIdx = 0;
  for (let i = 0; i < Math.min(env.length, 8); i++) if (env[i] > ePk) { ePk = env[i]; eIdx = i; }
  let decayMs = env.length - eIdx;
  for (let i = eIdx; i < env.length; i++) {
    if (env[i] < ePk * 0.1) { decayMs = i - eIdx; break; }
  }
  decayMs = Math.max(1, decayMs);

  return {
    peak: pk,
    clipped: pk > 0.98,
    energy: total,
    lowRatio: low / total,
    midRatio: mid / total,
    highRatio: high / total,
    centroid,
    domFreq,
    decayMs,
  };
}

/** Per-band levels in dB, bands defined by consecutive `edges` (Hz). */
export function bandLevelsDb(x, sr, edges) {
  const n = nextPow2(x.length);
  const p = powerSpectrum(x, n, hann);
  const binHz = sr / n;
  const out = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    out.push(10 * Math.log10(bandSum(p, binHz, edges[i], edges[i + 1]) + 1e-12));
  }
  return out;
}

export function logSpacedEdges(lo, hi, bands) {
  const out = [];
  for (let i = 0; i <= bands; i++) out.push(lo * Math.pow(hi / lo, i / bands));
  return out;
}

/**
 * Transient detector for knocks. High-passes the signal (removes handling rumble), tracks
 * a noise floor, and fires when short-term energy jumps well above it.
 */
export class OnsetDetector {
  constructor(sr, opts = {}) {
    this.sr = sr;
    this.hop = opts.hop ?? 256;
    this.ratio = opts.ratio ?? 10;
    this.minRms = opts.minRms ?? 0.006;
    this.refractory = Math.round(((opts.refractoryMs ?? 300) * sr) / 1000);
    this.warmup = Math.round(sr * 0.4);
    this.floor = 1e-7;
    this.last = -Infinity;
    this.acc = 0;
    this.cnt = 0;
    this.px = 0;
    this.py = 0;
    this.a = Math.exp((-2 * Math.PI * 60) / sr);
    this.seen = 0;
    this.enabled = true;
  }

  setSensitivity(level /* 1..10 */) {
    // 1 → needs +16 dB jump, 10 → +7 dB
    const db = 16 - (level - 1);
    this.ratio = Math.pow(10, db / 10);
    this.minRms = 0.012 / Math.pow(1.35, level - 1);
  }

  /** Returns absolute frame indices of detected onsets within this chunk. */
  process(chunk, startFrame) {
    const out = [];
    const minE = this.minRms * this.minRms;
    for (let i = 0; i < chunk.length; i++) {
      const x = chunk[i];
      const y = this.a * (this.py + x - this.px);
      this.px = x;
      this.py = y;
      this.acc += y * y;
      if (++this.cnt === this.hop) {
        const e = this.acc / this.hop;
        const hopStart = startFrame + i - this.hop + 1;
        this.seen += this.hop;
        if (
          this.enabled &&
          this.seen > this.warmup &&
          e > this.floor * this.ratio &&
          e > minE &&
          hopStart - this.last > this.refractory
        ) {
          out.push(hopStart);
          this.last = hopStart;
        }
        // Asymmetric floor tracker: drops quickly, rises slowly (ignores the knocks themselves).
        if (e < this.floor) this.floor = 0.7 * this.floor + 0.3 * e;
        else this.floor = 0.995 * this.floor + 0.005 * Math.min(e, this.floor * 4);
        this.acc = 0;
        this.cnt = 0;
      }
    }
    return out;
  }
}

/** Linear chirp, Hann-tapered. Used as the sonar ping and as its matched-filter template. */
export function makeChirp(sr, f0, f1, durSec, amp = 0.8) {
  const n = Math.round(sr * durSec);
  const out = new Float32Array(n);
  const k = (f1 - f0) / durSec;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] = amp * hann(i, n) * Math.sin(2 * Math.PI * (f0 * t + 0.5 * k * t * t));
  }
  return out;
}

/** Cross-correlation r[lag] = Σ x[lag+i]·t[i], for lag in [0, x.length). */
export function xcorr(x, t) {
  const N = nextPow2(x.length + t.length);
  const xr = new Float64Array(N), xi = new Float64Array(N);
  const tr = new Float64Array(N), ti = new Float64Array(N);
  xr.set(x);
  tr.set(t);
  fft(xr, xi);
  fft(tr, ti);
  // R = X · conj(T); inverse FFT via conjugation trick.
  for (let k = 0; k < N; k++) {
    const r = xr[k] * tr[k] + xi[k] * ti[k];
    const i = xi[k] * tr[k] - xr[k] * ti[k];
    xr[k] = r;
    xi[k] = -i;
  }
  fft(xr, xi);
  const out = new Float64Array(x.length);
  for (let k = 0; k < x.length; k++) out[k] = xr[k] / N;
  return out;
}

/**
 * Acoustic ranging. Each recording contains the speaker→mic direct path followed by the
 * echo from the wall. We matched-filter every recording, align them on the direct-path
 * peak, average the envelopes, then pick the most prominent peak in the plausible range.
 */
export function estimateEchoDistance(recordings, template, sr, opts = {}) {
  const c = opts.speedOfSound ?? 343;
  const minLag = Math.round((sr * 2 * (opts.minDist ?? 0.15)) / c);
  const maxLag = Math.round((sr * 2 * (opts.maxDist ?? 2.5)) / c);
  const post = maxLag + Math.round(sr * 0.008);
  const smooth = Math.max(1, Math.round(sr * 0.00025));
  const acc = new Float64Array(post);
  const hits = [];

  for (const rec of recordings) {
    if (!rec || rec.length < template.length + post) continue;
    const r = xcorr(rec, template);
    const env = new Float64Array(r.length);
    let run = 0;
    for (let i = 0; i < r.length; i++) {
      run += Math.abs(r[i]);
      if (i >= smooth) run -= Math.abs(r[i - smooth]);
      env[i] = run / smooth;
    }
    let d = 0, dv = 0;
    for (let i = 0; i < env.length - post; i++) if (env[i] > dv) { dv = env[i]; d = i; }
    if (dv <= 0) continue;
    // Was the chirp actually received? Its matched-filter peak must tower over the typical level.
    const sorted = Array.from(env).sort((a, b) => a - b);
    if (dv < 8 * sorted[sorted.length >> 1]) continue;
    hits.push({ env, d, dv });
  }
  // The speaker→mic latency is fixed, so a real direct path lands at the same lag in every
  // recording. Keep only recordings that agree with the median lag (rejects stray sounds).
  const lags = hits.map((h) => h.d).sort((a, b) => a - b);
  const medLag = lags[lags.length >> 1];
  const tol = Math.round(sr * 0.0007);
  let used = 0;
  for (const h of hits) {
    if (Math.abs(h.d - medLag) > tol) continue;
    for (let i = 0; i < post; i++) acc[i] += h.env[h.d + i] / h.dv;
    used++;
  }
  if (used < Math.min(3, recordings.length)) return null;
  for (let i = 0; i < post; i++) acc[i] /= used;

  const tail = Array.from(acc.slice(maxLag, post)).sort((a, b) => a - b);
  const noise = tail.length ? tail[Math.floor(tail.length / 2)] : 0;
  const valleyWin = Math.round(sr * 0.0015);
  let best = -1, bestProm = 0;
  for (let k = Math.max(1, minLag); k < Math.min(maxLag, post - 1); k++) {
    if (acc[k] < acc[k - 1] || acc[k] < acc[k + 1]) continue;
    let valley = Infinity;
    for (let j = Math.max(1, k - valleyWin); j < k; j++) valley = Math.min(valley, acc[j]);
    const prom = acc[k] - valley;
    if (prom > bestProm) { bestProm = prom; best = k; }
  }
  const thresh = Math.max(0.03, 3 * noise);
  if (best < 0 || bestProm < thresh) return { distance: null, quality: bestProm / thresh, used };
  return {
    distance: (c * (best / sr)) / 2,
    lagMs: (best / sr) * 1000,
    quality: bestProm / thresh,
    used,
  };
}
