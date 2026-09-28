/**
 * The soundtrack, synthesized: soft key ticks under the typing, a click on
 * each tap, one chime when the mission completes, over a quiet sustained
 * pad. Deterministic (seeded noise), mono, 48 kHz, no samples or services.
 */

export const SAMPLE_RATE = 48_000;
export const PEAK = 0.708;

export type Cue = { type: 'key' | 'click' | 'chime'; at: number };

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

function addKey(buf: Float32Array, at: number, rand: () => number) {
  // A short band-limited noise burst with a faint body tone: a soft key, not a typewriter.
  const start = Math.round(at * SAMPLE_RATE);
  const len = Math.round(0.028 * SAMPLE_RATE);
  const tone = 1400 + rand() * 500;
  const gain = 0.11 + rand() * 0.04;
  let lp = 0;
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-t * 190);
    lp += 0.35 * ((rand() * 2 - 1) - lp);
    buf[start + i] += gain * env * (0.75 * lp + 0.25 * Math.sin(2 * Math.PI * tone * t));
  }
}

function addClick(buf: Float32Array, at: number) {
  const start = Math.round(at * SAMPLE_RATE);
  const len = Math.round(0.07 * SAMPLE_RATE);
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-t * 85);
    buf[start + i] += 0.22 * env * (0.6 * Math.sin(2 * Math.PI * 1760 * t) + 0.4 * Math.sin(2 * Math.PI * 880 * t));
  }
}

function addChime(buf: Float32Array, at: number) {
  // Bell-like partials (slightly inharmonic), each decaying at its own rate.
  const partials: Array<[number, number, number]> = [[659.25, 0.16, 1.6], [987.77, 0.1, 2.2], [1318.5, 0.07, 2.9], [1975.5, 0.035, 4.2], [2637, 0.02, 5.5]];
  const start = Math.round(at * SAMPLE_RATE);
  const len = Math.round(3.2 * SAMPLE_RATE);
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const t = i / SAMPLE_RATE;
    const attack = Math.min(1, t / 0.004);
    let v = 0;
    for (const [f, g, d] of partials) v += g * Math.exp(-t * d) * Math.sin(2 * Math.PI * f * t);
    buf[start + i] += attack * v;
  }
}

/** A quiet two-chord pad under everything, faded in and out. */
function addPad(buf: Float32Array, duration: number) {
  const chords = [[110, 164.81, 220, 277.18, 329.63], [92.5, 138.59, 185, 220, 277.18]];
  const change = Math.max(4, duration / 2);
  const n = Math.min(buf.length, Math.round(duration * SAMPLE_RATE));
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const fade = Math.min(1, t / 2.5, (duration - t) / 2.5);
    // Crossfade the chords over two seconds around the change.
    const x = Math.min(1, Math.max(0, (t - change + 1) / 2));
    const breathe = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.07 * t);
    let v = 0;
    chords[0].forEach((f, k) => { v += (1 - x) * Math.sin(2 * Math.PI * f * t + k) / (k + 1.5); });
    chords[1].forEach((f, k) => { v += x * Math.sin(2 * Math.PI * f * t + k) / (k + 1.5); });
    buf[i] += 0.04 * fade * breathe * v;
  }
}

export function synthesize(cues: Cue[], duration: number, opts: { pad?: boolean; seed?: number } = {}): Float32Array {
  const buf = new Float32Array(Math.round(duration * SAMPLE_RATE));
  const rand = rng(opts.seed ?? 4);
  if (opts.pad !== false) addPad(buf, duration);
  for (const c of cues) {
    if (c.at < 0 || c.at >= duration) continue;
    if (c.type === 'key') addKey(buf, c.at, rand);
    else if (c.type === 'click') addClick(buf, c.at);
    else addChime(buf, c.at);
  }
  // Normalize to a -3 dBFS peak: loud enough to hear on a laptop, never clipping.
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < buf.length; i++) buf[i] *= PEAK / peak;
  return buf;
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
