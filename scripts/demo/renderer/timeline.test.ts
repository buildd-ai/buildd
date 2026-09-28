import { describe, expect, test } from 'bun:test';
import { fadeOutAt, cameraAt, captionOpacity, captionsAt, cutDuration, ease, frameCount, layersAt, placeScreen, soundCues, stillAt, tapAt, type Cut, type Shot } from './timeline';

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
      { type: 'key', at: 1 }, { type: 'key', at: 1.5 }, { type: 'click', at: 6 }, { type: 'chime', at: 7 },
    ]);
  });
});

test('the closing fade covers only the last seconds, and never a loop', () => {
  const c = cut([shot('a', 4)], { fadeOut: 1 });
  expect(fadeOutAt(c, 3)).toBe(0);
  expect(fadeOutAt(c, 4.5)).toBe(1);
  expect(fadeOutAt({ ...c, loop: true }, 3.9)).toBe(0);
});
