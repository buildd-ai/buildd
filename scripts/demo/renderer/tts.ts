/**
 * tts.ts: the film's voice, as a renderer step. One line per chapter is
 * synthesized by a provider and cached by (provider, voice, speed, text), so a
 * re-render only speaks lines that changed.
 *
 * Providers:
 *   kokoro      local Kokoro (onnx), run through a Python venv. No network.
 *               BUILDD_TTS_DIR (default ~/buildd-demo-renders/tts) holds
 *               .venv/, kokoro-v1.0.onnx and voices-v1.0.bin.
 *   elevenlabs  reserved: the interface is here so a hosted voice can drop in
 *               later; it throws until it is implemented.
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export type VoiceLine = { text: string; voice: string; speed: number };
export type Spoken = { file: string; seconds: number; cached: boolean };
export interface TtsProvider {
  name: string;
  /** Write `line` as a WAV at `file`. */
  speak(line: VoiceLine, file: string): Promise<void>;
}

/** The cache key: same provider, voice, speed and text → same file. */
export function cacheKey(provider: string, line: VoiceLine): string {
  return createHash('sha256').update(JSON.stringify([provider, line.voice, line.speed, line.text])).digest('hex').slice(0, 20);
}

/** Seconds of audio in a PCM WAV, from its header (fmt byte rate, data size). */
export function wavSeconds(buf: Uint8Array): number {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV');
  let byteRate = 0;
  for (let o = 12; o + 8 <= buf.length; ) {
    const id = tag(o), size = v.getUint32(o + 4, true);
    if (id === 'fmt ') byteRate = v.getUint32(o + 16, true);
    if (id === 'data') {
      if (!byteRate) throw new Error('WAV data before fmt');
      return Math.min(size, buf.length - o - 8) / byteRate;
    }
    o += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

export const TTS_DIR = process.env.BUILDD_TTS_DIR ?? join(homedir(), 'buildd-demo-renders', 'tts');

export function kokoro(dir = TTS_DIR): TtsProvider {
  return {
    name: 'kokoro',
    async speak(line, file) {
      const py = `import sys, soundfile as sf
from kokoro_onnx import Kokoro
k = Kokoro(${JSON.stringify(join(dir, 'kokoro-v1.0.onnx'))}, ${JSON.stringify(join(dir, 'voices-v1.0.bin'))})
audio, sr = k.create(sys.argv[1], voice=sys.argv[2], speed=float(sys.argv[3]), lang="en-us")
sf.write(sys.argv[4], audio, sr)`;
      const r = Bun.spawnSync([join(dir, '.venv/bin/python'), '-c', py, line.text, line.voice, String(line.speed), file], { stdout: 'pipe', stderr: 'pipe' });
      if (r.exitCode !== 0) throw new Error(`[tts] kokoro failed: ${r.stderr.toString().slice(-400)}`);
    },
  };
}

export function elevenlabs(): TtsProvider {
  return { name: 'elevenlabs', async speak() { throw new Error('[tts] the elevenlabs provider is not implemented yet'); } };
}

export function provider(name = process.env.BUILDD_TTS_PROVIDER ?? 'kokoro'): TtsProvider {
  if (name === 'kokoro') return kokoro();
  if (name === 'elevenlabs') return elevenlabs();
  throw new Error(`[tts] unknown provider "${name}" (kokoro, elevenlabs)`);
}

/** Speak every line (cached), returning each WAV and its length. */
export async function speakAll(lines: VoiceLine[], p: TtsProvider = provider(), cacheDir = join(TTS_DIR, 'cache')): Promise<Spoken[]> {
  mkdirSync(cacheDir, { recursive: true });
  const out: Spoken[] = [];
  for (const line of lines) {
    const file = join(cacheDir, `${p.name}-${cacheKey(p.name, line)}.wav`);
    const cached = existsSync(file);
    if (!cached) await p.speak(line, file);
    out.push({ file, seconds: wavSeconds(readFileSync(file)), cached });
  }
  return out;
}
