/**
 * The soundtrack, synthesized, bright and quiet: soft high key ticks under
 * the typing, a marimba tap (with a short high click) on each tap, small
 * pentatonic plucks as things land, a rising C-E-G chime when the mission
 * completes, and an optional warm major-key bed kept in the upper register.
 *
 * Nothing boomy: every voice sits above ~350 Hz, there are no reverb tails,
 * and the whole mix goes through a 160 Hz high-pass before it is normalized,
 * so there is nothing heavy below 150 Hz (audio.test.ts measures it).
 * Deterministic (seeded noise), mono, 48 kHz, no samples or services.
 */

export const SAMPLE_RATE = 48_000;
/** Peak level of the mix: -6 dBFS, quiet under the visuals. */
export const PEAK = 0.5;

export type Cue = { type: 'key' | 'click' | 'tap' | 'pluck' | 'chime'; at: number; note?: number };

/** C major pentatonic from C6: bright, and never a wrong note against the bed. */
export const PLUCK_NOTES = [1046.5, 1174.66, 1318.51, 1567.98, 1760, 2093];

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

/** A struck bar: a few partials, each with its own fast decay; a 3 ms attack so it never pops. */
function bar(buf: Float32Array, at: number, f0: number, gain: number, partials: Array<[number, number, number]>, seconds: number) {
  span(buf, at, seconds, (t) => {
    const attack = Math.min(1, t / 0.003);
    let v = 0;
    for (const [ratio, amp, decay] of partials) v += amp * Math.exp(-t * decay) * Math.sin(2 * Math.PI * f0 * ratio * t);
    return gain * attack * v;
  });
}

const MARIMBA: Array<[number, number, number]> = [[1, 1, 9], [3.93, 0.22, 34], [9.2, 0.05, 60]];
const BELL: Array<[number, number, number]> = [[1, 1, 2.6], [2.76, 0.28, 5], [5.4, 0.08, 9]];

function addKey(buf: Float32Array, at: number, rand: () => number) {
  // 7 ms of noise, differenced twice (a steep high-pass): a soft tick, no body.
  let p1 = 0, p2 = 0;
  const g = 0.05 + rand() * 0.015;
  span(buf, at, 0.007, (t) => {
    const n = rand() * 2 - 1;
    const d = n - 2 * p1 + p2;
    p2 = p1; p1 = n;
    return g * Math.exp(-t * 420) * d * 0.5;
  });
}

function addClick(buf: Float32Array, at: number) {
  span(buf, at, 0.012, (t) => 0.06 * Math.exp(-t * 380) * Math.sin(2 * Math.PI * 3400 * t));
}

function addTap(buf: Float32Array, at: number) {
  addClick(buf, at);
  bar(buf, at + 0.004, 1046.5, 0.16, MARIMBA, 0.6);
}

function addPluck(buf: Float32Array, at: number, note = 0) {
  bar(buf, at, PLUCK_NOTES[((note % PLUCK_NOTES.length) + PLUCK_NOTES.length) % PLUCK_NOTES.length], 0.07, MARIMBA, 0.5);
}

function addChime(buf: Float32Array, at: number) {
  // Rising C6, E6, G6: a small, friendly "done".
  [1046.5, 1318.51, 1567.98].forEach((f, i) => bar(buf, at + i * 0.17, f, i === 2 ? 0.13 : 0.1, BELL, i === 2 ? 2.4 : 1.2));
}

/**
 * A warm major-key bed in the upper register: I, IV, vi, V as soft sustained
 * triads with a slow swell, plus a quiet music-box arpeggio on the beat.
 */
function addBed(buf: Float32Array, duration: number, rand: () => number) {
  const chords = [[523.25, 659.25, 783.99], [698.46, 880, 1046.5], [440, 523.25, 659.25], [392, 493.88, 587.33]];
  const len = Math.max(4, duration / chords.length);
  const n = Math.min(buf.length, Math.round(duration * SAMPLE_RATE));
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const fade = Math.min(1, t / 2, (duration - t) / 2.5);
    const k = Math.min(chords.length - 1, Math.floor(t / len));
    // One second of crossfade into the next chord.
    const into = Math.max(0, (t - (k + 1) * len + 1)) / 1;
    const next = chords[Math.min(chords.length - 1, k + 1)];
    let v = 0;
    for (const [j, f] of chords[k].entries()) v += (1 - into) * Math.sin(2 * Math.PI * f * t + j);
    if (into > 0) for (const [j, f] of next.entries()) v += into * Math.sin(2 * Math.PI * f * t + j);
    buf[i] += 0.009 * fade * (0.8 + 0.2 * Math.sin(2 * Math.PI * 0.12 * t)) * v;
  }
  // The arpeggio: chord tones an octave up, one per beat at 84 bpm.
  const beat = 60 / 84;
  for (let b = 0, t = 1.2; t < duration - 2; b++, t += beat) {
    const k = Math.min(chords.length - 1, Math.floor(t / len));
    bar(buf, t, chords[k][b % 3] * 2, 0.018 + rand() * 0.004, MARIMBA, 0.4);
  }
}

export function synthesize(cues: Cue[], duration: number, opts: { bed?: boolean; seed?: number } = {}): Float32Array {
  const buf = new Float32Array(Math.round(duration * SAMPLE_RATE));
  const rand = rng(opts.seed ?? 5);
  if (opts.bed !== false) addBed(buf, duration, rand);
  for (const c of cues) {
    if (c.at < 0 || c.at >= duration) continue;
    if (c.type === 'key') addKey(buf, c.at, rand);
    else if (c.type === 'click') addClick(buf, c.at);
    else if (c.type === 'tap') addTap(buf, c.at);
    else if (c.type === 'pluck') addPluck(buf, c.at, c.note);
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
