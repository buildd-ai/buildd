import { describe, expect, test } from 'bun:test';
import type { Stills } from './cuts';
import { mergeShotlists, seamlessLoopFilter, siteFiles } from './render';
import { aim, beatLook, RULE_MIN_PX, askButtonShots, BEATS, beatLoopSeconds, captionCollisions, fanoutEscapes, v6aBeats, v6aFilm, v6aHero, v6xFilm, v6xHero } from './cuts-v6';
import { placeScreen, burstPose, captionBox, captionPlace, cutDuration, keepClear, overlap, soundCues, type Rect } from './timeline';
import { lowEnergyShare, synthesize } from './audio';
import { fleetRows, motionCues, splitAt, typedChars } from './motion-model';

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
};
const fake: Stills = {
  img: (step, viewport = 'desktop', at = 0) => ({ src: `/shots/${step}-${viewport}.png`, at, width: viewport === 'phone' ? 1170 : 2880, height: viewport === 'phone' ? 2532 : 1620 }),
  typing: (step) => Array.from({ length: 17 }, (_, i) => ({ src: `/shots/${step}-type-${i}.png`, at: 0, width: 2880, height: 1620 })),
  boxes: (_s, target) => BOXES[target] ?? [R(0.3, 0.3, 0.4, 0.2)],
  box: (s, target, index = 0, vp) => fake.boxes(s, target, vp)[index] ?? R(0.3, 0.3, 0.4, 0.2),
  boxAttrs: () => Array.from({ length: 8 }, (_, i) => ({ rect: R(0.18, 0.3 + i * 0.02, 0.2, 0.02), status: [1, 4].includes(i) ? 'idle' : 'running' })),
  text: () => ({ rects: [R(0.3, 0.3, 0.17, 0.01)], block: R(0.3, 0.29, 0.44, 0.06) }),
  file: (path) => ({ src: `/shots/${path}`, at: 0, width: 780, height: 2110 }),
};

describe('v6a', () => {
  const film = v6aFilm(fake);
  test('keeps the pace: 44-50s, no shot under 4s, 0.8s crossfades, dark', () => {
    expect(cutDuration(film)).toBeGreaterThanOrEqual(44);
    expect(cutDuration(film)).toBeLessThanOrEqual(50);
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
    for (const shot of film.shots.filter((x) => x.layout === 'screen' && x.caption && !x.burst)) expect(captionPlace(film, shot)).toBe('bottom');
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
  test('the soundtrack is soft: nothing below 150 Hz, and tiles tick instead of ringing', () => {
    expect(lowEnergyShare(synthesize(soundCues(film), cutDuration(film)))).toBeLessThan(0.005);
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
  test('a 16s hero loop', () => {
    expect(cutDuration(v6xHero(fake))).toBe(16);
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
    expect(BEATS).toEqual(['ask', 'remember', 'fanout', 'fleet', 'decide', 'proof', 'done']);
    expect(LOOKS[0].beats.map((c) => c.name)).toEqual(BEATS.map((b) => `beat-${b}`));
    expect(LOOKS[1].beats.map((c) => c.name)).toEqual(BEATS.map((b) => `beat-${b}-mobile`));
  });
  test('every film shot lands in exactly one beat', () => {
    const used = LOOKS[0].beats.flatMap((c) => c.shots.map((s) => s.id));
    expect(used.sort()).toEqual(film.shots.map((s) => s.id).sort());
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

test('v6x hero comes in both themes', () => {
  expect(v6xHero(fake).theme).toBe('dark');
  expect(v6xHero(fake, 'light').theme).toBe('light');
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
  const clips = [...BEATS.flatMap((b) => [b, `${b}-mobile`, `${b}-light`, `${b}-light-mobile`]), 'hero', 'hero-light', 'full'];
  const want = clips.flatMap((b) => [`${b}.webm`, `${b}.mp4`, `${b}-poster.jpg`]).sort();
  expect(names).toEqual(want);
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
