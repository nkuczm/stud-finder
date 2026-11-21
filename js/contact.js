// Contact-mode detectors: the phone is held flat against the wall and slid sideways.

import { apply, transpose, mul } from './orientation.js';
import { bandLevelsDb, logSpacedEdges } from './dsp.js';

const R2D = 180 / Math.PI;
const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

/**
 * Magnetic screw finder. Drywall is screwed (or nailed) into studs every ~30 cm with steel
 * fasteners, which distort the local magnetic field. Uses, in order of preference:
 *  1. Generic Sensor `Magnetometer` (Chrome Android with the sensor flag): field in µT,
 *     rotated into the world frame so turning the phone doesn't look like metal.
 *  2. Android: disagreement between the magnetometer-fused absolute orientation and the
 *     gyro-only relative orientation. Metal bends the compass; the gyro doesn't care.
 *  3. iOS: compass heading vs gyro heading, the same trick with webkitCompassHeading.
 */
export class MetalDetector {
  constructor(orientation) {
    this.o = orientation;
    this.source = 'none';
    this.unit = '';
    this.value = null; // vector (µT) or angle (°)
    this.base = null;
    this.signal = 0;
    this.calibrating = null;
    this.error = null;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    if ('Magnetometer' in window) {
      try {
        if (navigator.permissions) {
          const p = await navigator.permissions.query({ name: 'magnetometer' }).catch(() => null);
          if (p && p.state === 'denied') throw new Error('magnetometer permission denied');
        }
        const s = new window.Magnetometer({ frequency: 30 });
        s.addEventListener('reading', () => this.onVector([s.x, s.y, s.z]));
        s.addEventListener('error', (e) => {
          this.error = e.error?.message || 'magnetometer error';
          if (this.source === 'magnetometer') this.useHeadingFallback();
        });
        s.start();
        this.sensor = s;
        this.source = 'magnetometer';
        this.unit = 'µT';
        return;
      } catch (e) {
        this.error = e.message;
      }
    }
    this.useHeadingFallback();
  }

  useHeadingFallback() {
    if (this.sensor) try { this.sensor.stop(); } catch {}
    this.source = 'heading';
    this.unit = '°';
    this.base = null;
    this.o.onUpdate(() => this.onHeading());
  }

  onVector(b) {
    const v = this.o.available ? apply(this.o.rawR, b) : b; // device → world
    this.ingest(v, (a, base) => Math.hypot(a[0] - base[0], a[1] - base[1], a[2] - base[2]));
  }

  onHeading() {
    let off = null;
    if (this.o.Rabs && this.o.available) {
      // M = Rabs · Rrelᵀ is (ideally) a constant rotation about world-z: the compass offset.
      const M = mul(this.o.Rabs, transpose(this.o.rawR));
      off = Math.atan2(M[3], M[0]) * R2D;
    } else if (this.o.compassHeading != null && this.o.available) {
      const f = apply(this.o.rawR, [0, 0, -1]);
      const relHeading = Math.atan2(f[0], f[1]) * R2D; // clockwise from relative north
      off = wrap180(this.o.compassHeading - relHeading);
    }
    if (off == null) return;
    this.sourceDetail = this.o.Rabs ? 'compass vs gyro (Android)' : 'compass vs gyro (iOS)';
    this.ingest(off, (a, base) => Math.abs(wrap180(a - base)));
  }

  ingest(v, dist) {
    this.value = v;
    this.dist = dist;
    if (this.calibrating) {
      this.calibrating.samples.push(v);
      if (performance.now() > this.calibrating.until) this.finishCalibration();
    }
    if (this.base == null) this.base = v;
    const d = dist(v, this.base);
    this.signal = this.signal * 0.6 + d * 0.4;
  }

  calibrate(ms = 800) {
    this.calibrating = { until: performance.now() + ms, samples: [] };
  }

  finishCalibration() {
    const s = this.calibrating.samples;
    this.calibrating = null;
    if (!s.length) return;
    if (Array.isArray(s[0])) {
      this.base = [0, 1, 2].map((k) => s.reduce((a, v) => a + v[k], 0) / s.length);
    } else {
      // circular mean of angles
      const x = s.reduce((a, v) => a + Math.cos(v / R2D), 0), y = s.reduce((a, v) => a + Math.sin(v / R2D), 0);
      this.base = Math.atan2(y, x) * R2D;
    }
    this.signal = 0;
  }

  get defaultThreshold() {
    return this.unit === 'µT' ? 4 : 3;
  }
}

/**
 * Experimental echo / haptic probe. With the phone pressed on the wall it plays a low chirp
 * (and buzzes the vibration motor where supported) and listens. Over a cavity the drywall
 * acts like a soundboard and radiates more; over a stud the panel is pinned and damped.
 * Like a capacitive stud finder, it compares each probe against a calibration on a hollow spot.
 */
export class EchoProbe {
  constructor(audio, orientation) {
    this.audio = audio;
    this.o = orientation;
    this.edges = logSpacedEdges(150, 2500, 8);
    this.running = false;
    this.baseline = null;
    this.calib = null;
    this.score = 0;
    this.delta = 0;
    this.last = null;
    this.canVibrate = typeof navigator.vibrate === 'function';
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
  }

  calibrate(n = 6) {
    this.calib = { n, samples: [] };
  }

  async loop() {
    while (this.running) {
      try {
        const f = await this.probeOnce();
        if (f) this.handle(f);
      } catch (e) {
        console.warn(e);
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  async probeOnce() {
    const { audio } = this;
    const ctx = audio.ctx;
    if (!ctx || !audio.attached) return null;
    const sr = audio.sr;
    const t0 = ctx.currentTime + 0.05, dur = 0.15;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.frequency.setValueAtTime(150, t0);
    osc.frequency.exponentialRampToValueAtTime(2500, t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.7, t0 + 0.01);
    g.gain.setValueAtTime(0.7, t0 + dur - 0.01);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    const vibStart = performance.now() + 50;
    if (this.canVibrate) setTimeout(() => navigator.vibrate(150), 50);

    const a = Math.round(t0 * sr), b = Math.round((t0 + dur + 0.25) * sr);
    const ok = await audio.waitForFrame(b);
    if (!ok) return null;
    const rec = audio.getRange(a, b);
    if (!rec) return null;
    const bands = bandLevelsDb(rec, sr, this.edges);
    const acc = this.canVibrate ? this.o.accelRms(vibStart + 20, vibStart + 160) : null;
    const f = bands.slice();
    if (acc != null) f.push(20 * Math.log10(acc + 1e-3));
    return f;
  }

  handle(f) {
    this.last = f;
    if (this.calib) {
      this.calib.samples.push(f);
      if (this.calib.samples.length >= this.calib.n) {
        const s = this.calib.samples;
        const mean = f.map((_, k) => s.reduce((a, v) => a + v[k], 0) / s.length);
        const sd = f.map((_, k) => Math.max(0.7, Math.sqrt(s.reduce((a, v) => a + (v[k] - mean[k]) ** 2, 0) / s.length)));
        this.baseline = { mean, sd };
        this.calib = null;
        this.score = 0;
      }
      return;
    }
    if (!this.baseline) return;
    const { mean, sd } = this.baseline;
    let e = 0, dsum = 0;
    for (let k = 0; k < f.length; k++) {
      e += ((f[k] - mean[k]) / sd[k]) ** 2;
      dsum += f[k] - mean[k];
    }
    this.score = Math.sqrt(e / f.length);
    this.delta = dsum / f.length;
  }
}
