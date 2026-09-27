import { describe, expect, test } from 'bun:test';
import { captureFile, captureKey, clickTargets, highlightTargets, isRendered, loginUser, reducedMotionFor, resolveViewports, scrollPlan, stepViewports } from './storyboard';

describe('resolveViewports', () => {
  test('desktop comes from the board viewport; phone is built in', () => {
    const vps = resolveViewports({ viewport: { width: 1280, height: 800 } });
    expect(vps.desktop).toEqual({ width: 1280, height: 800, scale: 2 });
    expect(vps.phone).toEqual({ width: 390, height: 844, scale: 3, mobile: true });
  });

  test('named viewports override the built-ins field by field', () => {
    const vps = resolveViewports({ viewports: { phone: { scale: 2 }, tablet: { width: 820, height: 1180 } } });
    expect(vps.phone).toEqual({ width: 390, height: 844, scale: 2, mobile: true });
    expect(vps.tablet).toMatchObject({ width: 820, height: 1180 });
  });
});

describe('stepViewports', () => {
  const known = resolveViewports({});
  test('defaults to desktop', () => {
    expect(stepViewports({}, known)).toEqual(['desktop']);
  });
  test('rejects an unknown viewport name', () => {
    expect(() => stepViewports({ viewports: ['desktop', 'watch'] }, known)).toThrow(/watch/);
  });
});

describe('capture names', () => {
  test('desktop keeps <id>-<theme>; others carry the viewport name', () => {
    expect(captureFile('06-question', 'desktop', 'dark')).toBe('06-question-dark.png');
    expect(captureFile('06-question', 'phone', 'light')).toBe('06-question-phone-light.png');
    expect(captureKey('phone', 'dark')).toBe('phone-dark');
    expect(captureFile('04-peak', 'desktop', 'dark', 'webm')).toBe('04-peak-dark.webm');
  });
});

describe('highlightTargets', () => {
  test('step targets are required, board defaults optional, no duplicates', () => {
    expect(highlightTargets({ highlight: ['board-tile', 'goal-band'] }, ['goal-band', 'home-fleet'])).toEqual([
      { target: 'board-tile', required: true },
      { target: 'goal-band', required: true },
      { target: 'home-fleet', required: false },
    ]);
  });
});

describe('isRendered', () => {
  // A closed <details> keeps its content in layout (content-visibility: hidden),
  // so Playwright still reports a non-empty boundingBox for it. The collapsed
  // "all idle" home fleet hides its slot table that way.
  test('an element the browser reports as not visible is not rendered', () => {
    expect(isRendered({ checkVisibility: () => false })).toBe(false);
  });
  test('a visible element is rendered', () => {
    expect(isRendered({ checkVisibility: () => true })).toBe(true);
  });
  test('asks the browser to account for content-visibility and visibility', () => {
    let opts: unknown;
    isRendered({ checkVisibility: (o?: unknown) => { opts = o; return true; } });
    expect(opts).toMatchObject({ contentVisibilityAuto: true, visibilityProperty: true });
  });
  test('without checkVisibility (older engines) it falls back to rendered', () => {
    expect(isRendered({})).toBe(true);
  });
});

describe('scrollPlan', () => {
  test('default: target at the top edge, backed off 120px for sticky headers', () => {
    expect(scrollPlan({})).toEqual({ block: 'start', delta: -120 });
    expect(scrollPlan({ scrollOffset: 0 })).toEqual({ block: 'start', delta: 0 });
  });

  test('scrollAlign end: target at the bottom edge, pushed past it by the offset', () => {
    // A target near the end of a scroller cannot be brought to the top edge
    // (scrollTop clamps), so "start minus an offset" scrolls the wrong way.
    expect(scrollPlan({ scrollAlign: 'end' })).toEqual({ block: 'end', delta: 24 });
    expect(scrollPlan({ scrollAlign: 'end', scrollOffset: 60 })).toEqual({ block: 'end', delta: 60 });
  });

  test('rejects an unknown alignment instead of silently using start', () => {
    expect(() => scrollPlan({ scrollAlign: 'middle' as any })).toThrow(/scrollAlign/);
  });
});

describe('clickTargets', () => {
  test('none, one, or several in order', () => {
    expect(clickTargets({})).toEqual([]);
    expect(clickTargets({ click: 'mission-delivery-summary' })).toEqual(['mission-delivery-summary']);
    expect(clickTargets({ click: ['mission-delivery-summary', 'visual-review-thumb'] })).toEqual(['mission-delivery-summary', 'visual-review-thumb']);
  });
  test('an empty target is an error, not a skipped click', () => {
    expect(() => clickTargets({ click: ['mission-delivery-summary', ''] })).toThrow(/non-empty/);
    expect(() => clickTargets({ click: ' ' })).toThrow(/non-empty/);
  });
});

describe('loginUser', () => {
  const users = [
    { key: 'u_owner', email: 'owner@example.com', name: 'Owner' },
    { key: 'u_member', email: 'member@example.com', name: 'Member', _role: 'member' },
  ];
  test('defaults to the first user', () => {
    expect(loginUser(users).key).toBe('u_owner');
  });
  test('`as` picks another seeded user, so a storyboard can shoot the member view', () => {
    expect(loginUser(users, 'u_member').key).toBe('u_member');
  });
  test('an unknown `as` fails loudly rather than shooting as the owner', () => {
    expect(() => loginUser(users, 'u_nobody')).toThrow(/u_nobody/);
  });
  test('a story with no users fails', () => {
    expect(() => loginUser([])).toThrow(/no users/);
  });
});

describe('reducedMotionFor', () => {
  test('a step can ask for reduced motion; the board sets the default; otherwise motion is on', () => {
    expect(reducedMotionFor({}, {})).toBe('no-preference');
    expect(reducedMotionFor({ reducedMotion: true }, {})).toBe('reduce');
    expect(reducedMotionFor({}, { reducedMotion: true })).toBe('reduce');
    expect(reducedMotionFor({ reducedMotion: false }, { reducedMotion: true })).toBe('no-preference');
  });
});
