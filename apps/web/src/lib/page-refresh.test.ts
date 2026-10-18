/** The page's one live-refresh gate (spec 3ef37387 R-16), on a fake clock. */
import { describe, expect, it } from 'bun:test';
import type { Clock } from './realtime-throttle';
import { createPageRefreshGate, PAGE_REFRESH_MIN_MS } from './page-refresh';

function fakeClock(): Clock & { advance(ms: number): void } {
  let t = 1_000_000;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let next = 1;
  return {
    now: () => t,
    setTimeout(fn, ms) { const id = next++; timers.push({ at: t + ms, fn, id }); return id; },
    clearTimeout(h) { timers = timers.filter(x => x.id !== h); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter(x => x !== due);
        t = due.at;
        due.fn();
      }
      t = end;
    },
  };
}

const counter = () => { const r = { n: 0, refresh() { r.n++; } }; return r; };

describe('createPageRefreshGate', () => {
  it('runs the first ask at once', () => {
    const gate = createPageRefreshGate(fakeClock());
    const r = counter();
    gate.request(r);
    expect(r.n).toBe(1);
  });

  it('at most one refresh per 5 s, however many asks', () => {
    const clock = fakeClock();
    const gate = createPageRefreshGate(clock);
    const r = counter();
    for (let i = 0; i < 50; i++) { gate.request(r); clock.advance(200); }
    // 10 s of asks: one at once, then one per window.
    expect(r.n).toBeLessThanOrEqual(3);
    expect(r.n).toBeGreaterThanOrEqual(2);
    expect(PAGE_REFRESH_MIN_MS).toBe(5_000);
  });

  it('an ask inside the window is not dropped: it runs at the window\'s end', () => {
    const clock = fakeClock();
    const gate = createPageRefreshGate(clock);
    const r = counter();
    gate.request(r);
    clock.advance(1_000);
    gate.request(r);
    expect(r.n).toBe(1);
    clock.advance(3_999);
    expect(r.n).toBe(1);
    clock.advance(1);
    expect(r.n).toBe(2);
  });

  it('every distinct refresher that asked runs, each once', () => {
    const clock = fakeClock();
    const gate = createPageRefreshGate(clock);
    const a = counter();
    const b = counter();
    gate.request(a);
    gate.request(a);
    gate.request(b);
    gate.request(b);
    clock.advance(PAGE_REFRESH_MIN_MS);
    expect([a.n, b.n]).toEqual([2, 1]);
  });

  it('a pull restarts the window', () => {
    const clock = fakeClock();
    const gate = createPageRefreshGate(clock);
    const r = counter();
    gate.noteRefreshed();
    gate.request(r);
    expect(r.n).toBe(0);
    clock.advance(PAGE_REFRESH_MIN_MS);
    expect(r.n).toBe(1);
  });
});
