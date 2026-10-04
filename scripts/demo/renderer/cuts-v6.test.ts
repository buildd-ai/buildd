import { describe, expect, test } from 'bun:test';
import type { Stills } from './cuts';
import { clipSource, crfLadder, mergeShotlists, publishDir, seamlessLoopFilter, siteFiles, wantsCut } from './render';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { aim, beatLook, RULE_MIN_PX, askButtonShots, BEATS, beatLoopSeconds, captionCollisions, fanoutEscapes, v6aBeats, v6aFilm, v6aHero, v6xFilm, v6xHero } from './cuts-v6';
import { TAP_LIFE, layersAt, maskAt, tapAt, shotStarts as shotStartsOf, placeScreen, burstPose, captionBox, captionPlace, cutDuration, keepClear, overlap, soundCues, type Rect } from './timeline';
import { lowEnergyShare, synthesize } from './audio';
import { fleetRows, motionCues, splitAt, typedChars, verifyAt } from './motion-model';

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
// Board-shaped tiles: three columns (5, 5, 2), like the real Board.
const TILES = [...[0, 1, 2, 3, 4].map((r) => R(0.06, 0.4 + r * 0.1, 0.3, 0.085)), ...[0, 1, 2, 3, 4].map((r) => R(0.39, 0.4 + r * 0.1, 0.3, 0.083)), ...[0, 1].map((r) => R(0.72, 0.4 + r * 0.1, 0.25, 0.083))];
const BOXES: Record<string, Rect[]> = {
  'board-tile': TILES,
  'tool-call-row': [R(0.3, 0.2, 0.47, 0.03), R(0.3, 0.23, 0.47, 0.03), R(0.3, 0.26, 0.47, 0.03)],
  'standing-rule': [R(0.2, 0.4, 0.45, 0.08), R(0.2, 0.48, 0.45, 0.08)],
  'visual-review-deck': [R(0.1, 0.05, 0.8, 0.85)],
  'goal-band': [R(0.33, 0.14, 0.25, 0.17)],
  'visual-review-route': [R(0.68, 0.3, 0.3, 0.1), R(0.68, 0.41, 0.3, 0.1), R(0.68, 0.52, 0.3, 0.1)],
  // Confirm sits low and left, where a bottom caption would land.
  'kit-approval-confirm': [R(0.16, 0.8, 0.07, 0.03)],
  'approval-card': [R(0.15, 0.55, 0.47, 0.29)],
  'approval-draft-criteria': [R(0.25, 0.62, 0.35, 0.1)],
  // Real proportions (s08-home at 1440 CSS): four runner rows, 469 wide.
  'fleet-runner': [0, 1, 2, 3].map((i) => R(90 / 1440, (599 + i * 101) / 1620 * 2, 469 / 1440, 100 / 1620 * 2)),
  // Real proportions (s11-deck at 1440x810 CSS): Looks right is 376 x 57.
  'deck-looks-right': [R(724 / 1440, 715 / 810, 376 / 1440, 57 / 810)],
  'kit-approval-edit': [R(0.24, 0.8, 0.05, 0.03)],
};
const fake: Stills = {
  img: (step, viewport = 'desktop', at = 0) => ({ src: `/shots/${step}-${viewport}.png`, at, width: viewport === 'phone' ? 1170 : 2880, height: viewport === 'phone' ? 2532 : 1620 }),
  typing: (step) => Array.from({ length: 17 }, (_, i) => ({ src: `/shots/${step}-type-${i}.png`, at: 0, width: 2880, height: 1620 })),
  boxes: (_s, target) => BOXES[target] ?? [R(0.3, 0.3, 0.4, 0.2)],
  box: (s, target, index = 0, vp) => fake.boxes(s, target, vp)[index] ?? R(0.3, 0.3, 0.4, 0.2),
  boxAttrs: () => Array.from({ length: 8 }, (_, i) => ({ rect: R(0.18, 0.3 + i * 0.02, 0.2, 0.02), status: [1, 4].includes(i) ? 'idle' : 'running' })),
  // s02b-spec: the ask line above the Done-when list, then each row's two lines inside it (label, then check).
  text: (step, phrase) => {
    if (step !== 's02b-spec') return { rects: [R(0.3, 0.3, 0.17, 0.01)], block: R(0.3, 0.29, 0.44, 0.06) };
    const order = ["invoices in the customer's currency", 'pnpm test --filter web -- invoice-currency', 'public API backward compatible', 'pnpm test --filter api -- contract-v2', 'a EUR invoice pays end to end', 'e2e-eur-invoice', 'rounding rule written down', 'fx-rounding-decision'];
    const i = order.indexOf(phrase);
    const r = i < 0 ? R(0.25, 0.58, 0.3, 0.012) : R(0.26, 0.622 + i * 0.012, 0.2, 0.01);
    return { rects: [r], block: r };
  },
  file: (path) => ({ src: `/shots/${path}`, at: 0, width: 780, height: 2110 }),
};

describe('v6a', () => {
  const film = v6aFilm(fake);
  test('keeps the pace: 50-58s, no shot under 4s, 0.8s crossfades, dark', () => {
    expect(cutDuration(film)).toBeGreaterThanOrEqual(50);
    expect(cutDuration(film)).toBeLessThanOrEqual(58);
    for (const s of film.shots) expect(s.dur).toBeGreaterThanOrEqual(4);
    expect(film.fade).toBe(0.8);
    expect(film.theme).toBe('dark');
  });
  test('the rest dims to about 25%, and every hole is padded in screen pixels', () => {
    for (const s of film.shots) for (const k of s.spot ?? []) if (k.dim > 0.65) { expect(k.dim).toBeCloseTo(0.75, 5); expect(k.padPx).toBeGreaterThanOrEqual(10); }
  });
  test('no caption ever covers a lit element or a control', () => {
    expect(captionCollisions(film)).toEqual([]);
  });
  test('every crop leaves the caption band free: lit boxes end above the bottom caption', () => {
    // The Board fills the frame with tiles, so its caption goes up top instead.
    // A shot that sets captionAt (the edit, typed in the composer at the foot of the screen) chose its side.
    for (const shot of film.shots.filter((x) => x.layout === 'screen' && x.caption && !x.burst && !x.captionAt)) expect(captionPlace(film, shot)).toBe('bottom');
  });
  test('fan-out: the caption never covers a tile, landed or in flight', () => {
    const board = film.shots.find((x) => x.id === 'board')!;
    expect(captionPlace(film, board)).toBe('top');
    expect(captionCollisions({ ...film, shots: [board] })).toEqual([]);
  });
  test('review: the light cross-fades from the deck to the button, never gliding over the controls', () => {
    const review = film.shots.find((x) => x.id === 'review')!;
    const onBtn = review.spot!.find((k) => k.at > 0.5 && k.rects.length === 1 && k.rects[0].w < 0.5)!;
    expect(onBtn.cross).toBe(true);
  });
  test('fan-out: one column at a time, each tile inside its column, below the strip, at 0.9 scale or more', () => {
    expect(fanoutEscapes(film)).toEqual([]);
    const b = film.shots.find((s) => s.id === 'board')!.burst!;
    // Column 2 does not start before column 1 has started all its tiles.
    expect(Math.min(...b.starts!.slice(5, 10))).toBeGreaterThan(Math.max(...b.starts!.slice(0, 5)));
    expect(Math.min(...b.starts!.slice(10))).toBeGreaterThan(Math.max(...b.starts!.slice(5, 10)));
    expect(burstPose(b, 3, b.starts![3] + 0.01).scale).toBeGreaterThanOrEqual(0.9);
  });
  test('fanoutEscapes catches a tile that leaves its column', () => {
    const bad = v6aFilm(fake);
    const board = bad.shots.find((s) => s.id === 'board')!;
    board.burst = { ...board.burst!, mode: 'radial' };
    expect(fanoutEscapes({ ...bad, shots: bad.shots.map((s) => (s.id === 'board' ? { ...board, burst: { ...board.burst!, mode: 'column' as const, scaleFrom: 0.3 } } : s)) }).length).toBeGreaterThan(0);
  });
  // Synthesizing the whole ~57s film takes about 5s, so it gets its own timeout.
  test('the soundtrack is soft: nothing below 150 Hz, and tiles tick instead of ringing', () => {
    expect(lowEnergyShare(synthesize(soundCues(film), cutDuration(film)))).toBeLessThan(0.005);
  }, 20_000);
  test('spec: the drafted criteria are lit, then the change is typed after the Edit prefill', () => {
    const ids = film.shots.map((x) => x.id);
    expect(ids.slice(0, 5)).toEqual(['ask', 'reads', 'criteria', 'edit', 'confirm']);
    const criteria = film.shots.find((x) => x.id === 'criteria')!;
    expect(criteria.images[0].src).toContain('s02b-spec');
    const edit = film.shots.find((x) => x.id === 'edit')!;
    expect(edit.images.length).toBeGreaterThan(2);
    expect(edit.images[0].src).toContain('s03b-spec-edit-type-');
  });
  test('plan: you confirm before the Organizer fans the work out on the Board', () => {
    const ids = film.shots.map((x) => x.id);
    const confirm = film.shots.find((x) => x.id === 'confirm')!;
    expect(confirm.taps?.length).toBe(1);
    expect(ids.indexOf('confirm')).toBeLessThan(ids.indexOf('board'));
  });
  test('the reads shot stops at the thread: no card, no tap (the criteria shots carry it)', () => {
    const reads = film.shots.find((x) => x.id === 'reads')!;
    expect(reads.taps ?? []).toEqual([]);
  });
  test('done: the criteria band is lit, then the completion record', () => {
    const done = film.shots.find((x) => x.id === 'done')!;
    expect(done.spot!.some((k) => k.rects.includes(BOXES['goal-band'][0]))).toBe(true);
  });
  test('writes the review stills', () => {
    for (const k of ['fanout-mid', 'approval', 'visual-review', 'done']) expect(film.keyStills?.[k]).toBeGreaterThan(0);
  });
  test('a 16s hero loop without captions', () => {
    const h = v6aHero(fake);
    expect(cutDuration(h)).toBe(16);
    expect(h.shots.every((s) => !s.caption)).toBe(true);
  });
});

describe('v6x', () => {
  const film = v6xFilm(fake);
  test('about 30s of shapes and type: six beats, none under 4s, no caption chips', () => {
    expect(cutDuration(film)).toBeGreaterThanOrEqual(28);
    expect(cutDuration(film)).toBeLessThanOrEqual(34);
    expect(film.shots.map((s) => s.layout)).toEqual(Array(6).fill('motion'));
    for (const s of film.shots) expect(s.dur).toBeGreaterThanOrEqual(4);
    expect(film.captions).toBe(false);
  });
  test('the sentence is typed, then drops into 12 tiles, column by column', () => {
    const type = film.shots[0].motion as any;
    expect(typedChars(type, 0)).toBe(0);
    expect(typedChars(type, type.to)).toBe(type.text.length);
    const split = film.shots[1].motion as any;
    expect(split.columns.flatMap((c: any) => c.tiles)).toHaveLength(12);
    const mid = splitAt(split, 1.2);
    expect(mid[0][0]).toBeGreaterThan(0);
    expect(mid[2][0]).toBe(0);
  });
  test('six bars light up one at a time on four runners', () => {
    const fleet = film.shots[2].motion as any;
    expect(fleet.runners).toHaveLength(4);
    expect(fleetRows(fleet, 0).live).toBe(0);
    expect(fleetRows(fleet, 1.2).live).toBe(2);
    expect(fleetRows(fleet, 5).live).toBe(6);
  });
  test('its sounds: keys, near-silent ticks, taps, and the soft completion', () => {
    const cues = film.shots.flatMap((s) => motionCues(s.motion!));
    expect(cues.filter((c) => c.type === 'chime')).toHaveLength(1);
    expect(lowEnergyShare(synthesize(soundCues(film), cutDuration(film)))).toBeLessThan(0.005);
  });

});

test('askButtonShots flags a step where the Ask button was visible, and passes when hidden', () => {
  const m = { steps: [{ id: 'a', highlights: { dark: [{ target: 'canvas-ask', boxes: [] }] } }, { id: 'b', highlights: { dark: [{ target: 'canvas-ask', boxes: [{ x: 1 }] }] } }] };
  expect(askButtonShots(m)).toEqual(['b (dark)']);
});

describe('v6a beats (one short loop per feature, for the site)', () => {
  const film = v6aFilm(fake);
  const LOOKS = [
    { name: 'desktop dark', beats: v6aBeats(fake), frame: [1280, 720], theme: 'dark', minPx: 1.4 },
    { name: 'mobile dark', beats: v6aBeats(fake, { mobile: true }), frame: [720, 900], theme: 'dark', minPx: 1.5 },
    { name: 'desktop light', beats: v6aBeats(fake, { theme: 'light' }), frame: [1280, 720], theme: 'light', minPx: 1.4 },
    { name: 'mobile light', beats: v6aBeats(fake, { mobile: true, theme: 'light' }), frame: [720, 900], theme: 'light', minPx: 1.5 },
  ] as const;
  test('one cut per beat, in story order, named beat-<beat>[-mobile]', () => {
    expect(BEATS).toEqual(['spec', 'plan', 'rules', 'fleet', 'decide', 'review', 'done']);
    expect(LOOKS[0].beats.map((c) => c.name)).toEqual(BEATS.map((b) => `beat-${b}`));
    expect(LOOKS[1].beats.map((c) => c.name)).toEqual(BEATS.map((b) => `beat-${b}-mobile`));
  });
  test('no shot is in two beats; the typing, the thread, the edit and the Board stay film-only', () => {
    const used = LOOKS[0].beats.flatMap((c) => c.shots.map((s) => s.id));
    expect(new Set(used).size).toBe(used.length);
    expect(film.shots.map((s) => s.id).filter((id) => !used.includes(id)).sort()).toEqual(['ask', 'board', 'edit', 'reads']);
  });
  test('review never crops what it lights: every lit rect fits the frame width at the camera\'s zoom', () => {
    for (const look of LOOKS) {
      const review = look.beats.find((c) => c.name.startsWith('beat-review'))!.shots.find((x) => x.id === 'review')!;
      const zoom = Math.max(...review.camera!.map((k) => k.zoom));
      for (const k of review.spot!) for (const r of k.rects) if (k.dim > 0) expect(r.w * zoom).toBeLessThanOrEqual(1 + 1e-6);
    }
  });
  test('decide: nothing placed on the question layout outlives the swap to the answered one', () => {
    for (const c of [film, ...LOOKS.map((l) => l.beats.find((b) => b.name.startsWith('beat-decide'))!)]) {
      const q = c.shots.find((x) => x.id === 'question')!;
      const swap = q.images[1].at;
      for (const tap of q.taps ?? []) expect(tap.at + TAP_LIFE).toBeLessThanOrEqual(swap);
      const after = (q.spot ?? []).filter((k) => k.at >= swap);
      if (q.spot?.length) expect(after.length && after.every((k) => k.dim === 0)).toBe(true);
    }
  });
  test('fleet holds the runner table (the machines), not a zoom onto the stat', () => {
    for (const look of LOOKS) {
      const fleet = look.beats.find((c) => c.name.startsWith('beat-fleet'))!.shots[0];
      const cs = fleet.camera!;
      expect(Math.abs(cs[cs.length - 1].zoom - cs[0].zoom) / cs[0].zoom).toBeLessThan(0.1);
      // It lights the runner column (names + their slots) and never crops it.
      const lit = fleet.spot![0].rects[0];
      for (const k of cs) expect(lit.w * k.zoom).toBeLessThanOrEqual(1 + 1e-6);
    }
  });
  describe('spec: the change is the criteria arriving, and nothing is pressed', () => {
    const lit = (k: { rects: { w: number; h: number }[] }) => k.rects.filter((r) => r.w > 0 && r.h > 0).length;
    for (const look of LOOKS) {
      const spec = look.beats.find((c) => c.name.startsWith('beat-spec'))!;
      const crit = spec.shots[0];
      test(`${look.name}: no tap, no lit control, and no lit rect touches Edit or Confirm`, () => {
        for (const sh of spec.shots) {
          expect(sh.taps ?? []).toEqual([]);
          expect(sh.controls ?? []).toEqual([]);
          const buttons = [BOXES['kit-approval-edit'][0], BOXES['kit-approval-confirm'][0]];
          for (const k of sh.spot ?? []) for (const r of k.rects) if (r.w > 0) for (const b of buttons) {
            const ix = Math.min(r.x + r.w, b.x + b.w) - Math.max(r.x, b.x), iy = Math.min(r.y + r.h, b.y + b.h) - Math.max(r.y, b.y);
            expect(ix > 0 && iy > 0).toBe(false);
          }
        }
      });
      test(`${look.name}: opens on the full list lit, dims the rows to ghosts, lights the ask line, then the rows one at a time`, () => {
        expect(spec.shots.map((x) => x.id)).toEqual(['criteria']);
        const keys = crit.spot!;
        expect(lit(keys[0])).toBe(4); // the full list
        expect(lit(keys[1])).toBe(1); // the ask line alone
        expect(keys.slice(2).map(lit)).toEqual([1, 2, 3, 4]);
        for (let i = 1; i < keys.length; i++) expect(keys[i].at).toBeGreaterThan(keys[i - 1].at);
        // Rows are ghosts (never fully hidden) from the dim until each lights.
        for (const [i, m] of crit.masks!.entries()) {
          expect(m.max).toBeGreaterThan(0.5);
          expect(m.max).toBeLessThanOrEqual(0.85);
          expect(m.from).toBeCloseTo(keys[1].at, 5);
          expect(m.until).toBeCloseTo(keys[2 + i].at, 5);
        }
      });
      test(`${look.name}: the first encoded frame, the poster and the loop seam all show the full list lit`, () => {
        const allLit = (t: number) => lit(crit.spot!.filter((k) => k.at <= t).pop()!) === 4 && crit.masks!.every((m) => maskAt(m, t, crit.dur).opacity === 0);
        expect(allLit(spec.fade)).toBe(true); // the folded loop starts at cut t = fade
        expect(allLit(spec.poster!)).toBe(true);
        expect(allLit(crit.dur)).toBe(true); // the seam blends the end into the start: both full
        expect(allLit(0)).toBe(true);
        // The full list shows ~1.5s per loop or more: after the last row lands, plus the opening hold.
        const keys = crit.spot!;
        // (The cut runs one fade past the shot, holding its last frame; render.ts folds that tail onto the start.)
        expect((cutDuration(spec) - (keys[keys.length - 1].at + 0.4)) + (keys[1].at - spec.fade)).toBeGreaterThanOrEqual(1.4);
      });
    }
  });
  test('done holds the goal band, large enough to read at page size, from the first frame to the last (so the loop has no seam)', () => {
    for (const look of LOOKS) {
      const done = look.beats.find((c) => c.name.startsWith('beat-done'))!.shots[0];
      const css = done.images[0].width / 2;
      const zooms = done.camera!.map((k) => (look.frame[0] / css) * k.zoom);
      for (const z of zooms) expect(z).toBeGreaterThanOrEqual((look.frame[0] < 1000 ? 1.8 : 2) - 1e-6);
      // The lit band itself is never cut by the frame edge.
      const band = BOXES['goal-band'][0];
      for (const z of zooms) expect(band.w * css * 1.0 * z).toBeLessThanOrEqual(look.frame[0] + 1e-6);
      const cs = done.camera!.map((k) => [k.cx, k.cy]);
      for (const c of cs) { expect(c[0]).toBeCloseTo(cs[0][0], 2); expect(c[1]).toBeCloseTo(cs[0][1], 2); }
      expect(done.spot!.every((k) => k.rects.length === 1)).toBe(true);
    }
  });
  test('spec is the criteria then the edit; plan is Confirm then the Board', () => {
    const by = Object.fromEntries(LOOKS[0].beats.map((c) => [c.name, c.shots.map((s) => s.id)]));
    // demo:review: half of spec was the chat edit, not the checklist; plan's Board read as unrelated to "you press go".
    expect(by['beat-spec']).toEqual(['criteria']);
    expect(by['beat-plan']).toEqual(['confirm', 'filed']);
    expect(by['beat-review']).toEqual(['screens', 'review']);
  });
  for (const look of LOOKS) describe(look.name, () => {
    test('frame, theme, silent and caption-free; the loop is closed at encode', () => {
      for (const c of look.beats) {
        expect([c.width, c.height]).toEqual([...look.frame]);
        expect(c.theme).toBe(look.theme);
        expect(c.loop).toBeFalsy();
        expect(c.fadeOut).toBeFalsy();
        expect(c.captions).toBe(false);
        for (const s of c.shots) { expect(s.caption).toBeUndefined(); expect(s.chime).toBeUndefined(); }
      }
    });
    test('light dimming: the rest stays at 60% brightness or more', () => {
      for (const c of look.beats) for (const s of c.shots) for (const k of s.spot ?? []) expect(k.dim).toBeLessThanOrEqual(0.4);
    });
    test('readable: every camera key puts at least minPx output px on a CSS px', () => {
      for (const c of look.beats) for (const s of c.shots) {
        expect(s.layout).toBe('screen');
        const img = s.images[0];
        const css = img.width / (img.width < 2000 ? 3 : 2);
        const floor = s.id === 'rule' ? Math.min(look.minPx, RULE_MIN_PX) : look.minPx;
        for (const k of s.camera ?? []) expect((c.width / css) * k.zoom).toBeGreaterThanOrEqual(floor - 1e-6);
      }
    });
    test('4-12s loops (the cut runs one crossfade longer, folded into the start)', () => {
      for (const c of look.beats) {
        expect(beatLoopSeconds(c)).toBeCloseTo(cutDuration(c) - c.fade, 5);
        expect(beatLoopSeconds(c)).toBeGreaterThanOrEqual(4);
        expect(beatLoopSeconds(c)).toBeLessThanOrEqual(12);
        expect(c.fps).toBe(film.fps);
      }
    });
  });
  test('the film itself is unchanged by the beat looks: dark, 1920, dims to 0.75', () => {
    expect([film.width, film.height]).toEqual([1920, 1080]);
    expect(film.shots.some((s) => (s.spot ?? []).some((k) => Math.abs(k.dim - 0.75) < 1e-9))).toBe(true);
  });
});

describe('hero: agents say they are done, buildd checks', () => {
  const LOOKS = [
    { h: v6xHero(fake), frame: [1920, 1080], theme: 'dark', name: 'hero' },
    { h: v6xHero(fake, 'light'), frame: [1920, 1080], theme: 'light', name: 'hero' },
    { h: v6xHero(fake, 'dark', { mobile: true }), frame: [720, 900], theme: 'dark', name: 'hero-mobile' },
    { h: v6xHero(fake, 'light', { mobile: true }), frame: [720, 900], theme: 'light', name: 'hero-mobile' },
  ] as const;
  test('one abstract shot, 12-16s, looping, no typed sentence, named by size', () => {
    for (const { h, frame, theme, name } of LOOKS) {
      expect(h.name).toBe(name);
      expect([h.width, h.height]).toEqual([...frame]);
      expect(h.theme).toBe(theme);
      expect(h.loop).toBe(true);
      expect(cutDuration(h)).toBeGreaterThanOrEqual(12);
      expect(cutDuration(h)).toBeLessThanOrEqual(16);
      expect(h.shots).toHaveLength(1);
      expect(h.shots[0].motion!.kind).toBe('verify');
    }
  });
  test('the poster is the finished state: every check ticked and Done showing', () => {
    for (const { h } of LOOKS) {
      const v = verifyAt(h.shots[0].motion as any, h.poster!);
      expect(v.checks.every((c) => c === 1)).toBe(true);
      expect(v.done).toBe(1);
    }
  });
});

describe('verifyAt', () => {
  const m = v6xHero(fake).shots[0].motion as any;
  const dur = v6xHero(fake).shots[0].dur;
  test('starts empty: no bar filled, no check, no Done', () => {
    const v = verifyAt(m, 0);
    expect(v.bars.every((b) => b === 0)).toBe(true);
    expect(v.checks.every((c) => c === 0)).toBe(true);
    expect(v.done).toBe(0);
  });
  test('a check only ticks once its agent says done (its bar is full), and in order', () => {
    const tickAt = m.checks.map((_: string, i: number) => {
      for (let t = 0; t <= dur; t += 0.02) if (verifyAt(m, t).checks[i] > 0) return t;
      return Infinity;
    });
    for (let i = 0; i < tickAt.length; i++) {
      expect(verifyAt(m, tickAt[i]).bars[i]).toBe(1);
      if (i) expect(tickAt[i]).toBeGreaterThan(tickAt[i - 1]);
    }
    for (let t = 0; t <= dur; t += 0.05) {
      const v = verifyAt(m, t);
      if (v.done > 0) expect(v.checks.every((c) => c > 0.99) || t > m.resetAt).toBe(true);
    }
  });
  test('Done never shares a frame with the bars: they leave before it comes, and come back after it goes', () => {
    for (let t = 0; t <= dur + 1e-9; t += 0.02) {
      const v = verifyAt(m, t);
      expect(v.done > 0 && v.barsShown > 0).toBe(false);
    }
    // Both are fully there at some point: bars while the agents work, Done at the end.
    expect(verifyAt(m, 5).barsShown).toBe(1);
    expect(verifyAt(m, 10).done).toBe(1);
  });
  test('seamless: the last frame is the first', () => {
    const a = verifyAt(m, 0), b = verifyAt(m, dur);
    expect(b).toEqual(a);
  });
  test('sounds: one soft pluck per check and one finish', () => {
    const cues = motionCues(m);
    expect(cues.filter((c) => c.type === 'pluck')).toHaveLength(m.checks.length);
    expect(cues.filter((c) => c.type === 'chime')).toHaveLength(1);
  });
  test('very little text: four short checks', () => {
    expect(m.checks).toHaveLength(4);
    for (const c of m.checks) expect(c.length).toBeLessThanOrEqual(26);
  });
});

test('v6x hero comes in both themes', () => {
  expect(v6xHero(fake).theme).toBe('dark');
  expect(v6xHero(fake, 'light').theme).toBe('light');
});

test('spec fails loudly when a row\'s words were found outside the Done-when list (e.g. in a chat message above it)', () => {
  const stray: Stills = { ...fake, text: (step, phrase) => (step === 's02b-spec' && phrase === 'public API backward compatible' ? { rects: [R(0.5, 0.3, 0.2, 0.01)], block: R(0.5, 0.3, 0.2, 0.01) } : fake.text(step, phrase)) };
  expect(() => v6aBeats(stray)).toThrow(/not inside the Done-when list/);
});

test('a tap on a control outlines the control instead of stamping a square over its label', () => {
  for (const c of [v6aFilm(fake), ...v6aBeats(fake), ...v6aBeats(fake, { mobile: true })]) for (const sh of c.shots) for (const tap of sh.taps ?? []) {
    const on = (sh.controls ?? []).find((r) => tap.x >= r.x && tap.x <= r.x + r.w && tap.y >= r.y && tap.y <= r.y + r.h);
    if (on) expect(tap.rect).toEqual(on);
  }
  const t = tapAt([{ at: 1, x: 0.5, y: 0.5, rect: R(0.4, 0.45, 0.2, 0.1) }], 1.1)!;
  expect(t.rect).toEqual(R(0.4, 0.45, 0.2, 0.1));
});

test('the screenshots under review are marked as artifacts (their text is a picture of a page)', () => {
  const film = v6aFilm(fake);
  expect(film.shots.find((x) => x.id === 'screens')!.artifacts!.length).toBeGreaterThan(0);
  const review = film.shots.find((x) => x.id === 'review')!;
  expect(review.artifacts!.length).toBe(1);
  // The verdict buttons are not part of the artifact.
  const a = review.artifacts![0], btn = BOXES['deck-looks-right'][0];
  expect(a.y + a.h).toBeLessThanOrEqual(btn.y);
});

describe('dip transitions: two dense screens never share a frame', () => {
  const two = { fade: 0.8, shots: [{ dur: 4 }, { dur: 4 }] as any, dip: true };
  test('between shots: the outgoing shot is gone before the incoming one appears', () => {
    for (let t = 3.9; t <= 5; t += 0.01) {
      const ls = layersAt({ ...two, loop: false }, t).filter((l) => l.opacity > 0.001);
      expect(ls.length).toBeLessThanOrEqual(1);
    }
  });
  test('at a loop seam too', () => {
    for (let t = 7; t <= 8; t += 0.01) {
      const ls = layersAt({ ...two, loop: true }, t).filter((l) => l.opacity > 0.001);
      expect(ls.length).toBeLessThanOrEqual(1);
    }
  });
  test('without dip a crossfade still blends both', () => {
    expect(layersAt({ ...two, dip: false, loop: false }, 4.4).filter((l) => l.opacity > 0.1).length).toBe(2);
  });
  test('v6a film and beats dip; the seam of a folded beat dips through the theme ground', () => {
    expect(v6aFilm(fake).dip).toBe(true);
    for (const c of [...v6aBeats(fake), ...v6aBeats(fake, { theme: 'light' })]) expect(c.dip).toBe(true);
    expect(seamlessLoopFilter(10.8, 0.8, '', 'black')).toContain('transition=fadeblack');
    expect(seamlessLoopFilter(10.8, 0.8, '', 'white')).toContain('transition=fadewhite');
  });
});

describe('seamlessLoopFilter', () => {
  test('folds the last crossfade onto the start: output = cut - fade', () => {
    const f = seamlessLoopFilter(10.8, 0.8);
    expect(f).toContain('trim=start=0.8:end=10.8');
    expect(f).toContain('trim=start=0:end=0.8');
    expect(f).toContain('xfade=transition=fade:duration=0.8:offset=9.2');
  });
});

test('siteFiles: the exact names the site codes against', () => {
  const names = siteFiles().map(([, to]) => to).sort();
  const clips = [...BEATS.flatMap((b) => [b, `${b}-mobile`, `${b}-light`, `${b}-light-mobile`]), 'hero', 'hero-mobile', 'hero-light', 'hero-light-mobile'];
  // The film with sound is one mp4 (the dialog needs one source) plus its poster.
  const want = [...clips.flatMap((b) => [`${b}.webm`, `${b}.mp4`, `${b}-poster.jpg`]), 'full.mp4', 'full-poster.jpg'].sort();
  expect(names).toEqual(want);
});

test('wantsCut: --only hero takes the phone crop too, and nothing else by prefix', () => {
  expect(wantsCut(['hero'], 'hero')).toBe(true);
  expect(wantsCut(['hero'], 'hero-mobile')).toBe(true);
  expect(wantsCut(['full'], 'hero')).toBe(false);
  expect(wantsCut(['beats'], 'beat-spec-mobile')).toBe(true);
  expect(wantsCut(['hero'], 'beat-spec')).toBe(false);
});

test('clipSource: a site file back to its family dir and cut name (for the shotlist)', () => {
  expect(clipSource('a/buildd-demo-v6a-beat-spec-mobile.mp4')).toEqual({ dir: 'a', cut: 'beat-spec-mobile' });
  expect(clipSource('l/buildd-demo-v6l-hero-mobile.mp4')).toEqual({ dir: 'l', cut: 'hero-mobile' });
  expect(clipSource('a/buildd-demo-v6a.mp4')).toEqual({ dir: 'a', cut: 'full' });
});

test('crfLadder: steps up from the start in twos, to a ceiling', () => {
  expect(crfLadder(24, 30)).toEqual([24, 26, 28, 30]);
});

describe('publishDir: the site set is swapped in whole, never half-written', () => {
  const fresh = () => {
    const root = mkdtempSync(join(tmpdir(), 'site-'));
    const site = join(root, 'site');
    mkdirSync(site);
    writeFileSync(join(site, 'old.mp4'), 'old');
    return { root, site };
  };
  test('a build that throws leaves the previous set untouched, and no temp dir behind', () => {
    const { root, site } = fresh();
    expect(() => publishDir(site, (tmp) => { writeFileSync(join(tmp, 'half.mp4'), 'x'); throw new Error('render died'); })).toThrow('render died');
    expect(readdirSync(site)).toEqual(['old.mp4']);
    expect(readdirSync(root)).toEqual(['site']);
  });
  test('a finished build replaces the set in one swap', () => {
    const { root, site } = fresh();
    publishDir(site, (tmp) => writeFileSync(join(tmp, 'new.mp4'), 'new'));
    expect(readdirSync(site)).toEqual(['new.mp4']);
    expect(readFileSync(join(site, 'new.mp4'), 'utf8')).toBe('new');
    expect(readdirSync(root)).toEqual(['site']);
  });
  test('works when the site dir does not exist yet', () => {
    const root = mkdtempSync(join(tmpdir(), 'site-'));
    publishDir(join(root, 'site'), (tmp) => writeFileSync(join(tmp, 'a'), 'a'));
    expect(existsSync(join(root, 'site', 'a'))).toBe(true);
  });
});

test('mergeShotlists: a beats-only run keeps the full cut', () => {
  const merged = mergeShotlists([{ name: 'full' }, { name: 'hero' }, { name: 'beat-ask', v: 1 }] as any[], [{ name: 'beat-ask', v: 2 }] as any[]);
  expect(merged.map((c: any) => [c.name, c.v])).toEqual([['full', undefined], ['hero', undefined], ['beat-ask', 2]]);
});

describe('aim', () => {
  const look = beatLook();
  const phone = { width: 1170, height: 2532 };
  test('a tall phone region in a wide beat frame is framed (zoom < 1), not blown up to the frame width', () => {
    const region = { x: 0.06, y: 0.3, w: 0.88, h: 0.45 };
    const k = aim(look, phone, region, 1.1);
    expect(k.zoom).toBeLessThan(1);
    expect((1280 / 390) * k.zoom).toBeGreaterThanOrEqual(1.4 - 1e-9);
    // The region's centre lands near the frame's middle.
    const p = placeScreen(phone, { width: 1280, height: 720 }, k);
    const mid = p.y + (region.y + region.h / 2) * phone.height * p.scale;
    expect(Math.abs(mid - 360)).toBeLessThan(40);
  });
  test('the film never frames: its zoom stays at 1 or more', () => {
    const film = { ...look, beat: false, minPx: 0, reserve: 0, tight: 1, frame: { width: 1920, height: 1080 } };
    expect(aim(film, phone, { x: 0.06, y: 0.3, w: 0.88, h: 0.45 }, 1.1).zoom).toBeGreaterThanOrEqual(1);
  });
});
