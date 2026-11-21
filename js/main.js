import { Orientation } from './orientation.js';
import { AudioEngine, AUDIO_CONSTRAINTS } from './audio.js';
import { ARSession, ARRenderer } from './ar.js';
import { MetalDetector, EchoProbe } from './contact.js';
import { analyzeKnock, OnsetDetector, makeChirp, estimateEchoDistance } from './dsp.js';
import { synthKnock } from './synth.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEMO = new URLSearchParams(location.search).has('demo');

// ───────────── Settings ─────────────
const DEFAULTS = { distance: 55, fov: 68, spacing: 'auto', units: 'imperial', sensitivity: 6, sound: true, metalThr: null, echoThr: 2.5 };
const settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('studfinder.settings') || '{}')); } catch {}
const save = () => { try { localStorage.setItem('studfinder.settings', JSON.stringify(settings)); } catch {} };

const fmt = (cm) => {
  if (settings.units === 'metric') return `${Math.round(cm)} cm`;
  const inch = cm / 2.54;
  return `${Math.abs(inch) < 10 ? inch.toFixed(1) : Math.round(inch)}″`;
};

// ───────────── Shared state ─────────────
const orientation = new Orientation();
const audio = new AudioEngine();
const video = $('#cam');
const overlay = $('#overlay');
const renderer = new ARRenderer(overlay, video);
const session = new ARSession(settings);
let current = 'home';
let videoStream = null;
let onset = null;
let pending = [];
let sonarBusy = false;
let flashId = null;
let arStartedAt = 0;

function show(id) {
  current = id;
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  if (id === 'ar') requestAnimationFrame(() => renderer.resize());
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

if (!window.isSecureContext) {
  $('#secure-note').textContent = 'Camera, microphone and motion sensors need HTTPS. Open this page via https:// (or localhost).';
}

$$('[data-back]').forEach((b) => b.addEventListener('click', goHome));
function goHome() {
  if (videoStream) { videoStream.getVideoTracks().forEach((t) => t.stop()); videoStream = null; }
  echo.stop();
  show('home');
}

// ───────────── AR knock map ─────────────
$('#start-ar').addEventListener('click', startAR);
if (DEMO) {
  // The demo link lands here; go straight into the AR view.
  addEventListener('load', () => startAR());
}

async function startAR() {
  const perm = Orientation.request(); // must be inside the gesture on iOS
  let mediaP = null;
  if (!DEMO && navigator.mediaDevices?.getUserMedia) {
    audio.createContext();
    mediaP = navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: audio.attached ? false : AUDIO_CONSTRAINTS,
    });
  }
  show('ar');
  arStartedAt = performance.now();
  let seen = false;
  try { seen = localStorage.getItem('studfinder.coach') === '1'; } catch {}
  $('#coach').hidden = seen;
  $('#sim-knock').hidden = !DEMO;
  if (DEMO) {
    $('#sim-knock').textContent = 'Knock';
    $('#coach').hidden = true;
    toast('Demo: drag to look around, tap Knock. Long-press Knock to auto-sweep.', 5000);
  }

  await perm.catch(() => {});
  orientation.start();
  if (mediaP) {
    try {
      const stream = await mediaP;
      videoStream = stream;
      video.srcObject = new MediaStream(stream.getVideoTracks());
      await video.play().catch(() => {});
      if (stream.getAudioTracks().length) await audio.attach(new MediaStream(stream.getAudioTracks()));
      setupKnockDetection();
    } catch (e) {
      toast(`Camera/microphone unavailable: ${e.message || e.name}`, 5000);
    }
  } else if (!DEMO) {
    toast('This browser has no camera API. Try the demo.', 5000);
  }
  requestAnimationFrame(arFrame);
}

function setupKnockDetection() {
  if (onset || !audio.attached) return;
  onset = new OnsetDetector(audio.sr);
  onset.setSensitivity(settings.sensitivity);
  audio.onChunk((chunk, frame) => {
    const hits = onset.process(chunk, frame);
    if (current !== 'ar' || sonarBusy || !$('#coach').hidden || $('#settings').open) return;
    for (const f of hits) pending.push({ frame: f, R: orientation.matrix() });
  });
  setInterval(processPending, 40);
}

function processPending() {
  const sr = audio.sr;
  while (pending.length && audio.writeFrame >= pending[0].frame + 0.17 * sr) {
    const p = pending.shift();
    const samples = audio.getRange(p.frame - 0.01 * sr, p.frame + 0.16 * sr);
    const feat = samples && analyzeKnock(samples, sr);
    if (feat) registerKnock(p.R, feat);
  }
}

function registerKnock(R, feat) {
  if (!session.toWall(session.forward(R), session.camX) && session.wall) {
    toast('Point the crosshair at the wall');
    return;
  }
  const k = session.addKnock(R, feat);
  flashId = k.id;
  setTimeout(() => { if (flashId === k.id) flashId = null; }, 400);
  const ch = $('.crosshair');
  ch.classList.remove('pulse');
  void ch.offsetWidth;
  ch.classList.add('pulse');
  if (feat.clipped) toast('That knock clipped. Knock a little softer.');
  updateHud();
}

function updateHud() {
  const n = session.points.length;
  $('#knock-count').textContent = `${n} knock${n === 1 ? '' : 's'}`;
  const fit = session.fit;
  const chip = $('#fit-chip');
  if (!fit || n + session.clues.length < 6) {
    chip.textContent = n ? `Keep going: knock ${Math.max(1, 6 - n)}+ more, ~2″ apart` : 'Knock on the wall at the crosshair';
  } else if (fit.confidence < 0.3) {
    const span = fit.maxX - fit.minX;
    chip.textContent = span < fit.spacing * 1.5 ? `Widen the scan (now ${fmt(span)})` : `Unsure (${Math.round(fit.confidence * 100)}%): add knocks or a clue`;
  } else {
    chip.textContent = `Studs found · ${fit.label} · ${Math.round(fit.confidence * 100)}%`;
  }
}

function arFrame() {
  if (current !== 'ar') return;
  const R = orientation.matrix();
  if (!session.wall && (orientation.available || DEMO || performance.now() - arStartedAt > 1500)) {
    session.setWallFrom(R);
  }
  renderer.draw(session, R, { fov: settings.fov, demo: DEMO, fmt, units: settings.units, flashId });
  const lvl = Math.max(0, Math.min(1, (audio.level + 70) / 60));
  $('#mic-meter').style.width = `${audio.attached ? lvl * 100 : 0}%`;
  requestAnimationFrame(arFrame);
}

addEventListener('resize', () => renderer.resize());

// Drag: without a gyro it pans a virtual view; with one it slides the overlay along the wall
// (to re-align after you step sideways).
let drag = null;
overlay.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; overlay.setPointerCapture(e.pointerId); });
overlay.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag = { x: e.clientX, y: e.clientY };
  const f = renderer.intrinsics(settings.fov).f;
  if (orientation.available) {
    session.camX -= (dx * settings.distance) / f;
  } else {
    orientation.virtual.yaw += (dx / f) * (180 / Math.PI);
    orientation.virtual.pitch = Math.max(-60, Math.min(60, orientation.virtual.pitch + (dy / f) * (180 / Math.PI)));
  }
});
overlay.addEventListener('pointerup', () => (drag = null));
overlay.addEventListener('pointercancel', () => (drag = null));

$('#coach-ok').addEventListener('click', () => {
  $('#coach').hidden = true;
  try { localStorage.setItem('studfinder.coach', '1'); } catch {}
});
$('#undo').addEventListener('click', () => { if (!session.undo()) toast('Nothing to undo'); updateHud(); });
$('#clear').addEventListener('click', () => {
  if (!session.knocks.length && !session.clues.length) return;
  if (confirm('Clear all knocks and clues?')) { session.clear(); session.wall = null; updateHud(); }
});

$('#clue-btn').addEventListener('click', () => ($('#clue-menu').hidden = false));
$('#clue-cancel').addEventListener('click', () => ($('#clue-menu').hidden = true));
$$('[data-clue]').forEach((b) =>
  b.addEventListener('click', () => {
    session.addClue(orientation.matrix(), b.dataset.clue);
    $('#clue-menu').hidden = true;
    toast({ stud: 'Stud clue added', outlet: 'Outlet added: a stud runs along one of its sides', corner: 'Corner added' }[b.dataset.clue]);
    updateHud();
  }),
);

// Demo: simulated wall with hidden studs at 16″ centres.
const TRUTH = { spacing: 40.64, offset: 7.3 };
function simKnock() {
  const R = orientation.matrix();
  session.ensureWall(R);
  const aim = session.toWall(session.forward(R), session.camX);
  if (!aim) return toast('Point at the wall');
  const x = aim.x + (Math.random() - 0.5) * 3; // where the knuckle actually landed
  const m = (((x - TRUTH.offset) % TRUTH.spacing) + TRUTH.spacing) % TRUTH.spacing;
  const d = Math.min(m, TRUTH.spacing - m);
  const hollow = 1 - Math.exp(-0.5 * (d / 3) ** 2) + (Math.random() - 0.5) * 0.3;
  const sig = synthKnock(48000, hollow, Math.random, 0.25 + Math.random() * 0.5);
  const feat = analyzeKnock(sig, 48000);
  if (feat) registerKnock(R, feat);
}
let autoTimer = null, pressTimer = null, longPressed = false;
async function autoSweep() {
  if (autoTimer) return;
  autoTimer = true;
  const startYaw = orientation.virtual.yaw;
  const yawFor = (x) => startYaw - Math.atan(x / settings.distance) * (180 / Math.PI);
  const glide = async (target) => {
    for (let s = 0; s < 6; s++) {
      orientation.virtual.yaw += (target - orientation.virtual.yaw) * 0.45;
      await sleep(25);
    }
  };
  for (let x = -60; x <= 60 && current === 'ar'; x += 5) {
    await glide(yawFor(x));
    simKnock();
    await sleep(60);
  }
  await glide(yawFor(0));
  await glide(yawFor(0));
  autoTimer = null;
}
const sim = $('#sim-knock');
sim.addEventListener('pointerdown', () => { longPressed = false; pressTimer = setTimeout(() => { longPressed = true; autoSweep(); }, 600); });
sim.addEventListener('pointerup', () => { clearTimeout(pressTimer); if (!longPressed) simKnock(); });
sim.addEventListener('pointerleave', () => clearTimeout(pressTimer));
addEventListener('keydown', (e) => { if (DEMO && current === 'ar' && (e.key === 'k' || e.key === ' ')) simKnock(); });

// ───────────── AR settings ─────────────
const dlg = $('#settings');
function syncSettingsUI() {
  $('#distance').value = settings.distance;
  $('#dist-out').textContent = fmt(settings.distance);
  $('#fov').value = settings.fov;
  $('#fov-out').textContent = `${settings.fov}°`;
  $('#spacing').value = settings.spacing;
  $('#units').value = settings.units;
  $('#sensitivity').value = settings.sensitivity;
  $('#sens-out').textContent = settings.sensitivity;
}
$('#open-settings').addEventListener('click', () => { syncSettingsUI(); dlg.showModal(); });
const onSetting = (id, key, parse) =>
  $(id).addEventListener('input', (e) => {
    settings[key] = parse(e.target.value);
    save();
    syncSettingsUI();
    session.recompute();
    if (onset) onset.setSensitivity(settings.sensitivity);
    updateHud();
  });
onSetting('#distance', 'distance', Number);
onSetting('#fov', 'fov', Number);
onSetting('#spacing', 'spacing', String);
onSetting('#units', 'units', String);
onSetting('#sensitivity', 'sensitivity', Number);
$('#square').addEventListener('click', () => {
  session.setWallFrom(orientation.matrix());
  session.camX = 0;
  toast('Wall direction set from the current aim');
  dlg.close();
});
$('#realign').addEventListener('click', () => { session.camX = 0; toast('Alignment reset'); });

// Sonar ranging: chirp out of the speaker, time the echo off the wall.
$('#sonar').addEventListener('click', async () => {
  const out = $('#sonar-out');
  if (DEMO || !audio.attached) { out.textContent = 'Sonar needs the microphone (not available in demo).'; return; }
  if (sonarBusy) return;
  sonarBusy = true;
  $('#sonar').disabled = true;
  out.textContent = 'Pinging… hold still';
  try {
    audio.createContext();
    const sr = audio.sr;
    const chirp = makeChirp(sr, 2000, 11000, 0.006, 0.9);
    const recs = [];
    for (let i = 0; i < 8; i++) {
      const t0 = audio.ctx.currentTime + 0.06;
      audio.play(chirp, t0);
      const a = Math.round(t0 * sr), b = a + Math.round(0.3 * sr);
      if (await audio.waitForFrame(b)) {
        const rec = audio.getRange(a, b);
        if (rec) recs.push(rec);
      }
      await sleep(40);
    }
    const res = estimateEchoDistance(recs, chirp, sr, { minDist: 0.18, maxDist: 2.2 });
    if (res && res.distance) {
      settings.distance = Math.round(res.distance * 100);
      save();
      syncSettingsUI();
      session.recompute();
      updateHud();
      out.textContent = `Echo at ${fmt(settings.distance)} (${res.quality > 2 ? 'strong' : 'weak'} echo). Adjust the slider if it looks off.`;
    } else {
      out.textContent = 'No clear echo. Move a little closer, keep quiet and retry, or set the distance by hand.';
    }
  } catch (e) {
    out.textContent = `Sonar failed: ${e.message}`;
  } finally {
    sonarBusy = false;
    $('#sonar').disabled = false;
  }
});

// ───────────── Contact scanner ─────────────
const metal = new MetalDetector(orientation);
const echo = new EchoProbe(audio, orientation);
let contactMode = 'metal';
let hist = [];
let lastClick = 0;

$('#start-contact').addEventListener('click', async () => {
  const perm = Orientation.request();
  audio.createContext();
  show('contact');
  await perm.catch(() => {});
  orientation.start();
  await metal.start();
  setContactMode(contactMode);
  hist = [];
  requestAnimationFrame(contactFrame);
});

$$('.seg [data-mode]').forEach((b) => b.addEventListener('click', () => setContactMode(b.dataset.mode)));
async function setContactMode(m) {
  contactMode = m;
  hist = [];
  $$('.seg [data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  $('#tips-metal').hidden = m !== 'metal';
  $('#tips-echo').hidden = m !== 'echo';
  syncThreshold();
  if (m === 'echo') {
    if (!audio.attached) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
        await audio.attach(s);
      } catch (e) {
        $('#gauge-state').textContent = 'Microphone unavailable';
        return;
      }
    }
    echo.start();
  } else {
    echo.stop();
  }
}

function thrKey() { return contactMode === 'metal' ? 'metalThr' : 'echoThr'; }
function threshold() {
  return settings[thrKey()] ?? (contactMode === 'metal' ? metal.defaultThreshold : 2.5);
}
function syncThreshold() {
  $('#threshold').value = threshold();
  $('#thr-out').textContent = `${threshold()} ${contactMode === 'metal' ? metal.unit : 'σ'}`;
}
$('#threshold').addEventListener('input', (e) => { settings[thrKey()] = Number(e.target.value); save(); syncThreshold(); });
$('#calibrate').addEventListener('click', () => {
  if (contactMode === 'metal') metal.calibrate();
  else echo.calibrate();
  hist = [];
});
$('#sound-toggle').addEventListener('click', () => {
  settings.sound = !settings.sound;
  save();
  $('#sound-toggle').textContent = settings.sound ? '🔊' : '🔇';
});
$('#sound-toggle').textContent = settings.sound ? '🔊' : '🔇';

function contactFrame() {
  if (current !== 'contact') return;
  const now = performance.now();
  const thr = threshold();
  let v = 0, state = '', unit = '', ready = false;
  if (contactMode === 'metal') {
    unit = metal.unit;
    ready = metal.value != null;
    v = metal.signal;
    if (!ready) state = metal.source === 'none' ? 'No magnetic sensor' : 'Waiting for sensor…';
    else if (metal.calibrating) state = 'Calibrating… hold still';
    else state = v > thr ? 'METAL: likely a screw' : 'Slide slowly…';
    const src = metal.source === 'magnetometer' ? 'Magnetometer (µT, rotation-compensated)' : metal.sourceDetail || 'compass vs gyro';
    let srcText = `Sensor: ${src}`;
    if (!ready && now - (metal.startedAt ??= now) > 2500) {
      srcText = 'No magnetic data from this browser. On Android Chrome, enabling chrome://flags/#enable-generic-sensor-extra-classes gives the precise magnetometer.';
    }
    $('#contact-source').textContent = srcText;
    if (ready && settings.sound && !metal.calibrating) {
      const ratio = v / thr;
      const interval = ratio >= 1 ? 70 : 700 / (1 + 4 * ratio);
      if (now - lastClick > interval) { audio.blip(ratio >= 1 ? 1800 : 1100); lastClick = now; }
    }
  } else {
    unit = 'σ';
    v = echo.score;
    ready = !!echo.baseline;
    if (!audio.attached) state = 'Microphone needed';
    else if (echo.calib) state = `Calibrating… ${echo.calib.samples.length}/${echo.calib.n}`;
    else if (!ready) state = 'Press on a hollow spot, then calibrate';
    else state = v > thr ? 'DIFFERENT: possible stud' : 'Hollow-like';
    $('#contact-source').textContent = `Probe: 150–2500 Hz chirp${echo.canVibrate ? ' + vibration motor' : ''} · level change ${echo.delta >= 0 ? '+' : ''}${echo.delta.toFixed(1)} dB`;
  }

  $('#gauge-value').textContent = ready ? (v < 10 ? v.toFixed(1) : Math.round(v)) : '–';
  $('#gauge-unit').textContent = unit;
  $('#gauge-state').textContent = state;
  $('.ring').style.setProperty('--p', ready ? Math.min(100, (v / (thr * 2)) * 100) : 0);
  $('#gauge').classList.toggle('hit', ready && v > thr);

  if (ready && (!hist.length || now - hist[hist.length - 1].t > 33)) hist.push({ t: now, v });
  while (hist.length && now - hist[0].t > 12000) hist.shift();
  drawChart(thr, now);
  requestAnimationFrame(contactFrame);
}

function drawChart(thr, now) {
  const c = $('#chart');
  const dpr = Math.min(devicePixelRatio || 1, 3);
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const max = Math.max(thr * 2, ...hist.map((p) => p.v)) * 1.1;
  const y = (v) => h - 8 - (v / max) * (h - 16);
  g.strokeStyle = 'rgba(255,154,60,.6)';
  g.setLineDash([5, 5]);
  g.beginPath(); g.moveTo(0, y(thr)); g.lineTo(w, y(thr)); g.stroke();
  g.setLineDash([]);
  g.strokeStyle = '#5aa9ff';
  g.lineWidth = 2;
  g.beginPath();
  hist.forEach((p, i) => {
    const x = w - ((now - p.t) / 12000) * w;
    i ? g.lineTo(x, y(p.v)) : g.moveTo(x, y(p.v));
  });
  g.stroke();
  g.fillStyle = 'rgba(255,255,255,.45)';
  g.font = '11px system-ui, sans-serif';
  g.fillText('last 12 s', 8, 14);
}

updateHud();
