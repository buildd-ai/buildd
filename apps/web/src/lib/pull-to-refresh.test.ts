import { describe, it, expect } from 'bun:test';
import { createPullTracker, pullDistance, PULL_THRESHOLD_PX, PULL_MAX_PX } from './pull-to-refresh';

const AT_TOP = { atTop: true, enabled: true, touches: 1 };

/** Finger travel that yields `px` of indicator travel. */
const finger = (px: number) => px * 2;

describe('createPullTracker', () => {
  it('a pull past the threshold from the top refreshes on release', () => {
    const t = createPullTracker();
    t.start(100, 100, AT_TOP);
    const m = t.move(102, 100 + finger(PULL_THRESHOLD_PX + 4));
    expect(m.consume).toBe(true);
    expect(m.armed).toBe(true);
    expect(t.end()).toBe(true);
  });

  it('a short pull springs back without refreshing', () => {
    const t = createPullTracker();
    t.start(100, 100, AT_TOP);
    const m = t.move(100, 100 + finger(PULL_THRESHOLD_PX - 10));
    expect(m.consume).toBe(true);
    expect(m.armed).toBe(false);
    expect(t.end()).toBe(false);
  });

  it('releasing after pulling back up below the threshold cancels', () => {
    const t = createPullTracker();
    t.start(100, 100, AT_TOP);
    t.move(100, 100 + finger(PULL_THRESHOLD_PX + 20));
    t.move(100, 110);
    expect(t.end()).toBe(false);
  });

  it('ignores a pull that starts scrolled down, under an overlay, or with two fingers', () => {
    for (const ctx of [
      { ...AT_TOP, atTop: false },
      { ...AT_TOP, enabled: false },
      { ...AT_TOP, touches: 2 },
    ]) {
      const t = createPullTracker();
      t.start(100, 100, ctx);
      expect(t.move(100, 400).consume).toBe(false);
      expect(t.end()).toBe(false);
    }
  });

  it('an upward scroll or a sideways swipe is not a pull, even if it later turns downward', () => {
    const up = createPullTracker();
    up.start(100, 300, AT_TOP);
    expect(up.move(100, 280).consume).toBe(false);
    expect(up.move(100, 600).consume).toBe(false);
    expect(up.end()).toBe(false);

    const side = createPullTracker();
    side.start(100, 100, AT_TOP);
    expect(side.move(140, 110).consume).toBe(false);
    expect(side.move(140, 400).consume).toBe(false);
    expect(side.end()).toBe(false);
  });

  it('taps inside the slop do not claim the gesture', () => {
    const t = createPullTracker();
    t.start(100, 100, AT_TOP);
    expect(t.move(101, 103).consume).toBe(false);
    expect(t.phase).toBe('tracking');
  });
});

describe('pullDistance', () => {
  it('is damped, zero for upward travel, and capped', () => {
    expect(pullDistance(-10)).toBe(0);
    expect(pullDistance(40)).toBe(20);
    expect(pullDistance(10_000)).toBe(PULL_MAX_PX);
  });
});
