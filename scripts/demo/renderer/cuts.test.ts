import { describe, expect, test } from 'bun:test';
import { fullCut, heroLoop, type Stills } from './cuts';
import { cutDuration, type ShotImage } from './timeline';
import { pngSize, stillsFrom } from './render';

const fake: Stills = {
  img: (step, viewport = 'desktop', at = 0): ShotImage => ({ src: `/shots/${step}-${viewport}.png`, at, width: viewport === 'phone' ? 1170 : 2880, height: viewport === 'phone' ? 2532 : 1620 }),
  typing: (step) => Array.from({ length: 16 }, (_, i) => ({ src: `/shots/${step}-type-${i}.png`, at: 0, width: 2880, height: 1620 })),
};

const captionsOf = (c: ReturnType<typeof fullCut>) => c.shots.flatMap((s) => {
  if (!s.caption) return [];
  return typeof s.caption === 'string' ? [{ text: s.caption, span: s.dur }] : s.caption.map((x, i, all) => ({ text: x.text, span: (all[i + 1]?.at ?? s.dur) - x.at }));
});

describe('the full cut', () => {
  const cut = fullCut(fake);
  test('runs 40 to 50 seconds', () => {
    expect(cutDuration(cut)).toBeGreaterThanOrEqual(40);
    expect(cutDuration(cut)).toBeLessThanOrEqual(50);
  });
  test('holds every shot at least 3.5s, and gives every caption at least 2.5s to be read', () => {
    for (const s of cut.shots) expect(s.dur).toBeGreaterThanOrEqual(3.5);
    for (const c of captionsOf(cut)) expect(c.span).toBeGreaterThanOrEqual(2.5);
  });
  test('captions are short and plain: no em dashes, no "X, not Y"', () => {
    for (const { text } of captionsOf(cut)) {
      expect(text).not.toMatch(/[—–]/);
      expect(text).not.toMatch(/,\s*not\b/i);
      expect(text.length).toBeLessThanOrEqual(52);
    }
  });
  test('every tap lands inside its shot and on the image', () => {
    for (const s of cut.shots) for (const t of s.taps ?? []) {
      expect(t.at).toBeGreaterThan(0);
      expect(t.at).toBeLessThan(s.dur);
      for (const v of [t.x, t.y]) { expect(v).toBeGreaterThan(0); expect(v).toBeLessThan(1); }
    }
  });
  test('the CI-failure beat is gone; the visual review is in', () => {
    const ids = cut.shots.map((s) => s.id);
    expect(ids).not.toContain('ci');
    expect(ids).toEqual(expect.arrayContaining(['screens', 'review', 'done']));
  });
});

describe('the hero loop', () => {
  test('is exactly 16 seconds, loops, and has no captions', () => {
    const hero = heroLoop(fake);
    expect(hero.loop).toBe(true);
    expect(cutDuration(hero)).toBe(16);
    expect(hero.captions).toBe(false);
  });
});

describe('render helpers', () => {
  test('pngSize reads the IHDR', () => {
    const b = new Uint8Array(24);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(b.buffer).setUint32(16, 2880);
    new DataView(b.buffer).setUint32(20, 1620);
    expect(pngSize(b)).toEqual({ width: 2880, height: 1620 });
    expect(() => pngSize(new Uint8Array(24))).toThrow();
  });
  test('stillsFrom fails loudly on a step the storyboard never shot', () => {
    const st = stillsFrom({ steps: [{ id: 'a', files: { dark: 'a-dark.png' } }] }, '/nonexistent', 'dark');
    expect(() => st.img('b')).toThrow(/no step "b"/);
    expect(() => st.img('a')).toThrow(/missing still/);
    expect(() => st.img('a', 'phone')).toThrow(/no phone-dark still/);
  });
});
