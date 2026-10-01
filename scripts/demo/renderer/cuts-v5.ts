/**
 * The v5 cuts over `storyboards/demo-v5.yaml`: the v4 story, easier to follow.
 * One thing matters per beat and the rest is dimmed; things arrive in
 * sequence (tool rows tick in, the Board fans out of the mission, the fleet
 * lights up a row at a time); no shot under 4s, 0.8s crossfades.
 *
 *   a: warm dark  (dark UI, full edit)
 *   b: light      (light UI, same edit)
 *   c: simple     (light UI, six beats, abstract fleet, bigger captions, ~36s)
 *
 * All positions come from the boxes the storyboard recorded, so a re-shoot
 * against a changed UI moves the spotlights with it.
 */
import type { Stills } from './cuts';
import { focus, shotStarts, type CamKey, type Cut, type Fleet, type Mask, type Rect, type Shot, type ShotImage } from './timeline';

export type V5 = 'a' | 'b' | 'c';
type Theme = 'dark' | 'light';

const FRAME = { width: 1920, height: 1080, fps: 30 };
const FADE = 0.8;
const DIM = 0.65;

const union = (rs: Rect[]): Rect => {
  const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
};
/** Grow a rect by (dx, dy) image fractions on every side: a spotlight hole with a little air. */
const pad = (r: Rect, dx = 0.006, dy = 0.006): Rect => ({ x: r.x - dx, y: r.y - dy, w: r.w + 2 * dx, h: r.h + 2 * dy });
const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
/** A zero-size hole at a rect's centre: keeps a key's hole count, cuts nothing (even-odd would cancel a duplicate). */
const ghost = (r: Rect): Rect => ({ ...center(r), w: 0, h: 0 });
const at = (k: CamKey, t: number): CamKey => ({ ...k, at: t });

function typed(frames: ShotImage[], from: number, to: number): { images: ShotImage[]; keys: number[] } {
  const step = (to - from) / Math.max(1, frames.length - 1);
  const images = frames.map((f, i) => ({ ...f, at: i === 0 ? 0 : from + i * step }));
  const keys: number[] = [];
  for (let i = 1; i < frames.length; i++) keys.push(images[i].at - step / 2, images[i].at);
  return { images, keys };
}

/** Reads the recorded boxes once, into the shapes the shots need. */
function shotsFor(s: Stills, dim: number) {
  const f = (step: string, rect: Rect, padding = 1.25, t = 0) => focus(rect, s.img(step), FRAME, padding, t);

  const ask = (caption: string, dur: number): Shot => {
    const t = typed(s.typing('s01-ask'), 0.9, 3.3);
    const composer = s.box('s01-ask', 'chat-composer');
    return {
      id: 'ask', layout: 'screen', dur, images: t.images, keys: t.keys, caption,
      spot: [{ at: 0.35, rects: [pad(composer)], dim }],
      camera: [at(f('s01-ask', composer, 2.2), 0), at(f('s01-ask', composer, 1.7), 1)],
    };
  };

  const reads = (dur: number): Shot => {
    const rows = s.boxes('s02-thread', 'tool-call-row');
    const group = s.box('s02-thread', 'tool-call-group');
    const para = s.text('s02-thread', 'Nothing in flight touches currency.');
    const first = para.rects[0];
    const card = s.box('s02-thread', 'approval-card');
    const img = s.img('s02-thread');
    // Tool rows tick in one by one; the long answer is left in the dim, only
    // its first sentence lit.
    const masks: Mask[] = rows.map((r, i) => ({ rect: r, until: 0.5 + i * 0.45 }));
    const top = union([group, first]);
    void para;
    const confirm = { x: card.x + 0.055, y: card.y + card.h - 52 / (img.height / 2) };
    return {
      id: 'reads', layout: 'screen', dur, images: [img],
      caption: [{ at: 0, text: 'It checks first, and recalls a past decision.' }, { at: 3.2, text: 'You confirm the mission.' }],
      masks,
      // Two holes throughout (one a ghost when one will do), so every move glides.
      spot: [{ at: 0.2, rects: [pad(group), pad(first, 0.004, 0.004)], dim }, { at: 1.9, rects: [pad(rows[1]), ghost(first)], dim }, { at: 3.3, rects: [pad(card), ghost(card)], dim }],
      camera: [at(f('s02-thread', top, 1.35), 0), at(f('s02-thread', top, 1.35), 0.5), at(f('s02-thread', card, 1.15), 0.72), at(f('s02-thread', card, 1.15), 1)],
      taps: [{ at: 4.9, x: confirm.x, y: confirm.y }],
    };
  };

  const rule = (dur: number): Shot => {
    const phrase = s.text('s04-rule-card', 'From now on, keep the public API backward compatible.');
    const card = s.box('s04-rule-card', 'directive-card');
    const saved = s.box('s05-rule-saved', 'directive-card');
    const save = s.box('s04-rule-card', 'directive-save');
    const both = union([phrase.block, card]);
    return {
      id: 'rule', layout: 'screen', dur,
      images: [s.img('s04-rule-card'), { ...s.img('s05-rule-saved', 'desktop', 4.5), fade: 0 }],
      caption: [{ at: 0, text: 'It notices a rule in what you said.' }, { at: 2.9, text: 'Tap once to keep it.' }],
      marks: [{ rect: phrase.rects[0], from: 0.6, to: 3.0 }],
      masks: [{ rect: pad(card, 0.01, 0.01), until: 2.5, fill: 'auto', sample: { x: card.x - 0.012, y: card.y + card.h / 2 } }],
      spot: [{ at: 0.3, rects: [pad(phrase.block)], dim }, { at: 2.6, rects: [pad(card)], dim }, { at: 4.5, rects: [pad(saved)], dim }],
      camera: [at(f('s04-rule-card', phrase.block, 2.2), 0), at(f('s04-rule-card', phrase.block, 2.2), 0.33), at(f('s04-rule-card', both, 1.2), 0.55), at(f('s04-rule-card', card, 1.35), 1)],
      taps: [{ at: 4.3, ...center(save) }],
    };
  };

  const rules = (dur: number): Shot => {
    const list = s.boxes('s06-rules-settings', 'standing-rule');
    const all = union(list);
    return {
      id: 'rules', layout: 'screen', dur, images: [s.img('s06-rules-settings')],
      caption: 'It applies in billing-web from now on.',
      spot: [{ at: 0.2, rects: [pad(all)], dim }, { at: 1.8, rects: [pad(list[0])], dim }],
      camera: [at(f('s06-rules-settings', all, 1.3), 0), at(f('s06-rules-settings', all, 1.2), 1)],
    };
  };

  const board = (caption: string, dur: number, spotDim = 0): Shot => {
    // Row by row across the three columns, so the phases fill together.
    const tiles = [...s.boxes('s07-board', 'board-tile')].sort((p, q) => (Math.round(p.y * 40) - Math.round(q.y * 40)) || p.x - q.x);
    const band = s.box('s07-board', 'goal-band');
    const boardBox = s.box('s07-board', 'mission-board');
    return {
      id: 'board', layout: 'screen', dur, images: [s.img('s07-board')], caption,
      burst: { origin: center(band), tiles, from: 0.5, stagger: 0.12, dur: 0.95, sample: 'left' },
      spot: spotDim ? [{ at: 0, rects: [pad(boardBox)], dim: spotDim }] : undefined,
      camera: [{ at: 0, cx: 0.5, cy: 0.5, zoom: 1 }, { at: 1, cx: 0.5, cy: 0.52, zoom: 1.06 }],
    };
  };

  const fleetReal = (dur: number): Shot => {
    const slots = s.boxAttrs('s08-home', 'fleet-slot');
    const fleet = s.box('s08-home', 'home-fleet');
    const strip = s.box('s08-home', 'home-stat-strip');
    const agents: Rect = { x: strip.x, y: strip.y, w: strip.w / 4, h: strip.h };
    const right = fleet.x + fleet.w;
    const row = (r: Rect): Rect => ({ x: r.x, y: r.y, w: right - r.x, h: r.h });
    const live = slots.filter((x) => x.status === 'running');
    const idle = slots.filter((x) => x.status !== 'running');
    const masks: Mask[] = [
      // Each live slot lights up left to right in turn; idle slots stay down.
      ...live.map((x, i) => ({ rect: row(x.rect), until: 0.6 + i * 0.5, wipe: 0.7, fill: 'dim' })),
      ...idle.map((x) => ({ rect: row(x.rect), fill: 'dim' })),
    ];
    const view = union([fleet, agents]);
    return {
      id: 'fleet', layout: 'screen', dur, images: [s.img('s08-home')],
      caption: 'Six agents work at once.',
      masks,
      spot: [{ at: 0, rects: [pad(fleet)], dim }, { at: 4.0, rects: [pad(agents)], dim }],
      camera: [at(f('s08-home', fleet, 1.2), 0), at(f('s08-home', fleet, 1.2), 0.6), at(f('s08-home', view, 1.1), 1)],
      plucks: live.map((_, i) => ({ at: 0.6 + i * 0.5, note: i })),
    };
  };

  const fleetAbstract = (dur: number): Shot => {
    const B = '#0C72CB', R = '#B24C9C';
    const fleet: Fleet = {
      total: 8, from: 0.7, stagger: 0.55, grow: 1.1,
      runners: [
        { name: 'atlas', sub: 'Mac Studio', slots: [{ label: 'builder · export', color: B }, null] },
        { name: 'birch', sub: 'Linux box', slots: [{ label: 'researcher · FX providers', color: R }, { label: 'builder · currency API', color: B }] },
        { name: 'cedar', sub: 'cloud VM', slots: [null, { label: 'builder · invoices', color: B }] },
        { name: 'dune', sub: 'cloud VM', slots: [{ label: 'builder · currency picker', color: B }, { label: 'builder · checkout', color: B }] },
      ],
    };
    return { id: 'fleet', layout: 'fleet', dur, images: [], fleet, caption: 'Six agents work at once.' };
  };

  const question = (dur: number, first: string, second: string): Shot => {
    const opt = s.box('s09-question', 'question-option', 0, 'phone');
    return {
      id: 'question', layout: 'phone', dur,
      images: [s.img('s09-question', 'phone'), { ...s.img('s14-answered', 'phone', 3.3), fade: 0 }],
      caption: [{ at: 0, text: first }, { at: 2.8, text: second }],
      camera: [{ at: 0, cx: 0.5, cy: 0.5, zoom: 1 }, { at: 1, cx: 0.5, cy: 0.5, zoom: 1.04 }],
      taps: [{ at: 3.1, ...center(opt) }],
    };
  };

  const screens = (dur: number): Shot => {
    const thumbs = s.boxes('s10-screens', 'visual-review-thumb');
    const all = union(thumbs);
    return {
      id: 'screens', layout: 'screen', dur, images: [s.img('s10-screens')],
      caption: 'It screenshots its own change, phone and desktop.',
      spot: [{ at: 0.3, rects: thumbs.slice(0, 2).map((r) => pad(r)), dim }, { at: 2.0, rects: [pad(all)], dim }],
      camera: [at(f('s10-screens', union(thumbs.slice(0, 2)), 2.4), 0), at(f('s10-screens', all, 1.3), 1)],
    };
  };

  const review = (caption: string, dur: number): Shot => {
    const btn = s.box('s11-deck', 'deck-looks-right');
    return {
      id: 'review', layout: 'screen', dur,
      images: [s.img('s11-deck'), { ...s.img('s12-deck-agreed', 'desktop', dur - 1.5), fade: 0 }],
      caption,
      spot: [{ at: dur - 2.7, rects: [pad(btn)], dim: dim * 0.8 }, { at: dur - 1.3, rects: [pad(btn)], dim: 0 }],
      camera: [{ at: 0, cx: 0.5, cy: 0.5, zoom: 0.8 }, { at: 1, cx: 0.5, cy: 0.5, zoom: 0.815 }],
      taps: [{ at: dur - 1.7, ...center(btn) }],
    };
  };

  const done = (caption: string, dur: number): Shot => {
    const rec = s.box('s13-complete', 'mission-completion-record');
    return {
      id: 'done', layout: 'screen', dur, images: [s.img('s13-complete')], caption,
      spot: [{ at: 0.4, rects: [pad(rec)], dim }],
      camera: [at(f('s13-complete', rec, 1.35), 0), at(f('s13-complete', rec, 1.2), 1)],
      chime: 0.9,
    };
  };

  return { ask, reads, rule, rules, board, fleetReal, fleetAbstract, question, screens, review, done };
}

function keyStills(shots: Shot[], want: Record<string, [string, number]>): Record<string, number> {
  const starts = shotStarts({ shots });
  const out: Record<string, number> = {};
  for (const [name, [id, t]] of Object.entries(want)) {
    const i = shots.findIndex((x) => x.id === id);
    if (i >= 0) out[name] = +(starts[i] + t).toFixed(2);
  }
  return out;
}

export function v5Film(s: Stills, variant: V5, theme: Theme): Cut {
  const b = shotsFor(s, variant === 'c' ? 0.72 : DIM);
  const shots: Shot[] = variant === 'c'
    ? [
      b.ask('Ask in one sentence.', 5),
      b.board('The plan fans out into tasks.', 6),
      b.fleetAbstract(6.5),
      b.question(6.5, 'It asks you when a choice matters.', 'You tap an answer.'),
      b.review('You approve its screenshots.', 6.5),
      b.done('Done. Every criterion checked.', 5.5),
    ]
    : [
      b.ask('Start with one sentence.', 4),
      b.reads(6),
      b.rule(6),
      b.rules(4),
      b.board('The work fans out across a board.', 5),
      b.fleetReal(5.5),
      b.question(5.5, 'When a choice matters, it asks.', 'You answer from your phone.'),
      b.screens(4),
      b.review('You look, and approve.', 4.5),
      b.done('Done. Every PR merged, every criterion checked.', 4.5),
    ];
  const keys = keyStills(shots, {
    'chat-read': ['reads', 2.8], 'rule-origin': ['rule', 1.6], 'fanout-mid': ['board', 1.25],
    'fleet-mid': ['fleet', 2.2], ask: ['ask', 3.6], review: ['review', 2.2],
  });
  return {
    name: 'full', ...FRAME, fade: FADE, fadeOut: 0.9, captions: true, theme,
    captionSize: variant === 'c' ? 44 : 32, keyStills: keys, poster: keys['fleet-mid'] ?? 0, shots,
  };
}

/** 16 seconds, four 4s beats, no captions; the last fades back into the first at rest. */
export function v5Hero(s: Stills, variant: V5, theme: Theme): Cut {
  const b = shotsFor(s, variant === 'c' ? 0.72 : DIM);
  const shots: Shot[] = variant === 'c'
    ? [b.board('', 4), b.fleetAbstract(4), b.review('', 4), b.done('', 4)]
    : [b.board('', 4), b.fleetReal(4), b.review('', 4), b.done('', 4)];
  for (const x of shots) { x.caption = undefined; x.chime = undefined; x.plucks = undefined; x.taps = undefined; }
  return { name: 'hero', ...FRAME, fade: FADE, loop: true, captions: false, theme, shots };
}
