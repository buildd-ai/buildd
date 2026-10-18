import { describe, expect, test } from 'bun:test';
import { createLiveListener, LIVE_FALLBACK_MS } from './live-listen';
import type { Clock } from './realtime-throttle';

function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (h) => { timers.delete(h as number); },
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
  };
  return { clock, advance };
}

function setup(opts: { hidden?: boolean; fallbackMs?: number | null } = {}) {
  const { clock, advance } = fakeClock();
  let hidden = opts.hidden ?? false;
  let calls = 0;
  const l = createLiveListener({ refresh: () => { calls++; }, clock, isHidden: () => hidden, fallbackMs: opts.fallbackMs });
  l.start();
  return { l, advance, calls: () => calls, setHidden: (h: boolean) => { hidden = h; } };
}

describe('createLiveListener', () => {
  test('the fallback read is at most once a minute when nothing happens', () => {
    const s = setup();
    s.advance(10 * 60_000);
    expect(LIVE_FALLBACK_MS).toBe(60_000);
    expect(s.calls()).toBe(10);
  });

  test('an event refreshes soon, and a burst of events is one refresh', () => {
    const s = setup();
    s.l.event(); s.l.event(); s.l.event();
    s.advance(1_000);
    expect(s.calls()).toBe(1);
  });

  test('an event-driven refresh pushes the fallback back a full minute', () => {
    const s = setup();
    s.advance(50_000);
    s.l.event();
    s.advance(1_000); // event refresh at ~50.5 s
    expect(s.calls()).toBe(1);
    s.advance(30_000); // 81 s: the original 60 s fallback must not have fired
    expect(s.calls()).toBe(1);
    s.advance(30_000); // past 110.5 s
    expect(s.calls()).toBe(2);
  });

  test('hidden: no reads at all, events and the fallback only mark it stale', () => {
    const s = setup({ hidden: true });
    s.l.event();
    s.advance(5 * 60_000);
    expect(s.calls()).toBe(0);
    s.setHidden(false);
    s.l.visible();
    expect(s.calls()).toBe(1);
  });

  test('becoming visible with nothing missed reads nothing', () => {
    const s = setup();
    s.setHidden(true);
    s.advance(10_000);
    s.setHidden(false);
    s.l.visible();
    expect(s.calls()).toBe(0);
  });

  test('fallbackMs null: events only, never a timer read', () => {
    const s = setup({ fallbackMs: null });
    s.advance(10 * 60_000);
    expect(s.calls()).toBe(0);
    s.l.event();
    s.advance(10 * 60_000);
    expect(s.calls()).toBe(1);
  });

  test('dispose stops every timer', () => {
    const s = setup();
    s.l.event();
    s.l.dispose();
    s.advance(5 * 60_000);
    expect(s.calls()).toBe(0);
  });
});
