import { describe, it, expect } from 'bun:test';
import { summarizeDeferralRows } from './mission-claim-deferrals';
import { SURFACE_DEFERRAL_MS, STRAND_MS, MIN_CONSECUTIVE_DEFERRALS, isRepeatedlyDeferred } from './claim-deferral-thresholds';

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
    expect(isRepeatedlyDeferred(out[0].consecutiveDeferrals, out[0].firstDeferredAt)).toBe(false);
  });

  it('carries the blocking PR number from a path_overlap row', () => {
    const out = summarizeDeferralRows([
      { taskId: 't1', reason: 'path_overlap', detail: { consecutiveDeferrals: 5, prNumber: 1126, prUrl: 'https://github.com/org/repo/pull/1126' } },
      { taskId: 't2', reason: 'workspace_cap', detail: { consecutiveDeferrals: 2 } },
    ]);
    expect(out.find(d => d.taskId === 't1')?.blockedByPr).toBe(1126);
    expect(out.find(d => d.taskId === 't2')?.blockedByPr ?? null).toBeNull();
  });

  it('drops rows with no task to attribute them to', () => {
    expect(summarizeDeferralRows([{ taskId: null, reason: 'workspace_cap', detail: { consecutiveDeferrals: 99 } }])).toEqual([]);
  });
});

describe('thresholds', () => {
  const OLD_ASSUMED_POLL_MS = 30 * 1000;

  it('surfaces well before the stranding sweep declares the task lost', () => {
    expect(SURFACE_DEFERRAL_MS).toBeLessThan(STRAND_MS);
    // Pinned to a fraction of the strand threshold, not chosen independently —
    // change one and the other moves with it.
    expect(STRAND_MS % SURFACE_DEFERRAL_MS).toBe(0);
  });

  it('is above the noise floor: a single deferral is contention, not a stall', () => {
    const now = Date.now();
    const longAgo = new Date(now - SURFACE_DEFERRAL_MS * 10).toISOString();
    expect(isRepeatedlyDeferred(1, longAgo, now)).toBe(false);
    expect(isRepeatedlyDeferred(MIN_CONSECUTIVE_DEFERRALS, longAgo, now)).toBe(true);
  });

  it('fires at the real measured claim cadence — this is the bug the poll-count threshold had', () => {
    // The measured p50 claim cadence is over five minutes, over 10x the ~30s
    // this threshold used to assume. At that cadence, a streak long enough to
    // cross SURFACE_DEFERRAL_MS wall-clock time produces far fewer polls than
    // a poll-count threshold sized for the old assumption would ever see.
    const now = Date.now();
    const measuredCadenceMs = 5 * 60 * 1000;
    const pollsInSurfaceWindow = Math.ceil(SURFACE_DEFERRAL_MS / measuredCadenceMs);
    // Provably fewer than what the old ~30s-poll assumption would have required.
    expect(pollsInSurfaceWindow).toBeLessThan(SURFACE_DEFERRAL_MS / OLD_ASSUMED_POLL_MS);
    const firstDeferredAt = new Date(now - SURFACE_DEFERRAL_MS).toISOString();
    expect(isRepeatedlyDeferred(pollsInSurfaceWindow, firstDeferredAt, now)).toBe(true);
  });

  it('does not surface a streak that has not run long enough yet, no matter the poll count', () => {
    const now = Date.now();
    const recentlyStarted = new Date(now - (SURFACE_DEFERRAL_MS - 1000)).toISOString();
    // A huge poll count from a hyperactive claim loop, but not enough elapsed
    // time — should NOT surface. Poll count alone is exactly the wrong signal.
    expect(isRepeatedlyDeferred(9999, recentlyStarted, now)).toBe(false);
  });

  it('treats a missing counter or timestamp as not-stuck rather than as zero-or-stuck', () => {
    const now = Date.now();
    const longAgo = new Date(now - SURFACE_DEFERRAL_MS * 10).toISOString();
    expect(isRepeatedlyDeferred(null, longAgo, now)).toBe(false);
    expect(isRepeatedlyDeferred(undefined, longAgo, now)).toBe(false);
    expect(isRepeatedlyDeferred(MIN_CONSECUTIVE_DEFERRALS, null, now)).toBe(false);
    expect(isRepeatedlyDeferred(MIN_CONSECUTIVE_DEFERRALS, undefined, now)).toBe(false);
  });
});
