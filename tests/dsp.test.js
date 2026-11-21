import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeKnock, OnsetDetector, makeChirp, estimateEchoDistance, fft } from '../js/dsp.js';
import { synthKnock, mulberry32 } from '../js/synth.js';

const SR = 48000;

test('fft of a pure tone peaks at the right bin', () => {
  const n = 1024, re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 37 * i) / n);
  fft(re, im);
  let best = 0;
  for (let k = 1; k < n / 2; k++) if (re[k] ** 2 + im[k] ** 2 > re[best] ** 2 + im[best] ** 2) best = k;
  assert.equal(best, 37);
});

test('hollow knocks are lower, longer and boomier than stud knocks', () => {
  const rng = mulberry32(1);
  const hollow = [], solid = [];
  for (let i = 0; i < 10; i++) {
    hollow.push(analyzeKnock(synthKnock(SR, 1, rng), SR));
    solid.push(analyzeKnock(synthKnock(SR, 0, rng), SR));
  }
  const avg = (a, k) => a.reduce((s, f) => s + f[k], 0) / a.length;
  assert.ok(avg(hollow, 'lowRatio') > avg(solid, 'lowRatio') + 0.2, 'lowRatio');
  assert.ok(avg(hollow, 'decayMs') > avg(solid, 'decayMs'), 'decay');
  assert.ok(avg(hollow, 'centroid') < avg(solid, 'centroid'), 'centroid');
});

test('analyzeKnock rejects silence', () => {
  assert.equal(analyzeKnock(new Float32Array(SR / 5), SR), null);
});

test('onset detector finds knocks in a noisy stream and ignores noise', () => {
  const rng = mulberry32(2);
  const total = SR * 3;
  const sig = new Float32Array(total);
  for (let i = 0; i < total; i++) sig[i] = 0.003 * (rng() * 2 - 1);
  const at = [SR * 0.8, SR * 1.5, SR * 2.4].map(Math.round);
  for (const a of at) {
    const k = synthKnock(SR, 0.5, rng, 0.3);
    for (let i = 0; i < k.length && a + i < total; i++) sig[a + i] += k[i];
  }
  const det = new OnsetDetector(SR);
  const found = [];
  for (let s = 0; s < total; s += 1024) found.push(...det.process(sig.subarray(s, s + 1024), s));
  assert.equal(found.length, 3, `found ${found}`);
  found.forEach((f, i) => assert.ok(Math.abs(f - (at[i] + 0.01 * SR)) < 0.01 * SR, `onset ${i} at ${f}`));
});

test('sonar finds the wall echo behind a ringing direct path', () => {
  const rng = mulberry32(3);
  const chirp = makeChirp(SR, 2000, 11000, 0.006);
  const distance = 0.55; // metres
  const recs = [];
  for (let r = 0; r < 6; r++) {
    const len = Math.round(SR * 0.06);
    const rec = new Float32Array(len);
    const d0 = 400 + Math.floor(rng() * 50); // unknown system latency
    const echo = d0 + Math.round((2 * distance / 343) * SR);
    // direct path with some phone-body ringing
    for (let i = 0; i < chirp.length; i++) {
      rec[d0 + i] += chirp[i];
      rec[d0 + i + 7] += 0.4 * chirp[i];
      rec[d0 + i + 23] += 0.15 * chirp[i];
      rec[echo + i] += 0.12 * chirp[i];
      rec[echo + 140 + i] += 0.05 * chirp[i]; // weaker floor/ceiling reflection
    }
    for (let i = 0; i < len; i++) rec[i] += 0.01 * (rng() * 2 - 1);
    recs.push(rec);
  }
  const res = estimateEchoDistance(recs, chirp, SR);
  assert.ok(res && res.distance, JSON.stringify(res));
  assert.ok(Math.abs(res.distance - distance) < 0.03, `got ${res.distance}`);
});

test('sonar refuses recordings that do not contain the chirp', () => {
  const rng = mulberry32(7);
  const chirp = makeChirp(SR, 2000, 11000, 0.006);
  const recs = [];
  for (let r = 0; r < 6; r++) {
    const rec = new Float32Array(Math.round(SR * 0.06));
    for (let i = 0; i < rec.length; i++) rec[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR) + 0.01 * (rng() * 2 - 1);
    recs.push(rec);
  }
  assert.equal(estimateEchoDistance(recs, chirp, SR), null);
});
