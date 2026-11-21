// Synthetic knock audio for demo mode and tests. Models a knock as a click plus a few
// damped modes: hollow spots have a strong, slow low "drum" mode; studs are short and bright.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** hollowness: 0 = right over a stud, 1 = middle of a cavity. */
export function synthKnock(sr, hollowness, rng = Math.random, gain = 0.5) {
  const n = Math.round(sr * 0.2);
  const pre = Math.round(sr * 0.01);
  const out = new Float32Array(n);
  const h = Math.max(0, Math.min(1, hollowness));
  const modes = [
    { f: 130 + 70 * rng(), a: 1.1 * h + 0.05, tau: 0.012 + 0.025 * h },
    { f: 300 + 100 * rng(), a: 0.5 * h + 0.15, tau: 0.008 + 0.012 * h },
    { f: 750 + 250 * rng(), a: 0.35 + 0.6 * (1 - h), tau: 0.006 },
    { f: 1900 + 600 * rng(), a: 0.2 + 0.5 * (1 - h), tau: 0.003 },
  ];
  let max = 0;
  for (let i = 0; i < n; i++) {
    const t = (i - pre) / sr;
    let v = 0;
    if (t >= 0) {
      for (const m of modes) v += m.a * Math.exp(-t / m.tau) * Math.sin(2 * Math.PI * m.f * t);
      v += 0.5 * Math.exp(-t / 0.0012) * (rng() * 2 - 1);
    }
    out[i] = v;
    max = Math.max(max, Math.abs(v));
  }
  for (let i = 0; i < n; i++) out[i] = (out[i] / max) * gain + 0.002 * (rng() * 2 - 1);
  return out;
}
