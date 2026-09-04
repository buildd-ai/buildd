/**
 * Tests for mission pacing enforcement in the claim loop.
 * Covers: paced missions (rate gate), mission maxConcurrentTasks, budget_exhausted skip.
 */
import { describe, it, expect } from 'bun:test';
import { checkMissionPacingGate, checkMissionConcurrencyGate } from './pacing-gate';

describe('checkMissionPacingGate', () => {
  const nowMs = Date.now();
  const now = new Date(nowMs);

  it('allows eager missions unconditionally', () => {
    const mission = { pacingMode: 'eager' as const, pacingMaxPerHour: null, lastTaskStartedAt: now };
    expect(checkMissionPacingGate(mission, now)).toBeNull();
  });

  it('allows paced mission when lastTaskStartedAt is null (first task ever)', () => {
    const mission = { pacingMode: 'paced' as const, pacingMaxPerHour: 2, lastTaskStartedAt: null };
    expect(checkMissionPacingGate(mission, now)).toBeNull();
  });

  it('allows paced mission when interval has elapsed', () => {
    // 2 per hour → 30min interval; started 35min ago → should be allowed
    const lastStartedAt = new Date(nowMs - 35 * 60 * 1000);
    const mission = { pacingMode: 'paced' as const, pacingMaxPerHour: 2, lastTaskStartedAt: lastStartedAt };
    expect(checkMissionPacingGate(mission, now)).toBeNull();
  });

  it('blocks paced mission when interval has NOT elapsed', () => {
    // 2 per hour → 30min interval; started 10min ago → blocked
    const lastStartedAt = new Date(nowMs - 10 * 60 * 1000);
    const mission = { pacingMode: 'paced' as const, pacingMaxPerHour: 2, lastTaskStartedAt: lastStartedAt };
    const result = checkMissionPacingGate(mission, now);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('pacing_rate');
    // nextEligibleAt should be ~20min from now (30min interval - 10min elapsed)
    const expectedNext = new Date(lastStartedAt.getTime() + 30 * 60 * 1000);
    expect(result!.nextEligibleAt.getTime()).toBe(expectedNext.getTime());
  });

  it('blocks paced mission with 1/hr when started 50min ago', () => {
    const lastStartedAt = new Date(nowMs - 50 * 60 * 1000);
    const mission = { pacingMode: 'paced' as const, pacingMaxPerHour: 1, lastTaskStartedAt: lastStartedAt };
    const result = checkMissionPacingGate(mission, now);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('pacing_rate');
  });

  it('allows paced mission with 1/hr when started 65min ago', () => {
    const lastStartedAt = new Date(nowMs - 65 * 60 * 1000);
    const mission = { pacingMode: 'paced' as const, pacingMaxPerHour: 1, lastTaskStartedAt: lastStartedAt };
    expect(checkMissionPacingGate(mission, now)).toBeNull();
  });

  it('uses default 1/hr when pacingMaxPerHour is null but paced', () => {
    // null pacingMaxPerHour on a paced mission defaults to 1/hr → 60min interval
    const lastStartedAt = new Date(nowMs - 30 * 60 * 1000);
    const mission = { pacingMode: 'paced' as const, pacingMaxPerHour: null, lastTaskStartedAt: lastStartedAt };
    const result = checkMissionPacingGate(mission, now);
    expect(result).not.toBeNull();
  });

  it('allows the start at EXACTLY the interval boundary (elapsed == interval)', () => {
    // The comparison is `elapsed >= interval`, not `>`. Every other test in this
    // file sits several minutes clear of the boundary, so `>=` → `>` passed them
    // all. Under that off-by-one a mission paced at N/hr starts N-1 tasks per
    // hour forever: the tick that lands exactly on the interval is rejected and
    // the next claim poll is a whole poll-interval later, so the drift never
    // recovers. Cron-driven claims land on round timestamps, which is precisely
    // where this bites.
    for (const maxPerHour of [1, 2, 4]) {
      const intervalMs = (3600 / maxPerHour) * 1000;
      const mission = {
        pacingMode: 'paced' as const,
        pacingMaxPerHour: maxPerHour,
        lastTaskStartedAt: new Date(nowMs - intervalMs),
      };
      expect(checkMissionPacingGate(mission, now)).toBeNull();
    }
  });

  it('blocks one millisecond before the interval boundary', () => {
    // The other half of the boundary: the gate must still be closed at
    // interval-1ms, so the test above cannot be satisfied by removing the gate.
    const mission = {
      pacingMode: 'paced' as const,
      pacingMaxPerHour: 2,
      lastTaskStartedAt: new Date(nowMs - (30 * 60 * 1000 - 1)),
    };
    expect(checkMissionPacingGate(mission, now)).not.toBeNull();
  });

  it('reports the true intervalSec and elapsedSec on the block', () => {
    // These two fields are the diagnostic the runner surfaces on /api/claim when
    // a claim is rejected (and what nextEligibleAt is derived from). Nothing
    // asserted them, so swapping the two values — or reporting the wrong
    // rate — was invisible, and an operator debugging a stalled mission would
    // be told the mission is paced at a rate it is not.
    const mission = {
      pacingMode: 'paced' as const,
      pacingMaxPerHour: 4,
      lastTaskStartedAt: new Date(nowMs - 5 * 60 * 1000),
    };
    const result = checkMissionPacingGate(mission, now);
    expect(result).not.toBeNull();
    expect(result!.intervalSec).toBe(900); // 3600 / 4
    expect(result!.elapsedSec).toBe(300); // 5 min
  });

  it('pins the null-pacingMaxPerHour default to exactly 1/hr (3600s interval)', () => {
    // "not null" alone left the default rate almost unconstrained — 0.5/hr (a
    // 2-hour interval) also blocks the 30-min case above. The default is the
    // documented 1/hr, and a paced mission that never set a rate must not be
    // throttled to half of it.
    const mission = {
      pacingMode: 'paced' as const,
      pacingMaxPerHour: null,
      lastTaskStartedAt: new Date(nowMs - 30 * 60 * 1000),
    };
    const result = checkMissionPacingGate(mission, now);
    expect(result!.intervalSec).toBe(3600);
  });
});

describe('checkMissionConcurrencyGate', () => {
  it('allows when mission has no maxConcurrentTasks', () => {
    expect(checkMissionConcurrencyGate(null, 5)).toBeNull();
  });

  it('allows when active count is below cap', () => {
    expect(checkMissionConcurrencyGate(3, 2)).toBeNull();
  });

  it('blocks when active count equals cap', () => {
    const result = checkMissionConcurrencyGate(3, 3);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('mission_concurrency');
    expect(result!.cap).toBe(3);
    expect(result!.active).toBe(3);
  });

  it('blocks when active count exceeds cap', () => {
    const result = checkMissionConcurrencyGate(2, 4);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('mission_concurrency');
  });
});
