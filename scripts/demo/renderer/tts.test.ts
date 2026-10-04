import { describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cacheKey, provider, speakAll, wavSeconds, type TtsProvider } from './tts';

/** A minimal PCM16 mono WAV of `seconds` at `sr`. */
function wav(seconds: number, sr = 24000): Uint8Array {
  const n = Math.round(seconds * sr), data = n * 2;
  const b = new Uint8Array(44 + data), v = new DataView(b.buffer);
  const put = (o: number, s: string) => { for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i); };
  put(0, 'RIFF'); v.setUint32(4, 36 + data, true); put(8, 'WAVE');
  put(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  put(36, 'data'); v.setUint32(40, data, true);
  return b;
}

describe('wavSeconds', () => {
  test('reads the length from the header', () => {
    expect(wavSeconds(wav(2.5))).toBeCloseTo(2.5, 3);
  });
  test('refuses what is not a WAV', () => {
    expect(() => wavSeconds(new Uint8Array(64))).toThrow('not a WAV');
  });
});

describe('cacheKey', () => {
  const line = { text: 'buildd checks.', voice: 'af_heart', speed: 1 };
  test('same provider, voice, speed and text → same key; any change → a new one', () => {
    expect(cacheKey('kokoro', line)).toBe(cacheKey('kokoro', { ...line }));
    expect(cacheKey('kokoro', { ...line, text: 'buildd checks' })).not.toBe(cacheKey('kokoro', line));
    expect(cacheKey('kokoro', { ...line, voice: 'af_bella' })).not.toBe(cacheKey('kokoro', line));
    expect(cacheKey('kokoro', { ...line, speed: 1.1 })).not.toBe(cacheKey('kokoro', line));
    expect(cacheKey('elevenlabs', line)).not.toBe(cacheKey('kokoro', line));
  });
});

test('speakAll speaks a line once, then serves it from the cache', async () => {
  let calls = 0;
  const fake: TtsProvider = { name: 'fake', async speak(_l, file) { calls++; await Bun.write(file, wav(1.2)); } };
  const dir = mkdtempSync(join(tmpdir(), 'tts-'));
  const lines = [{ text: 'One.', voice: 'v', speed: 1 }];
  const a = await speakAll(lines, fake, dir);
  const b = await speakAll(lines, fake, dir);
  expect(calls).toBe(1);
  expect(a[0].cached).toBe(false);
  expect(b[0].cached).toBe(true);
  expect(b[0].seconds).toBeCloseTo(1.2, 3);
  expect(existsSync(b[0].file)).toBe(true);
});

test('providers: kokoro and elevenlabs by name; anything else is an error', () => {
  expect(provider('kokoro').name).toBe('kokoro');
  expect(provider('elevenlabs').name).toBe('elevenlabs');
  expect(() => provider('nope')).toThrow('unknown provider');
});
