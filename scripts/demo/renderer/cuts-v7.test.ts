import { describe, expect, test } from 'bun:test';
import type { Stills } from './cuts';
import { CHAPTERS, V7_LINES, timeToVoice, v7Captioned, v7Chapters, v7Film } from './cuts-v7';
import { captionCollisions } from './cuts-v6';
import { v7SiteFiles } from './render';
import { cutDuration, shotStarts, soundCues, type Rect } from './timeline';

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const BOXES: Record<string, Rect[]> = {
  'chat-composer': [R(0.25, 0.42, 0.5, 0.1)],
  'approval-draft-criteria': [R(0.3, 0.45, 0.35, 0.16)],
  'kit-approval-confirm': [R(0.3, 0.66, 0.06, 0.03)],
  'home-fleet': [R(0.3, 0.35, 0.5, 0.25)],
  'question-option': [R(0.05, 0.4, 0.9, 0.1), R(0.05, 0.52, 0.9, 0.08)],
  '[data-loop-status]': [R(0.25, 0.12, 0.1, 0.02)],
  'loop-history': [R(0.05, 0.3, 0.45, 0.15)],
  'deck-looks-right': [R(0.503, 0.883, 0.261, 0.07)],
  'visual-review-deck': [R(0.1, 0.05, 0.8, 0.85)],
};
const TEXT: Record<string, Rect> = {
  'The invoice table overflows on phones.': R(0.3, 0.42, 0.25, 0.012),
  'Fits a 390px screen': R(0.32, 0.455, 0.12, 0.012),
  'No sideways scroll on /invoices': R(0.32, 0.505, 0.18, 0.012),
  'Phone screenshot approved': R(0.32, 0.555, 0.15, 0.012),
};
const fake: Stills = {
  img: (step, viewport = 'desktop', at = 0) => ({ src: `/shots/${step}-${viewport}.png`, at, width: viewport === 'phone' ? 1170 : 2880, height: viewport === 'phone' ? 2532 : 1620 }),
  typing: (step) => Array.from({ length: 15 }, (_, i) => ({ src: `/shots/${step}-type-${i}.png`, at: 0, width: 2880, height: 1620 })),
  boxes: (_s, target) => BOXES[target] ?? [R(0.3, 0.3, 0.4, 0.2)],
  box: (s, target, index = 0, vp) => fake.boxes(s, target, vp)[index] ?? R(0.3, 0.3, 0.4, 0.2),
  boxAttrs: () => [0, 1, 2].map((i) => ({ rect: R(0.32, 0.4 + i * 0.05, 0.4, 0.04), status: 'running' })),
  text: (_s, phrase) => ({ rects: [TEXT[phrase] ?? R(0.3, 0.3, 0.2, 0.01)], block: TEXT[phrase] ?? R(0.3, 0.3, 0.2, 0.01) }),
  file: (path) => ({ src: `/shots/${path}`, at: 0, width: 780, height: 1688 }),
};
const spoken = [2.18, 3.07, 5.27, 3.8, 3.11].map((seconds, i) => ({ file: `/tmp/v${i}.wav`, seconds }));

describe('v7 chapters', () => {
  const ch = v7Chapters(fake);
  test('hook, three chapters each opened by its card, then the recap', () => {
    expect(ch.map((c) => c[0].id)).toEqual(['hook', 'ch1', 'ch2', 'ch3', 'recap']);
    for (const [i, c] of ch.slice(1, 4).entries()) expect((c[0].motion as any).title).toBe(CHAPTERS[i]);
    expect(ch[3].map((x) => x.id)).toEqual(['ch3', 'red', 'attempt2', 'green', 'beforeAfter', 'looks']);
  });
  test('one gentle tone, on green; the rest of the sound is clicks', () => {
    const film = v7Film(fake, spoken);
    const cues = soundCues(film);
    expect(cues.filter((c) => c.type === 'chime')).toHaveLength(1);
    const green = shotStarts(film)[film.shots.findIndex((x) => x.id === 'green')];
    expect(cues.find((c) => c.type === 'chime')!.at).toBeGreaterThan(green);
    expect(cues.filter((c) => c.type === 'pluck')).toHaveLength(0);
  });
  test('nothing in the film says "checkout"', () => {
    const film = v7Film(fake, spoken), cap = v7Captioned(fake, spoken);
    const words = JSON.stringify([film.shots.map((s) => [s.caption, s.motion]), cap.shots.map((s) => [s.caption, s.motion]), V7_LINES]);
    expect(words.toLowerCase()).not.toContain('checkout');
  });
});

describe('timeToVoice', () => {
  test('each line starts 0.3s into its chapter, and no chapter is shorter than its line plus a tail', () => {
    const chapters = v7Chapters(fake);
    const { shots, voice } = timeToVoice(chapters, spoken);
    const starts = shotStarts({ shots });
    let k = 0;
    chapters.forEach((ch, i) => {
      const chStart = starts[k];
      const len = shots.slice(k, k + ch.length).reduce((a, s) => a + s.dur, 0);
      expect(voice[i].at).toBeCloseTo(chStart + 0.3, 5);
      expect(len).toBeGreaterThanOrEqual(0.3 + spoken[i].seconds + 0.8 - 1e-9);
      k += ch.length;
    });
  });
  test('a long line stretches the chapter\'s last shot, never cuts the voice', () => {
    const long = spoken.map((s, i) => (i === 0 ? { ...s, seconds: 9 } : s));
    const { shots } = timeToVoice(v7Chapters(fake), long);
    expect(shots[0].dur).toBeGreaterThanOrEqual(0.3 + 9 + 0.8 - 1e-9);
  });
});

describe('v7 cuts', () => {
  const film = v7Film(fake, spoken);
  test('about 50s, voiced, no captions, ≤8MB cap, dips between shots', () => {
    expect(cutDuration(film)).toBeGreaterThanOrEqual(45);
    expect(cutDuration(film)).toBeLessThanOrEqual(58);
    expect(film.voice).toHaveLength(5);
    expect(film.captions).toBe(false);
    expect(film.maxBytes).toBe(8 * 1024 * 1024);
    expect(film.dip).toBe(true);
  });
  test('the captioned cut is silent and carries each chapter\'s line once, clear of lit elements', () => {
    const cap = v7Captioned(fake, spoken);
    expect(cap.voice).toBeUndefined();
    expect(cap.shots.filter((s) => s.caption).map((s) => s.caption)).toEqual(V7_LINES.slice(1, 4));
    expect(captionCollisions(cap)).toEqual([]);
  });
});

test('v7SiteFiles: the published v7 set is the two films and their posters', () => {
  expect(v7SiteFiles().map(([, to]) => to).sort()).toEqual(['captioned-poster.jpg', 'captioned.mp4', 'full-poster.jpg', 'full.mp4']);
});
