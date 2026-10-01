/**
 * The soundtrack, synthesized, soft and glassy, in the manner of system and
 * product-UI sounds: every key, click and tap is a 30-60 ms transient
 * (band-passed noise plus a quick high sine, no pitch sweep, nothing that
 * rings). Landing tiles are near-silent ticks. Completion is a soft rising
 * fifth, not a bell. Under it all sits a quiet, warm, major-key bed in the
 * upper register.
 *
 * Nothing boomy: every voice sits above ~390 Hz, and the whole mix goes
 * through a 160 Hz high-pass before it is normalized, so there is nothing
 * heavy below 150 Hz (audio.test.ts measures it).
 * Deterministic (seeded noise), mono, 48 kHz, no samples or services.
 */

export const SAMPLE_RATE = 48_000;
/** Peak level of the mix: -6 dBFS, quiet under the visuals. */
export const PEAK = 0.5;

export type Cue = { type: 'key' | 'click' | 'tap' | 'pluck' | 'chime'; at: number; note?: number };

/** mulberry32: a tiny seeded PRNG, so the same cut always sounds the same. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** RBJ biquad, in place: 'highpass' | 'lowpass' at f Hz. */
export function biquad(buf: Float32Array, type: 'highpass' | 'lowpass', f: number, q = Math.SQRT1_2): Float32Array {
  const w = (2 * Math.PI * f) / SAMPLE_RATE;
  const cos = Math.cos(w), alpha = Math.sin(w) / (2 * q);
  const b1 = type === 'lowpass' ? 1 - cos : -(1 + cos);
  const b0 = type === 'lowpass' ? b1 / 2 : (1 + cos) / 2;
  const b2 = b0;
  const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    buf[i] = y;
  }
  return buf;
}

function span(buf: Float32Array, at: number, seconds: number, fn: (t: number) => number) {
  const start = Math.round(at * SAMPLE_RATE);
  const len = Math.round(seconds * SAMPLE_RATE);
  for (let i = 0; i < len && start + i < buf.length; i++) if (start + i >= 0) buf[start + i] += fn(i / SAMPLE_RATE);
}

/**
 * A glassy UI transient (the macOS / product-UI kind): a few ms of noise
 * band-passed to 3-9 kHz, plus a quick high sine, with no pitch sweep. The
 * whole thing is 30-60 ms, with nothing that rings.
 */
function glass(buf: Float32Array, at: number, rand: () => number, o: { gain: number; tone: number; noise?: number; toneDecay?: number; seconds?: number }) {
  const seconds = o.seconds ?? 0.05;
  const n = Math.round(seconds * SAMPLE_RATE);
  const noise = Float32Array.from({ length: n }, () => rand() * 2 - 1);
  biquad(biquad(noise, 'highpass', 3000), 'lowpass', 9000);
  const noiseGain = o.noise ?? 0.6;
  const tau = o.toneDecay ?? 0.012;
  span(buf, at, seconds, (t) => {
    const i = Math.round(t * SAMPLE_RATE);
    const attack = Math.min(1, t / 0.0015);
    const tone = Math.exp(-t / tau) * Math.sin(2 * Math.PI * o.tone * t);
    const hiss = Math.exp(-t / 0.003) * (noise[i] ?? 0);
    // A short raised-cosine tail so the event ends at exactly zero.
    const tail = t > seconds - 0.01 ? 0.5 + 0.5 * Math.cos((Math.PI * (t - (seconds - 0.01))) / 0.01) : 1;
    return o.gain * attack * tail * (tone + noiseGain * hiss);
  });
}

function addKey(buf: Float32Array, at: number, rand: () => number) {
  glass(buf, at, rand, { gain: 0.022 + rand() * 0.006, tone: 3300, noise: 1.2, toneDecay: 0.004, seconds: 0.03 });
}

function addClick(buf: Float32Array, at: number, rand: () => number) {
  glass(buf, at, rand, { gain: 0.06, tone: 2600, seconds: 0.045 });
}

function addTap(buf: Float32Array, at: number, rand: () => number) {
  glass(buf, at, rand, { gain: 0.09, tone: 2050, noise: 0.5, toneDecay: 0.014, seconds: 0.06 });
}

/** What used to be a note per landing tile: now a near-silent tick. */
function addPluck(buf: Float32Array, at: number, rand: () => number) {
  glass(buf, at, rand, { gain: 0.014, tone: 3000, noise: 1, toneDecay: 0.004, seconds: 0.03 });
}

/** A soft, airy rising fifth (G5 to D6): sine with a little triangle, gentle attack, ~600 ms decay. */
function addChime(buf: Float32Array, at: number) {
  const note = (t0: number, f: number, gain: number) => span(buf, t0, 1.2, (t) => {
    const attack = Math.min(1, t / 0.02);
    const tri = (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * f * t));
    return gain * attack * Math.exp(-t / 0.22) * (0.72 * Math.sin(2 * Math.PI * f * t) + 0.28 * tri);
  });
  note(at, 783.99, 0.1);
  note(at + 0.14, 1174.66, 0.085);
}

/** A warm major-key bed in the upper register: I, IV, vi, V as soft sustained triads with a slow swell. */
function addBed(buf: Float32Array, duration: number) {
  const chords = [[523.25, 659.25, 783.99], [698.46, 880, 1046.5], [440, 523.25, 659.25], [392, 493.88, 587.33]];
  const len = Math.max(4, duration / chords.length);
  const n = Math.min(buf.length, Math.round(duration * SAMPLE_RATE));
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const fade = Math.min(1, t / 2, (duration - t) / 2.5);
    const k = Math.min(chords.length - 1, Math.floor(t / len));
    const into = Math.max(0, t - (k + 1) * len + 1);
    const next = chords[Math.min(chords.length - 1, k + 1)];
    let v = 0;
    for (const [j, f] of chords[k].entries()) v += (1 - into) * Math.sin(2 * Math.PI * f * t + j);
    if (into > 0) for (const [j, f] of next.entries()) v += into * Math.sin(2 * Math.PI * f * t + j);
    buf[i] += 0.008 * fade * (0.8 + 0.2 * Math.sin(2 * Math.PI * 0.12 * t)) * v;
  }
}

export function synthesize(cues: Cue[], duration: number, opts: { bed?: boolean; seed?: number } = {}): Float32Array {
  const buf = new Float32Array(Math.round(duration * SAMPLE_RATE));
  const rand = rng(opts.seed ?? 5);
  if (opts.bed !== false) addBed(buf, duration);
  for (const c of cues) {
    if (c.at < 0 || c.at >= duration) continue;
    if (c.type === 'key') addKey(buf, c.at, rand);
    else if (c.type === 'click') addClick(buf, c.at, rand);
    else if (c.type === 'tap') addTap(buf, c.at, rand);
    else if (c.type === 'pluck') addPluck(buf, c.at, rand);
    else addChime(buf, c.at);
  }
  // Nothing heavy below 150 Hz, whatever a future voice does.
  biquad(biquad(buf, 'highpass', 160), 'highpass', 160);
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < buf.length; i++) buf[i] *= PEAK / peak;
  return buf;
}

/** Share of the signal's energy below `hz` (0..1), by a two-pole low-pass run twice. */
export function lowEnergyShare(buf: Float32Array, hz = 150): number {
  const low = biquad(biquad(Float32Array.from(buf), 'lowpass', hz), 'lowpass', hz);
  let e = 0, el = 0;
  for (let i = 0; i < buf.length; i++) { e += buf[i] * buf[i]; el += low[i] * low[i]; }
  return e > 0 ? el / e : 0;
}

/** 16-bit PCM mono WAV. */
export function wav(samples: Float32Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return out;
}
