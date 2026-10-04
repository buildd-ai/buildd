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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
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

// ── one continuous read ───────────────────────────────────────────────────────
// The film's voice is one passage read once (so it sounds like one person
// talking, the intonation never reset per line), then cut into its lines at
// the reader's own sentence pauses, so each line can be placed on the picture.

export function sentenceCount(text: string): number {
  return Math.max(1, (text.match(/[.!?](\s|$)/g) ?? []).length);
}

/** Quiet runs (10ms RMS under `floor` of the peak) at least `minSec` long, as [start, end] seconds. */
export function findPauses(x: Float32Array, sr: number, o: { minSec?: number; floor?: number } = {}): Array<[number, number]> {
  const win = Math.max(1, Math.round(sr * 0.01));
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const floor = (o.floor ?? 0.02) * (peak || 1);
  const out: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < x.length; i += win) {
    let q = 0;
    const n = Math.min(win, x.length - i);
    for (let j = 0; j < n; j++) q += x[i + j] * x[i + j];
    const quiet = Math.sqrt(q / n) < floor;
    if (quiet && start < 0) start = i;
    if ((!quiet || i + win >= x.length) && start >= 0) {
      const end = quiet ? x.length : i;
      if ((end - start) / sr >= (o.minSec ?? 0.15)) out.push([start / sr, end / sr]);
      start = -1;
    }
  }
  return out;
}

/**
 * Where each line ends: the sentence pauses are the longest (sentences - 1)
 * quiet runs (commas leave shorter ones); line k ends after its last
 * sentence. Cuts land mid-pause, so each line keeps half a pause either side.
 */
export function lineCuts(pauses: Array<[number, number]>, sentencesPerLine: number[]): number[] {
  const total = sentencesPerLine.reduce((a, b) => a + b, 0);
  const ends = [...pauses].sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])).slice(0, total - 1).sort((a, b) => a[0] - b[0]);
  if (ends.length < total - 1) throw new Error(`[tts] found ${ends.length} sentence pauses, expected ${total - 1}`);
  const cuts: number[] = [];
  let seen = 0;
  for (const n of sentencesPerLine.slice(0, -1)) {
    seen += n;
    const [a, b] = ends[seen - 1];
    cuts.push(+((a + b) / 2).toFixed(3));
  }
  return cuts;
}

function readPcm16(buf: Uint8Array): { x: Float32Array; sr: number } {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  let sr = 0;
  for (let o = 12; o + 8 <= buf.length; ) {
    const id = tag(o), size = v.getUint32(o + 4, true);
    if (id === 'fmt ') {
      if (v.getUint16(o + 8, true) !== 1 || v.getUint16(o + 22, true) !== 16 || v.getUint16(o + 10, true) !== 1) throw new Error('[tts] expected mono PCM16');
      sr = v.getUint32(o + 12, true);
    }
    if (id === 'data') {
      const n = Math.min(size, buf.length - o - 8) / 2;
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = v.getInt16(o + 8 + i * 2, true) / 32768;
      return { x, sr };
    }
    o += 8 + size + (size % 2);
  }
  throw new Error('[tts] WAV has no data chunk');
}

function pcm16(x: Float32Array, sr: number): Uint8Array {
  const b = new Uint8Array(44 + x.length * 2), v = new DataView(b.buffer);
  const put = (o: number, s: string) => { for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i); };
  put(0, 'RIFF'); v.setUint32(4, 36 + x.length * 2, true); put(8, 'WAVE'); put(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); put(36, 'data'); v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), true);
  return b;
}

/** Read the passage once (cached), cut it into its lines; one WAV per line. */
export async function speakPassage(lines: string[], o: { voice: string; speed: number }, p: TtsProvider = provider(), cacheDir = join(TTS_DIR, 'cache')): Promise<Spoken[]> {
  const [whole] = await speakAll([{ text: lines.join(' '), voice: o.voice, speed: o.speed }], p, cacheDir);
  const { x, sr } = readPcm16(new Uint8Array(readFileSync(whole.file)));
  const cuts = lineCuts(findPauses(x, sr, { minSec: 0.15 }), lines.map(sentenceCount));
  const bounds = [0, ...cuts, x.length / sr];
  const base = whole.file.replace(/\.wav$/, '');
  return lines.map((_, i) => {
    const file = `${base}-line${i + 1}.wav`;
    if (!existsSync(file)) writeFileSync(file, pcm16(x.slice(Math.round(bounds[i] * sr), Math.round(bounds[i + 1] * sr)), sr));
    return { file, seconds: bounds[i + 1] - bounds[i], cached: whole.cached };
  });
}
