import test from 'node:test';
import assert from 'node:assert/strict';
import { fitStudGrid, solidityScores, studsInRange, SPACINGS } from '../js/inference.js';
import { analyzeKnock } from '../js/dsp.js';
import { synthKnock, mulberry32 } from '../js/synth.js';

const SR = 48000;

function simulateScan({ spacing, offset, from = -60, to = 70, step = 5, seed = 1, jitter = 1.5 }) {
  const rng = mulberry32(seed);
  const xs = [], feats = [];
  for (let x = from; x <= to; x += step) {
    const xr = x + (rng() * 2 - 1) * jitter;
    const m = (((xr - offset) % spacing) + spacing) % spacing;
    const d = Math.min(m, spacing - m);
    const hollow = Math.min(1, Math.max(0, 1 - Math.exp(-0.5 * (d / 3) ** 2) + (rng() - 0.5) * 0.25));
    xs.push(x); // measured position (true + error already applied to physics)
    feats.push(analyzeKnock(synthKnock(SR, hollow, rng, 0.2 + rng() * 0.6), SR));
  }
  const s = solidityScores(feats);
  return xs.map((x, i) => ({ x, s: s[i] }));
}

const wrapDist = (a, b, S) => { const d = Math.abs((((a - b) % S) + S) % S); return Math.min(d, S - d); };

test('recovers a 16in grid from synthetic knocks', () => {
  const samples = simulateScan({ spacing: 40.64, offset: 9 });
  const fit = fitStudGrid(samples, [], { spacing: 'auto' });
  assert.equal(fit.spacingKey, '16in');
  assert.ok(wrapDist(fit.offset, 9, fit.spacing) < 2.5, `offset ${fit.offset}`);
  assert.ok(fit.confidence > 0.5, `confidence ${fit.confidence}`);
});

test('recovers a 24in grid from synthetic knocks', () => {
  const samples = simulateScan({ spacing: 60.96, offset: 20, from: -80, to: 90, seed: 4 });
  const fit = fitStudGrid(samples, [], { spacing: 'auto' });
  assert.equal(fit.spacingKey, '24in');
  assert.ok(wrapDist(fit.offset, 20, fit.spacing) < 2.5, `offset ${fit.offset}`);
});

test('solid knocks score higher than hollow ones', () => {
  const rng = mulberry32(9);
  const f = [1, 1, 0, 1, 0, 1].map((h) => analyzeKnock(synthKnock(SR, h, rng), SR));
  const s = solidityScores(f);
  assert.ok(Math.min(s[2], s[4]) > Math.max(s[0], s[1], s[3], s[5]));
});

test('a confirmed stud clue alone pins the grid', () => {
  const fit = fitStudGrid([], [{ type: 'stud', x: 12 }], { spacing: '16in' });
  assert.ok(wrapDist(fit.offset, 12, SPACINGS['16in'].cm) <= 0.5);
  const studs = studsInRange(fit, -50, 60);
  assert.ok(studs.some((x) => Math.abs(x - 12) < 1));
});

test('pure noise gives low confidence', () => {
  const rng = mulberry32(5);
  const samples = [];
  for (let x = -50; x <= 50; x += 5) samples.push({ x, s: rng() * 2 - 1 });
  const fit = fitStudGrid(samples, [], { spacing: 'auto' });
  assert.ok(fit.confidence < 0.5, `confidence ${fit.confidence}`);
});
