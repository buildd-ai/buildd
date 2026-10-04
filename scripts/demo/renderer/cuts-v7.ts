/**
 * The v7 film over `storyboards/demo-v7.yaml` (story: stories/invoice-phone.json):
 * a visual UI fix. The invoice table overflows on phones; you say what done
 * means; one runner works three tasks and one question reaches your phone;
 * the fix's own check fails, sends it back, and passes on attempt 2.
 *
 * Five chapters, each opened by a chapter card, timed to one spoken line
 * (tts.ts; the voice is measured, so a longer line stretches its chapter):
 *   hook · say what done means · agents work · buildd checks · recap
 *
 * Cuts: `full` (voice over soft clicks and one tone on green, no captions)
 * and `captioned` (silent, the chapter's line as a caption).
 */
import type { Stills } from './cuts';
import { aim, type Look } from './cuts-v6';
import type { Motion } from './motion-model';
import { captionReserve, shotStarts, type CamKey, type Cut, type Mask, type Rect, type Shot } from './timeline';

const FRAME = { width: 1920, height: 1080, fps: 30 };
export const V7_FADE = 0.6;
const DIM = 0.72;
const PAD = 14;

/**
 * The approved voice: one passage, read once (tts.ts speakPassage), cut into
 * one line per chapter at the reader's own sentence pauses.
 */
export const V7_LINES = [
  "Coding agents are fast. But they'll tell you they're done when they aren't.",
  'With buildd, you start by writing down what done means.',
  'Then the agents get to work on your own machine, a few tasks at a time. If they need a decision from you, it comes to your phone.',
  "When an agent says it's finished, buildd runs your checks. Here, the table still didn't fit, so the work went back. On the second try, it passed.",
  'Done means the checks pass.',
];
export const V7_VOICE = { voice: 'af_heart', speed: 1.0 };

export type Spoken = Array<{ file: string; seconds: number }>;

const union = (rs: Rect[]): Rect => {
  const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
};
const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const ghost = (r: Rect): Rect => ({ ...center(r), w: 0, h: 0 });
const press = (at: number, rect: Rect) => ({ at, ...center(rect), rect });

function typed(frames: Array<{ src: string; width: number; height: number; at: number }>, from: number, to: number) {
  const step = (to - from) / Math.max(1, frames.length - 1);
  const images = frames.map((f, i) => ({ ...f, at: i === 0 ? 0 : from + i * step }));
  const keys: number[] = [];
  for (let i = 1; i < frames.length; i++) keys.push(images[i].at - step / 2, images[i].at);
  return { images, keys };
}

const motion = (id: string, dur: number, m: Motion): Shot => ({ id, layout: 'motion', dur, images: [], motion: m });

/** The chapters' shots, before timing: [hook], [ch1...], [ch2...], [ch3...], [recap]. */
export function v7Chapters(s: Stills): Shot[][] {
  const look: Look = { frame: FRAME, dim: DIM, reserve: captionReserve(), tight: 1, minPx: 0, theme: 'dark', beat: false };
  const f = (step: string, rect: Rect, padding: number, t = 0, viewport: 'desktop' | 'phone' = 'desktop'): CamKey => aim(look, s.img(step, viewport), rect, padding, t);
  const key = (t: number, rects: Rect[], dim = DIM) => ({ at: t, rects, dim, padPx: PAD });

  // Opening, quiet and abstract: an agent says it's done, and a question mark appears.
  const open = motion('open', 4.6, { kind: 'doubt', label: '', agent: 'agent', task: 'invoices · rows as cards', from: -0.6, doneAt: 0.9, doubtAt: 2.4 });

  // 1. What done means: the checks set large, each appearing once, held; then the real draft card, held still.
  const T = 's02-thread';
  const list = s.box(T, 'approval-draft-criteria');
  const askLine = s.text(T, 'The invoice table overflows on phones.').rects[0];
  const confirm = s.box(T, 'kit-approval-confirm');
  const checks = motion('checks', 5.0, { kind: 'checks', label: '', title: 'Done when', items: ['Fits a 390px screen', 'No sideways scroll on /invoices', 'Phone screenshot approved'], from: -0.3, stagger: 0.7 });
  // The whole draft card, heading included (a crop from the ask line down clipped the title at the top edge).
  const card = union([s.box(T, 'approval-card'), askLine, list, confirm]);
  const draft: Shot = {
    id: 'draft', layout: 'screen', dur: 2.6, images: [s.img(T)],
    // Held still: one light on the whole card, no tap, nothing moving but a slow push.
    spot: [key(0, [card], DIM * 0.6)],
    camera: [f(T, card, 1.08, 0), f(T, card, 1.05, 1)],
  };

  // 2. Agents work: one runner, three slots lighting up; the question on the phone.
  const H = 's04-home';
  const fleetBox = s.box(H, 'home-fleet');
  const slotRows = s.boxAttrs(H, 'fleet-slot');
  const right = fleetBox.x + fleetBox.w;
  const fleet: Shot = {
    id: 'fleet', layout: 'screen', dur: 4.6, images: [s.img(H)],
    masks: slotRows.map((x, i): Mask => ({ rect: { x: x.rect.x, y: x.rect.y, w: right - x.rect.x, h: x.rect.h }, until: 0.6 + i * 0.55, wipe: 0.6, fill: 'dim' })),
    spot: [key(0, [fleetBox])],
    camera: [f(H, fleetBox, 1.08, 0), f(H, fleetBox, 1.05, 1)],
  };
  const Q = 's05-question';
  const opts = s.boxes(Q, 'question-option', 'phone');
  const all = union(opts);
  const lift = Math.min(all.y, 0.3);
  const qRect = { x: all.x, y: all.y - lift, w: all.w, h: all.h + lift };
  const phone = s.img(Q, 'phone');
  // The question card framed wide enough to read at 1280 (a 390px phone at 2.3 output px per CSS px).
  const beatLook: Look = { ...look, beat: true, minPx: 2.3, reserve: 0 };
  const question: Shot = {
    id: 'question', layout: 'screen', dur: 4.6,
    images: [phone, { ...s.img('s05b-answered', 'phone', 3.0), fade: 0 }],
    // One light on the whole question, held (dimming it to the option then back read as flicker); the tap outlines Yes.
    spot: [key(0.3, [qRect])],
    camera: [aim(beatLook, phone, qRect, 1.12, 0), aim(beatLook, phone, qRect, 1.08, 1)],
    taps: [press(2.1, opts[0])], controls: [opts[0]],
  };

  // 3. buildd checks: red (attempt 1 said done, the check said no), attempt 2, green, before/after, Looks right.
  const chip = (step: string) => s.box(step, '[data-loop-status]');
  // The history's text column (its timestamps sit on the right): framed tighter so the lines read at 1280.
  const hist = (step: string) => { const h = s.box(step, 'loop-history'); return { ...h, w: h.w * 0.74 }; };
  const taskCrop = (step: string) => union([chip(step), hist(step)]);
  // The chip first ("LOOPING · ATTEMPT 2/3"), then the history close enough to read why.
  const red: Shot = {
    id: 'red', layout: 'screen', dur: 3.4, images: [s.img('s06-sent-back')],
    // Both lit from the start (the chip alone left the frame a dark panel), then the light settles on the history.
    spot: [key(0.1, [chip('s06-sent-back'), hist('s06-sent-back')]), key(1.3, [ghost(chip('s06-sent-back')), hist('s06-sent-back')])],
    camera: [f('s06-sent-back', taskCrop('s06-sent-back'), 1.05, 0), f('s06-sent-back', taskCrop('s06-sent-back'), 1.05, 0.25), f('s06-sent-back', hist('s06-sent-back'), 1.08, 0.45), f('s06-sent-back', hist('s06-sent-back'), 1.05, 1)],
  };
  const retry: Shot = {
    id: 'attempt2', layout: 'screen', dur: 3.0, images: [s.img('s07-attempt2')],
    spot: [key(0.2, [chip('s07-attempt2'), hist('s07-attempt2')])],
    camera: [f('s07-attempt2', taskCrop('s07-attempt2'), 1.08, 0), f('s07-attempt2', taskCrop('s07-attempt2'), 1.06, 1)],
  };
  const green: Shot = {
    id: 'green', layout: 'screen', dur: 3.0, images: [s.img('s08-green')],
    // Once the task lands, its PR card sits between the chip and the history; frame the history alone (both attempts).
    spot: [key(0.2, [hist('s08-green')])],
    camera: [f('s08-green', hist('s08-green'), 1.1, 0), f('s08-green', hist('s08-green'), 1.06, 1)],
    chime: 0.6,
  };
  const ba = motion('beforeAfter', 3.0, {
    kind: 'beforeAfter', label: '',
    before: s.file('scripts/demo/stories/shots/invoices-list-mobile-before.png'),
    after: s.file('scripts/demo/stories/shots/invoices-list-mobile-after.png'),
    brokenAt: 0.25, afterAt: 0.9, checkAt: 1.6, view: 0.5,
  });
  const btn = s.box('s09-deck', 'deck-looks-right');
  const deck = s.box('s09-deck', 'visual-review-deck');
  const looks: Shot = {
    id: 'looks', layout: 'screen', dur: 3.0,
    // Held on the deck: after the tap it moves to "Nothing to review", which reads as nothing happening.
    images: [s.img('s09-deck')],
    spot: [key(0.2, [deck], DIM * 0.8), { ...key(1.0, [btn], DIM * 0.8), cross: true }],
    camera: [f('s09-deck', deck, 1.04, 0), f('s09-deck', deck, 1.03, 1)],
    taps: [press(1.6, btn)], controls: [btn],
    // The phone screenshot in the deck is a picture of a page (demo:review exempts its text).
    artifacts: [{ x: deck.x, y: deck.y, w: deck.w, h: Math.max(0, btn.y - 0.03 - deck.y) }],
  };

  const end = motion('end', 4.2, { kind: 'recap', label: '', titles: [], from: 0, stagger: 0, line: 'Done means the checks pass.', lineAt: 0.1, url: 'buildd.dev' });

  return [[open], [checks, draft], [fleet, question], [red, retry, green, ba, looks], [end]];
}

/**
 * Time the chapters to the voice: each line starts 0.3s into its chapter, and
 * a chapter is never shorter than its line plus a 0.8s tail (its last shot
 * stretches). Returns the shots and where each line lands on the cut's clock.
 */
export function timeToVoice(chapters: Shot[][], spoken: Spoken, fade = V7_FADE): { shots: Shot[]; voice: Array<{ at: number; file: string; seconds: number }> } {
  const shots: Shot[] = [];
  const voice: Array<{ at: number; file: string; seconds: number }> = [];
  let t = 0;
  chapters.forEach((ch, i) => {
    const sp = spoken[i];
    const len = ch.reduce((a, s) => a + s.dur, 0);
    const need = sp ? 0.3 + sp.seconds + 0.8 : 0;
    const out = ch.map((s) => ({ ...s }));
    if (need > len) out[out.length - 1].dur += need - len;
    if (sp) voice.push({ at: +(t + 0.3).toFixed(3), file: sp.file, seconds: sp.seconds });
    shots.push(...out);
    t += out.reduce((a, s) => a + s.dur, 0);
  });
  void fade;
  return { shots, voice };
}

export function v7Film(s: Stills, spoken: Spoken): Cut {
  const { shots, voice } = timeToVoice(v7Chapters(s), spoken);
  return { name: 'full', ...FRAME, fade: V7_FADE, fadeOut: 0.9, captions: false, theme: 'dark', dip: true, voice, maxBytes: 8 * 1024 * 1024,
    poster: posterAt(shots, 'green', 1.5), keyStills: keyStills(shots), shots };
}

/** A line's sentences. */
export const sentences = (line: string) => line.match(/[^.!?]+[.!?]+/g)!.map((x) => x.trim());

/**
 * The silent cut: each chapter's line as captions, one sentence per shot in
 * order (a long line on one caption ran off the frame); a chapter with more
 * sentences than shots puts the rest on its last shot, one after another.
 * The end card already shows its words.
 */
export function v7Captioned(s: Stills, spoken: Spoken): Cut {
  const chapters = v7Chapters(s);
  // The phone question fills the frame's height, so no caption can sit clear of it: its sentence goes on the shot before.
  const NO_CAPTION = new Set(['question']);
  chapters.slice(0, -1).forEach((ch, i) => {
    const ss = sentences(V7_LINES[i]);
    const shots = ch.filter((x) => !NO_CAPTION.has(x.id));
    shots.forEach((shot, k) => {
      if (k >= ss.length) return;
      const mine = k === shots.length - 1 ? ss.slice(k) : [ss[k]];
      shot.caption = mine.length === 1 ? mine[0] : mine.map((text, j) => ({ at: (j * shot.dur) / mine.length, text }));
    });
  });
  const { shots } = timeToVoice(chapters, spoken);
  return { name: 'captioned', ...FRAME, fade: V7_FADE, captions: true, captionScrim: true, theme: 'dark', dip: true, loop: false, shots, poster: posterAt(shots, 'green', 1.5) };
}

function posterAt(shots: Shot[], id: string, t: number): number {
  const starts = shotStarts({ shots });
  const i = shots.findIndex((x) => x.id === id);
  return i < 0 ? 0 : +(starts[i] + t).toFixed(2);
}

function keyStills(shots: Shot[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, id, t] of [['open', 'open', 3.5], ['checks', 'checks', 3.6], ['draft', 'draft', 1.5], ['fleet', 'fleet', 3.0], ['question', 'question', 2.0], ['red', 'red', 2.6], ['green', 'green', 1.5], ['before-after', 'beforeAfter', 2.4], ['looks-right', 'looks', 1.8], ['end', 'end', 2.5]] as const) {
    const at = posterAt(shots, id, t);
    if (at) out[name] = at;
  }
  return out;
}
