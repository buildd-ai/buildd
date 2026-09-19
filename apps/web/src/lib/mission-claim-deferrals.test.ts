import { describe, it, expect } from 'bun:test';
import { summarizeDeferralRows } from './mission-claim-deferrals';
import { SURFACE_DEFERRAL_THRESHOLD, STRAND_CONSECUTIVE_THRESHOLD, isRepeatedlyDeferred } from './claim-deferral-thresholds';

describe('summarizeDeferralRows', () => {
  it('keeps the longest streak when one task is refused for several reasons', () => {
    const out = summarizeDeferralRows([
      { taskId: 't1', reason: 'workspace_cap', detail: { consecutiveDeferrals: 4 } },
      { taskId: 't1', reason: 'path_overlap', detail: { consecutiveDeferrals: 19, firstDeferredAt: '2026-09-19T09:00:00.000Z' } },
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe('path_overlap');
    expect(out[0].consecutiveDeferrals).toBe(19);
    expect(out[0].firstDeferredAt).toBe('2026-09-19T09:00:00.000Z');
  });

  it('ranks tasks worst-first, so the header names the most stuck one', () => {
    const out = summarizeDeferralRows([
      { taskId: 't1', reason: 'workspace_cap', detail: { consecutiveDeferrals: 3 } },
      { taskId: 't2', reason: 'workspace_cap', detail: { consecutiveDeferrals: 30 } },
    ]);

    expect(out.map(d => d.taskId)).toEqual(['t2', 't1']);
  });

  it('treats a row with no counter as a streak of one, not as unknown', () => {
    const out = summarizeDeferralRows([{ taskId: 't1', reason: 'mission_paced', detail: null }]);

    expect(out[0].consecutiveDeferrals).toBe(1);
    expect(out[0].firstDeferredAt).toBeNull();
    expect(isRepeatedlyDeferred(out[0].consecutiveDeferrals)).toBe(false);
  });

  it('drops rows with no task to attribute them to', () => {
    expect(summarizeDeferralRows([{ taskId: null, reason: 'workspace_cap', detail: { consecutiveDeferrals: 99 } }])).toEqual([]);
  });
});

describe('thresholds', () => {
  it('surfaces well before the stranding sweep declares the task lost', () => {
    expect(SURFACE_DEFERRAL_THRESHOLD).toBeLessThan(STRAND_CONSECUTIVE_THRESHOLD);
    // Pinned to a fraction of the strand threshold, not chosen independently —
    // change the poll cadence and both move together.
    expect(STRAND_CONSECUTIVE_THRESHOLD % SURFACE_DEFERRAL_THRESHOLD).toBe(0);
  });

  it('is above the noise floor: a deferral or two is contention, not a stall', () => {
    expect(isRepeatedlyDeferred(1)).toBe(false);
    expect(isRepeatedlyDeferred(2)).toBe(false);
    expect(isRepeatedlyDeferred(SURFACE_DEFERRAL_THRESHOLD)).toBe(true);
  });

  it('treats a missing counter as not-stuck rather than as zero-or-stuck', () => {
    expect(isRepeatedlyDeferred(null)).toBe(false);
    expect(isRepeatedlyDeferred(undefined)).toBe(false);
  });
});
