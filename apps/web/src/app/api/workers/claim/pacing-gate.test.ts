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
