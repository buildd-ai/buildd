/**
 * The deterministic half of `bun run demo:review`: pure rules over what
 * ffmpeg and tesseract measured on the rendered clips. No I/O here, so every
 * threshold is tested; review.ts does the measuring.
 *
 * Why pixels: the cut-model tests (cuts-v6.test.ts) check what the renderer
 * was told to draw. These check what came out: a hero "Done." over its bars,
 * text too small at the size the page shows it, a frame that reads as a dark
 * rectangle, a loop with a seam, numbers that disagree on one screen.
 */

export type Severity = 'high' | 'medium' | 'low';
export type Finding = { clip?: string; t?: number; severity: Severity; check: string; issue: string; box?: { x: number; y: number; w: number; h: number }; accepted?: string };
export type Word = { text: string; x: number; y: number; w: number; h: number; conf: number; line: number };

/** The width the site shows a clip at (site-landing-v2: beats in a 700px column, 360 on a phone; heroes and the film full-bleed). */
/** The films (played once, full-bleed): the voiced cut and the silent captioned one. */
export const FILMS = ['full', 'captioned'];

export function displayWidth(name: string): number {
  const mobile = name.endsWith('-mobile');
  if (FILMS.includes(name)) return 1280;
  if (name.startsWith('hero')) return mobile ? 360 : 1280;
  return mobile ? 360 : 700;
}

export type ClipMeta = { folded: boolean; loop: boolean; crossfades: number[] };

/**
 * Crossfade midpoints in the clip's own (encoded) time. Beats are folded at
 * encode (render.ts seamlessLoopFilter): the first `fade` moves to the end, so
 * encoded t = cut t - fade and the seam is itself a crossfade.
 */
export function clipMeta(name: string, cut: { loop: boolean; shots: Array<{ start: number; dur: number }> }, fade: number): ClipMeta {
  const folded = !name.startsWith('hero') && !FILMS.includes(name);
  const mids = cut.shots.slice(1).map((s) => s.start + fade / 2 - (folded ? fade : 0));
  // A folded beat's seam is a transition too: the last `fade` of the encoded clip.
  if (folded) mids.push(cut.shots.reduce((x, s) => x + s.dur, 0) - fade / 2);
  if (cut.loop && cut.shots.length > 1) {
    const total = cut.shots.reduce((a, s) => a + s.dur, 0);
    mids.push(total - fade / 2);
  }
  return { folded, loop: folded || cut.loop, crossfades: mids };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Every `step` seconds, each crossfade midpoint, and (for a loop) the last frame, to compare with the first. */
export function sampleTimes(duration: number, crossfades: number[], o: { loop: boolean; fps: number; step?: number }): number[] {
  const step = o.step ?? 0.5;
  const out = new Set<number>();
  for (let t = 0; t < duration - 1e-6; t += step) out.add(r3(t));
  for (const c of crossfades) if (c > 0 && c < duration) out.add(r3(c));
  if (o.loop) out.add(r3(duration - 1 / o.fps));
  return [...out].sort((a, b) => a - b);
}

export function parseBlack(stderr: string): Array<{ start: number; end: number }> {
  return [...stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => ({ start: +m[1], end: +m[2] }));
}

export function parseFreeze(stderr: string, duration: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let open: number | null = null;
  for (const m of stderr.matchAll(/freeze_(start|end): ([\d.]+)/g)) {
    if (m[1] === 'start') open = +m[2];
    else if (open !== null) { out.push({ start: open, end: +m[2] }); open = null; }
  }
  if (open !== null) out.push({ start: open, end: duration });
  return out;
}

/** tesseract `tsv` output → words (level 5) it read with some confidence. */
export function parseTsv(tsv: string, minConf = 30): Word[] {
  const out: Word[] = [];
  for (const row of tsv.split('\n').slice(1)) {
    const c = row.split('\t');
    if (c.length < 12 || c[0] !== '5') continue;
    const text = c.slice(11).join('\t').trim();
    const conf = +c[10];
    if (!text || conf < minConf) continue;
    out.push({ text, x: +c[6], y: +c[7], w: +c[8], h: +c[9], conf, line: +c[2] * 1e6 + +c[3] * 1e3 + +c[4] });
  }
  return out;
}

export function lumaStats(gray: Uint8Array): { mean: number; rms: number } {
  let s = 0;
  for (const v of gray) s += v;
  const mean = s / gray.length;
  let q = 0;
  for (const v of gray) q += (v - mean) ** 2;
  return { mean, rms: Math.sqrt(q / gray.length) };
}

/**
 * The "dark rectangle" floor: a frame whose luma barely varies reads as an
 * empty panel at page size, whatever its spotlight says. RMS contrast is the
 * measure; a dark theme may be dark, but not flat.
 */
export const CONTRAST = { high: 12, medium: 18 };
export function contrastFloor(s: { mean: number; rms: number }, _theme: 'dark' | 'light'): Finding | null {
  const what = `RMS contrast ${s.rms.toFixed(1)} (mean luma ${s.mean.toFixed(0)})`;
  if (s.rms < CONTRAST.high) return { severity: 'high', check: 'contrast', issue: `${what}: reads as a flat panel` };
  if (s.rms < CONTRAST.medium) return { severity: 'medium', check: 'contrast', issue: `${what}: low contrast at page size` };
  return null;
}

/**
 * A large empty region between content: the frame cut into a 16-column grid of
 * square-ish blocks; a block is flat when its luma barely varies. A flat block
 * counts when its own column has content both above and below it (it sits in
 * the layout, not in a margin the crop left), whatever it connects to at the
 * sides. More than `share` of the frame counted that way reads as a hole.
 */
export const GAP = { share: 0.25, flatRms: 3 };
export function emptyGap(gray: Uint8Array, width: number, height: number, share = GAP.share): Finding | null {
  const cols = 16, bw = width / cols, rows = Math.max(1, Math.round(height / bw)), bh = height / rows;
  const flat: boolean[][] = [];
  for (let r = 0; r < rows; r++) {
    flat.push([]);
    for (let c = 0; c < cols; c++) {
      let sum = 0, sq = 0, n = 0;
      for (let y = Math.floor(r * bh); y < Math.floor((r + 1) * bh); y++) for (let x = Math.floor(c * bw); x < Math.floor((c + 1) * bw); x++) {
        const v = gray[y * width + x]; sum += v; sq += v * v; n++;
      }
      const mean = sum / n;
      flat[r].push(Math.sqrt(Math.max(0, sq / n - mean * mean)) < GAP.flatRms);
    }
  }
  let held = 0;
  for (let c = 0; c < cols; c++) {
    const content = flat.map((row, r) => (!row[c] ? r : -1)).filter((r) => r >= 0);
    if (content.length < 2) continue;
    for (let r = content[0] + 1; r < content[content.length - 1]; r++) if (flat[r][c]) held++;
  }
  const worst = held / (rows * cols);
  return worst > share ? { severity: 'high', check: 'empty-gap', issue: `an empty region covers ${Math.round(worst * 100)}% of the frame between content` } : null;
}

/** A title card: some word set at display size (32px or more at page size), read with confidence. Its plain ground is the design. */
export function isTypeCard(words: Word[], sourceWidth: number, displayWidth: number): boolean {
  const k = displayWidth / sourceWidth;
  return words.some((w) => w.conf >= 80 && (w.text.match(/[A-Za-z]/g) ?? []).length >= 3 && fontPx(w) * k >= 32);
}

/**
 * Flicker: an element that re-appears, lit or shown, then dimmed or hidden,
 * then lit or shown again, within `windowSec`. Read from a coarse grid of
 * block averages over time (`frames[f][b]`, 8-bit luma at `fps`): a block's
 * change of more than `delta` is a transition; three alternating transitions
 * in the window is a re-appearance. One pulse (on, then off) is not flicker,
 * and a frame where over a third of the blocks change at once is a cut or a
 * dip, not an element.
 */
export const FLICKER = { delta: 18, windowSec: 2, globalShare: 0.34 };
export function flicker(frames: Uint8Array[], fps: number, o = FLICKER): Finding[] {
  if (frames.length < 3) return [];
  const blocks = frames[0].length;
  const steps: Array<Array<{ f: number; sign: number }>> = Array.from({ length: blocks }, () => []);
  for (let f = 1; f < frames.length; f++) {
    const moved: Array<{ b: number; sign: number }> = [];
    for (let b = 0; b < blocks; b++) {
      const d = frames[f][b] - frames[f - 1][b];
      if (Math.abs(d) > o.delta) moved.push({ b, sign: Math.sign(d) });
    }
    if (moved.length > blocks * o.globalShare) continue;
    for (const m of moved) {
      const s = steps[m.b];
      // Consecutive frames of the same fade are one transition.
      if (s.length && s[s.length - 1].sign === m.sign && f - s[s.length - 1].f <= 3) { s[s.length - 1].f = f; continue; }
      s.push({ f, sign: m.sign });
    }
  }
  const hits: number[] = [];
  for (const s of steps) for (let i = 0; i + 2 < s.length; i++) {
    const [a, b, c] = [s[i], s[i + 1], s[i + 2]];
    if (a.sign !== b.sign && b.sign !== c.sign && (c.f - a.f) / fps <= o.windowSec) { hits.push(a.f / fps); break; }
  }
  if (!hits.length) return [];
  const t = Math.min(...hits);
  return [{ t: +t.toFixed(2), severity: 'high', check: 'flicker', issue: `${hits.length} region(s) re-appear within ${o.windowSec}s (lit or shown, then gone, then back), first at ${t.toFixed(1)}s` }];
}

/** A clip that does not loop (the film) fades to black over its last second, by design. */
export function inFadeOut(t: number, duration: number, loop: boolean): boolean {
  return !loop && t > duration - 1;
}

export const SEAM = { high: 0.85, medium: 0.93 };
export function seamCheck(ssim: number, loop: boolean): Finding | null {
  if (!loop) return null;
  if (ssim < SEAM.high) return { severity: 'high', check: 'seam', issue: `loop seam: last vs first frame SSIM ${ssim.toFixed(3)}` };
  if (ssim < SEAM.medium) return { severity: 'medium', check: 'seam', issue: `loop seam: last vs first frame SSIM ${ssim.toFixed(3)}` };
  return null;
}

/**
 * A word's font size from its OCR box. tesseract boxes the ink, so "are" is
 * only its x-height (~0.55 em), caps or one ascender ~0.72 em, and a word
 * with both ascenders and descenders ("typed") nearly the whole em.
 */
export function fontPx(w: Word): number {
  const asc = /[A-Zbdfhiklt0-9]/.test(w.text), desc = /[gjpqy,;]/.test(w.text);
  return w.h / (asc && desc ? 0.95 : asc || desc ? 0.72 : 0.55);
}

/**
 * Font size at the size the page shows the clip. Only words OCR read well
 * count, and only lit ones at full severity: dimmed context is meant to recede.
 */
export const GLYPH = { high: 7, medium: 9, minConf: 80, minChars: 3 };
export type Box = { x: number; y: number; w: number; h: number };
const isWord = (t: string, min = 2) => (t.match(/[A-Za-z0-9]/g) ?? []).length >= min;
const inside = (w: Word, bs: Box[] | undefined) => !!bs?.some((b) => { const cx = w.x + w.w / 2, cy = w.y + w.h / 2; return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h; });

/**
 * Font size at the size the page shows the clip, by what the text is for:
 * - the lit target (the renderer's spotlight rects for that moment) is what a
 *   visitor must read: too small is high;
 * - other lit text: medium; dimmed context: low;
 * - text inside an artifact (a screenshot under review, an invoice page) is
 *   a picture of a page: exempt.
 * Tokens under 3 characters or read under 80 confidence are OCR fragments.
 */
export function legibility(words: Word[], o: { sourceWidth: number; displayWidth: number; sourceHeight?: number; lit?: Set<Word>; target?: Box[]; artifacts?: Box[] }): Finding[] {
  const k = o.displayWidth / o.sourceWidth;
  // A word the frame edge cuts is part of the crop, not a size: the judge looks at clipping.
  const cut = (w: Word) => w.x <= 2 || w.x + w.w >= o.sourceWidth - 2 || w.y <= 2 || (o.sourceHeight !== undefined && w.y + w.h >= o.sourceHeight - 2);
  const small = words
    .filter((w) => w.conf >= GLYPH.minConf && isWord(w.text, GLYPH.minChars) && !cut(w) && !inside(w, o.artifacts))
    .map((w) => ({ w, px: fontPx(w) * k }))
    .filter((x) => x.px < GLYPH.medium)
    .sort((a, b) => a.px - b.px);
  const target = small.filter((x) => inside(x.w, o.target));
  const rest = small.filter((x) => !inside(x.w, o.target));
  const lit = o.lit ? rest.filter((x) => o.lit!.has(x.w)) : rest;
  const ctx = o.lit ? rest.filter((x) => !o.lit!.has(x.w)) : [];
  const out: Finding[] = [];
  const list = (xs: typeof small) => xs.slice(0, 5).map((x) => `"${x.w.text}" ${x.px.toFixed(1)}px`).join(', ') + (xs.length > 5 ? ` (+${xs.length - 5})` : '');
  const at = (x: (typeof small)[number]) => ({ x: x.w.x, y: x.w.y, w: x.w.w, h: x.w.h });
  if (target.length) out.push({ severity: target[0].px < GLYPH.high ? 'high' : 'medium', check: 'legibility', issue: `the lit target is set under ${GLYPH.medium}px at ${o.displayWidth}px wide: ${list(target)}`, box: at(target[0]) });
  if (lit.length) out.push({ severity: 'medium', check: 'legibility', issue: `lit text set under ${GLYPH.medium}px at ${o.displayWidth}px wide: ${list(lit)}`, box: at(lit[0]) });
  // Dimmed context is meant to recede; small is fine there, so it is only noted.
  if (ctx.length) out.push({ severity: 'low', check: 'legibility', issue: `dimmed context under ${GLYPH.medium}px: ${list(ctx)}` });
  return out;
}

/**
 * Which words the spotlight lights: a word's own contrast (p90 - p10 of the
 * luma in its box) near the frame's best. Dimmed context sits well below it.
 * `gray` is the frame at `scale` x the OCR'd pixels.
 */
export function litWords(words: Word[], f: { gray: Uint8Array; width: number; height: number; scale: number }, share = 0.75): Set<Word> {
  const contrast = new Map<Word, number>();
  for (const w of words) {
    if (w.conf < 60 || !isWord(w.text)) continue;
    const vals: number[] = [];
    const x0 = Math.max(0, Math.floor(w.x * f.scale)), x1 = Math.min(f.width, Math.ceil((w.x + w.w) * f.scale));
    const y0 = Math.max(0, Math.floor(w.y * f.scale)), y1 = Math.min(f.height, Math.ceil((w.y + w.h) * f.scale));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) vals.push(f.gray[y * f.width + x]);
    if (vals.length < 4) continue;
    vals.sort((a, b) => a - b);
    contrast.set(w, vals[Math.floor(vals.length * 0.9)] - vals[Math.floor(vals.length * 0.1)]);
  }
  const best = Math.max(0, ...contrast.values());
  return new Set([...contrast].filter(([, c]) => c >= best * share).map(([w]) => w));
}

/** Two words from different lines whose boxes overlap: text drawn over text. */
export function collisions(words: Word[]): Finding[] {
  const out: Finding[] = [];
  for (let i = 0; i < words.length; i++) for (let j = i + 1; j < words.length; j++) {
    const a = words[i], b = words[j];
    if (a.line === b.line) continue;
    // OCR fragments and punctuation are not text a visitor reads: both must be real words read with confidence.
    if (a.conf < 80 || b.conf < 80 || !/[A-Za-z]{2,}/.test(a.text) || !/[A-Za-z]{2,}/.test(b.text)) continue;
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    if (ix * iy > 0.25 * Math.min(a.w * a.h, b.w * b.h)) {
      out.push({ severity: 'high', check: 'overprint', issue: `"${a.text}" and "${b.text}" overlap`, box: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x), h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y) } });
    }
  }
  return out;
}

/**
 * Display type (24px or taller at page size) should sit on a clean ground: the
 * ring just outside its box should be flat. A bar, a rule or another shape
 * running through the word makes the ring vary. Small UI text always has
 * neighbours, so it is left to the overprint and OCR checks. `gray` is the
 * frame in 8-bit luma at `scale` x the OCR'd frame's pixels.
 */
export const DISPLAY_TYPE_PX = 32;
export function textOverShape(words: Word[], f: { gray: Uint8Array; width: number; height: number; scale: number; displayWidth: number }): Finding[] {
  const out: Finding[] = [];
  const toDisplay = f.displayWidth / (f.width / f.scale);
  const inBox = (x: number, y: number) => words.some((o) => x >= o.x * f.scale && x < (o.x + o.w) * f.scale && y >= o.y * f.scale && y < (o.y + o.h) * f.scale);
  for (const w of words) {
    if (w.conf < 60 || w.h * toDisplay < DISPLAY_TYPE_PX || (w.text.match(/[A-Za-z]/g) ?? []).length < 2) continue;
    const pad = Math.max(3, Math.round(w.h * 0.3 * f.scale));
    const x0 = Math.round(w.x * f.scale), y0 = Math.round(w.y * f.scale), x1 = Math.round((w.x + w.w) * f.scale), y1 = Math.round((w.y + w.h) * f.scale);
    const vals: number[] = [];
    for (let y = Math.max(0, y0 - pad); y < Math.min(f.height, y1 + pad); y++) for (let x = Math.max(0, x0 - pad); x < Math.min(f.width, x1 + pad); x++) {
      // The ring is ground only: this word's box and every other word's box are masked out.
      if ((x >= x0 && x < x1 && y >= y0 && y < y1) || inBox(x, y)) continue;
      vals.push(f.gray[y * f.width + x]);
    }
    if (vals.length < 16) continue;
    const s = lumaStats(Uint8Array.from(vals));
    if (s.rms > 18) out.push({ severity: 'high', check: 'text-over-shape', issue: `"${w.text}" has something drawn through it (ring contrast ${s.rms.toFixed(0)})`, box: { x: w.x, y: w.y, w: w.w, h: w.h } });
  }
  return out;
}

/**
 * OCR confidence falling apart on one frame while both neighbours read fine is
 * a sign of overprint (or a smeared frame). Crossfades blend two layers by
 * design, so frames within `window` of one are skipped.
 */
export function confidenceCollapse(frames: Array<{ t: number; conf: number; words: number }>, crossfades: number[], window = 0.45): Finding[] {
  const out: Finding[] = [];
  for (let i = 1; i < frames.length - 1; i++) {
    const f = frames[i];
    if (crossfades.some((c) => Math.abs(c - f.t) < window)) continue;
    const ref = Math.min(frames[i - 1].conf, frames[i + 1].conf);
    if (ref >= 70 && f.words >= 3 && f.conf < ref - 25) {
      out.push({ t: f.t, severity: 'medium', check: 'ocr-collapse', issue: `OCR confidence ${f.conf.toFixed(0)} against ${ref.toFixed(0)} on both neighbours: overprint or a smeared frame` });
    }
  }
  return out;
}

/** Number words in a stat grid: pair each with the caps label stacked right above it ("YOUR ANSWERS" over "2" → "YOUR ANSWERS 2"). */
export function stackedLabels(words: Word[]): string[] {
  const out: string[] = [];
  for (const n of words.filter((w) => /^[+-]?[\d,]+$/.test(w.text))) {
    const above = words.filter((w) => w !== n && /^[A-Z][A-Z']*$/.test(w.text) && w.y + w.h <= n.y + 2 && n.y - (w.y + w.h) < n.h * 1.6
      && w.x < n.x + n.w + n.h * 4 && w.x + w.w > n.x - n.h).sort((a, b) => a.x - b.x);
    // A label row holds only words: a header that carries numbers itself ("FLEET 4 RUNNERS") is not a stat label.
    const row = above.filter((w) => Math.abs(w.y - above[0]?.y) < 4);
    if (row.some((w) => words.some((o) => o.line === w.line && /\d/.test(o.text)))) continue;
    if (row.length) out.push(`${row.map((w) => w.text).join(' ')} ${n.text}`);
  }
  return out;
}

const STOP = new Set(['your', 'you', 'a', 'an', 'the', 'from', 'of', 'by', 'all']);
const PARTICIPLES = new Set(['reviewed', 'judged', 'merged', 'live', 'open', 'landed', 'answered']);
const SYN: Record<string, string> = { answer: 'decision', call: 'decision', pr: 'pr', criterion: 'criteria' };
function noun(w: string): string {
  const s = w.toLowerCase().replace(/[^a-z]/g, '');
  const one = s.length > 3 && s.endsWith('s') && !s.endsWith('ss') ? s.slice(0, -1) : s;
  return SYN[one] ?? one;
}
function key(words: string[]): string | null {
  const ws = words.map((w) => w.toLowerCase()).filter((w) => /[a-z]/.test(w) && !STOP.has(w.replace(/[^a-z]/g, '')));
  if (!ws.length) return null;
  const head = noun(ws[0]);
  const part = ws.slice(1).map((w) => w.replace(/[^a-z]/g, '')).find((w) => PARTICIPLES.has(w));
  return part ? `${head} ${part}` : head;
}

/**
 * Numbers that disagree inside one frame: an impossible "N of M", one total
 * given two counts ("4/4 criteria" beside "3 of 4 criteria"), or a count said
 * in words and shown as a stat ("1 decision" beside "YOUR ANSWERS 2").
 */
export function numberContradictions(frames: Array<{ t: number; text: string }>): Finding[] {
  const out: Finding[] = [];
  for (const { t, text } of frames) {
    const totals = new Map<string, Set<string>>();
    for (const m of text.matchAll(/(\d+)\s*(?:of|\/)\s*(\d+)\s*([A-Za-z]+)?/g)) {
      const [n, d] = [+m[1], +m[2]];
      if (n > d) out.push({ t, severity: 'high', check: 'numbers', issue: `impossible "${n} of ${d}"` });
      if (m[3]) {
        const k = `${d} ${noun(m[3])}`;
        (totals.get(k) ?? totals.set(k, new Set()).get(k)!).add(String(n));
      }
    }
    for (const [k, ns] of totals) if (ns.size > 1) out.push({ t, severity: 'high', check: 'numbers', issue: `"${k}" counted as ${[...ns].join(' and ')} in one frame` });
    // Counts outside N/M forms: "N word word" forward, "WORD WORD N" backward (stat labels).
    const bare = text.replace(/\d+\s*(?:of|\/)\s*\d+/g, ' ');
    const counts = new Map<string, Set<number>>();
    const add = (k: string | null, n: number) => { if (k) (counts.get(k) ?? counts.set(k, new Set()).get(k)!).add(n); };
    // " · " joins separate OCR lines: no label or count reaches across it.
    for (const seg of bare.split(/\s·\s/)) {
    const toks = seg.split(/[\s,.;:()]+/).filter(Boolean);
    toks.forEach((tok, i) => {
      if (!/^\d+$/.test(tok)) return;
      const n = +tok;
      const fwd = toks.slice(i + 1, i + 4);
      // A count's noun is lowercase ("3 tasks", "1 decision"); a capitalized word after a number is a label ("Iteration 1 Condition").
      if (fwd[0] && /^[a-z]/.test(fwd[0])) add(key(fwd), n);
      // A stat label is the run of caps words right before the number ("YOUR ANSWERS 2"), nothing in between.
      const back: string[] = [];
      for (let j = i - 1; j >= Math.max(0, i - 3) && /^[A-Z][A-Z']+$/.test(toks[j]); j--) back.unshift(toks[j]);
      if (back.length) add(key(back), n);
    });
    }
    // A bare head ("screen") is ambiguous when the frame also qualifies it ("screen reviewed", "screen judged"):
    // OCR drops words from stat labels, so only a head with no qualified variant is compared bare.
    for (const [k, ns] of counts) {
      if (!k.includes(' ') && [...counts.keys()].some((q) => q.startsWith(`${k} `))) continue;
      if (ns.size > 1) out.push({ t, severity: 'high', check: 'numbers', issue: `"${k}" given as ${[...ns].join(' and ')} in one frame` });
    }
  }
  return out;
}

export function exitCode(findings: Array<{ severity: Severity; accepted?: string }>): number {
  return findings.some((f) => f.severity === 'high' && !f.accepted) ? 1 : 0;
}

/**
 * Known false positives, reviewed by a person: each rule names the clip
 * (regex), the check and the issue text (regex) it covers, and why. A match
 * keeps its finding in the report, marked accepted with the reason, and stops
 * counting toward the exit code. Rules never apply to the judge.
 */
export type AcceptRule = { clip: string; check: string; match: string; reason: string };
export function applyAccepted<T extends Finding>(findings: T[], rules: AcceptRule[]): T[] {
  return findings.map((f) => {
    if (f.check.startsWith('judge')) return f;
    const r = rules.find((x) => x.check === f.check && new RegExp(x.clip).test(f.clip ?? '') && new RegExp(x.match).test(f.issue));
    return r ? { ...f, accepted: r.reason } : f;
  });
}
