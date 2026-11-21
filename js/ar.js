// AR knock map: the wall model (knocks + clues pinned to wall coordinates) and the
// canvas renderer that projects it over the live camera feed.
//
// Model: the phone pivots at a roughly fixed spot in front of a flat wall at distance D.
// Orientation comes from the gyro; translation along the wall is user-corrected by dragging.

import { apply, applyT, cross, dot, normalize, len } from './orientation.js';
import { fitStudGrid, solidityProfile, solidityScores, studsInRange, STUD_WIDTH_CM } from './inference.js';

const D2R = Math.PI / 180;
const UP = [0, 0, 1];
const NEAR = 1; // cm

export class ARSession {
  constructor(settings) {
    this.settings = settings;
    this.wall = null;
    this.camX = 0;
    this.knocks = [];
    this.clues = [];
    this.history = [];
    this.points = [];
    this.cluePoints = [];
    this.fit = null;
    this.profile = [];
    this.nextId = 1;
  }

  forward(R) {
    return apply(R, [0, 0, -1]);
  }

  setWallFrom(R) {
    const f = this.forward(R);
    let n = [f[0], f[1], 0];
    if (len(n) < 0.25) n = [0, 1, 0];
    n = normalize(n);
    this.wall = { n, right: cross(n, UP), up: UP };
    this.recompute();
  }

  ensureWall(R) {
    if (!this.wall) this.setWallFrom(R);
  }

  /** World direction (+ camera offset at the time) → wall coordinates in cm. */
  toWall(dir, camX) {
    if (!this.wall) return null;
    const { n, right } = this.wall;
    const den = dot(dir, n);
    if (den < 0.15) return null;
    const t = this.settings.distance / den;
    return { x: camX + t * dot(dir, right), y: t * dir[2] };
  }

  /** Wall coordinates → vector from the current camera position (world frame, cm). */
  toCam(x, y) {
    const { n, right, up } = this.wall;
    const dx = x - this.camX, D = this.settings.distance;
    return [
      dx * right[0] + y * up[0] + D * n[0],
      dx * right[1] + y * up[1] + D * n[1],
      dx * right[2] + y * up[2] + D * n[2],
    ];
  }

  addKnock(R, feat) {
    this.ensureWall(R);
    const k = { id: this.nextId++, dir: this.forward(R), camX: this.camX, feat, t: Date.now() };
    this.knocks.push(k);
    this.history.push({ kind: 'knock', item: k });
    this.recompute();
    return k;
  }

  addClue(R, type) {
    this.ensureWall(R);
    const c = { id: this.nextId++, type, dir: this.forward(R), camX: this.camX };
    this.clues.push(c);
    this.history.push({ kind: 'clue', item: c });
    this.recompute();
    return c;
  }

  undo() {
    const h = this.history.pop();
    if (!h) return false;
    const list = h.kind === 'knock' ? this.knocks : this.clues;
    const i = list.indexOf(h.item);
    if (i >= 0) list.splice(i, 1);
    this.recompute();
    return true;
  }

  clear() {
    this.knocks = [];
    this.clues = [];
    this.history = [];
    this.camX = 0;
    this.recompute();
  }

  recompute() {
    this.points = [];
    this.cluePoints = [];
    this.fit = null;
    this.profile = [];
    if (!this.wall) return;
    const s = solidityScores(this.knocks.map((k) => k.feat));
    this.knocks.forEach((k, i) => {
      const w = this.toWall(k.dir, k.camX);
      if (w) this.points.push({ ...w, s: s[i], id: k.id });
    });
    for (const c of this.clues) {
      const w = this.toWall(c.dir, c.camX);
      if (w) this.cluePoints.push({ ...w, type: c.type, id: c.id });
    }
    this.fit = fitStudGrid(this.points, this.cluePoints, { spacing: this.settings.spacing });
    if (this.points.length >= 3) {
      const xs = this.points.map((p) => p.x);
      this.profile = solidityProfile(this.points, Math.min(...xs) - 8, Math.max(...xs) + 8, 1, 3);
      this.stripY = this.points.map((p) => p.y).sort((a, b) => a - b)[this.points.length >> 1];
    } else {
      this.stripY = undefined;
    }
  }
}

export function solidityColor(s, alpha = 1) {
  // hollow (−) → blue, neutral → grey-white, solid (+) → amber
  const t = Math.max(-1, Math.min(1, s / 1.5));
  const lerp = (a, b, u) => Math.round(a + (b - a) * u);
  let c;
  if (t < 0) c = [lerp(225, 70, -t), lerp(230, 150, -t), lerp(235, 255, -t)];
  else c = [lerp(225, 255, t), lerp(230, 150, t), lerp(235, 40, t)];
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

export class ARRenderer {
  constructor(canvas, video) {
    this.canvas = canvas;
    this.video = video;
    this.ctx = canvas.getContext('2d');
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = this.canvas.clientWidth || innerWidth, h = this.canvas.clientHeight || innerHeight;
    this.W = w; this.H = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  /** Pinhole intrinsics in CSS pixels; video is displayed with object-fit: cover. */
  intrinsics(fovDeg) {
    const vw = this.video.videoWidth || this.W, vh = this.video.videoHeight || this.H;
    const fv = Math.max(vw, vh) / 2 / Math.tan((fovDeg * D2R) / 2);
    const s = Math.max(this.W / vw, this.H / vh);
    return { f: fv * s, cx: this.W / 2, cy: this.H / 2 };
  }

  /** Project a camera-relative world vector. Returns [u, v, depth] or null if behind. */
  project(R, K, P) {
    const d = applyT(R, P);
    if (d[2] > -NEAR) return null;
    return [K.cx + (K.f * d[0]) / -d[2], K.cy - (K.f * d[1]) / -d[2], -d[2]];
  }

  /** Project a 3D segment, clipping against the near plane. */
  projectSeg(R, K, A, B) {
    let a = applyT(R, A), b = applyT(R, B);
    const za = a[2] + NEAR, zb = b[2] + NEAR; // ≤ 0 is visible
    if (za > 0 && zb > 0) return null;
    if (za > 0 || zb > 0) {
      const t = za / (za - zb);
      const m = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, -NEAR];
      if (za > 0) a = m; else b = m;
    }
    const p = (d) => [K.cx + (K.f * d[0]) / -d[2], K.cy - (K.f * d[1]) / -d[2]];
    return [p(a), p(b)];
  }

  draw(session, R, opts) {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    if (!session.wall) return;
    const K = this.intrinsics(opts.fov);
    if (opts.demo) this.drawDemoWall(session, R, K);

    const aim = session.toWall(session.forward(R), session.camX);
    const yMid = session.stripY ?? aim?.y ?? 0;
    const fit = session.fit;

    // Studs: solid inside the scanned span, dashed where extrapolated from the grid.
    if (fit && fit.confidence > 0.05) {
      const span = fit.maxX - fit.minX;
      const pad = Math.max(fit.spacing * 2, 60);
      const studs = studsInRange(fit, fit.minX - pad, fit.maxX + pad);
      const alpha = 0.25 + 0.6 * Math.min(1, fit.confidence);
      for (const x of studs) {
        const inside = span > 10 && x >= fit.minX - fit.spacing * 0.25 && x <= fit.maxX + fit.spacing * 0.25;
        this.drawStud(session, R, K, x, inside ? alpha : alpha * 0.45, !inside);
      }
      if (aim) {
        let near = null;
        for (const x of studs) if (near == null || Math.abs(x - aim.x) < Math.abs(near - aim.x)) near = x;
        if (near != null) {
          const p = this.project(R, K, session.toCam(near, yMid + 18));
          if (p) this.label(p[0], p[1], `STUD · ${fit.label}`, `${Math.round(fit.confidence * 100)}% confidence`);
        }
      }
    }

    // Heat strip of kernel-smoothed solidity
    if (session.profile.length) {
      const h = 5;
      for (const cell of session.profile) {
        if (cell.w < 0.25) continue;
        const pts = [
          session.toCam(cell.x - 0.55, yMid - h), session.toCam(cell.x + 0.55, yMid - h),
          session.toCam(cell.x + 0.55, yMid + h), session.toCam(cell.x - 0.55, yMid + h),
        ].map((P) => this.project(R, K, P));
        if (pts.some((p) => !p)) continue;
        ctx.fillStyle = solidityColor(cell.s, Math.min(0.85, cell.w * 0.6));
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.closePath();
        ctx.fill();
      }
    }

    // Ruler ticks along the strip, relative to the first knock
    if (session.points.length >= 2 && opts.fmt) {
      const x0 = session.points[0].x;
      const step = opts.units === 'metric' ? 10 : 15.24; // 10 cm or 6 in
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.5;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const xs = session.points.map((p) => p.x);
      const lo = Math.min(...xs), hi = Math.max(...xs);
      for (let k = Math.ceil((lo - x0) / step); x0 + k * step <= hi; k++) {
        const x = x0 + k * step;
        const seg = this.projectSeg(R, K, session.toCam(x, yMid - 6), session.toCam(x, yMid - 10));
        if (!seg) continue;
        ctx.beginPath(); ctx.moveTo(...seg[0]); ctx.lineTo(...seg[1]); ctx.stroke();
        ctx.fillText(opts.fmt(k * step), seg[1][0], seg[1][1] + 2);
      }
    }

    // Knock dots
    for (const p of session.points) {
      const q = this.project(R, K, session.toCam(p.x, p.y));
      if (!q) continue;
      const r = Math.max(4, Math.min(10, (K.f * 1.2) / q[2]));
      ctx.beginPath();
      ctx.arc(q[0], q[1], opts.flashId === p.id ? r * 1.8 : r, 0, Math.PI * 2);
      ctx.fillStyle = solidityColor(p.s, 0.95);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.stroke();
    }

    // Clues
    for (const c of session.cluePoints) {
      const q = this.project(R, K, session.toCam(c.x, c.y));
      if (!q) continue;
      const icon = { stud: '✚', outlet: '⏻', corner: '⌐' }[c.type] || '•';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath(); ctx.arc(q[0], q[1], 14, 0, Math.PI * 2); ctx.fill();
      ctx.font = '600 18px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = c.type === 'stud' ? '#ffb347' : '#fff';
      ctx.fillText(icon, q[0], q[1] + 1);
    }
  }

  drawStud(session, R, K, x, alpha, dashed) {
    const { ctx } = this;
    const hw = STUD_WIDTH_CM / 2, y0 = -150, y1 = 130;
    const L = this.projectSeg(R, K, session.toCam(x - hw, y0), session.toCam(x - hw, y1));
    const Rr = this.projectSeg(R, K, session.toCam(x + hw, y0), session.toCam(x + hw, y1));
    if (!L || !Rr) return;
    ctx.fillStyle = `rgba(255,150,40,${alpha * 0.45})`;
    ctx.beginPath();
    ctx.moveTo(...L[0]); ctx.lineTo(...L[1]); ctx.lineTo(...Rr[1]); ctx.lineTo(...Rr[0]);
    ctx.closePath();
    ctx.fill();
    ctx.setLineDash(dashed ? [10, 8] : []);
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(255,170,60,${Math.min(1, alpha + 0.2)})`;
    for (const s of [L, Rr]) { ctx.beginPath(); ctx.moveTo(...s[0]); ctx.lineTo(...s[1]); ctx.stroke(); }
    ctx.setLineDash([]);
  }

  label(x, y, title, sub) {
    const { ctx } = this;
    ctx.font = '700 13px system-ui, sans-serif';
    const w = Math.max(ctx.measureText(title).width, 100) + 20;
    const h = 40, lx = x - w / 2, ly = y - h;
    ctx.fillStyle = 'rgba(20,20,24,0.8)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(lx, ly, w, h, 8); else ctx.rect(lx, ly, w, h);
    ctx.fill();
    ctx.fillStyle = '#ffb347';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(title, x, ly + 17);
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(sub, x, ly + 32);
  }

  /** Demo mode has no camera: draw a plain wall with visual cues so panning feels real. */
  drawDemoWall(session, R, K) {
    const { ctx } = this;
    const g = ctx.createLinearGradient(0, 0, 0, this.H);
    g.addColorStop(0, '#d9d2c5');
    g.addColorStop(1, '#bfb6a6');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.W, this.H);
    const line = (y, color, w) => {
      const s = this.projectSeg(R, K, session.toCam(session.camX - 500, y), session.toCam(session.camX + 500, y));
      if (!s) return;
      ctx.strokeStyle = color; ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(...s[0]); ctx.lineTo(...s[1]); ctx.stroke();
    };
    line(-125, '#f4f1ea', 10);
    line(-131, '#8d8576', 2);
    // Faint drywall specks at fixed wall positions give the eye something to track.
    ctx.fillStyle = 'rgba(90,80,65,0.35)';
    for (let i = 0; i < 400; i++) {
      const x = ((i * 73.13) % 300) - 150, y = ((i * 41.7) % 220) - 120;
      const p = this.project(R, K, session.toCam(x, y));
      if (p) ctx.fillRect(p[0], p[1], 2, 2);
    }
    // A fake outlet at x ≈ 55 cm, a little below eye level
    const corners = [[51, -40], [58, -40], [58, -28], [51, -28]].map(([x, y]) => this.project(R, K, session.toCam(x, y)));
    if (corners.every(Boolean)) {
      ctx.fillStyle = '#f7f5ef';
      ctx.strokeStyle = '#9d968a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      corners.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }
}
