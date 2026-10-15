import { describe, expect, it } from 'bun:test';
import { deferralOf, isOutageAnswer, nextDeferral } from './control-plane-deferral';

describe('a control-plane deferral is bounded', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 9, 15, 0, 0, 0) + h * 3_600_000);

  it('counts each deferral from the first, and runs out at 24 ticks', () => {
    let s = null as ReturnType<typeof nextDeferral>['state'] | null;
    for (let i = 1; i <= 23; i++) {
      const n = nextDeferral(s, 'cp down', at(i * 0.01));
      expect(n.exhausted).toBe(false);
      s = n.state;
    }
    expect(s!.count).toBe(23);
    expect(nextDeferral(s, 'cp down', at(0.5)).exhausted).toBe(true);
  });

  it('runs out 24 hours after the first, however few ticks', () => {
    const first = nextDeferral(null, 'cp down', at(0));
    expect(first.state).toMatchObject({ firstAt: at(0).toISOString(), count: 1 });
    expect(nextDeferral(first.state, 'cp down', at(23.9)).exhausted).toBe(false);
    expect(nextDeferral(first.state, 'cp down', at(24)).exhausted).toBe(true);
  });

  it('reads a stored deferral back, and only an outage answer defers', () => {
    expect(deferralOf({ firstAt: 'x', count: 2, reason: 'r' })).toEqual({ firstAt: 'x', count: 2, reason: 'r' });
    expect(deferralOf(null)).toBeNull();
    expect(deferralOf({ count: 2 })).toBeNull();
    expect(isOutageAnswer({ code: 'control_plane_unavailable' })).toBe(true);
    expect(isOutageAnswer({ code: 'control_plane_refused' })).toBe(false);
    expect(isOutageAnswer({ code: 'command_failed' })).toBe(false);
  });
});
