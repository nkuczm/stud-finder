// Device orientation → rotation matrices, plus small 3-vector helpers.
// World frame (W3C): x = east, y = north, z = up. Device frame: x = right of screen,
// y = up the screen, z = out of the screen toward the user. Rear camera looks along −z.

const D2R = Math.PI / 180;

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const normalize = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** R = Rz(α)·Rx(β)·Ry(γ), row-major 3×3, maps device vectors to world vectors. */
export function matFromEuler(alpha, beta, gamma) {
  const a = (alpha || 0) * D2R, b = (beta || 0) * D2R, g = (gamma || 0) * D2R;
  const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
  return [
    cA * cG - sA * sB * sG, -cB * sA, cG * sA * sB + cA * sG,
    cG * sA + cA * sB * sG, cA * cB, sA * sG - cA * cG * sB,
    -cB * sG, sB, cB * cG,
  ];
}

export function rotZ(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

export function mul(A, B) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      o[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return o;
}

export const transpose = (M) => [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]];
export const apply = (M, v) => [
  M[0] * v[0] + M[1] * v[1] + M[2] * v[2],
  M[3] * v[0] + M[4] * v[1] + M[5] * v[2],
  M[6] * v[0] + M[7] * v[1] + M[8] * v[2],
];
export const applyT = (M, v) => [
  M[0] * v[0] + M[3] * v[1] + M[6] * v[2],
  M[1] * v[0] + M[4] * v[1] + M[7] * v[2],
  M[2] * v[0] + M[5] * v[1] + M[8] * v[2],
];

/** Gram-Schmidt on the columns so a blended matrix stays a rotation. */
function orthonormalize(M) {
  let x = normalize([M[0], M[3], M[6]]);
  let y = [M[1], M[4], M[7]];
  y = normalize(sub(y, scale(x, dot(x, y))));
  const z = cross(x, y);
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

export class Orientation {
  constructor() {
    this.available = false;
    this.R = matFromEuler(0, 90, 0); // smoothed relative orientation
    this.rawR = this.R;
    this.Rabs = null; // absolute (magnetometer-fused) orientation, Android only
    this.compassHeading = null; // iOS
    this.virtual = { yaw: 0, pitch: 0 }; // used when there is no sensor (desktop / demo)
    this.accel = []; // {t, x, y, z}
    this.listeners = new Set();
    this.started = false;
  }

  /** Must be called synchronously inside a user gesture (iOS). */
  static request() {
    const ps = [];
    for (const E of [globalThis.DeviceOrientationEvent, globalThis.DeviceMotionEvent]) {
      if (E && typeof E.requestPermission === 'function') ps.push(E.requestPermission().catch(() => 'denied'));
    }
    return Promise.all(ps);
  }

  start() {
    if (this.started) return;
    this.started = true;
    addEventListener('deviceorientation', (e) => {
      if (e.alpha == null && e.beta == null) return;
      const M = matFromEuler(e.alpha, e.beta, e.gamma);
      this.rawR = M;
      if (typeof e.webkitCompassHeading === 'number') this.compassHeading = e.webkitCompassHeading;
      this.R = this.available ? orthonormalize(this.R.map((v, i) => v * 0.45 + M[i] * 0.55)) : M;
      this.available = true;
      for (const fn of this.listeners) fn();
    });
    addEventListener('deviceorientationabsolute', (e) => {
      if (e.alpha == null) return;
      this.Rabs = matFromEuler(e.alpha, e.beta, e.gamma);
      for (const fn of this.listeners) fn();
    });
    addEventListener('devicemotion', (e) => {
      const a = e.accelerationIncludingGravity || e.acceleration;
      if (!a || a.x == null) return;
      const t = performance.now();
      this.accel.push({ t, x: a.x, y: a.y, z: a.z });
      while (this.accel.length && t - this.accel[0].t > 3000) this.accel.shift();
    });
  }

  onUpdate(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  screenAngle() {
    const a = screen.orientation?.angle ?? window.orientation ?? 0;
    return a * D2R;
  }

  /** Screen-frame → world rotation, accounting for screen rotation. */
  matrix() {
    const base = this.available ? this.R : matFromEuler(this.virtual.yaw, 90 + this.virtual.pitch, 0);
    return mul(base, rotZ(-this.screenAngle()));
  }

  /** RMS of the high-passed acceleration between two performance.now() timestamps. */
  accelRms(t0, t1) {
    const w = this.accel.filter((s) => s.t >= t0 && s.t <= t1);
    if (w.length < 3) return null;
    const m = ['x', 'y', 'z'].map((k) => w.reduce((s, p) => s + p[k], 0) / w.length);
    let e = 0;
    for (const p of w) e += (p.x - m[0]) ** 2 + (p.y - m[1]) ** 2 + (p.z - m[2]) ** 2;
    return Math.sqrt(e / w.length);
  }
}
