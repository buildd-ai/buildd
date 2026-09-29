/**
 * The renderer's clock, pure: which shots are on screen at time t, where the
 * camera is, which still of a shot shows, and how opaque the caption and tap
 * marker are. The browser stage (stage.ts) and the soundtrack (audio.ts) both
 * read the same cut through these functions, so a frame and its sound agree.
 *
 * Units: seconds for time, image-fraction (0..1) for points on a shot, output
 * pixels for anything placed on the frame.
 */

export type Layout = 'screen' | 'phone' | 'card' | 'fleet';

/** A box on a still, in image fractions (0..1). */
export type Rect = { x: number; y: number; w: number; h: number };

/**
 * Spotlight keys: from `at`, everything outside `rects` is dimmed by `dim`
 * (0 = off, 0.65 = the rest at ~35%). Moving between keys eases over
 * SPOT_MOVE; flat fills only, no blur.
 */
export type SpotKey = { at: number; rects: Rect[]; dim: number };

/**
 * Covers `rect` from `from` (default: the start) until `until` (default:
 * the end), then fades out, or wipes away left to right over `wipe` seconds.
 * `fill`: 'auto' samples the still at `sample` (default: just inside the
 * rect's top-left) so the cover matches what is behind; 'dim' is the
 * spotlight's dim colour; anything else is a CSS colour.
 */
export type Mask = { rect: Rect; from?: number; until?: number; wipe?: number; fill?: string; sample?: { x: number; y: number } };

/** An accent underline under a phrase, on from `from` to `to`. */
export type Mark = { rect: Rect; from: number; to: number };

/**
 * The Board fan-out: each tile is lifted off the still and flies from
 * `origin` to where it really sits, one after another; its real spot is
 * covered until it lands, so the last frame is the still itself.
 */
export type Burst = { origin: { x: number; y: number }; tiles: Rect[]; from: number; stagger: number; dur: number; sample?: 'left' };

/** The abstract fleet: runners with their slots; each live slot's bar grows in turn. */
export type FleetRunner = { name: string; sub: string; slots: Array<{ label: string; color: string } | null> };
export type Fleet = { runners: FleetRunner[]; from: number; stagger: number; grow: number; total: number };

/** A camera key: at `at` (0..1 of the shot) the point (cx, cy) of the image sits at the frame centre, `zoom` over fit-width. */
export type CamKey = { at: number; cx: number; cy: number; zoom: number };

/** `fade`: how long this still dissolves in over the last (default SWAP_FADE); 0 cuts, for a UI that jumps on a tap. */
export type ShotImage = { src: string; at: number; width: number; height: number; fade?: number };

export type Tap = { at: number; x: number; y: number };

export type Shot = {
  id: string;
  layout: Layout;
  /** How long the shot holds before the next begins to fade in. */
  dur: number;
  /** Stills in order; each replaces the last at its `at` (seconds into the shot). */
  images: ShotImage[];
  /** One caption for the shot, or several, each on from its `at` until the next. */
  caption?: string | Array<{ at: number; text: string }>;
  camera?: CamKey[];
  taps?: Tap[];
  /** Seconds into the shot where a key tick sounds (typing). */
  keys?: number[];
  /** Seconds into the shot for the completion chime. */
  chime?: number;
  /** Soft pentatonic plucks (note = index into PLUCK_NOTES). */
  plucks?: Array<{ at: number; note: number }>;
  spot?: SpotKey[];
  masks?: Mask[];
  marks?: Mark[];
  burst?: Burst;
  fleet?: Fleet;
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
  captions?: boolean;
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
export function layersAt(cut: Pick<Cut, 'shots' | 'fade' | 'loop'>, t: number): Layer[] {
  const starts = shotStarts(cut);
  const n = cut.shots.length;
  const total = cutDuration(cut);
  const tt = cut.loop ? ((t % total) + total) % total : clamp(t, 0, total);
  let i = n - 1;
  while (i > 0 && starts[i] > tt) i--;
  const local = tt - starts[i];
  const layers: Layer[] = [];
  const inFade = i > 0 && local < cut.fade;
  if (inFade) layers.push({ index: i - 1, local: local + cut.shots[i - 1].dur, opacity: 1 });
  layers.push({ index: i, local, opacity: inFade ? ease(local / cut.fade) : 1 });
  if (cut.loop && i === n - 1 && n > 1) {
    const into = local - (cut.shots[i].dur - cut.fade);
    if (into > 0) layers.push({ index: 0, local: 0, opacity: ease(into / cut.fade) });
  }
  return layers;
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
    const end = i + 1 < list.length ? list[i + 1].at + CAPTION_IN.from : shot.dur + fade * 0.5;
    const fout = 1 - ease((local - (end - CAPTION_OUT)) / CAPTION_OUT);
    return { text: c.text, opacity: clamp(Math.min(fin, fout)) };
  });
}

/** A tap marker: a square that settles onto the target and fades. Null when no tap is live. */
export function tapAt(taps: Tap[] | undefined, local: number): { x: number; y: number; opacity: number; scale: number } | null {
  for (const tap of taps ?? []) {
    const u = (local - tap.at) / TAP_LIFE;
    if (u < 0 || u > 1) continue;
    const opacity = u < 0.2 ? ease(u / 0.2) : 1 - ease((u - 0.2) / 0.8);
    return { x: tap.x, y: tap.y, opacity, scale: 1.6 - 0.6 * ease(u / 0.35) };
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
  if (prev.rects.length === cur.rects.length) return { rects: cur.rects.map((r, i) => lerpRect(prev.rects[i], r, e)), dim: lerp(prev.dim, cur.dim, e) };
  return e < 0.5 ? { rects: prev.rects, dim: prev.dim * (1 - 2 * e) } : { rects: cur.rects, dim: cur.dim * (2 * e - 1) };
}

/** A mask's cover at `local`: how opaque, and how much of its width is still covered (a wipe eats it from the left). */
export function maskAt(m: Mask, local: number, dur = Infinity): { opacity: number; left: number } {
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
  const u = (local - (b.from + index * b.stagger)) / b.dur;
  return u >= 1 - 1e-9 ? 1 : ease(u);
}

/** When the burst's last tile has landed (seconds into the shot). */
export function burstEnd(b: Burst): number {
  return b.from + (b.tiles.length - 1) * b.stagger + b.dur;
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
export function focus(rect: Rect, img: { width: number; height: number }, frame: { width: number; height: number }, pad = 1.25, at = 0): CamKey {
  const byW = 1 / (rect.w * pad);
  const byH = (frame.height * img.width) / (pad * rect.h * img.height * frame.width);
  return { at, cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2, zoom: Math.max(1, Math.min(byW, byH)) };
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
