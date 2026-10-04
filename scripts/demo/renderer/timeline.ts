/**
 * The renderer's clock, pure: which shots are on screen at time t, where the
 * camera is, which still of a shot shows, and how opaque the caption and tap
 * marker are. The browser stage (stage.ts) and the soundtrack (audio.ts) both
 * read the same cut through these functions, so a frame and its sound agree.
 *
 * Units: seconds for time, image-fraction (0..1) for points on a shot, output
 * pixels for anything placed on the frame.
 */

export type Layout = 'screen' | 'phone' | 'card' | 'fleet' | 'motion';

/** A box on a still, in image fractions (0..1). */
export type Rect = { x: number; y: number; w: number; h: number };

/**
 * Spotlight keys: from `at`, everything outside `rects` is dimmed by `dim`
 * (0 = off, 0.65 = the rest at ~35%). Moving between keys eases over
 * SPOT_MOVE; flat fills only, no blur.
 */
export type SpotKey = {
  at: number; rects: Rect[]; dim: number; /** Air around every hole, in output pixels (so it survives the zoom). */ padPx?: number;
  /** Cross-fade to this key through an undimmed frame instead of gliding: a big hole shrinking onto a button would sweep a lit band across the controls. */
  cross?: boolean;
};

/**
 * Covers `rect` from `from` (default: the start) until `until` (default:
 * the end), then fades out, or wipes away left to right over `wipe` seconds.
 * `fill`: 'auto' samples the still at `sample` (default: just inside the
 * rect's top-left) so the cover matches what is behind; 'dim' is the
 * spotlight's dim colour; anything else is a CSS colour.
 */
/** `max` caps the cover (default 1): 0.8 leaves what is under it as a 20% ghost. */
export type Mask = { rect: Rect; from?: number; until?: number; wipe?: number; fill?: string; sample?: { x: number; y: number }; max?: number };

/** An accent underline under a phrase, on from `from` to `to`. */
export type Mark = { rect: Rect; from: number; to: number };

/**
 * The Board fan-out: each tile is lifted off the still and flies from
 * `origin` to where it really sits, one after another; its real spot is
 * covered until it lands, so the last frame is the still itself.
 */
export type Burst = {
  origin: { x: number; y: number }; tiles: Rect[]; from: number; stagger: number; dur: number; sample?: 'left';
  /**
   * 'column': each tile starts at the top slot of its own column and slides
   * straight down to its place (never leaving the column, never crossing
   * what is above it). Default 'radial': out of `origin`.
   */
  mode?: 'radial' | 'column';
  /** Scale a tile starts at (default 0.3 radial, 0.9 column). */
  scaleFrom?: number;
  /** Explicit start time per tile, overriding from + i * stagger. */
  starts?: number[];
  /** Column mode: how far above its place a tile appears, in tile heights (default 0.6). */
  drop?: number;
  /** Column mode: no tile ever rises above this (image fraction y), e.g. the stat strip's bottom edge. */
  ceiling?: number;
};

/** The abstract fleet: runners with their slots; each live slot's bar grows in turn. */
export type FleetRunner = { name: string; sub: string; slots: Array<{ label: string; color: string } | null> };
export type Fleet = { runners: FleetRunner[]; from: number; stagger: number; grow: number; total: number };

/** A camera key: at `at` (0..1 of the shot) the point (cx, cy) of the image sits at the frame centre, `zoom` over fit-width. */
export type CamKey = { at: number; cx: number; cy: number; zoom: number };

/** `fade`: how long this still dissolves in over the last (default SWAP_FADE); 0 cuts, for a UI that jumps on a tap. */
export type ShotImage = { src: string; at: number; width: number; height: number; fade?: number };

/** A tap at (x, y). With `rect` (the control tapped) the mark outlines the control, so it never sits on its label. */
export type Tap = { at: number; x: number; y: number; rect?: Rect };

export type Shot = {
  id: string;
  layout: Layout;
  /** How long the shot holds before the next begins to fade in. */
  dur: number;
  /** Stills in order; each replaces the last at its `at` (seconds into the shot). */
  images: ShotImage[];
  /** One caption for the shot, or several, each on from its `at` until the next (or its own `to`: a gap, e.g. while the camera pans). */
  caption?: string | Array<{ at: number; text: string; to?: number }>;
  camera?: CamKey[];
  taps?: Tap[];
  /**
   * Embedded artifacts in the still (fractions): screenshots under review, an
   * invoice page. A picture of a page: demo:review exempts their text from the
   * size floor. Recorded per frame with the lit target (stage __regions).
   */
  artifacts?: Rect[];
  /** Seconds into the shot where a key tick sounds (typing). */
  keys?: number[];
  /** Seconds into the shot for the completion chime. */
  chime?: number;
  /** Near-silent ticks (`note` is kept for ordering only). */
  plucks?: Array<{ at: number; note: number }>;
  spot?: SpotKey[];
  masks?: Mask[];
  marks?: Mark[];
  burst?: Burst;
  fleet?: Fleet;
  /** Buttons and other controls on the still (image fractions): a caption never covers them. */
  controls?: Rect[];
  /** Force the caption to the top or bottom (default: captionPlace decides). */
  captionAt?: 'top' | 'bottom';
  /** Abstract motion layout (layout 'motion'), drawn by motion.ts. */
  motion?: import('./motion-model').Motion;
  /** Card layout: the lines of text. */
  card?: { title: string; sub?: string };
};

export type Cut = {
  name: string;
  width: number;
  height: number;
  fps: number;
  /** Crossfade between shots. */
  fade: number;
  /** Seamless: the last shot fades into the first, and the cut is exactly sum(dur) long. */
  loop?: boolean;
  /**
   * Dip instead of crossfade: the outgoing shot fades to the ground over the
   * first half of `fade`, then the next fades in. Two dense screens blended
   * at 50% read as text printed over text (demo:review's judge, every beat).
   */
  dip?: boolean;
  captions?: boolean;
  /** Spoken lines (tts.ts), each a WAV placed at `at` seconds; the cut's clicks duck under them. */
  voice?: Array<{ at: number; file: string; seconds: number }>;
  /** Cap the encoded mp4 (re-encoded down if larger). */
  maxBytes?: number;
  theme?: 'dark' | 'light';
  /** Caption chip font size in px (default 32). */
  captionSize?: number;
  /** Named review stills written as key-<name>.png, at seconds into the cut. */
  keyStills?: Record<string, number>;
  /** Seconds into the cut for the poster frame (default 0). */
  poster?: number;
  /** Fade the last shot to the background over this long at the very end (not in a loop). */
  fadeOut?: number;
  shots: Shot[];
};

export const SWAP_FADE = 0.35;
export const TAP_LIFE = 0.8;
export const CAPTION_IN = { from: 0.45, to: 1.0 };
export const CAPTION_OUT = 0.45;
export const SPOT_MOVE = 0.6;
export const MASK_FADE = 0.4;

export function clamp(v: number, lo = 0, hi = 1): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Smootherstep: zero velocity and acceleration at both ends, so a move never lurches. */
export function ease(u: number): number {
  const x = clamp(u);
  return x * x * x * (x * (6 * x - 15) + 10);
}

export function shotStarts(cut: Pick<Cut, 'shots'>): number[] {
  const out: number[] = [];
  let t = 0;
  for (const s of cut.shots) { out.push(t); t += s.dur; }
  return out;
}

export function cutDuration(cut: Pick<Cut, 'shots' | 'fade' | 'loop'>): number {
  const sum = cut.shots.reduce((a, s) => a + s.dur, 0);
  return cut.loop ? sum : sum + cut.fade;
}

export type Layer = { index: number; local: number; opacity: number };

/**
 * The shots visible at t, bottom first. A shot is on from its start until the
 * next one has fully faded in over it. In a loop the first shot fades in over
 * the last during the final `fade`, held at its first frame, so t = duration
 * lands exactly on t = 0.
 */
export function layersAt(cut: Pick<Cut, 'shots' | 'fade' | 'loop' | 'dip'>, t: number): Layer[] {
  const starts = shotStarts(cut);
  const n = cut.shots.length;
  const total = cutDuration(cut);
  const tt = cut.loop ? ((t % total) + total) % total : clamp(t, 0, total);
  let i = n - 1;
  while (i > 0 && starts[i] > tt) i--;
  const local = tt - starts[i];
  const layers: Layer[] = [];
  const inFade = i > 0 && local < cut.fade;
  const half = cut.fade / 2;
  // Dip: out over the first half, in over the second; the two never overlap.
  const out = (u: number) => (cut.dip ? 1 - ease(u / half) : 1);
  const inn = (u: number) => (cut.dip ? ease((u - half) / half) : ease(u / cut.fade));
  if (inFade) layers.push({ index: i - 1, local: local + cut.shots[i - 1].dur, opacity: out(local) });
  let own = inFade ? inn(local) : 1;
  if (cut.loop && i === n - 1 && n > 1) {
    const into = local - (cut.shots[i].dur - cut.fade);
    if (into > 0) {
      if (cut.dip) own = Math.min(own, out(into));
      layers.push({ index: i, local, opacity: own });
      layers.push({ index: 0, local: 0, opacity: inn(into) });
      return layers.filter((l) => l.opacity > 0 || !cut.dip);
    }
  }
  layers.push({ index: i, local, opacity: own });
  return cut.dip ? layers.filter((l, k) => l.opacity > 0 || k === layers.length - 1) : layers;
}

export function cameraAt(keys: CamKey[] | undefined, u: number): { cx: number; cy: number; zoom: number } {
  if (!keys?.length) return { cx: 0.5, cy: 0.5, zoom: 1 };
  const k = [...keys].sort((a, b) => a.at - b.at);
  if (u <= k[0].at) return { cx: k[0].cx, cy: k[0].cy, zoom: k[0].zoom };
  for (let j = 1; j < k.length; j++) {
    if (u <= k[j].at) {
      const e = ease((u - k[j - 1].at) / (k[j].at - k[j - 1].at || 1));
      const lerp = (a: number, b: number) => a + (b - a) * e;
      return { cx: lerp(k[j - 1].cx, k[j].cx), cy: lerp(k[j - 1].cy, k[j].cy), zoom: lerp(k[j - 1].zoom, k[j].zoom) };
    }
  }
  const last = k[k.length - 1];
  return { cx: last.cx, cy: last.cy, zoom: last.zoom };
}

export type Placement = { x: number; y: number; scale: number };

/** Top margin of a framed (zoom < 1) shot: the room under it is the caption's. */
export const WINDOW_TOP = 40;

/**
 * A full-bleed shot: fit the image to the frame width, zoom, put (cx, cy) at
 * the centre, then clamp so the image always covers the frame (no empty edge).
 * An image shorter than the frame at this scale is centred vertically.
 * Zoom below 1 frames the shot as a window instead: centred across, hung from
 * WINDOW_TOP, so the caption sits below it rather than over the UI.
 */
export function placeScreen(img: { width: number; height: number }, frame: { width: number; height: number }, cam: { cx: number; cy: number; zoom: number }): Placement {
  const scale = (frame.width / img.width) * cam.zoom;
  const w = img.width * scale;
  const h = img.height * scale;
  if (cam.zoom < 1) return { x: (frame.width - w) / 2, y: Math.min(WINDOW_TOP, (frame.height - h) / 2) - Math.max(0, cam.cy - 0.5) * Math.max(0, h - frame.height), scale };
  const x = clamp(frame.width / 2 - cam.cx * w, frame.width - w, 0);
  const y = h >= frame.height ? clamp(frame.height / 2 - cam.cy * h, frame.height - h, 0) : (frame.height - h) / 2;
  return { x, y, scale };
}

export type Still = { src: string; prev?: string; alpha: number; index: number };

/** Which still is up at `local`, and how far it has faded in over the one before. */
export function stillAt(images: ShotImage[], local: number, swapFade = SWAP_FADE): Still {
  let i = 0;
  for (let j = 0; j < images.length; j++) if (images[j].at <= local) i = j;
  const cur = images[i];
  if (i === 0) return { src: cur.src, alpha: 1, index: 0 };
  // Typing frames swap faster than a crossfade; anything closer than the fade cuts.
  const gap = cur.at - images[i - 1].at;
  const f = Math.min(cur.fade ?? swapFade, gap);
  const alpha = f <= 0.1 ? 1 : ease((local - cur.at) / f);
  return { src: cur.src, prev: alpha < 1 ? images[i - 1].src : undefined, alpha, index: i };
}

export function captionOpacity(shot: { dur: number; caption?: Shot['caption'] }, local: number, fade: number): number {
  return captionsAt(shot, local, fade).reduce((m, c) => Math.max(m, c.opacity), 0);
}

/**
 * The captions of a shot with their opacity at `local`. Each waits for its
 * start to land, holds, and fades before the next (or with the crossfade out).
 */
export function captionsAt(shot: { dur: number; caption?: Shot['caption'] }, local: number, fade: number): Array<{ text: string; opacity: number }> {
  if (!shot.caption) return [];
  const list = typeof shot.caption === 'string' ? [{ at: 0, text: shot.caption }] : shot.caption;
  return list.map((c, i) => {
    const start = c.at + CAPTION_IN.from;
    const fin = ease((local - start) / (CAPTION_IN.to - CAPTION_IN.from));
    const end = (list[i] as { to?: number }).to ?? (i + 1 < list.length ? list[i + 1].at + CAPTION_IN.from : shot.dur + fade * 0.5);
    const fout = 1 - ease((local - (end - CAPTION_OUT)) / CAPTION_OUT);
    return { text: c.text, opacity: clamp(Math.min(fin, fout)) };
  });
}

/** A tap marker: a square that settles onto the target and fades. Null when no tap is live. */
export function tapAt(taps: Tap[] | undefined, local: number): { x: number; y: number; opacity: number; scale: number; rect?: Rect } | null {
  for (const tap of taps ?? []) {
    const u = (local - tap.at) / TAP_LIFE;
    if (u < 0 || u > 1) continue;
    const opacity = u < 0.2 ? ease(u / 0.2) : 1 - ease((u - 0.2) / 0.8);
    return { x: tap.x, y: tap.y, opacity, scale: 1.6 - 0.6 * ease(u / 0.35), ...(tap.rect ? { rect: tap.rect } : {}) };
  }
  return null;
}

export type SoundCue = { type: 'key' | 'tap' | 'pluck' | 'chime'; at: number; note?: number };

/** Every sound event on the cut's clock: key ticks, taps, plucks (burst tiles and bars landing), the chime. */
export function soundCues(cut: Cut): SoundCue[] {
  const starts = shotStarts(cut);
  const out: SoundCue[] = [];
  cut.shots.forEach((s, i) => {
    const t0 = starts[i];
    for (const k of s.keys ?? []) out.push({ type: 'key', at: t0 + k });
    for (const tap of s.taps ?? []) out.push({ type: 'tap', at: t0 + tap.at });
    if (s.motion) for (const c of motionCues(s.motion)) out.push({ ...c, at: t0 + c.at });
    for (const p of s.plucks ?? []) out.push({ type: 'pluck', at: t0 + p.at, note: p.note });
    // Every third tile lands on a note, rising: a light patter, not a drum roll.
    if (s.burst) s.burst.tiles.forEach((_, j) => { if (j % 3 === 0) out.push({ type: 'pluck', at: t0 + s.burst!.from + j * s.burst!.stagger + s.burst!.dur, note: j / 3 }); });
    if (s.fleet) {
      let j = 0;
      for (const r of s.fleet.runners) for (const slot of r.slots) if (slot) { out.push({ type: 'pluck', at: t0 + s.fleet.from + j * s.fleet.stagger, note: j }); j++; }
    }
    if (s.chime !== undefined) out.push({ type: 'chime', at: t0 + s.chime });
  });
  return out.sort((a, b) => a.at - b.at);
}

import { motionCues } from './motion-model';

const lerp = (a: number, b: number, e: number) => a + (b - a) * e;
const lerpRect = (a: Rect, b: Rect, e: number): Rect => ({ x: lerp(a.x, b.x, e), y: lerp(a.y, b.y, e), w: lerp(a.w, b.w, e), h: lerp(a.h, b.h, e) });

/**
 * The spotlight at `local`. Between two keys with the same number of rects
 * the rects glide; otherwise the dim eases out and back in around the change,
 * so holes never pop.
 */
export function spotAt(keys: SpotKey[] | undefined, local: number, move = SPOT_MOVE): { rects: Rect[]; dim: number } {
  if (!keys?.length) return { rects: [], dim: 0 };
  let k = -1;
  for (let j = 0; j < keys.length; j++) if (keys[j].at <= local) k = j;
  if (k < 0) return { rects: keys[0].rects, dim: 0 };
  const cur = keys[k];
  const prev = k > 0 ? keys[k - 1] : { at: cur.at, rects: cur.rects, dim: 0 };
  const e = ease((local - cur.at) / move);
  if (e >= 1) return { rects: cur.rects, dim: cur.dim };
  if (prev.rects.length === cur.rects.length && !cur.cross) return { rects: cur.rects.map((r, i) => lerpRect(prev.rects[i], r, e)), dim: lerp(prev.dim, cur.dim, e) };
  return e < 0.5 ? { rects: prev.rects, dim: prev.dim * (1 - 2 * e) } : { rects: cur.rects, dim: cur.dim * (2 * e - 1) };
}

/** A mask's cover at `local`: how opaque, and how much of its width is still covered (a wipe eats it from the left). */
export function maskAt(m: Mask, local: number, dur = Infinity): { opacity: number; left: number } {
  const r = maskCover(m, local, dur);
  return m.max === undefined ? r : { ...r, opacity: r.opacity * m.max };
}

function maskCover(m: Mask, local: number, dur: number): { opacity: number; left: number } {
  const from = m.from ?? -Infinity;
  const until = m.until ?? dur;
  if (local < from) return { opacity: 0, left: 1 };
  const fin = Number.isFinite(from) ? ease((local - from) / MASK_FADE) : 1;
  if (local < until) return { opacity: fin, left: 0 };
  if (m.wipe) {
    const e = ease((local - until) / m.wipe);
    return e >= 1 ? { opacity: 0, left: 1 } : { opacity: fin, left: e };
  }
  return { opacity: fin * (1 - ease((local - until) / MASK_FADE)), left: 0 };
}

/** One burst tile at `local`: 0 at the origin (hidden), 1 landed. */
export function burstAt(b: Burst, index: number, local: number): number {
  const u = (local - (b.starts?.[index] ?? b.from + index * b.stagger)) / b.dur;
  return u >= 1 - 1e-9 ? 1 : ease(u);
}

/** When the burst's last tile has landed (seconds into the shot). */
export function burstEnd(b: Burst): number {
  if (b.starts?.length) return Math.max(...b.starts) + b.dur;
  return b.from + (b.tiles.length - 1) * b.stagger + b.dur;
}

/** Tiles grouped by column (same left edge, to a hair), columns left to right, tiles top to bottom. */
export function burstColumns(tiles: Rect[]): number[][] {
  const cols: Array<{ x: number; idx: number[] }> = [];
  tiles.forEach((t, i) => {
    const c = cols.find((k) => Math.abs(k.x - t.x) < 0.01);
    if (c) c.idx.push(i); else cols.push({ x: t.x, idx: [i] });
  });
  return cols.sort((a, b) => a.x - b.x).map((c) => c.idx.sort((i, j) => tiles[i].y - tiles[j].y));
}

/**
 * Where burst tile `index` is at `local`, in image fractions: its box (the
 * tile's own size times `scale`, about its centre), and its opacity.
 */
export function burstPose(b: Burst, index: number, local: number): { x: number; y: number; w: number; h: number; scale: number; opacity: number; p: number } {
  const t = b.tiles[index];
  const p = burstAt(b, index, local);
  const scale = (b.scaleFrom ?? (b.mode === 'column' ? 0.9 : 0.3)) + (1 - (b.scaleFrom ?? (b.mode === 'column' ? 0.9 : 0.3))) * p;
  let cx = t.x + t.w / 2, cy = t.y + t.h / 2;
  if (b.mode === 'column') {
    // Straight down into its own slot from just above it: never sideways, never over a neighbour's flight path.
    // The first tile of a column only settles in place; the rest drop in from just above their slot.
    const col = burstColumns(b.tiles).find((c) => c.includes(index))!;
    const top = b.tiles[col[0]];
    const from = Math.max(cy - (b.drop ?? 0.35) * t.h, top.y + top.h / 2, (b.ceiling ?? -Infinity) + (t.h * scale) / 2);
    cy = from + (cy - from) * p;
  } else {
    cx = b.origin.x + (cx - b.origin.x) * p;
    cy = b.origin.y + (cy - b.origin.y) * p;
  }
  const w = t.w * scale, h = t.h * scale;
  return { x: cx - w / 2, y: cy - h / 2, w, h, scale, opacity: p <= 0 ? 0 : Math.min(1, p * (b.mode === 'column' ? 3 : 5)), p };
}

/** The abstract fleet at `local`: each live slot's bar length (0..1) and how many are live so far. */
export function fleetAt(f: Fleet, local: number): { bars: number[]; live: number } {
  const bars: number[] = [];
  let j = 0;
  for (const r of f.runners) for (const slot of r.slots) if (slot) { bars.push(ease((local - (f.from + j * f.stagger)) / f.grow)); j++; }
  return { bars, live: bars.filter((b) => b > 0).length };
}

/**
 * A camera key that frames `rect` (image fractions of an image `img` px) in a
 * `frame`, with `pad` of breathing room; never below fit-width.
 */
export function focus(rect: Rect, img: { width: number; height: number }, frame: { width: number; height: number }, pad = 1.25, at = 0, reservePx = 0): CamKey {
  // Fit into the frame above a reserved band (the caption's), and centre there.
  const H = frame.height - reservePx;
  const byW = 1 / (rect.w * pad);
  const byH = (H * img.width) / (pad * rect.h * img.height * frame.width);
  const zoom = Math.max(1, Math.min(byW, byH));
  const scale = (frame.width / img.width) * zoom;
  return { at, cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2 + reservePx / 2 / (img.height * scale), zoom };
}

/** Room a bottom caption needs (margin + chip + air), for focus's reservePx. */
export function captionReserve(size = 32): number {
  return CAPTION_MARGIN + 2.4 * size + 24;
}

/** Frame count at the cut's fps; a loop drops the frame that would repeat t = 0. */
export function frameCount(cut: Cut): number {
  return Math.round(cutDuration(cut) * cut.fps);
}

/** Opacity of the closing fade-to-background at t (0 until the last `fadeOut` seconds). */
export function fadeOutAt(cut: Pick<Cut, 'shots' | 'fade' | 'loop' | 'fadeOut'>, t: number): number {
  if (cut.loop || !cut.fadeOut) return 0;
  return ease((t - (cutDuration(cut) - cut.fadeOut)) / cut.fadeOut);
}

// ── Caption placement ───────────────────────────────────────────────────────

export const CAPTION_MARGIN = 72;
export type Box = { x: number; y: number; w: number; h: number };

/** The chip's box on the frame (px): Plex Mono is ~0.6em a character; padding and the square as stage.ts draws them. */
export function captionBox(cut: Pick<Cut, 'width' | 'height' | 'captionSize'>, text: string, place: 'top' | 'bottom'): Box {
  const size = cut.captionSize ?? 32;
  const w = Math.min(cut.width - 2 * CAPTION_MARGIN, text.length * 0.6 * size + 2.5 * size);
  const h = 2.4 * size;
  return { x: CAPTION_MARGIN, y: place === 'top' ? CAPTION_MARGIN : cut.height - CAPTION_MARGIN - h, w, h };
}

/** An image-fraction rect on the frame (px) under the camera at `cam`. */
export function toFrameBox(img: { width: number; height: number }, frame: { width: number; height: number }, cam: { cx: number; cy: number; zoom: number }, r: Rect): Box {
  const p = placeScreen(img, frame, cam);
  return { x: p.x + r.x * img.width * p.scale, y: p.y + r.y * img.height * p.scale, w: r.w * img.width * p.scale, h: r.h * img.height * p.scale };
}

export function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** What a caption must not cover in a screen shot at `local`: every lit hole (with its padding) and every control, on the frame. */
export function keepClear(cut: Pick<Cut, 'width' | 'height'>, shot: Shot, local: number): Box[] {
  if (shot.layout !== 'screen') return [];
  const img = shot.images[stillAt(shot.images, local).index];
  const cam = cameraAt(shot.camera, clamp(local / shot.dur));
  const spot = spotAt(shot.spot, local);
  const k = (shot.spot ?? []).filter((x) => x.at <= local).pop()?.padPx ?? 0;
  const boxes = (spot.dim > 0.05 ? spot.rects : []).filter((r) => r.w > 0).map((r) => {
    const b = toFrameBox(img, cut, cam, r);
    return { x: b.x - k, y: b.y - k, w: b.w + 2 * k, h: b.h + 2 * k };
  });
  for (const c of shot.controls ?? []) boxes.push(toFrameBox(img, cut, cam, c));
  // Fan-out tiles, wherever they are in flight: the caption must not sit on the Board.
  if (shot.burst) shot.burst.tiles.forEach((_, i) => {
    const q = burstPose(shot.burst!, i, local);
    if (q.opacity > 0) boxes.push(toFrameBox(img, cut, cam, q));
  });
  return boxes;
}

/** Captions of a shot with the window each is on screen. */
export function captionWindows(shot: Pick<Shot, 'caption' | 'dur'>): Array<{ text: string; from: number; to: number }> {
  if (!shot.caption) return [];
  const list = typeof shot.caption === 'string' ? [{ at: 0, text: shot.caption }] : shot.caption;
  return list.map((c, i) => ({ text: c.text, from: c.at + CAPTION_IN.from, to: (c as { to?: number }).to ?? (i + 1 < list.length ? list[i + 1].at + CAPTION_IN.from : shot.dur) }));
}

/**
 * Where a screen shot's captions go: at the bottom unless, at any sampled
 * moment a caption is up, it would cover a lit element or a control; then at
 * the top; if both would, whichever covers less. Pure, so the test and the
 * stage agree.
 */
export function captionPlace(cut: Pick<Cut, 'width' | 'height' | 'captionSize'>, shot: Shot): 'top' | 'bottom' {
  if (shot.captionAt) return shot.captionAt;
  const cost = (place: 'top' | 'bottom') => {
    let c = 0;
    for (const w of captionWindows(shot)) {
      const box = captionBox(cut, w.text, place);
      for (let t = w.from; t <= w.to; t += 0.1) for (const k of keepClear(cut, shot, t)) c += overlap(box, k);
    }
    return c;
  };
  const bottom = cost('bottom');
  return bottom === 0 ? 'bottom' : cost('top') < bottom ? 'top' : 'bottom';
}
