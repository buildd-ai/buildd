import { describe, expect, it } from 'bun:test';
import { captureConfigErrorFrom, deriveMissionVisualReview, readAuditedSha, type VisualReviewStateInput } from './visual-review-state';
import { resolveVisualReviewPolicy } from './visual-review-policy';
import {
  MAX_AUTO_ATTEMPTS_PER_HEAD,
  RETRY_BACKOFF_BASE_MS,
  autoRetriesLeft,
  planVisualReviewSchedule,
  retryBackoffMs,
  type ScheduleAudit,
  type ScheduleInput,
} from './visual-review-schedule';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const HEAD = 'aaaa1111';

const stateOf = (over: Partial<VisualReviewStateInput> = {}) => deriveMissionVisualReview({
  policy: resolveVisualReviewPolicy({}),
  uiChange: { state: 'yes', source: 'diff', uiFiles: 2 },
  audit: null,
  review: null,
  waiver: null,
  branch: { headSha: HEAD, base: 'dev', integrationPr: { number: 9, state: 'open', ready: false, blocked: false }, workLanded: true },
  ...over,
});
const au = (over: Partial<ScheduleAudit> = {}): ScheduleAudit => ({ id: 'a1', status: 'pending', round: 1, headSha: HEAD, updatedAt: NOW - 60_000, ...over });
const plan = (over: Partial<ScheduleInput> & { stateOver?: Partial<VisualReviewStateInput> } = {}) => {
  const { stateOver, ...rest } = over;
  return planVisualReviewSchedule({
    state: stateOf(stateOver), impact: { verdict: 'review_required', headSha: HEAD }, audits: [],
    browserRunnerOnline: true, executorLocal: false, now: NOW, ...rest,
  });
};
const passedReview = { phase: 'reviewed' as const, screens: 3, effectiveIssues: 0, awaitingHuman: 0, openFixes: 0, roundCapOpen: false, needsYouReason: null, captured: 0, expected: null };
const auditRow = { id: 'a1', createdAt: '2026-10-01T00:00:00Z', errorType: null };

describe('planVisualReviewSchedule', () => {
  it('files the first review on the exact head once the work has landed', () => {
    expect(plan()).toEqual({ action: 'enqueue', headSha: HEAD, round: 1, reason: 'first', attempt: 1, runnerNote: null });
  });

  it('files nothing before the work landed or before there is a head', () => {
    const notLanded = stateOf({ branch: { headSha: HEAD, base: 'dev', integrationPr: null, workLanded: false } });
    expect(plan({ state: notLanded })).toMatchObject({ action: 'none', why: 'work_not_landed' });
    const noHead = stateOf({ branch: { headSha: null, base: 'dev', integrationPr: null, workLanded: true } });
    expect(plan({ state: noHead })).toMatchObject({ action: 'none', why: 'no_integration_head' });
  });

  it('never double-files: a queued or running audit is the review', () => {
    for (const status of ['pending', 'in_progress', 'assigned']) {
      const s = stateOf({ audit: auditRow, review: { ...passedReview, phase: 'queued' } });
      expect(plan({ state: s, audits: [au({ status })] })).toMatchObject({ action: 'none', why: 'audit_live' });
    }
  });

  it('re-stamps a queued audit that was stamped for an older head instead of filing a second', () => {
    const s = stateOf({ audit: auditRow, review: { ...passedReview, phase: 'queued' } });
    expect(plan({ state: s, audits: [au({ headSha: 'old00000' })] })).toEqual({ action: 'restamp', auditId: 'a1', headSha: HEAD });
  });

  it('a running audit is never re-stamped (it keeps the head it started on)', () => {
    const s = stateOf({ audit: auditRow, review: { ...passedReview, phase: 'capturing' } });
    expect(plan({ state: s, audits: [au({ status: 'in_progress', headSha: 'old00000' })] })).toMatchObject({ action: 'none', why: 'audit_live' });
  });

  it('files nothing while the review passed on this head', () => {
    const s = stateOf({ audit: auditRow, review: passedReview, auditedSha: HEAD });
    expect(plan({ state: s, audits: [au({ status: 'completed' })] })).toMatchObject({ action: 'none', why: 'passed' });
  });

  it('re-files as the next round when a new UI-impacting commit lands after a pass', () => {
    const s = stateOf({ audit: auditRow, review: passedReview, auditedSha: 'old00000' });
    expect(plan({ state: s, audits: [au({ status: 'completed', headSha: 'old00000' })] }))
      .toEqual({ action: 'enqueue', headSha: HEAD, round: 2, reason: 'new_head', attempt: 1, runnerNote: null });
  });

  it('a new commit with no UI impact re-files nothing', () => {
    const s = stateOf({ audit: auditRow, review: passedReview, auditedSha: 'old00000', uiChange: { state: 'no', source: null, uiFiles: 0 } });
    expect(plan({ state: s, impact: { verdict: 'not_applicable', headSha: HEAD }, audits: [au({ status: 'completed', headSha: 'old00000' })] }).action).toBe('none');
  });

  it('a stale not-applicable verdict (another head) never rules the review out', () => {
    expect(plan({ impact: { verdict: 'not_applicable', headSha: 'old00000' } }).action).toBe('enqueue');
  });

  it('leaves findings to the findings loop', () => {
    const s = stateOf({ audit: auditRow, review: { ...passedReview, phase: 'fixing', effectiveIssues: 1, openFixes: 1 }, auditedSha: HEAD });
    expect(plan({ state: s, audits: [au({ status: 'completed' })] })).toMatchObject({ action: 'none', why: 'findings_open' });
  });

  it('does not file for `ask` (a person chooses) or `off`', () => {
    expect(plan({ stateOver: { policy: resolveVisualReviewPolicy({ workspace: 'ask' }) } })).toMatchObject({ why: 'ask_policy' });
    expect(plan({ stateOver: { policy: resolveVisualReviewPolicy({ workspace: 'off' }) } })).toMatchObject({ why: 'policy_off' });
  });

  it('does not file over a recorded waiver', () => {
    const waiver = { reason: 'copy only', actorLabel: null, at: '2026-10-02T00:00:00Z' };
    expect(plan({ stateOver: { waiver } })).toMatchObject({ action: 'none', why: 'waived' });
  });

  describe('bounded retry for system failures', () => {
    const failed = (n: number, ageMs: number): ScheduleAudit[] =>
      Array.from({ length: n }, (_, i) => au({ id: `f${i}`, status: 'failed', updatedAt: NOW - ageMs - i * 1000 }));

    it('backs off exponentially: 5, 15, 45 minutes, capped', () => {
      expect([1, 2, 3].map(retryBackoffMs)).toEqual([RETRY_BACKOFF_BASE_MS, RETRY_BACKOFF_BASE_MS * 3, RETRY_BACKOFF_BASE_MS * 9]);
      expect(retryBackoffMs(10)).toBeLessThanOrEqual(60 * 60_000);
    });

    it('waits out the backoff after a failure', () => {
      const r = plan({ audits: failed(1, 60_000) });
      expect(r).toMatchObject({ action: 'wait', attempt: 2 });
      expect((r as { until: number }).until).toBe(NOW - 60_000 + RETRY_BACKOFF_BASE_MS);
    });

    it('retries once the backoff has elapsed, on the same round, as the next attempt', () => {
      expect(plan({ audits: failed(1, RETRY_BACKOFF_BASE_MS + 1) }))
        .toEqual({ action: 'enqueue', headSha: HEAD, round: 1, reason: 'retry', attempt: 2, runnerNote: null });
    });

    it('a longer wait applies after each further failure', () => {
      expect(plan({ audits: failed(2, RETRY_BACKOFF_BASE_MS * 2) }).action).toBe('wait');
      expect(plan({ audits: failed(2, RETRY_BACKOFF_BASE_MS * 3 + 5000) }).action).toBe('enqueue');
    });

    it('blocks with the owner as next actor after the last attempt, and files nothing more', () => {
      const r = plan({ audits: failed(MAX_AUTO_ATTEMPTS_PER_HEAD, 24 * 3600_000) });
      expect(r).toMatchObject({ action: 'blocked', cause: 'retries_exhausted', nextActor: 'owner' });
    });

    it("failures on an older head do not use up the new head's attempts", () => {
      const old = Array.from({ length: 3 }, (_, i) => au({ id: `o${i}`, status: 'failed', headSha: 'old00000', updatedAt: NOW - 24 * 3600_000 }));
      expect(plan({ audits: old }).action).toBe('enqueue');
    });

    it('counts attempts left for the state', () => {
      expect([0, 1, 2, 3, 4].map(autoRetriesLeft)).toEqual([3, 2, 1, 0, 0]);
    });

    it("a capture setup error is the workspace's to fix and is never retried", () => {
      expect(plan({ audits: [au({ status: 'failed', updatedAt: NOW - 3600_000, captureConfigError: 'protection_bypass_missing' })] }))
        .toMatchObject({ action: 'blocked', cause: 'capture_config', nextActor: 'owner' });
    });
  });

  describe('browser unavailable', () => {
    it('still files the review, so a runner that connects picks it up, and says no browser is online', () => {
      expect(plan({ browserRunnerOnline: false })).toMatchObject({ action: 'enqueue', runnerNote: 'no_browser_runner' });
    });
    it('unknown runner state is not treated as offline', () => {
      expect(plan({ browserRunnerOnline: null })).toMatchObject({ action: 'enqueue', runnerNote: null });
    });
    it("a local executor is blocked with the owner, because buildd's runners will not claim it", () => {
      expect(plan({ executorLocal: true })).toMatchObject({ action: 'blocked', cause: 'executor_local', nextActor: 'owner' });
    });
    it('the state names the owner for a missing browser runner once retries are spent', () => {
      const s = stateOf({ audit: auditRow, review: { ...passedReview, phase: 'no_browser_runner' }, auditedSha: HEAD, autoRetriesLeft: 0 });
      expect(s).toMatchObject({ status: 'blocked', nextActor: 'owner', blocked: { cause: 'no_browser_runner' } });
    });
  });

  it('a person cancelling the review on this head is respected, a new head is a new question', () => {
    expect(plan({ audits: [au({ status: 'cancelled' })] })).toMatchObject({ action: 'blocked', cause: 'audit_cancelled', nextActor: 'owner' });
    expect(plan({ audits: [au({ status: 'cancelled', headSha: 'old00000' })] }).action).toBe('enqueue');
  });

  it('stops re-filing at the round ceiling and says so', () => {
    const done = Array.from({ length: 5 }, (_, i) => au({ id: `d${i}`, status: 'completed', round: 5 - i, headSha: `old0000${i}` }));
    const s = stateOf({ audit: auditRow, review: passedReview, auditedSha: 'old00000' });
    expect(plan({ state: s, audits: done })).toMatchObject({ action: 'blocked', cause: 'rereview_cap', nextActor: 'owner' });
  });

  it('an integration PR that already merged runs as a post-merge audit, labelled as such', () => {
    const merged = stateOf({ branch: { headSha: HEAD, base: 'dev', integrationPr: { number: 9, state: 'merged', ready: true, blocked: false }, workLanded: true } });
    expect(merged.branch.postMergeRecovery).toBe(true);
    expect(plan({ state: merged })).toMatchObject({ action: 'enqueue', reason: 'post_merge_recovery' });
  });
});

describe('evidence helpers', () => {
  it('reads the stamped head, lowercased, and nothing else', () => {
    expect(readAuditedSha({ visualReview: { headSha: 'ABCDEF1234' } })).toBe('abcdef1234');
    expect(readAuditedSha({ visualReview: { headSha: 'not a sha' } })).toBeNull();
    expect(readAuditedSha(null)).toBeNull();
    expect(readAuditedSha({})).toBeNull();
  });
  it('reads only named capture setup codes from a failure', () => {
    expect(captureConfigErrorFrom({ error: 'failed: protection_bypass_missing' })).toBe('protection_bypass_missing');
    expect(captureConfigErrorFrom('app_auth_not_configured')).toBe('app_auth_not_configured');
    expect(captureConfigErrorFrom('browser crashed')).toBeNull();
    expect(captureConfigErrorFrom(undefined)).toBeNull();
  });
});
