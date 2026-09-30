import { describe, expect, test } from 'bun:test';
import { captionPlace, captionBox, captionReserve, burstAt, burstEnd, fleetAt, focus, maskAt, spotAt, fadeOutAt, cameraAt, captionOpacity, captionsAt, cutDuration, ease, frameCount, layersAt, placeScreen, soundCues, stillAt, tapAt, type Cut, type Shot } from './timeline';

const img = (src: string, at = 0) => ({ src, at, width: 2880, height: 1620 });
const shot = (id: string, dur: number, extra: Partial<Shot> = {}): Shot => ({ id, layout: 'screen', dur, images: [img(`${id}.png`)], ...extra });
const cut = (shots: Shot[], extra: Partial<Cut> = {}): Cut => ({ name: 't', width: 1920, height: 1080, fps: 30, fade: 0.5, shots, ...extra });

describe('ease', () => {
  test('starts and ends at rest, and is monotonic', () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    let prev = 0;
    for (let u = 0.05; u <= 1; u += 0.05) { expect(ease(u)).toBeGreaterThanOrEqual(prev); prev = ease(u); }
  });
});

describe('layersAt', () => {
  const c = cut([shot('a', 4), shot('b', 5), shot('c', 3)]);
  test('a cut runs the sum of its holds plus one closing fade', () => {
    expect(cutDuration(c)).toBe(12.5);
    expect(frameCount(c)).toBe(375);
  });
  test('mid-hold only one shot is on, fully', () => {
    expect(layersAt(c, 2)).toEqual([{ index: 0, local: 2, opacity: 1 }]);
  });
  test('at a cut the next shot fades in over the last, which keeps its clock', () => {
    const l = layersAt(c, 4.25);
    expect(l.map((x) => x.index)).toEqual([0, 1]);
    expect(l[0]).toMatchObject({ local: 4.25, opacity: 1 });
    expect(l[1].opacity).toBeCloseTo(0.5, 5);
  });
  test('a loop is exactly its holds long, and its last fade is into the first shot at rest', () => {
    const loop = cut([shot('a', 4), shot('b', 4)], { loop: true });
    expect(cutDuration(loop)).toBe(8);
    const end = layersAt(loop, 8 - 1e-6);
    expect(end[end.length - 1].index).toBe(0);
    expect(end[end.length - 1].local).toBe(0);
    expect(end[end.length - 1].opacity).toBeCloseTo(1, 3);
    expect(layersAt(loop, 0)).toEqual([{ index: 0, local: 0, opacity: 1 }]);
  });
});

describe('cameraAt + placeScreen', () => {
  test('no keys is the whole image, fit to width', () => {
    const p = placeScreen({ width: 2880, height: 1620 }, { width: 1920, height: 1080 }, cameraAt(undefined, 0.5));
    expect(p).toEqual({ x: 0, y: 0, scale: 1920 / 2880 });
  });
  test('keys interpolate with easing and hold past the ends', () => {
    const keys = [{ at: 0, cx: 0.5, cy: 0.5, zoom: 1 }, { at: 1, cx: 0.7, cy: 0.3, zoom: 1.2 }];
    expect(cameraAt(keys, -1)).toEqual({ cx: 0.5, cy: 0.5, zoom: 1 });
    expect(cameraAt(keys, 0.5).zoom).toBeCloseTo(1.1, 5);
    expect(cameraAt(keys, 2)).toEqual({ cx: 0.7, cy: 0.3, zoom: 1.2 });
  });
  test('a zoomed focus near an edge is clamped so the image still covers the frame', () => {
    const p = placeScreen({ width: 2880, height: 1620 }, { width: 1920, height: 1080 }, { cx: 1, cy: 1, zoom: 1.5 });
    const w = 2880 * p.scale, h = 1620 * p.scale;
    expect(p.x + w).toBeCloseTo(1920, 5);
    expect(p.y + h).toBeCloseTo(1080, 5);
  });
  test('zoom below 1 hangs the shot as a window from the top, centred across', () => {
    const p = placeScreen({ width: 2880, height: 1620 }, { width: 1920, height: 1080 }, { cx: 0.5, cy: 0.5, zoom: 0.8 });
    expect(p.scale).toBeCloseTo((1920 / 2880) * 0.8, 6);
    expect(p.x).toBeCloseTo((1920 - 2880 * p.scale) / 2, 6);
    expect(p.y).toBe(40);
  });
  test('a tall page pans: cy picks the band that is centred', () => {
    const tall = { width: 2880, height: 6000 };
    const top = placeScreen(tall, { width: 1920, height: 1080 }, { cx: 0.5, cy: 0, zoom: 1 });
    const mid = placeScreen(tall, { width: 1920, height: 1080 }, { cx: 0.5, cy: 0.5, zoom: 1 });
    expect(top.y).toBe(0);
    expect(mid.y).toBeCloseTo(540 - 3000 * (1920 / 2880), 5);
  });
});

describe('stillAt', () => {
  const images = [img('a'), img('b', 2), img('c', 2.05)];
  test('the latest still at or before local is up; the one before fades out under it', () => {
    expect(stillAt(images, 1)).toEqual({ src: 'a', alpha: 1, index: 0 });
    const s = stillAt(images.slice(0, 2), 2.1);
    expect(s.src).toBe('b');
    expect(s.prev).toBe('a');
    expect(s.alpha).toBeGreaterThan(0);
    expect(s.alpha).toBeLessThan(1);
  });
  test('a still marked fade 0 cuts in at its time', () => {
    expect(stillAt([img('a'), { ...img('b', 2), fade: 0 }], 2.01)).toEqual({ src: 'b', alpha: 1, index: 1 });
  });
  test('stills closer together than a fade (typing) cut, never blend', () => {
    expect(stillAt(images, 2.06)).toEqual({ src: 'c', alpha: 1, index: 2 });
  });
});

describe('captions and taps', () => {
  test('a caption waits for the shot to land, holds, and leaves with the crossfade', () => {
    const s = { dur: 5, caption: 'Hi' };
    expect(captionOpacity(s, 0.2, 0.5)).toBe(0);
    expect(captionOpacity(s, 2.5, 0.5)).toBe(1);
    expect(captionOpacity(s, 5.25, 0.5)).toBe(0);
    expect(captionOpacity({ dur: 5 }, 2.5, 0.5)).toBe(0);
  });
  test('several captions hand over: the first is gone before the second lands', () => {
    const s = { dur: 8, caption: [{ at: 0, text: 'one' }, { at: 4, text: 'two' }] };
    expect(captionsAt(s, 2, 0.5).map((c) => c.opacity)).toEqual([1, 0]);
    const at = captionsAt(s, 4.45, 0.5);
    expect(at[0].opacity).toBe(0);
    expect(captionsAt(s, 6, 0.5).map((c) => c.opacity)).toEqual([0, 1]);
  });
  test('a tap marker lives briefly after its time', () => {
    const taps = [{ at: 2, x: 0.4, y: 0.6 }];
    expect(tapAt(taps, 1.9)).toBeNull();
    expect(tapAt(taps, 2.3)).toMatchObject({ x: 0.4, y: 0.6 });
    expect(tapAt(taps, 3.5)).toBeNull();
  });
  test('sound cues sit on the cut clock, sorted', () => {
    const c = cut([shot('a', 4, { keys: [1, 1.5] }), shot('b', 4, { taps: [{ at: 2, x: 0, y: 0 }], chime: 3 })]);
    expect(soundCues(c)).toEqual([
      { type: 'key', at: 1 }, { type: 'key', at: 1.5 }, { type: 'tap', at: 6 }, { type: 'chime', at: 7 },
    ]);
  });
});

test('the closing fade covers only the last seconds, and never a loop', () => {
  const c = cut([shot('a', 4)], { fadeOut: 1 });
  expect(fadeOutAt(c, 3)).toBe(0);
  expect(fadeOutAt(c, 4.5)).toBe(1);
  expect(fadeOutAt({ ...c, loop: true }, 3.9)).toBe(0);
});

const R = (x: number, y: number, w = 0.1, h = 0.1) => ({ x, y, w, h });

describe('spotAt', () => {
  const keys = [{ at: 1, rects: [R(0.1, 0.1)], dim: 0.65 }, { at: 3, rects: [R(0.5, 0.5)], dim: 0.65 }, { at: 5, rects: [R(0, 0), R(0.5, 0)], dim: 0.65 }];
  test('off before the first key, then eases in', () => {
    expect(spotAt(keys, 0.5).dim).toBe(0);
    expect(spotAt(keys, 1.3).dim).toBeGreaterThan(0);
    expect(spotAt(keys, 2).dim).toBe(0.65);
  });
  test('same count: the hole glides between keys', () => {
    const mid = spotAt(keys, 3.3).rects[0];
    expect(mid.x).toBeGreaterThan(0.1);
    expect(mid.x).toBeLessThan(0.5);
    expect(spotAt(keys, 4).rects[0]).toEqual(R(0.5, 0.5));
  });
  test('a different count dips the dim through zero instead of popping', () => {
    expect(spotAt(keys, 5.3).dim).toBeLessThan(0.1);
    expect(spotAt(keys, 6).rects).toHaveLength(2);
  });
});

describe('maskAt', () => {
  test('covers until its time, then fades', () => {
    const m = { rect: R(0, 0), until: 2 };
    expect(maskAt(m, 1)).toEqual({ opacity: 1, left: 0 });
    expect(maskAt(m, 2.2).opacity).toBeLessThan(1);
    expect(maskAt(m, 3).opacity).toBe(0);
  });
  test('a wipe keeps it opaque and eats it from the left', () => {
    const m = { rect: R(0, 0), until: 2, wipe: 1 };
    expect(maskAt(m, 2.5)).toMatchObject({ opacity: 1 });
    expect(maskAt(m, 2.5).left).toBeCloseTo(0.5, 5);
    expect(maskAt(m, 3.1).opacity).toBe(0);
  });
  test('with `from`, it appears then, and with no `until` it stays to the end', () => {
    const m = { rect: R(0, 0), from: 1 };
    expect(maskAt(m, 0.5).opacity).toBe(0);
    expect(maskAt(m, 4, 5).opacity).toBe(1);
  });
});

describe('burst and fleet', () => {
  const b = { origin: { x: 0.5, y: 0.1 }, tiles: [R(0, 0), R(0.3, 0), R(0.6, 0)], from: 0.5, stagger: 0.2, dur: 1 };
  test('tiles leave in turn and all have landed by burstEnd', () => {
    expect(burstAt(b, 0, 0.5)).toBe(0);
    expect(burstAt(b, 0, 1)).toBeGreaterThan(burstAt(b, 2, 1));
    expect(burstEnd(b)).toBeCloseTo(1.9, 5);
    for (let i = 0; i < 3; i++) expect(burstAt(b, i, burstEnd(b))).toBe(1);
  });
  test('the abstract fleet lights live slots one at a time and counts them', () => {
    const f = { runners: [{ name: 'a', sub: '', slots: [{ label: 'x', color: '#000' }, null] }, { name: 'b', sub: '', slots: [{ label: 'y', color: '#000' }, { label: 'z', color: '#000' }] }], from: 1, stagger: 0.5, grow: 0.8, total: 4 };
    expect(fleetAt(f, 0.5)).toEqual({ bars: [0, 0, 0], live: 0 });
    expect(fleetAt(f, 1.6).live).toBe(2);
    expect(fleetAt(f, 5)).toEqual({ bars: [1, 1, 1], live: 3 });
  });
  test('sound: a burst patters on every third tile, and each fleet bar plucks', () => {
    const c = cut([shot('board', 5, { burst: b }), shot('fleet', 5, { fleet: { runners: [{ name: 'a', sub: '', slots: [{ label: 'x', color: '#000' }] }], from: 1, stagger: 0.5, grow: 0.8, total: 2 } })]);
    const plucks = soundCues(c).filter((q) => q.type === 'pluck');
    expect(plucks.map((p) => p.at)).toEqual([1.5, 6]);
  });
});

test('focus frames a rect and never zooms out past fit-width', () => {
  const k = focus(R(0.25, 0.25, 0.5, 0.2), { width: 2880, height: 1620 }, { width: 1920, height: 1080 }, 1);
  expect(k.cx).toBeCloseTo(0.5, 6);
  expect(k.zoom).toBeCloseTo(2, 6);
  expect(focus(R(0, 0, 1, 1), { width: 2880, height: 1620 }, { width: 1920, height: 1080 }).zoom).toBe(1);
});

describe('captionPlace', () => {
  const frame = { width: 1920, height: 1080, captionSize: 32 };
  const base = { id: 's', layout: 'screen' as const, dur: 5, images: [{ src: 'a', at: 0, width: 2880, height: 1620 }], caption: 'You confirm the mission.' };
  test('bottom when nothing is under it; top when a control sits where the bottom caption lands', () => {
    expect(captionPlace(frame, base)).toBe('bottom');
    const b = captionBox(frame, base.caption, 'bottom');
    const control = { x: (b.x + 10) / 1920, y: (b.y + 10) / 1080, w: 0.05, h: 0.02 };
    expect(captionPlace(frame, { ...base, controls: [control] })).toBe('top');
  });
  test('a forced placement wins', () => {
    expect(captionPlace(frame, { ...base, captionAt: 'top' })).toBe('top');
  });
  test('focus with a reserve keeps the rect above the caption band', () => {
    const img = { width: 2880, height: 1620 };
    const r = { x: 0.3, y: 0.6, w: 0.3, h: 0.3 };
    const k = focus(r, img, frame, 1.1, 0, captionReserve());
    const p = placeScreen(img, frame, k);
    const bottom = p.y + (r.y + r.h) * img.height * p.scale;
    expect(bottom).toBeLessThanOrEqual(1080 - captionReserve() + 1);
  });
});
