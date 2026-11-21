// Turns noisy per-knock measurements into stud positions.
// Pure functions: no DOM, unit-tested in Node.

export const SPACINGS = {
  '16in': { cm: 40.64, label: '16″ OC' },
  '24in': { cm: 60.96, label: '24″ OC' },
  '400mm': { cm: 40, label: '400 mm' },
  '600mm': { cm: 60, label: '600 mm' },
};
export const STUD_WIDTH_CM = 3.81; // 1.5″ actual width of a 2×4
const OUTLET_HALF_CM = 2.85; // half of a 2.25″ single-gang box; boxes are nailed to a stud's side

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

/** Robust z-score (median / MAD), falling back to std-dev, falling back to zeros. */
export function robustZ(values) {
  const m = median(values);
  let s = 1.4826 * median(values.map((v) => Math.abs(v - m)));
  if (!(s > 1e-9)) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    s = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  }
  if (!(s > 1e-9)) return values.map(() => 0);
  return values.map((v) => (v - m) / s);
}

/**
 * Solidity per knock, relative to the other knocks in this session (walls, knuckles and
 * rooms differ too much for absolute thresholds). Positive = solid (stud), negative = hollow.
 */
export function solidityScores(features) {
  if (features.length < 3) return features.map(() => 0);
  const low = robustZ(features.map((f) => f.lowRatio));
  const dec = robustZ(features.map((f) => Math.log(f.decayMs)));
  const cen = robustZ(features.map((f) => Math.log(f.centroid)));
  const dom = robustZ(features.map((f) => Math.log(f.domFreq)));
  return features.map((_, i) => {
    const hollow = 1.0 * low[i] + 0.8 * dec[i] - 0.6 * cen[i] - 0.4 * dom[i];
    return Math.max(-3, Math.min(3, -hollow / 2.2));
  });
}

const gauss = (d, s) => Math.exp(-0.5 * (d / s) ** 2);

function nearestStudDist(x, S, o) {
  const m = (((x - o) % S) + S) % S;
  return Math.min(m, S - m);
}

function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  if (saa < 1e-12 || sbb < 1e-12) return 0;
  return sab / Math.sqrt(saa * sbb);
}

export function scoreGrid(samples, clues, S, o, sigma) {
  let data = 0;
  if (samples.length >= 3) {
    const s = samples.map((p) => p.s);
    const pred = samples.map((p) => gauss(nearestStudDist(p.x, S, o), sigma));
    data = pearson(s, pred) * Math.sqrt(samples.length);
  }
  let clue = 0;
  for (const c of clues) {
    if (c.type === 'stud') clue += 3 * gauss(nearestStudDist(c.x, S, o), 2);
    else if (c.type === 'corner') clue += 1.5 * gauss(nearestStudDist(c.x, S, o), 4);
    else if (c.type === 'outlet') {
      const off = OUTLET_HALF_CM + STUD_WIDTH_CM / 2;
      clue += 1.5 * Math.max(
        gauss(nearestStudDist(c.x - off, S, o), 2.5),
        gauss(nearestStudDist(c.x + off, S, o), 2.5),
      );
    }
  }
  return data + clue;
}

/**
 * Fit a regular stud grid (centres at offset + k·spacing) to the knock map + clues.
 * Grid-searches the offset for each candidate spacing; confidence is the posterior mass
 * near the best offset (softmax over offsets) times the posterior of the chosen spacing.
 */
export function fitStudGrid(samples, clues = [], opts = {}) {
  const pts = samples.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.s));
  if (pts.length < 4 && !clues.some((c) => c.type === 'stud')) return null;
  const sigma = opts.sigma ?? 4;
  const beta = opts.beta ?? 1.5;
  const keys = !opts.spacing || opts.spacing === 'auto' ? ['16in', '24in'] : [opts.spacing];
  const step = 0.5;

  const perSpacing = keys.map((key) => {
    const S = SPACINGS[key].cm;
    const grid = [];
    for (let o = 0; o < S; o += step) grid.push({ o, score: scoreGrid(pts, clues, S, o, sigma) });
    let best = grid[0];
    for (const g of grid) if (g.score > best.score) best = g;
    let mass = 0, near = 0;
    for (const g of grid) {
      const w = Math.exp(beta * (g.score - best.score));
      mass += w;
      const d = Math.min(Math.abs(g.o - best.o), S - Math.abs(g.o - best.o));
      if (d <= 2.5) near += w;
    }
    const prior = key === '16in' || key === '400mm' ? 0.3 : 0;
    return { key, S, offset: best.o, score: best.score, adj: best.score + prior, offsetConf: near / mass };
  });

  let chosen = perSpacing[0];
  for (const r of perSpacing) if (r.adj > chosen.adj) chosen = r;
  let z = 0;
  for (const r of perSpacing) z += Math.exp(beta * (r.adj - chosen.adj));
  const spacingConf = 1 / z;

  // Not enough evidence yet → damp confidence.
  const evidence = Math.min(1, (pts.length + 4 * clues.filter((c) => c.type === 'stud').length) / 10);
  const xs = pts.map((p) => p.x).concat(clues.map((c) => c.x));
  return {
    spacingKey: chosen.key,
    spacing: chosen.S,
    label: SPACINGS[chosen.key].label,
    offset: chosen.offset,
    score: chosen.score,
    confidence: chosen.offsetConf * spacingConf * evidence,
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    alternatives: perSpacing,
  };
}

/** Stud centres of a fit, within [from, to]. */
export function studsInRange(fit, from, to) {
  if (!fit) return [];
  const out = [];
  const k0 = Math.ceil((from - fit.offset) / fit.spacing);
  for (let k = k0; ; k++) {
    const x = fit.offset + k * fit.spacing;
    if (x > to) break;
    out.push(x);
  }
  return out;
}

/** Kernel-smoothed solidity along the wall, for the AR heat strip. */
export function solidityProfile(samples, from, to, step = 1, bw = 3) {
  const out = [];
  for (let x = from; x <= to; x += step) {
    let ws = 0, w = 0;
    for (const p of samples) {
      const k = gauss(p.x - x, bw);
      ws += k * p.s;
      w += k;
    }
    out.push({ x, s: w > 1e-3 ? ws / w : 0, w });
  }
  return out;
}
