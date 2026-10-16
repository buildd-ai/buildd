import { describe, expect, test } from 'bun:test';
import type { Stills } from './cuts';
import { V7_LINES } from './cuts-v7';
import { V8_LINES, v8Captioned, v8Chapters, v8Film } from './cuts-v8';
import { captionCollisions } from './cuts-v6';
import { FAMILIES, v8SiteFiles } from './render';
import { cutDuration, type Rect } from './timeline';

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
// The Health > Runners shot: the runner's group (two rows), then "Your sessions" (one row).
const BOXES: Record<string, Rect[]> = {
  'approval-draft-criteria': [R(0.3, 0.45, 0.35, 0.16)],
  'kit-approval-confirm': [R(0.3, 0.66, 0.06, 0.03)],
  'running-now': [R(0.41, 0.14, 0.45, 0.25)],
  'running-now-group': [R(0.41, 0.14, 0.45, 0.13), R(0.41, 0.3, 0.45, 0.08)],
  'running-now-row': [R(0.41, 0.17, 0.45, 0.04), R(0.41, 0.23, 0.45, 0.04), R(0.41, 0.34, 0.45, 0.04)],
  'question-option': [R(0.05, 0.4, 0.9, 0.1), R(0.05, 0.52, 0.9, 0.08)],
  '[data-loop-status]': [R(0.25, 0.12, 0.1, 0.02)],
  'loop-history': [R(0.05, 0.3, 0.45, 0.15)],
  'deck-looks-right': [R(0.503, 0.883, 0.261, 0.07)],
  'visual-review-deck': [R(0.1, 0.05, 0.8, 0.85)],
};
const fake: Stills = {
  img: (step, viewport = 'desktop', at = 0) => {
    if (step === 's04-home') throw new Error('v8 has no Home fleet shot');
    return { src: `/shots/${step}-${viewport}.png`, at, width: viewport === 'phone' ? 1170 : 2880, height: viewport === 'phone' ? 2532 : 1824 };
  },
  typing: (step) => Array.from({ length: 15 }, (_, i) => ({ src: `/shots/${step}-type-${i}.png`, at: 0, width: 2880, height: 1824 })),
  boxes: (_s, target) => BOXES[target] ?? [R(0.3, 0.3, 0.4, 0.2)],
  box: (s, target, index = 0, vp) => fake.boxes(s, target, vp)[index] ?? R(0.3, 0.3, 0.4, 0.2),
  boxAttrs: () => [],
  text: () => ({ rects: [R(0.3, 0.42, 0.25, 0.012)], block: R(0.3, 0.42, 0.25, 0.012) }),
  file: (path) => ({ src: `/shots/${path}`, at: 0, width: 780, height: 1688 }),
};
const spoken = [3.73, 3.06, 9.4, 8.43, 1.65].map((seconds, i) => ({ file: `/tmp/v${i}.wav`, seconds }));

describe('v8 chapters', () => {
  const ch = v8Chapters(fake);
  test("v7's film with the agents chapter opened by the runner, then your own session", () => {
    expect(ch.map((c) => c.map((x) => x.id))).toEqual([['open'], ['checks', 'draft'], ['fleet', 'session', 'decided', 'question'], ['red', 'green', 'looks', 'beforeAfter'], ['end']]);
  });
  test('both agent shots are the Health > Runners still: the runner group lit first, then the sessions group', () => {
    const [fleet, session] = ch[2];
    expect(fleet.images[0].src).toContain('s04-runners');
    expect(session.images[0].src).toContain('s04-runners');
    const groups = BOXES['running-now-group'];
    expect(fleet.spot![0].rects).toContainEqual(groups[0]);
    expect(session.spot!.at(-1)!.rects).toEqual([groups[groups.length - 1]]);
    for (const x of [fleet, session]) expect(x.dur).toBeGreaterThanOrEqual(3);
  });
  test('only the agents line changes from v7, and it says "use the agent you already have"', () => {
    expect(V8_LINES.filter((l, i) => l !== V7_LINES[i])).toEqual([V8_LINES[2]]);
    expect(V8_LINES[2]).toContain('Use the agent you already have');
    expect(V8_LINES[2]).toContain('Claude Code session');
  });
  test('no word about how a session is paid for or signed in', () => {
    const words = JSON.stringify([V8_LINES, v8Film(fake, spoken).shots.map((s) => [s.caption, s.motion]), v8Captioned(fake, spoken).shots.map((s) => [s.caption, s.motion])]).toLowerCase();
    for (const w of ['subscription', 'seat', 'login', 'sign-in', 'sign in', 'token', 'api key', 'oauth', 'plan']) expect(words).not.toContain(w);
  });
});

describe('v8 cuts', () => {
  test('the voiced film: five lines, no captions, under a minute, ≤8MB', () => {
    const film = v8Film(fake, spoken);
    expect(film.voice).toHaveLength(5);
    expect(film.captions).toBe(false);
    expect(film.maxBytes).toBe(8 * 1024 * 1024);
    expect(cutDuration(film)).toBeLessThanOrEqual(60);
  });
  test('the captioned cut is silent, shows every sentence once in order, clear of lit elements', () => {
    const cap = v8Captioned(fake, spoken);
    expect(cap.voice).toBeUndefined();
    const shown = cap.shots.flatMap((s) => (s.caption === undefined ? [] : typeof s.caption === 'string' ? [s.caption] : s.caption.map((c) => c.text)));
    expect(shown).toEqual(V8_LINES.slice(0, 4).flatMap((l) => l.match(/[^.!?]+[.!?]+/g)!.map((x) => x.trim())));
    // The session shot carries the whole "use the agent you already have" sentence, never the next shot.
    expect(cap.shots.find((s) => s.id === 'session')!.caption).toBe('Use the agent you already have: your own Claude Code session takes a task.');
    expect(captionCollisions(cap)).toEqual([]);
  });
  test("no caption is longer than v7's longest, which fits the frame (a longer one ran off its right edge)", () => {
    const longest = Math.max(...V7_LINES.flatMap((l) => l.match(/[^.!?]+[.!?]+/g)!.map((x) => x.trim().length)));
    const cap = v8Captioned(fake, spoken);
    const shown = cap.shots.flatMap((s) => (s.caption === undefined ? [] : typeof s.caption === 'string' ? [s.caption] : s.caption.map((c) => c.text)));
    for (const text of shown) expect(text.length).toBeLessThanOrEqual(longest);
  });
});

test('render: the v8 family renders the voiced and captioned films into v8/', () => {
  expect(FAMILIES.v8.dir).toBe('v8');
  expect(FAMILIES.v8.prefix).toBe('buildd-demo-v8');
  expect(v8SiteFiles().map(([, to]) => to).sort()).toEqual(['captioned-poster.jpg', 'captioned.mp4', 'full-poster.jpg', 'full.mp4']);
});
