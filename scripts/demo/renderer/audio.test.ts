import { describe, expect, test } from 'bun:test';
import { PEAK, rng, SAMPLE_RATE, synthesize, wav } from './audio';

const energy = (b: Float32Array, from: number, to: number) => {
  let e = 0;
  for (let i = Math.round(from * SAMPLE_RATE); i < Math.round(to * SAMPLE_RATE); i++) e += b[i] * b[i];
  return e;
};

describe('synthesize', () => {
  test('is exactly the cut long and peaks at -3 dBFS, never clipping', () => {
    const b = synthesize([{ type: 'chime', at: 1 }, { type: 'click', at: 1 }, { type: 'key', at: 1 }], 4);
    expect(b.length).toBe(4 * SAMPLE_RATE);
    expect(Math.max(...Array.from(b, Math.abs))).toBeCloseTo(PEAK, 5);
  });
  test('a cue sounds at its time and not before', () => {
    const b = synthesize([{ type: 'click', at: 2 }], 4, { pad: false });
    expect(energy(b, 0, 1.99)).toBe(0);
    expect(energy(b, 2, 2.1)).toBeGreaterThan(0);
  });
  test('the same cues always make the same sound', () => {
    const cues = [{ type: 'key' as const, at: 0.5 }, { type: 'key' as const, at: 0.7 }];
    expect(synthesize(cues, 1)).toEqual(synthesize(cues, 1));
  });
  test('cues outside the cut are dropped, not wrapped', () => {
    const b = synthesize([{ type: 'chime', at: 9 }], 2, { pad: false });
    expect(energy(b, 0, 2)).toBe(0);
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
    expect(w.length).toBe(44 + 960);
  });
});

test('rng is seeded', () => {
  expect(rng(1)()).toBe(rng(1)());
  expect(rng(1)()).not.toBe(rng(2)());
});
