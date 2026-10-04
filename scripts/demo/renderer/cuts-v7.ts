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

/** The approved voice, one line per chapter. */
export const V7_LINES = [
  "Agents say they're done. buildd checks.",
  "Say what's wrong. buildd turns it into checks you can read.",
  'One runner works several tasks. It settles routine calls itself, and asks you the rest.',
  'The agent said done. The check said no. Second try, it fits.',
  'Say what done means. Let agents work. buildd checks.',
];
export const V7_VOICE = { voice: 'af_heart', speed: 1.0 };
export const CHAPTERS = ['Say what done means', 'Agents work', 'buildd checks'];

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
const chapter = (n: number, title: string): Shot => motion(`ch${n}`, 1.3, { kind: 'chapter', label: '', index: String(n).padStart(2, '0'), title, from: 0.05 });

/** The chapters' shots, before timing: [hook], [ch1...], [ch2...], [ch3...], [recap]. */
export function v7Chapters(s: Stills): Shot[][] {
  const look: Look = { frame: FRAME, dim: DIM, reserve: captionReserve(), tight: 1, minPx: 0, theme: 'dark', beat: false };
  const f = (step: string, rect: Rect, padding: number, t = 0, viewport: 'desktop' | 'phone' = 'desktop'): CamKey => aim(look, s.img(step, viewport), rect, padding, t);
  const key = (t: number, rects: Rect[], dim = DIM) => ({ at: t, rects, dim, padPx: PAD });

  const hook = motion('hook', 5, { kind: 'title', label: '', lines: ["Agents say they're done.", 'buildd checks.'], from: -0.5, stagger: 1.6 });

  // 1. Say what done means: the ask typed; the draft's Done-when rows lit one by one; Confirm.
  const composer = s.box('s01-ask', 'chat-composer');
  const t1 = typed(s.typing('s01-ask'), 0.5, 2.4);
  const ask: Shot = {
    id: 'ask', layout: 'screen', dur: 3.2, images: t1.images, keys: t1.keys,
    spot: [key(0.2, [composer])], camera: [f('s01-ask', composer, 1.7, 0), f('s01-ask', composer, 1.55, 1)],
  };
  const T = 's02-thread';
  const list = s.box(T, 'approval-draft-criteria');
  const line = (p: string) => s.text(T, p).rects[0];
  const askLine = line('The invoice table overflows on phones.');
  const rowLabels = ['Fits a 390px screen', 'No sideways scroll on /invoices', 'Phone screenshot approved'];
  const labelRects = rowLabels.map(line);
  const rows = labelRects.map((r, i): Rect => {
    const next = labelRects[i + 1];
    const y1 = next ? next.y - 0.004 : list.y + list.h;
    return { x: list.x, y: r.y - 0.004, w: list.w, h: y1 - (r.y - 0.004) };
  });
  const confirm = s.box(T, 'kit-approval-confirm');
  const REVEAL = [1.0, 1.6, 2.2];
  const slots = (askOn: boolean, n: number) => [askOn ? askLine : ghost(askLine), ...rows.map((r, i) => (i < n ? r : { x: r.x, y: r.y, w: r.w, h: 0 }))];
  const card = union([askLine, list, confirm]);
  const criteria: Shot = {
    id: 'criteria', layout: 'screen', dur: 4.6, images: [s.img(T)],
    masks: rows.map((r, i): Mask => ({ rect: { x: r.x - 0.004, y: r.y, w: r.w + 0.008, h: r.h }, from: 0, until: REVEAL[i], max: 0.7 })),
    spot: [key(0.2, slots(true, 0)), ...REVEAL.map((t, i) => key(t, slots(false, i + 1)))],
    camera: [f(T, card, 1.1, 0), f(T, card, 1.06, 1)],
  };
  const confirming: Shot = {
    id: 'confirm', layout: 'screen', dur: 2.8, images: [s.img(T)],
    spot: [key(0.1, [list]), { ...key(0.9, [confirm]), cross: true }],
    camera: [f(T, card, 1.06, 0), f(T, card, 1.05, 1)],
    taps: [press(1.6, confirm)], controls: [confirm],
  };

  // 2. Agents work: one runner, three slots lighting up; the question on the phone.
  const H = 's04-home';
  const fleetBox = s.box(H, 'home-fleet');
  const slotRows = s.boxAttrs(H, 'fleet-slot');
  const right = fleetBox.x + fleetBox.w;
  const fleet: Shot = {
    id: 'fleet', layout: 'screen', dur: 5.2, images: [s.img(H)],
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
  const beatLook: Look = { ...look, beat: true, minPx: 1.4, reserve: 0 };
  const question: Shot = {
    id: 'question', layout: 'screen', dur: 5.0,
    images: [phone, { ...s.img('s05b-answered', 'phone', 3.0), fade: 0 }],
    spot: [key(0.3, [qRect]), key(1.3, [opts[0]]), { ...key(3.0, [qRect], 0), cross: true }],
    camera: [aim(beatLook, phone, qRect, 1.12, 0), aim(beatLook, phone, qRect, 1.08, 1)],
    taps: [press(2.1, opts[0])], controls: [opts[0]],
  };

  // 3. buildd checks: red (attempt 1 said done, the check said no), attempt 2, green, before/after, Looks right.
  const chip = (step: string) => s.box(step, '[data-loop-status]');
  const hist = (step: string) => s.box(step, 'loop-history');
  const taskCrop = (step: string) => union([chip(step), hist(step)]);
  // The chip first ("LOOPING · ATTEMPT 2/3"), then the history close enough to read why.
  const red: Shot = {
    id: 'red', layout: 'screen', dur: 3.8, images: [s.img('s06-sent-back')],
    spot: [key(0.1, [chip('s06-sent-back')]), key(1.3, [hist('s06-sent-back')])],
    camera: [f('s06-sent-back', taskCrop('s06-sent-back'), 1.05, 0), f('s06-sent-back', taskCrop('s06-sent-back'), 1.05, 0.25), f('s06-sent-back', hist('s06-sent-back'), 1.08, 0.45), f('s06-sent-back', hist('s06-sent-back'), 1.05, 1)],
  };
  const retry: Shot = {
    id: 'attempt2', layout: 'screen', dur: 2.4, images: [s.img('s07-attempt2')],
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
    brokenAt: 0.25, afterAt: 0.9, checkAt: 1.6,
  });
  const btn = s.box('s09-deck', 'deck-looks-right');
  const deck = s.box('s09-deck', 'visual-review-deck');
  const looks: Shot = {
    id: 'looks', layout: 'screen', dur: 2.8,
    images: [s.img('s09-deck'), { ...s.img('s09b-agreed', 'desktop', 2.2), fade: 0 }],
    spot: [key(0.2, [deck], DIM * 0.8), { ...key(1.0, [btn], DIM * 0.8), cross: true }],
    camera: [f('s09-deck', deck, 1.04, 0), f('s09-deck', deck, 1.03, 1)],
    taps: [press(1.6, btn)], controls: [btn],
    // The phone screenshot in the deck is a picture of a page (demo:review exempts its text).
    artifacts: [{ x: deck.x, y: deck.y, w: deck.w, h: Math.max(0, btn.y - 0.03 - deck.y) }],
  };

  const recap = motion('recap', 6, { kind: 'recap', label: '', titles: CHAPTERS, from: -0.3, stagger: 0.45, line: 'Done means the checks pass.', lineAt: 2.1, url: 'buildd.dev' });

  return [
    [hook],
    [chapter(1, CHAPTERS[0]), ask, criteria, confirming],
    [chapter(2, CHAPTERS[1]), fleet, question],
    [chapter(3, CHAPTERS[2]), red, retry, green, ba, looks],
    [recap],
  ];
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

/** The silent cut: the chapter's line as a caption on its first content shot. */
export function v7Captioned(s: Stills, spoken: Spoken): Cut {
  const chapters = v7Chapters(s);
  chapters.forEach((ch, i) => {
    const first = ch.find((x) => x.layout === 'screen');
    if (first) first.caption = V7_LINES[i];
  });
  const { shots } = timeToVoice(chapters, spoken);
  return { name: 'captioned', ...FRAME, fade: V7_FADE, captions: true, theme: 'dark', dip: true, loop: false, shots, poster: posterAt(shots, 'green', 1.5) };
}

function posterAt(shots: Shot[], id: string, t: number): number {
  const starts = shotStarts({ shots });
  const i = shots.findIndex((x) => x.id === id);
  return i < 0 ? 0 : +(starts[i] + t).toFixed(2);
}

function keyStills(shots: Shot[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, id, t] of [['hook', 'hook', 3.5], ['criteria', 'criteria', 3.2], ['fleet', 'fleet', 3.0], ['question', 'question', 2.0], ['red', 'red', 2.6], ['green', 'green', 1.5], ['before-after', 'beforeAfter', 2.4], ['looks-right', 'looks', 1.8], ['recap', 'recap', 4.0]] as const) {
    const at = posterAt(shots, id, t);
    if (at) out[name] = at;
  }
  return out;
}
