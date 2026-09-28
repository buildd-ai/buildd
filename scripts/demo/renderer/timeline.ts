/**
 * The renderer's clock, pure: which shots are on screen at time t, where the
 * camera is, which still of a shot shows, and how opaque the caption and tap
 * marker are. The browser stage (stage.ts) and the soundtrack (audio.ts) both
 * read the same cut through these functions, so a frame and its sound agree.
 *
 * Units: seconds for time, image-fraction (0..1) for points on a shot, output
 * pixels for anything placed on the frame.
 */

export type Layout = 'screen' | 'phone' | 'card';

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

/** Every sound event on the cut's clock: key ticks, tap clicks, the chime. */
export function soundCues(cut: Cut): Array<{ type: 'key' | 'click' | 'chime'; at: number }> {
  const starts = shotStarts(cut);
  const out: Array<{ type: 'key' | 'click' | 'chime'; at: number }> = [];
  cut.shots.forEach((s, i) => {
    for (const k of s.keys ?? []) out.push({ type: 'key', at: starts[i] + k });
    for (const tap of s.taps ?? []) out.push({ type: 'click', at: starts[i] + tap.at });
    if (s.chime !== undefined) out.push({ type: 'chime', at: starts[i] + s.chime });
  });
  return out.sort((a, b) => a.at - b.at);
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
