import { describe, it, expect } from 'bun:test';
import {
  createFreshnessCoordinator,
  subscribeCatchUp,
  emitCatchUp,
  setActiveCoordinator,
  demandCatchUp,
  CATCH_UP_WINDOW_MS,
  MIN_AWAY_MS,
  FOCUS_STALE_MS,
  type CatchUpReason,
} from './app-freshness';
import type { Clock } from './realtime-throttle';

/** Deterministic clock: timers fire only when `advance` passes their deadline. */
function fakeClock(): Clock & { advance(ms: number): void } {
  let t = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id as number); },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of timers) {
          if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
        }
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
  };
}

function setup() {
  const clock = fakeClock();
  let hidden = false;
  const fired: CatchUpReason[] = [];
  const c = createFreshnessCoordinator({
    onCatchUp: (r) => fired.push(r),
    isHidden: () => hidden,
    clock,
  });
  /** Background the page for `ms`, then bring it back with the full browser burst. */
  function awayAndBack(ms: number) {
    hidden = true;
    c.onHidden();
    clock.advance(ms);
    hidden = false;
    c.onForeground('visible');
    c.onForeground('pageshow');
    c.onForeground('focus');
  }
  return {
    clock,
    c,
    fired,
    awayAndBack,
    setHidden(h: boolean) { hidden = h; },
  };
}

describe('createFreshnessCoordinator — resume', () => {
  it('catches up on return from the background with no realtime event at all', () => {
    const { clock, fired, awayAndBack } = setup();
    clock.advance(CATCH_UP_WINDOW_MS);
    awayAndBack(30_000);
    expect(fired).toEqual(['resume']);
  });

  it('collapses visibilitychange + pageshow + focus + resume into one catch-up', () => {
    const { clock, c, fired, awayAndBack } = setup();
    clock.advance(CATCH_UP_WINDOW_MS);
    awayAndBack(5 * 60_000);
    c.onForeground('resume');
    clock.advance(CATCH_UP_WINDOW_MS * 3);
    expect(fired).toHaveLength(1);
  });

  it('ignores a brief peek (app switcher, notification shade)', () => {
    const { clock, fired, awayAndBack } = setup();
    clock.advance(CATCH_UP_WINDOW_MS);
    awayAndBack(MIN_AWAY_MS - 1);
    clock.advance(CATCH_UP_WINDOW_MS * 2);
    expect(fired).toEqual([]);
  });

  it('a long-hidden page returning inside the window still converges (trailing, not dropped)', () => {
    const { clock, c, fired, awayAndBack } = setup();
    c.request('pull'); // t=0 fresh
    expect(fired).toEqual(['pull']);
    awayAndBack(MIN_AWAY_MS + 1);
    expect(fired).toHaveLength(1);
    clock.advance(CATCH_UP_WINDOW_MS);
    expect(fired).toEqual(['pull', 'resume']);
  });

  it('a bfcache restore always counts as stale', () => {
    const { clock, c, fired } = setup();
    clock.advance(CATCH_UP_WINDOW_MS);
    c.onForeground('pageshow', { persisted: true });
    expect(fired).toEqual(['pageshow']);
  });

  it('desktop window switching (focus without a hide) only catches up on an old view', () => {
    const { clock, c, fired } = setup();
    for (let i = 0; i < 20; i++) {
      clock.advance(1_000);
      c.onForeground('focus');
    }
    expect(fired).toEqual([]);
    clock.advance(FOCUS_STALE_MS);
    c.onForeground('focus');
    expect(fired).toEqual(['focus']);
  });

  it('a plain visibilitychange without a prior hide does nothing', () => {
    const { clock, c, fired } = setup();
    clock.advance(FOCUS_STALE_MS * 2);
    c.onForeground('visible');
    expect(fired).toEqual([]);
  });
});

describe('createFreshnessCoordinator — reconnect dedupe', () => {
  it('resume followed by a Pusher reconnect a few seconds later: one now, at most one more at the window edge', () => {
    const { clock, c, fired, awayAndBack } = setup();
    clock.advance(CATCH_UP_WINDOW_MS);
    awayAndBack(60_000);
    clock.advance(3_000);
    c.demand('reconnect');
    c.demand('online');
    c.demand('reconnect');
    expect(fired).toEqual(['resume']);
    clock.advance(CATCH_UP_WINDOW_MS);
    expect(fired).toEqual(['resume', 'reconnect']);
    clock.advance(CATCH_UP_WINDOW_MS * 5);
    expect(fired).toHaveLength(2);
  });

  it('a flapping socket refreshes at most once per window', () => {
    const { clock, c, fired } = setup();
    for (let i = 0; i < 60; i++) {
      c.demand('reconnect');
      clock.advance(1_000);
    }
    // 60s of a reconnect every second → ≤ one per window.
    expect(fired.length).toBeLessThanOrEqual(60_000 / CATCH_UP_WINDOW_MS);
    expect(fired.length).toBeGreaterThan(0);
  });

  it('a reconnect while hidden is owed, and paid once on return even if the hide was brief', () => {
    const { clock, c, fired, setHidden } = setup();
    clock.advance(CATCH_UP_WINDOW_MS);
    setHidden(true);
    c.onHidden();
    c.demand('reconnect');
    c.demand('missed');
    clock.advance(500);
    setHidden(false);
    c.onForeground('visible');
    c.onForeground('focus');
    expect(fired).toEqual(['resume']);
  });

  it('a trailing catch-up that comes due while hidden is deferred to the return', () => {
    const { clock, c, fired, setHidden } = setup();
    c.demand('reconnect'); // inside the initial window → trailing
    setHidden(true);
    c.onHidden();
    clock.advance(CATCH_UP_WINDOW_MS * 2);
    expect(fired).toEqual([]);
    setHidden(false);
    c.onForeground('visible');
    expect(fired).toHaveLength(1);
  });

  it('steady state with no lifecycle or socket churn does nothing', () => {
    const { clock, fired } = setup();
    clock.advance(10 * 60_000);
    expect(fired).toEqual([]);
  });
});

describe('createFreshnessCoordinator — pull-to-refresh', () => {
  it('a pull bypasses the window and cancels a pending trailing catch-up', () => {
    const { clock, c, fired } = setup();
    c.demand('reconnect'); // trailing, inside the initial window
    c.request();
    expect(fired).toEqual(['pull']);
    clock.advance(CATCH_UP_WINDOW_MS * 2);
    expect(fired).toEqual(['pull']);
  });
});

describe('catch-up bus', () => {
  it('fans out to subscribers until they unsubscribe, isolating a throwing listener', () => {
    const seen: string[] = [];
    const offA = subscribeCatchUp(() => { throw new Error('boom'); });
    const offB = subscribeCatchUp((r) => seen.push(r));
    const origError = console.error;
    console.error = () => {};
    try {
      emitCatchUp('resume');
    } finally {
      console.error = origError;
    }
    offA();
    offB();
    emitCatchUp('pull');
    expect(seen).toEqual(['resume']);
  });

  it('demandCatchUp routes to the active coordinator and is a no-op without one', () => {
    demandCatchUp('missed'); // nothing mounted: must not throw
    const demanded: string[] = [];
    const off = setActiveCoordinator({
      onHidden() {}, onForeground() {}, request() {}, dispose() {},
      demand: (r) => demanded.push(r),
    });
    demandCatchUp('missed');
    off();
    demandCatchUp('missed');
    expect(demanded).toEqual(['missed']);
  });
});
