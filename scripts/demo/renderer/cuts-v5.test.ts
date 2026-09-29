import { describe, expect, test } from 'bun:test';
import type { Stills } from './cuts';
import { v5Film, v5Hero, type V5 } from './cuts-v5';
import { cutDuration, soundCues, type Rect, type Shot } from './timeline';
import { lowEnergyShare, synthesize } from './audio';

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const fake: Stills = {
  img: (step, viewport = 'desktop', at = 0) => ({ src: `/shots/${step}-${viewport}.png`, at, width: viewport === 'phone' ? 1170 : 2880, height: viewport === 'phone' ? 2532 : 1620 }),
  typing: (step) => Array.from({ length: 17 }, (_, i) => ({ src: `/shots/${step}-type-${i}.png`, at: 0, width: 2880, height: 1620 })),
  boxes: (_step, target) => target === 'board-tile' ? Array.from({ length: 12 }, (_, i) => R(0.06 + (i % 3) * 0.33, 0.4 + Math.floor(i / 3) * 0.1, 0.3, 0.08))
    : target === 'tool-call-row' || target === 'standing-rule' ? [R(0.3, 0.2, 0.47, 0.04), R(0.3, 0.24, 0.47, 0.04), R(0.3, 0.28, 0.47, 0.04)]
    : target === 'visual-review-thumb' ? [R(0.7, 0.3, 0.04, 0.05), R(0.75, 0.3, 0.1, 0.05), R(0.7, 0.36, 0.04, 0.05), R(0.75, 0.36, 0.1, 0.05)]
    : [R(0.3, 0.3, 0.4, 0.2)],
  box: (step, target, index = 0, viewport) => fake.boxes(step, target, viewport)[index] ?? R(0.3, 0.3, 0.4, 0.2),
  boxAttrs: () => Array.from({ length: 8 }, (_, i) => ({ rect: R(0.18, 0.3 + i * 0.02, 0.2, 0.02), status: [1, 4].includes(i) ? 'idle' : 'running' })),
  text: () => ({ rects: [R(0.3, 0.3, 0.17, 0.01)], block: R(0.3, 0.29, 0.44, 0.06) }),
};

const captions = (shots: Shot[]) => shots.flatMap((s) => !s.caption ? [] : typeof s.caption === 'string'
  ? [{ text: s.caption, span: s.dur }]
  : s.caption.map((c, i, all) => ({ text: c.text, span: (all[i + 1]?.at ?? s.dur) - c.at })));
const inside = (r: Rect) => r.x >= -0.05 && r.y >= -0.05 && r.x + r.w <= 1.05 && r.y + r.h <= 1.05;

for (const [variant, theme, lo, hi] of [['a', 'dark', 44, 50], ['b', 'light', 44, 50], ['c', 'light', 33, 40]] as const) {
  describe(`v5${variant}`, () => {
    const film = v5Film(fake, variant as V5, theme);
    test(`runs ${lo} to ${hi} seconds in the ${theme} theme`, () => {
      expect(film.theme).toBe(theme);
      expect(cutDuration(film)).toBeGreaterThanOrEqual(lo);
      expect(cutDuration(film)).toBeLessThanOrEqual(hi);
    });
    test('no shot under 4s, crossfades of 0.8s, every caption on screen at least 2.5s', () => {
      for (const s of film.shots) expect(s.dur).toBeGreaterThanOrEqual(4);
      expect(film.fade).toBe(0.8);
      for (const c of captions(film.shots)) expect(c.span).toBeGreaterThanOrEqual(2.5);
    });
    test('captions stay short and plain', () => {
      for (const { text } of captions(film.shots)) {
        expect(text).not.toMatch(/[—–]/);
        expect(text).not.toMatch(/,\s*not\b/i);
        expect(text.length).toBeLessThanOrEqual(52);
      }
    });
    test('the spotlight dims the rest to roughly a third, and every box sits on its still', () => {
      for (const s of film.shots) {
        for (const k of s.spot ?? []) { expect(k.dim).toBeLessThanOrEqual(0.75); for (const r of k.rects) expect(inside(r)).toBe(true); }
        for (const m of s.masks ?? []) expect(inside(m.rect)).toBe(true);
      }
    });
    test('the Board fans out of the mission, and the fleet lights up one row at a time', () => {
      const board = film.shots.find((s) => s.id === 'board')!;
      expect(board.burst?.tiles.length).toBe(12);
      const fleet = film.shots.find((s) => s.id === 'fleet')!;
      if (variant === 'c') expect(fleet.layout).toBe('fleet');
      else {
        const lit = (fleet.masks ?? []).filter((m) => m.wipe).map((m) => m.until!);
        expect(lit).toHaveLength(6);
        for (let i = 1; i < lit.length; i++) expect(lit[i]).toBeGreaterThan(lit[i - 1]);
      }
    });
    test('the soundtrack has nothing heavy below 150 Hz', () => {
      expect(lowEnergyShare(synthesize(soundCues(film), cutDuration(film)))).toBeLessThan(0.005);
    });
    test('writes the review stills', () => {
      const want = variant === 'c' ? ['ask', 'fanout-mid', 'fleet-mid', 'review'] : ['chat-read', 'rule-origin', 'fanout-mid', 'fleet-mid'];
      for (const k of want) expect(film.keyStills?.[k]).toBeGreaterThan(0);
    });
    test('a 16s seamless hero loop with no captions', () => {
      const hero = v5Hero(fake, variant as V5, theme);
      expect(hero.loop).toBe(true);
      expect(cutDuration(hero)).toBe(16);
      expect(hero.captions).toBe(false);
      for (const s of hero.shots) expect(s.dur).toBeGreaterThanOrEqual(4);
    });
  });
}

test('no spotlight key repeats a hole (even-odd fill would cancel it)', () => {
  for (const v of ['a', 'b', 'c'] as const) for (const sh of v5Film(fake, v, 'dark').shots) for (const k of sh.spot ?? []) {
    const seen = k.rects.filter((r) => r.w > 0).map((r) => JSON.stringify(r));
    expect(new Set(seen).size).toBe(seen.length);
  }
});
test('the simple cut is the six-beat story', () => {
  expect(v5Film(fake, 'c', 'light').shots.map((s) => s.id)).toEqual(['ask', 'board', 'fleet', 'question', 'review', 'done']);
});
test('the rule shot marks Maya’s own words before the card comes in', () => {
  const rule = v5Film(fake, 'a', 'dark').shots.find((s) => s.id === 'rule')!;
  const cardMask = rule.masks!.find((m) => m.until !== undefined)!;
  expect(rule.marks![0].from).toBeLessThan(cardMask.until!);
});
