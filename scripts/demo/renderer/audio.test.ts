import { describe, expect, test } from 'bun:test';
import { biquad, lowEnergyShare, PEAK, rng, SAMPLE_RATE, synthesize, wav, type Cue } from './audio';

const energy = (b: Float32Array, from: number, to: number) => {
  let e = 0;
  for (let i = Math.round(from * SAMPLE_RATE); i < Math.round(to * SAMPLE_RATE); i++) e += b[i] * b[i];
  return e;
};
const sine = (hz: number, seconds = 1) => Float32Array.from({ length: seconds * SAMPLE_RATE }, (_, i) => Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE));

const EVERY: Cue[] = [
  ...Array.from({ length: 20 }, (_, i) => ({ type: 'key' as const, at: 0.5 + i * 0.08 })),
  { type: 'tap', at: 3 }, { type: 'click', at: 4 }, { type: 'pluck', at: 5, note: 2 }, { type: 'chime', at: 7 },
];

describe('synthesize', () => {
  test('is exactly the cut long and peaks at -6 dBFS', () => {
    const b = synthesize(EVERY, 10);
    expect(b.length).toBe(10 * SAMPLE_RATE);
    expect(Math.max(...Array.from(b, Math.abs))).toBeCloseTo(PEAK, 5);
  });
  test('nothing heavy below 150 Hz: under 0.5% of the energy, bed and every cue included', () => {
    expect(lowEnergyShare(synthesize(EVERY, 10))).toBeLessThan(0.005);
    expect(lowEnergyShare(synthesize(EVERY, 10, { bed: false }))).toBeLessThan(0.005);
  });
  test('a cue sounds at its time and not before', () => {
    const b = synthesize([{ type: 'tap', at: 2 }], 4, { bed: false });
    expect(energy(b, 0, 1.99)).toBeLessThan(1e-9);
    expect(energy(b, 2, 2.2)).toBeGreaterThan(0);
  });
  test('clicks, taps and ticks are 30-60 ms and leave nothing behind', () => {
    for (const type of ['key', 'click', 'tap', 'pluck'] as const) {
      const b = synthesize([{ type, at: 1 }], 2, { bed: false });
      expect(energy(b, 1, 1.06)).toBeGreaterThan(0);
      expect(energy(b, 1.07, 2)).toBeLessThan(1e-12);
    }
  });
  test('a landing tile is near-silent next to a tap', () => {
    const tap = synthesize([{ type: 'tap', at: 1 }, { type: 'pluck', at: 2 }], 3, { bed: false });
    expect(energy(tap, 2, 2.06)).toBeLessThan(energy(tap, 1, 1.06) * 0.1);
  });
  test('completion is two soft notes: the second enters 140 ms later, and both have faded by 1.2 s', () => {
    const b = synthesize([{ type: 'chime', at: 1 }], 4, { bed: false });
    expect(energy(b, 0.9, 0.999)).toBeLessThan(1e-12);
    expect(energy(b, 1.14, 1.3)).toBeGreaterThan(energy(b, 1.0, 1.02));
    expect(energy(b, 2.3, 4)).toBeLessThan(energy(b, 1, 1.3) * 1e-3);
  });
  test('the same cues always make the same sound', () => {
    expect(synthesize(EVERY, 10)).toEqual(synthesize(EVERY, 10));
  });
});

describe('lowEnergyShare', () => {
  test('tells a boom from a bell', () => {
    expect(lowEnergyShare(sine(60))).toBeGreaterThan(0.5);
    expect(lowEnergyShare(sine(1046))).toBeLessThan(0.001);
  });
  test('the mix high-pass takes a 60 Hz boom down by more than 30 dB', () => {
    const before = energy(sine(60), 0.5, 1);
    const after = energy(biquad(biquad(sine(60), 'highpass', 160), 'highpass', 160), 0.5, 1);
    expect(after / before).toBeLessThan(1e-3);
  });
});

describe('wav', () => {
  test('writes a 16-bit mono RIFF header sized to the samples', () => {
    const w = wav(new Float32Array(480));
    const v = new DataView(w.buffer);
    expect(new TextDecoder().decode(w.slice(0, 4))).toBe('RIFF');
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(960);
  });
});

test('rng is seeded', () => {
  expect(rng(1)()).toBe(rng(1)());
  expect(rng(1)()).not.toBe(rng(2)());
});
