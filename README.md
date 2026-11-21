# Stud Finder

A phone stud finder that runs in the browser. It needs no extra hardware: it uses the
microphone, speaker, motion sensors, magnetometer and camera you already have, and draws the
studs it finds over a live AR view of the wall.

Try the simulated wall without any sensors: open `index.html?demo`.

## Approaches

| Method | Sensor(s) | What it measures | Reliability |
| --- | --- | --- | --- |
| **AR Knock Map** | mic + gyro + camera | The pitch, ring time and "boom" of a knuckle knock at the crosshair | Good with 10+ knocks, because it fits a grid rather than trusting single knocks |
| **Sonar ranging** | speaker + mic | Time of flight of a 2–11 kHz chirp's echo off the wall, used to set the AR scale | Works in quiet rooms. It rejects stray sounds and falls back to a slider |
| **Magnetic screw finder** | magnetometer / compass vs gyro | Field distortion from the steel drywall screws in each stud | The most direct signal, but you have to pass close to a screw |
| **Echo / haptic probe** (β) | speaker + mic (+ vibration motor on Android) | How the wall panel radiates a chirp/buzz compared with a calibrated hollow spot | Experimental |

### 1. Knock acoustics → AR knock map
Drywall over a cavity behaves like a drum skin: a knock excites a low (≈100–400 Hz),
slowly decaying mode. Over a stud the panel is pinned, so you get a short, brighter "tock".

For each knock (`js/dsp.js → analyzeKnock`) the app extracts features that don't depend on
amplitude: the share of energy below 400 Hz, the time to decay by −20 dB, the spectral
centroid and the dominant frequency. Each feature is **z-scored against your other knocks**
(`js/inference.js → solidityScores`), so the wall, your knuckle and the room cancel out.

**Where was the knock?** You knock exactly at the on-screen crosshair. The gyro says where the
camera points, so each knock becomes a direction. Intersect that with a wall plane at
distance *D* and you get wall coordinates. *D* comes from sonar or the slider.

**Grid fitting.** Single knocks are noisy, but studs are regular (16″ or 24″ on centre, 1.5″
wide). `fitStudGrid` grid-searches spacing × offset to maximise the correlation between knock
solidity and "distance to the nearest stud", plus optional clues:
- *Confirmed stud* (for example one found by the magnet mode)
- *Outlet/switch*: electrical boxes are nailed to the side of a stud
- *Corner/door edge*

Confidence is the posterior mass near the best offset times the posterior of the chosen
spacing. Studs inside the scanned span are drawn solid; extrapolated ones are dashed.

### 2. Sonar ranging ("send a sound, see how it returns")
The app plays eight 6 ms linear chirps and matched-filters the recording (FFT
cross-correlation). Two checks make sure it's really hearing the chirp:
- the direct speaker→mic path must stand far above the noise floor;
- it must arrive at the **same latency in every ping**, which rejects stray sounds.

The envelopes are then aligned on the direct path and averaged, and the most prominent later
peak is the wall echo: `D = c·Δt / 2`.

### 3. Magnetic screw finder
There are steel screws every ~12″ up each stud. The detector uses the best source available:
1. `Magnetometer` (Generic Sensor API, Chrome Android behind
   `chrome://flags/#enable-generic-sensor-extra-classes`). The field is in µT, rotated into the
   world frame so that turning the phone isn't mistaken for metal.
2. **Compass vs gyro disagreement**, which works without flags. Android exposes both an
   absolute (magnetometer-fused) and a relative (gyro-only) orientation. Metal bends the
   first but not the second, so the rotation between them is the magnetic anomaly. On iOS
   the same trick uses `webkitCompassHeading`.

It behaves like a metal detector: calibrate, slide, and it clicks faster as you approach a screw.

### 4. Echo / haptic probe (experimental)
Press the phone to the wall. Every ~0.4 s it plays a 150→2500 Hz sweep (and buzzes the
vibration motor on Android) and records 8 log-spaced band levels plus the accelerometer
response. Like a capacitive stud finder, it compares each probe against a calibration on a
hollow spot. A cavity wall acts as a soundboard; a stud pins and damps it.

## Using it

1. Serve the folder over **HTTPS**. Camera, mic and motion sensors are blocked on plain HTTP
   except on `localhost`. Any static host works (GitHub Pages, Vercel, Netlify, …).
   Locally: `npm run serve`, then use an HTTPS tunnel to reach it from your phone.
2. **AR Knock Map:** stand an arm's length from the wall. ⚙ → *Measure with sonar*. Aim, then
   knock at the crosshair every ~2″ across 3–4 ft. Pivot the phone rather than walking. If you
   do step sideways, drag the view to re-align.
3. **Contact Scanner → Metal:** lay the phone flat on the wall, calibrate, and slide slowly in a
   zig-zag. A spike marks a screw.

Always confirm with a finishing nail or a magnet before drilling, and stay clear of outlets,
switches and plumbing runs.

## Code layout

```
index.html, css/style.css   UI (home, AR, contact screens)
js/main.js                  UI controller and permission flow
js/dsp.js                   FFT, knock features, onset detector, chirp + echo ranging
js/inference.js             solidity scoring, stud-grid fitting, heat profile
js/ar.js                    wall model + canvas AR projection
js/orientation.js           DeviceOrientation → rotation matrices, vector maths
js/audio.js, js/worklet.js  mic ring buffer (AudioWorklet), playback helpers
js/contact.js               magnetometer and echo-probe detectors
js/synth.js                 synthetic knocks (demo + tests)
tests/                      node:test unit tests (`npm test`)
```

There's no build step and no dependencies.

## Ideas / next steps
- **WebXR hit-test** (Android Chrome + ARCore) for true 6-DoF world-locked studs, so you can
  walk along the wall without re-aligning.
- **Learn from you:** tag a few knocks as "known stud / known hollow" and train a per-wall
  classifier instead of using the fixed feature weights.
- **Raking-light vision:** the flashlight at a grazing angle shows screw dimples and tape
  seams. Detect vertical columns of dimples in the camera image.
- **Knock localisation by vision:** find the knuckle in the frame at the moment of the sound,
  so you don't need to aim the crosshair.
