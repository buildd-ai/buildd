import { describe, it, expect } from 'bun:test';
import {
  classifyReportedFailure,
  classifyStaleExit,
  consumesRetryAttempt,
  isConcurrencyConflictError,
  NEVER_STARTED_ERROR,
  SILENT_START_ERROR,
  STALE_EXPIRED_ERROR,
} from './worker-exit-taxonomy';

describe('classifyReportedFailure', () => {
  it('prioritises budget over everything else', () => {
    expect(classifyReportedFailure({ budgetLimited: true, sandboxMountGap: true })).toBe('budget_limited');
  });

  it('classifies sandbox mount gaps', () => {
    expect(classifyReportedFailure({ budgetLimited: false, sandboxMountGap: true })).toBe('sandbox_mount_gap');
  });

  it('classifies steering-delivery crashes as infra', () => {
    expect(
      classifyReportedFailure({ budgetLimited: false, sandboxMountGap: false, steeringDelivery: true }),
    ).toBe('infra_failure');
  });

  // Regression: a worker killed by a server-side lost-update race is not a code
  // failure. Recording it as one pollutes the taxonomy and burns a retry cap.
  it('classifies a concurrency conflict as infra_failure, not code_failure', () => {
    const cause = classifyReportedFailure({
      budgetLimited: false,
      sandboxMountGap: false,
      concurrencyConflict: true,
    });
    expect(cause).toBe('infra_failure');
    expect(consumesRetryAttempt(cause)).toBe(false);
  });

  it('defaults to code_failure', () => {
    expect(classifyReportedFailure({ budgetLimited: false, sandboxMountGap: false })).toBe('code_failure');
  });
});

describe('isConcurrencyConflictError', () => {
  it('detects the runner fallback string for an unexplained server abort', () => {
    expect(isConcurrencyConflictError('Terminated by server')).toBe(true);
    expect(isConcurrencyConflictError('terminated by server')).toBe(true);
  });

  it('detects the server conflict message', () => {
    expect(isConcurrencyConflictError('Worker state changed concurrently')).toBe(true);
  });

  it('does not match real failures', () => {
    expect(isConcurrencyConflictError('TypeError: undefined is not a function')).toBe(false);
    expect(isConcurrencyConflictError('Interrupted — human takeover')).toBe(false);
    expect(isConcurrencyConflictError(null)).toBe(false);
    expect(isConcurrencyConflictError(undefined)).toBe(false);
  });
});

describe('classifyStaleExit', () => {
  it('books a worker no runner ever started as never_started, not infra_failure', () => {
    const result = classifyStaleExit({ startedAt: null, turns: 0, costUsd: '0.000000' });
    expect(result.exitCause).toBe('never_started');
    expect(result.error).toBe(NEVER_STARTED_ERROR);
    // The old text implied a runner timed out. It never ran.
    expect(result.error).not.toContain('no update for 15+ minutes');
  });

  it('books a started-but-outputless worker as silent_start with diagnosable text', () => {
    const result = classifyStaleExit({ startedAt: new Date(), turns: 2, costUsd: '0.000000' });
    expect(result.exitCause).toBe('silent_start');
    expect(result.error).toBe(SILENT_START_ERROR);
    expect(result.error).toContain('no output');
  });

  it('treats a worker that produced real turns as a plain infra_failure', () => {
    const result = classifyStaleExit({ startedAt: new Date(), turns: 37, costUsd: '0.140000' });
    expect(result.exitCause).toBe('infra_failure');
    expect(result.error).toBe(STALE_EXPIRED_ERROR);
  });

  it('treats a worker that spent money as a plain infra_failure even with few turns', () => {
    const result = classifyStaleExit({ startedAt: new Date(), turns: 1, costUsd: '0.010000' });
    expect(result.exitCause).toBe('infra_failure');
  });

  it('tolerates numeric and null cost/turn shapes', () => {
    expect(classifyStaleExit({ startedAt: new Date(), turns: null, costUsd: null }).exitCause).toBe('silent_start');
    expect(classifyStaleExit({ startedAt: new Date(), turns: 0, costUsd: 0 }).exitCause).toBe('silent_start');
  });
});

describe('consumesRetryAttempt', () => {
  it('charges code failures and unknown (legacy null) causes', () => {
    expect(consumesRetryAttempt('code_failure')).toBe(true);
    expect(consumesRetryAttempt(null)).toBe(true);
    expect(consumesRetryAttempt(undefined)).toBe(true);
  });

  it('does not charge external-constraint causes', () => {
    expect(consumesRetryAttempt('budget_limited')).toBe(false);
    expect(consumesRetryAttempt('infra_failure')).toBe(false);
    expect(consumesRetryAttempt('sandbox_mount_gap')).toBe(false);
    expect(consumesRetryAttempt('condition_unmet')).toBe(false);
  });

  it('does not charge a worker that was never started or never produced output', () => {
    expect(consumesRetryAttempt('never_started')).toBe(false);
    expect(consumesRetryAttempt('silent_start')).toBe(false);
  });
});
