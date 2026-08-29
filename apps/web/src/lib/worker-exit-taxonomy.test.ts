import { describe, it, expect } from 'bun:test';
import {
  classifyReportedFailure,
  consumesRetryAttempt,
  isConcurrencyConflictError,
} from './worker-exit-taxonomy';

describe('classifyReportedFailure', () => {
  it('defaults to code_failure', () => {
    expect(classifyReportedFailure({ budgetLimited: false, sandboxMountGap: false })).toBe('code_failure');
  });

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
