/**
 * The v6 cuts over `storyboards/demo-v6.yaml`.
 *
 *   v6a  v5a (warm dark) polished: the rest dims to ~25%, crops sit tight on
 *        the lit element, spotlight holes are padded in screen pixels after
 *        the zoom, captions move out of the way of any lit element or
 *        control (timeline.captionPlace), and the Board fans out one column
 *        at a time, each tile sliding straight down inside its own column.
 *   v6x  an abstract brand-motion piece (~31s): type, shapes and two real
 *        screenshots; no dashboard crops (motion-model.ts / motion.ts).
 *
 * Both keep the 4s minimum shot and 0.8s crossfades.
 */
import type { Stills } from './cuts';
import type { Motion } from './motion-model';
import { WINDOW_TOP, burstColumns, burstPose, captionReserve, cutDuration, captionBox, captionPlace, captionWindows, focus, keepClear, overlap, shotStarts, type CamKey, type Cut, type Mask, type Rect, type Shot } from './timeline';

const FRAME = { width: 1920, height: 1080, fps: 30 };
const FADE = 0.8;
const DIM = 0.75;
const PAD = 14;

const union = (rs: Rect[]): Rect => {
  const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
};
const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const ghost = (r: Rect): Rect => ({ ...center(r), w: 0, h: 0 });
const at = (k: CamKey, t: number): CamKey => ({ ...k, at: t });

/**
 * How a set of v6a shots is framed. The film: 1920 dark, the rest dimmed to
 * ~25%, crops leaving the caption band free. A site beat: its own frame, the
 * rest left at ~65% (a tile on a page must not read as a dark rectangle),
 * tighter crops, no caption band, and a readability floor: at least `minPx`
 * output pixels per CSS pixel, so the lit thing still reads at ~700px
 * (desktop) or ~360px (mobile) display width.
 */
export type Look = { frame: { width: number; height: number }; dim: number; reserve: number; tight: number; minPx: number; theme: 'dark' | 'light'; beat: boolean };
const FILM: Look = { frame: FRAME, dim: DIM, reserve: captionReserve(), tight: 1, minPx: 0, theme: 'dark', beat: false };
export const BEAT_DIM = 0.35;
/** The one exception to a beat's readability floor: the rule card, whose sentence is set large. */
export const RULE_MIN_PX = 1.3;
export function beatLook(o: { mobile?: boolean; theme?: 'dark' | 'light' } = {}): Look {
  return o.mobile
    ? { frame: { width: 720, height: 900 }, dim: BEAT_DIM, reserve: 0, tight: 0.35, minPx: 1.5, theme: o.theme ?? 'dark', beat: true }
    : { frame: { width: 1280, height: 720 }, dim: BEAT_DIM, reserve: 0, tight: 0.35, minPx: 1.4, theme: o.theme ?? 'dark', beat: true };
}

/**
 * focus(), under a look: tighter padding for a beat, then the readability
 * floor. When the floor crops the element, the crop starts where it reads
 * from (its left and top edges), or ends at its far edge with `anchor: 'end'`.
 */
export function aim(o: Look, img: { width: number; height: number }, rect: Rect, padding: number, t = 0, anchor: 'start' | 'end' = 'start'): CamKey {
  const pad = o.tight === 1 ? padding : Math.max(1.06, 1 + (padding - 1) * o.tight);
  const k = focus(rect, img, o.frame, pad, t, o.reserve);
  if (!o.minPx) return k;
  const css = img.width / (img.width < 2000 ? 3 : 2); // phone stills are @3x, desktop @2x
  const floor = (o.minPx * css) / o.frame.width;
  // A tall region in a wide frame (a phone still in a 16:9 beat): focus() clamps
  // at zoom 1, which blows it up to the frame width. Frame it instead, as a
  // window (placeScreen's zoom < 1), still no smaller than the floor.
  const byH = (o.frame.height * img.width) / (pad * rect.h * img.height * o.frame.width);
  const fit = Math.max(floor, Math.min(1 / (rect.w * pad), byH));
  if (o.beat && fit < 1) {
    const scale = (o.frame.width / img.width) * fit;
    const h = img.height * scale;
    const top = Math.min(WINDOW_TOP, (o.frame.height - h) / 2);
    const y = o.frame.height / 2 - (rect.y + rect.h / 2) * h;
    const cy = h > o.frame.height ? 0.5 + Math.max(0, top - y) / (h - o.frame.height) : 0.5;
    return { at: t, cx: 0.5, cy, zoom: fit };
  }
  if (k.zoom >= floor) return k;
  const zoom = floor;
  const visW = 1 / zoom;
  const visH = (o.frame.height * img.width) / (o.frame.width * zoom * img.height);
  const m = 0.012;
  const along = (lo: number, len: number, vis: number, mid: number) =>
    len + 2 * m <= vis ? mid : anchor === 'start' ? lo - m + vis / 2 : lo + len + m - vis / 2;
  return { at: t, cx: along(rect.x, rect.w, visW, rect.x + rect.w / 2), cy: along(rect.y, rect.h, visH, rect.y + rect.h / 2), zoom };
}


function typed(frames: Array<{ src: string; width: number; height: number; at: number }>, from: number, to: number) {
  const step = (to - from) / Math.max(1, frames.length - 1);
  const images = frames.map((f, i) => ({ ...f, at: i === 0 ? 0 : from + i * step }));
  const keys: number[] = [];
  for (let i = 1; i < frames.length; i++) keys.push(images[i].at - step / 2, images[i].at);
  return { images, keys };
}

function v6aShots(s: Stills, o: Look = FILM): Shot[] {
  // Film crops leave the caption band free, so a lit element never sits under the caption.
  const f = (step: string, rect: Rect, padding: number, t = 0, anchor: 'start' | 'end' = 'start') => aim(o, s.img(step), rect, padding, t, anchor);
  const key = (t: number, rects: Rect[], dim = o.dim) => ({ at: t, rects, dim, padPx: PAD });

  const composer = s.box('s01-ask', 'chat-composer');
  const t1 = typed(s.typing('s01-ask'), 0.9, 3.2);
  const ask: Shot = {
    id: 'ask', layout: 'screen', dur: 4, images: t1.images, keys: t1.keys, caption: 'Start with one sentence.',
    spot: [key(0.35, [composer])],
    camera: [at(f('s01-ask', composer, 1.9), 0), at(f('s01-ask', composer, 1.6), 1)],
  };

  const rows = s.boxes('s02-thread', 'tool-call-row');
  const group = s.box('s02-thread', 'tool-call-group');
  const reads: Shot = {
    id: 'reads', layout: 'screen', dur: 4, images: [s.img('s02-thread')],
    caption: 'It checks first, and recalls a past decision.',
    masks: rows.map((r, i): Mask => ({ rect: r, until: 0.35 + i * 0.3 })),
    spot: [key(0.2, [group, ghost(group)]), key(1.4, [rows[1], ghost(rows[1])])],
    camera: [at(f('s02-thread', group, 1.2), 0), at(f('s02-thread', group, 1.25), 1)],
  };

  // The spec: the draft's "Done when" list, opened. Edit writes a prefix into
  // the composer and you type the change; Confirm files it, and only then does
  // the Organizer start.
  const card = s.box('s03-spec', 'approval-card');
  const crit = s.box('s03-spec', 'approval-draft-criteria');
  const edit = s.box('s03-spec', 'kit-approval-edit');
  const confirm = s.box('s03-spec', 'kit-approval-confirm');
  const criteria: Shot = {
    id: 'criteria', layout: 'screen', dur: 4.5, images: [s.img('s03-spec')],
    caption: 'It drafts the mission, and what done means.',
    spot: [key(0.2, [card]), key(1.2, [crit]), { ...key(3.2, [edit]), cross: true }],
    camera: [at(f('s03-spec', card, 1.1), 0), at(f('s03-spec', crit, 1.15), 1.2 / 4.5), at(f('s03-spec', crit, 1.15), 1)],
    taps: [{ at: 3.9, ...center(edit) }],
    controls: [edit, confirm],
  };

  const composerEdit = s.box('s03b-spec-edit', 'chat-composer');
  const t2 = typed(s.typing('s03b-spec-edit'), 0.6, 3.4);
  const editing: Shot = {
    id: 'edit', layout: 'screen', dur: 4.5, images: t2.images, keys: t2.keys,
    // The composer sits at the foot of the screen, so this caption goes up top.
    caption: 'Change anything before it starts.', captionAt: 'top',
    spot: [key(0.2, [composerEdit])],
    camera: [at(f('s03b-spec-edit', composerEdit, 1.5), 0), at(f('s03b-spec-edit', composerEdit, 1.4), 1)],
  };

  const confirming: Shot = {
    id: 'confirm', layout: 'screen', dur: 4, images: [s.img('s03-spec')],
    caption: 'When it reads right, you confirm.',
    spot: [key(0.2, [card]), { ...key(1.4, [confirm]), cross: true }],
    camera: [at(f('s03-spec', card, 1.12), 0), at(f('s03-spec', card, 1.12), 1)],
    taps: [{ at: 2.6, ...center(confirm) }],
    controls: [confirm, edit],
  };

  const phrase = s.text('s04-rule-card', 'From now on, keep the public API backward compatible.');
  const rcard = s.box('s04-rule-card', 'directive-card');
  const saved = s.box('s05-rule-saved', 'directive-card');
  const save = s.box('s04-rule-card', 'directive-save');
  const rule: Shot = {
    id: 'rule', layout: 'screen', dur: 6,
    images: [s.img('s04-rule-card'), { ...s.img('s05-rule-saved', 'desktop', 4.5), fade: 0 }],
    caption: [{ at: 0, text: 'It notices a rule in what you said.' }, { at: 2.9, text: 'Tap once to keep it.' }],
    marks: phrase.rects.map((rect) => ({ rect, from: 0.6, to: 3.0 })),
    masks: [{ rect: { x: rcard.x - 0.01, y: rcard.y - 0.01, w: rcard.w + 0.02, h: rcard.h + 0.02 }, until: 2.5, fill: 'auto', sample: { x: rcard.x - 0.012, y: rcard.y + rcard.h / 2 } }],
    spot: [key(0.3, [phrase.block]), key(2.6, [rcard]), key(4.5, [saved])],
    camera: (() => {
      // The rule card is wider than a 1.5 phone crop; its sentence is a 17px serif, so it may go to 1.3.
      const g = (rect: Rect, pad: number) => aim({ ...o, minPx: Math.min(o.minPx, RULE_MIN_PX) }, s.img('s04-rule-card'), rect, pad);
      return [at(f('s04-rule-card', phrase.block, 2.0), 0), at(f('s04-rule-card', phrase.block, 2.0), 0.33), at(g(union([phrase.block, rcard]), 1.12), 0.55), at(g(rcard, 1.25), 1)];
    })(),
    taps: [{ at: 4.3, ...center(save) }],
    controls: [save],
  };

  const list = s.boxes('s06-rules-settings', 'standing-rule');
  const rules: Shot = {
    id: 'rules', layout: 'screen', dur: 4, images: [s.img('s06-rules-settings')],
    caption: 'It applies in billing-web from now on.',
    spot: [key(0.2, [union(list)]), key(1.8, [list[0]])],
    camera: [at(f('s06-rules-settings', union(list), 1.15), 0), at(f('s06-rules-settings', list[0], 1.3), 1)],
  };

  const board = boardShot(s, 'The Organizer plans it into tasks.', 5, o);

  const slots = s.boxAttrs('s08-home', 'fleet-slot');
  const fleetBox = s.box('s08-home', 'home-fleet');
  const strip = s.box('s08-home', 'home-stat-strip');
  const agents: Rect = { x: strip.x, y: strip.y, w: strip.w / 4, h: strip.h };
  const right = fleetBox.x + fleetBox.w;
  const row = (r: Rect): Rect => ({ x: r.x, y: r.y, w: right - r.x, h: r.h });
  const live = slots.filter((x) => x.status === 'running');
  const idle = slots.filter((x) => x.status !== 'running');
  const fleet: Shot = {
    id: 'fleet', layout: 'screen', dur: 5.5, images: [s.img('s08-home')], caption: 'Six agents work at once.',
    masks: [
      ...live.map((x, i): Mask => ({ rect: row(x.rect), until: 0.5 + i * 0.42, wipe: 0.7, fill: 'dim' })),
      ...idle.map((x): Mask => ({ rect: row(x.rect), fill: 'dim' })),
    ],
    // Rows are all lit by 3.3s; the light moves to "6/8" as the camera starts to follow it.
    spot: [key(0, [fleetBox]), key(3.4, [agents])],
    camera: [at(f('s08-home', fleetBox, 1.1), 0), at(f('s08-home', fleetBox, 1.1), 3.4 / 5.5), at(f('s08-home', agents, 2.2), 1)],
    plucks: live.map((_, i) => ({ at: 0.5 + i * 0.42, note: i })),
  };

  const opt = s.box('s09-question', 'question-option', 0, 'phone');
  const question: Shot = {
    id: 'question', layout: 'phone', dur: 5.5,
    images: [s.img('s09-question', 'phone'), { ...s.img('s14-answered', 'phone', 3.3), fade: 0 }],
    caption: [{ at: 0, text: 'When a choice matters, it asks.' }, { at: 2.8, text: 'You answer from your phone.' }],
    camera: [{ at: 0, cx: 0.5, cy: 0.5, zoom: 1 }, { at: 1, cx: 0.5, cy: 0.5, zoom: 1.04 }],
    taps: [{ at: 3.1, ...center(opt) }],
  };
  if (o.beat) {
    // A beat crops into the phone screen itself (no device): the question and its options.
    const all = union(s.boxes('s09-question', 'question-option', 'phone'));
    const lift = Math.min(all.y, 0.3); // up to the question itself, not just its options
    const ask = { x: all.x, y: all.y - lift, w: all.w, h: all.h + lift };
    const phone = s.img('s09-question', 'phone');
    Object.assign(question, {
      layout: 'screen',
      spot: [key(0.3, [ask]), key(2.6, [opt])],
      camera: [aim(o, phone, ask, 1.15, 0), aim(o, phone, ask, 1.1, 1)],
    });
  }

  const routes = s.boxes('s10-screens', 'visual-review-route');
  const screens: Shot = {
    id: 'screens', layout: 'screen', dur: 4, images: [s.img('s10-screens')],
    caption: 'It screenshots its own change, phone and desktop.',
    spot: [key(0.3, [routes[0], ghost(routes[0])]), key(2.0, [routes[0], routes[1]])],
    // A held frame on both routes; only the light moves.
    camera: [at(f('s10-screens', union(routes.slice(0, 2)), 1.3), 0), at(f('s10-screens', union(routes.slice(0, 2)), 1.2), 1)],
  };

  const btn = s.box('s11-deck', 'deck-looks-right');
  const deck = s.box('s11-deck', 'visual-review-deck');
  // For a beat: the buttons and the bottom of the desktop screenshot just above them.
  const verdict: Rect = { x: btn.x - 0.12, y: btn.y - 0.18, w: btn.w + 0.12, h: btn.h + 0.18 };
  const review: Shot = {
    id: 'review', layout: 'screen', dur: 4.5,
    images: [s.img('s11-deck'), { ...s.img('s12-deck-agreed', 'desktop', 3.0), fade: 0 }],
    caption: 'You look, and approve.',
    // Deck to button is a cross-fade: a glide would drag a lit band across both buttons.
    spot: [key(0.3, [deck], o.dim * 0.8), { ...key(1.8, [btn], o.dim * 0.8), cross: true }, key(3.2, [btn], 0)],
    camera: o.beat
      ? [f('s11-deck', deck, 1.1, 0), f('s11-deck', deck, 1.1, 1.2 / 4.5), f('s11-deck', verdict, 1.1, 2.0 / 4.5), f('s11-deck', verdict, 1.1, 1)]
      : [{ at: 0, cx: 0.5, cy: 0.5, zoom: 0.8 }, { at: 1, cx: 0.5, cy: 0.5, zoom: 0.815 }],
    taps: [{ at: 2.8, ...center(btn) }],
    controls: [btn],
  };

  const rec = s.box('s13-complete', 'mission-completion-record');
  const band = s.box('s13-complete', 'goal-band');
  const done: Shot = {
    id: 'done', layout: 'screen', dur: 4.5, images: [s.img('s13-complete')],
    caption: 'Done when all four criteria pass.',
    spot: [key(0.3, [band]), key(2.3, [rec])],
    // One held crop on both: a pan from the band down to the record drags the lit band through the caption.
    camera: [at(f('s13-complete', union([band, rec]), 1.1), 0), at(f('s13-complete', union([band, rec]), 1.06), 1)],
    chime: 0.9,
  };

  return [ask, reads, criteria, editing, confirming, rule, rules, board, fleet, question, screens, review, done];
}

/**
 * The Board fan-out: column 1, then 2, then 3. Each tile appears at the top
 * slot of its own column (below the stat strip) at 0.92 of its size and
 * slides straight down to its place, while the rest of the Board fades in
 * under it.
 */
function boardShot(s: Stills, caption: string, dur: number, o: Look = FILM): Shot {
  const tiles = s.boxes('s07-board', 'board-tile');
  const boardBox = s.box('s07-board', 'mission-board');
  const strip = s.box('s07-board', 'goal-band');
  const cols = burstColumns(tiles);
  const starts: number[] = new Array(tiles.length);
  cols.forEach((col, c) => col.forEach((i, r) => { starts[i] = 0.45 + c * 0.85 + r * 0.14; }));
  return {
    id: 'board', layout: 'screen', dur, images: [s.img('s07-board')], caption,
    burst: { origin: center(boardBox), tiles, from: 0.45, stagger: 0.14, dur: 0.7, mode: 'column', scaleFrom: 0.92, starts, sample: 'left', drop: 0.35, ceiling: strip.y + strip.h + 0.01 },
    masks: [{ rect: { x: boardBox.x - 0.01, y: boardBox.y - 0.01, w: boardBox.w + 0.02, h: boardBox.h + 0.02 }, until: 0.15, fill: 'auto', sample: { x: boardBox.x - 0.012, y: boardBox.y + 0.02 } }],
    camera: o.beat ? boardPan(s, o, cols.map((col) => union(col.map((i) => tiles[i]))), cols.map((col) => Math.min(...col.map((i) => starts[i]))), dur)
      : [{ at: 0, cx: 0.5, cy: 0.5, zoom: 1 }, { at: 1, cx: 0.5, cy: 0.52, zoom: 1.05 }],
  };
}

/**
 * A beat can't show the whole Board readably, so the camera follows the
 * fan-out: on mobile it sits on the column that is landing; on desktop on
 * columns 1-2, then 2-3 as the third starts to fall.
 */
function boardPan(s: Stills, o: Look, colRects: Rect[], colStart: number[], dur: number): CamKey[] {
  const img = s.img('s07-board');
  const mobile = o.frame.height > o.frame.width;
  const groups = mobile ? colRects.map((r) => union([r])) : [union(colRects.slice(0, 2)), union(colRects.slice(-2))];
  const at = mobile ? colStart : [0, colStart[colStart.length - 1]];
  const keys: CamKey[] = [aim(o, img, groups[0], 1.08, 0)];
  for (let i = 1; i < groups.length; i++) {
    keys.push(aim(o, img, groups[i - 1], 1.08, Math.max(0, (at[i] - 0.3) / dur)), aim(o, img, groups[i], 1.08, Math.min(1, (at[i] + 0.4) / dur)));
  }
  keys.push({ ...keys[keys.length - 1], at: 1 });
  return keys;
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

/** Shots only the site's beats use: the film goes straight from the rule card to the Board. */
const BEAT_ONLY = ['rules'];

export function v6aFilm(s: Stills): Cut {
  const shots = v6aShots(s).filter((x) => !BEAT_ONLY.includes(x.id));
  const keys = keyStills(shots, {
    'fanout-mid': ['board', 1.6], approval: ['confirm', 2.9], 'visual-review': ['review', 2.2], done: ['done', 3.0],
    'chat-read': ['reads', 2.8], criteria: ['criteria', 2.0], edit: ['edit', 3.8], 'rule-origin': ['rule', 1.6], 'fleet-mid': ['fleet', 2.2],
  });
  return { name: 'full', ...FRAME, fade: FADE, fadeOut: 0.9, captions: true, theme: 'dark', keyStills: keys, poster: keys['fleet-mid'] ?? 0, shots };
}

export function v6aHero(s: Stills): Cut {
  const all = v6aShots(s);
  const pick = (id: string, dur = 4) => ({ ...all.find((x) => x.id === id)!, dur, caption: undefined, chime: undefined, taps: undefined, plucks: undefined });
  return { name: 'hero', ...FRAME, fade: FADE, loop: true, captions: false, theme: 'dark', shots: [boardShot(s, '', 4), pick('fleet'), pick('review'), pick('done')].map((x) => ({ ...x, caption: undefined })) };
}

// ── v6x: abstract ───────────────────────────────────────────────────────────

const B = '#0C72CB', R = '#B24C9C';
const RUNNERS = [
  { name: 'atlas', sub: 'Mac Studio', slots: [{ label: 'builder · export', color: B }, null] },
  { name: 'birch', sub: 'Linux box', slots: [{ label: 'researcher · FX providers', color: R }, { label: 'builder · currency API', color: B }] },
  { name: 'cedar', sub: 'cloud VM', slots: [null, { label: 'builder · invoices', color: B }] },
  { name: 'dune', sub: 'cloud VM', slots: [{ label: 'builder · currency picker', color: B }, { label: 'builder · checkout', color: B }] },
];
const SENTENCE = 'What would it take to bill customers in their own currency?';

function v6xShots(s: Stills): Shot[] {
  const m = (id: string, dur: number, motion: Motion, extra: Partial<Shot> = {}): Shot => ({ id, layout: 'motion', dur, images: [], motion, ...extra });
  const phone = s.file('scripts/demo/stories/shots/invoices-eur-mobile.png');
  const desk = s.file('scripts/demo/stories/shots/invoices-eur-desktop.png');
  return [
    m('ask', 5, { kind: 'type', label: '01 · Ask', text: SENTENCE, from: 0.6, to: 3.4 }),
    m('plan', 5.5, {
      // The mission, not the sentence, is what the Organizer splits: you confirmed its spec first.
      kind: 'split', label: '02 · Plan', text: 'Multi-currency invoices', from: 0.5, stagger: 0.12, columnGap: 0.25, dur: 0.6,
      columns: [
        { title: 'Foundations', tiles: ['FX providers', 'currency columns', 'rates service', 'currency picker', 'formatMoney'] },
        { title: 'Through the product', tiles: ['currency on API', 'render in currency', 'Stripe in currency', 'dual-currency CSV', 'receipt currency'] },
        { title: 'Prove it', tiles: ['pay a EUR invoice', 'admin guide'] },
      ],
    }),
    m('fleet', 5.5, { kind: 'fleet', label: '03 · Work', runners: RUNNERS, from: 0.6, stagger: 0.5, grow: 1.1, total: 8 }),
    m('question', 5, { kind: 'phone', label: '04 · Ask you', question: 'Round per line, or only the total?', options: ['Per line', 'Total only'], tapAt: 2.6 }, { taps: [{ at: 2.6, x: (360 + 215) / 1920, y: 0.4 }] }),
    m('review', 5, { kind: 'screens', label: '05 · Review', images: [phone, desk], checks: [1.6, 2.4] }),
    m('done', 5, { kind: 'done', label: '06 · Done', title: 'Done.', sub: '4 of 4 criteria passed · 11 PRs merged · 1 answer from you', from: 0.3 }),
  ];
}

export function v6xFilm(s: Stills): Cut {
  const shots = v6xShots(s);
  const keys = keyStills(shots, { 'fanout-mid': ['plan', 1.9], approval: ['question', 3.4], 'visual-review': ['review', 3.2], done: ['done', 2.0], 'fleet-mid': ['fleet', 2.2] });
  return { name: 'full', ...FRAME, fade: FADE, fadeOut: 0.9, captions: false, theme: 'dark', keyStills: keys, poster: keys['fleet-mid'] ?? 0, shots };
}

export function v6xHero(s: Stills, theme: 'dark' | 'light' = 'dark'): Cut {
  const all = v6xShots(s);
  const pick = (id: string) => ({ ...all.find((x) => x.id === id)!, dur: 4, taps: undefined });
  return { name: 'hero', ...FRAME, fade: FADE, loop: true, captions: false, theme, shots: [pick('plan'), pick('fleet'), pick('review'), pick('done')] };
}

// ── Checks run by render.ts before a frame is drawn (and by the tests) ─────

/** Every moment a caption is up, it covers no lit element and no control. Returns the collisions. */
export function captionCollisions(cut: Cut): Array<{ shot: string; t: number; text: string }> {
  if (cut.captions === false) return [];
  const out: Array<{ shot: string; t: number; text: string }> = [];
  for (const shot of cut.shots) {
    const place = captionPlace(cut, shot);
    for (const w of captionWindows(shot)) {
      const box = captionBox(cut, w.text, place);
      for (let t = w.from; t <= w.to; t += 0.1) {
        if (keepClear(cut, shot, t).some((k) => overlap(box, k) > 0)) { out.push({ shot: shot.id, t: +t.toFixed(1), text: w.text }); break; }
      }
    }
  }
  return out;
}

/** During a column fan-out, every tile stays inside its column's x-range, below the ceiling (the stat strip), at 0.9 scale or more. */
export function fanoutEscapes(cut: Cut): string[] {
  const out: string[] = [];
  for (const shot of cut.shots) {
    const b = shot.burst;
    if (!b || b.mode !== 'column') continue;
    const cols = burstColumns(b.tiles);
    for (let t = 0; t <= shot.dur; t += 0.05) {
      cols.forEach((col, c) => {
        const x0 = Math.min(...col.map((i) => b.tiles[i].x)), x1 = Math.max(...col.map((i) => b.tiles[i].x + b.tiles[i].w));
        for (const i of col) {
          const q = burstPose(b, i, t);
          if (q.opacity <= 0) continue;
          if (q.x < x0 - 1e-6 || q.x + q.w > x1 + 1e-6) out.push(`${shot.id} col ${c + 1} tile ${i} left its column at ${t.toFixed(2)}s`);
          if (b.ceiling !== undefined && q.y < b.ceiling - 1e-6) out.push(`${shot.id} tile ${i} crossed the ceiling at ${t.toFixed(2)}s`);
          if (q.scale < 0.9) out.push(`${shot.id} tile ${i} shrank to ${q.scale.toFixed(2)}`);
        }
      });
    }
  }
  return out;
}

/** The storyboard recorded no visible canvas Ask button anywhere. */
export function askButtonShots(manifest: any): string[] {
  return (manifest.steps ?? []).flatMap((st: any) => Object.entries(st.highlights ?? {}).flatMap(([k, hs]: [string, any]) =>
    (hs as any[]).some((h) => h.target === 'canvas-ask' && h.boxes?.length) ? [`${st.id} (${k})`] : []));
}

/** The site's feature beats, in story order: one short silent loop each. */
export const BEATS = ['spec', 'plan', 'rules', 'fleet', 'decide', 'review', 'done'] as const;
export type Beat = (typeof BEATS)[number];
const BEAT_SHOTS: Record<Beat, string[]> = {
  spec: ['criteria', 'edit'],
  plan: ['confirm', 'board'],
  rules: ['rule', 'rules'],
  fleet: ['fleet'],
  decide: ['question'],
  review: ['screens', 'review'],
  done: ['done'],
};

/**
 * One cut per beat, from the v6a shots with captions and sound stripped (the
 * page sets the words). Each runs one crossfade past its last shot; render.ts
 * folds that tail onto the start (seamlessLoopFilter), so the clip loops
 * without a jump and is beatLoopSeconds long.
 */
export function v6aBeats(s: Stills, opts: { mobile?: boolean; theme?: 'dark' | 'light' } = {}): Cut[] {
  const o = beatLook(opts);
  const all = v6aShots(s, o);
  // Taps stay: they are also the on-screen tap ring. Beats are encoded silent.
  const quiet = (x: Shot): Shot => ({ ...x, caption: undefined, chime: undefined });
  return BEATS.map((beat) => ({
    name: `beat-${beat}${opts.mobile ? '-mobile' : ''}`, ...o.frame, fps: FRAME.fps, fade: FADE, captions: false, theme: o.theme,
    shots: BEAT_SHOTS[beat].map((id) => quiet(all.find((x) => x.id === id)!)),
  }));
}

export const beatLoopSeconds = (c: Cut) => cutDuration(c) - c.fade;
