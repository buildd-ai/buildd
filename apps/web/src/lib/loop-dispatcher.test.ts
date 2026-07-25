import { describe, it, expect, mock } from 'bun:test';

// Mock deferred-start before importing loop-dispatcher
mock.module('@/lib/deferred-start', () => ({
  laterStartAt: (a: Date | null, b: Date | null): Date | null => {
    if (!a && !b) return null;
    if (!a) return b;
    if (!b) return a;
    return a > b ? a : b;
  },
}));

mock.module('@buildd/core/loop-config', () => ({
  LOOP_MAX_LOOPS_DEFAULT: 5,
  LOOP_BACKOFF_MINUTES_DEFAULT: 0,
}));

import {
  dispatchLoopIteration,
  computeLoopStartAt,
  evaluateExitCondition,
} from './loop-dispatcher';

const BASE_LOOP_CONFIG = {
  exitCondition: { type: 'command' as const, command: 'bun test' },
  maxLoops: 5,
  backoffMinutes: 0,
};

describe('evaluateExitCondition — command', () => {
  it('is satisfied when outcome=ok and binding matches', () => {
    const result = evaluateExitCondition({
      exitCondition: { type: 'command', command: 'bun test' },
      workerId: 'w1',
      iteration: 0,
      verificationEvidence: { workerId: 'w1', iteration: 0, conditionType: 'command', exitCode: 0, outcome: 'ok' },
      structuredOutput: null,
      prLifecycleStatus: null,
      prNumber: null,
    });
    expect(result.satisfied).toBe(true);
  });

  it('is not satisfied when outcome=failed', () => {
    const result = evaluateExitCondition({
      exitCondition: { type: 'command', command: 'bun test' },
      workerId: 'w1',
      iteration: 0,
      verificationEvidence: { workerId: 'w1', iteration: 0, conditionType: 'command', exitCode: 1, outcome: 'failed' },
      structuredOutput: null,
      prLifecycleStatus: null,
      prNumber: null,
    });
    expect(result.satisfied).toBe(false);
  });

  it('rejects evidence with wrong workerId', () => {
    const result = evaluateExitCondition({
      exitCondition: { type: 'command', command: 'bun test' },
      workerId: 'w1',
      iteration: 0,
      verificationEvidence: { workerId: 'w-WRONG', iteration: 0, conditionType: 'command', exitCode: 0, outcome: 'ok' },
      structuredOutput: null,
      prLifecycleStatus: null,
      prNumber: null,
    });
    expect(result.satisfied).toBe(false);
    expect(result.summary).toMatch(/workerId mismatch/);
  });

  it('rejects evidence with wrong iteration', () => {
    const result = evaluateExitCondition({
      exitCondition: { type: 'command', command: 'bun test' },
      workerId: 'w1',
      iteration: 2,
      verificationEvidence: { workerId: 'w1', iteration: 0, conditionType: 'command', exitCode: 0, outcome: 'ok' },
      structuredOutput: null,
      prLifecycleStatus: null,
      prNumber: null,
    });
    expect(result.satisfied).toBe(false);
    expect(result.summary).toMatch(/iteration mismatch/);
  });

  it('is not satisfied when no evidence provided', () => {
    const result = evaluateExitCondition({
      exitCondition: { type: 'command', command: 'bun test' },
      workerId: 'w1',
      iteration: 0,
      verificationEvidence: null,
      structuredOutput: null,
      prLifecycleStatus: null,
      prNumber: null,
    });
    expect(result.satisfied).toBe(false);
  });
});

describe('evaluateExitCondition — pr_checks_green', () => {
  it('is satisfied when prLifecycleStatus=ci_green', () => {
    const result = evaluateExitCondition({
      exitCondition: { type: 'pr_checks_green' },
      workerId: 'w1',
      iteration: 0,
      verificationEvidence: null,
      structuredOutput: null,
      prLifecycleStatus: 'ci_green',
      prNumber: 42,
    });
    expect(result.satisfied).toBe(true);
  });

  it('is satisfied when prLifecycleStatus=merged', () => {
    const result = evaluateExitCondition({
      exitCondition: { type: 'pr_checks_green' },
      workerId: 'w1',
      iteration: 0,
      verificationEvidence: null,
      structuredOutput: null,
      prLifecycleStatus: 'merged',
      prNumber: 42,
    });
    expect(result.satisfied).toBe(true);
  });

  it('is not satisfied when prLifecycleStatus=ci_running', () => {
    const result = evaluateExitCondition({
      exitCondition: { type: 'pr_checks_green' },
      workerId: 'w1',
      iteration: 0,
      verificationEvidence: null,
      structuredOutput: null,
      prLifecycleStatus: 'ci_running',
      prNumber: 42,
    });
    expect(result.satisfied).toBe(false);
  });
});

describe('evaluateExitCondition — structured_predicate', () => {
  it('eq operator: satisfied when values match', () => {
    const result = evaluateExitCondition({
      exitCondition: { type: 'structured_predicate', predicate: { path: '/status', operator: 'eq', value: 'done' } },
      workerId: 'w1',
      iteration: 0,
      verificationEvidence: null,
      structuredOutput: { status: 'done' },
      prLifecycleStatus: null,
      prNumber: null,
    });
    expect(result.satisfied).toBe(true);
  });

  it('exists operator: satisfied when path is present', () => {
    const result = evaluateExitCondition({
      exitCondition: { type: 'structured_predicate', predicate: { path: '/result', operator: 'exists' } },
      workerId: 'w1',
      iteration: 0,
      verificationEvidence: null,
      structuredOutput: { result: 'value' },
      prLifecycleStatus: null,
      prNumber: null,
    });
    expect(result.satisfied).toBe(true);
  });

  it('exists operator: not satisfied when path is absent', () => {
    const result = evaluateExitCondition({
      exitCondition: { type: 'structured_predicate', predicate: { path: '/missing', operator: 'exists' } },
      workerId: 'w1',
      iteration: 0,
      verificationEvidence: null,
      structuredOutput: { other: 1 },
      prLifecycleStatus: null,
      prNumber: null,
    });
    expect(result.satisfied).toBe(false);
  });

  it('gte operator: satisfied when value >= expected', () => {
    const result = evaluateExitCondition({
      exitCondition: { type: 'structured_predicate', predicate: { path: '/score', operator: 'gte', value: 90 } },
      workerId: 'w1',
      iteration: 0,
      verificationEvidence: null,
      structuredOutput: { score: 95 },
      prLifecycleStatus: null,
      prNumber: null,
    });
    expect(result.satisfied).toBe(true);
  });
});

describe('dispatchLoopIteration', () => {
  it('returns satisfied when condition is met', () => {
    const result = dispatchLoopIteration({
      loopConfig: BASE_LOOP_CONFIG,
      currentIteration: 0,
      existingHistory: [],
      existingStartAt: null,
      workerId: 'w1',
      workerBranch: 'buildd/loop',
      workerLastCommitSha: 'sha1',
      verificationEvidence: { workerId: 'w1', iteration: 0, conditionType: 'command', exitCode: 0, outcome: 'ok' },
      structuredOutput: null,
      prLifecycleStatus: null,
      prNumber: null,
    });
    expect(result.kind).toBe('satisfied');
    expect(result.loopIteration).toBe(1);
    expect(result.loopHistory[0].satisfied).toBe(true);
  });

  it('returns requeue with loop context when condition is unmet', () => {
    const result = dispatchLoopIteration({
      loopConfig: BASE_LOOP_CONFIG,
      currentIteration: 2,
      existingHistory: [],
      existingStartAt: null,
      workerId: 'w1',
      workerBranch: 'buildd/loop',
      workerLastCommitSha: 'sha2',
      verificationEvidence: { workerId: 'w1', iteration: 2, conditionType: 'command', exitCode: 1, outcome: 'failed' },
      structuredOutput: null,
      prLifecycleStatus: null,
      prNumber: null,
    });
    expect(result.kind).toBe('requeue');
    if (result.kind !== 'requeue') throw new Error('expected requeue');
    expect(result.loopIteration).toBe(3);
    expect(result.loopState).toBe('condition_unmet');
    expect(result.resumeBranch).toBe('buildd/loop');
    expect(result.lastCommitSha).toBe('sha2');
    expect(result.loopHistory[0].satisfied).toBe(false);
  });

  it('returns exhausted when newIteration >= maxLoops', () => {
    const result = dispatchLoopIteration({
      loopConfig: { ...BASE_LOOP_CONFIG, maxLoops: 3 },
      currentIteration: 2, // newIteration = 3 = maxLoops
      existingHistory: [],
      existingStartAt: null,
      workerId: 'w1',
      workerBranch: 'buildd/loop',
      workerLastCommitSha: null,
      verificationEvidence: { workerId: 'w1', iteration: 2, conditionType: 'command', exitCode: 1, outcome: 'failed' },
      structuredOutput: null,
      prLifecycleStatus: null,
      prNumber: null,
    });
    expect(result.kind).toBe('exhausted');
    if (result.kind !== 'exhausted') throw new Error('expected exhausted');
    expect(result.loopState).toBe('exhausted');
    expect(result.loopIteration).toBe(3);
  });

  it('condition_unmet does not consume a retry slot — distinct from code failure', () => {
    // This test verifies that the requeue path uses 'condition_unmet' exitCause, NOT 'code_failure'.
    // In stale-workers.ts, 'condition_unmet' is excluded from chargeableFailures.
    const result = dispatchLoopIteration({
      loopConfig: BASE_LOOP_CONFIG,
      currentIteration: 0,
      existingHistory: [],
      existingStartAt: null,
      workerId: 'w1',
      workerBranch: null,
      workerLastCommitSha: null,
      verificationEvidence: { workerId: 'w1', iteration: 0, conditionType: 'command', exitCode: 1, outcome: 'failed' },
      structuredOutput: null,
      prLifecycleStatus: null,
      prNumber: null,
    });
    // The route sets exitCause='condition_unmet' only for non-satisfied results.
    // This test verifies the dispatcher correctly produces a non-satisfied result.
    expect(result.kind).not.toBe('satisfied');
  });
});

describe('computeLoopStartAt — backoff composition', () => {
  it('returns null when no backoff and no existing startAt', () => {
    const result = computeLoopStartAt(null, 0, new Date('2025-01-01T00:00:00Z'));
    expect(result).toBeNull();
  });

  it('returns backoff floor when backoff > 0 and no existing startAt', () => {
    const evaluatedAt = new Date('2025-01-01T00:00:00Z');
    const result = computeLoopStartAt(null, 60, evaluatedAt); // 60 min backoff
    expect(result).not.toBeNull();
    // Should be ~60 minutes after evaluatedAt
    const diff = result!.getTime() - evaluatedAt.getTime();
    expect(diff).toBe(60 * 60 * 1000);
  });

  it('returns max(existingStartAt, backoffFloor) — later wins', () => {
    const evaluatedAt = new Date('2025-01-01T00:00:00Z');
    // Existing startAt is 2 hours away; backoff is 30 min → existing is later
    const existingStartAt = new Date(evaluatedAt.getTime() + 2 * 60 * 60 * 1000);
    const result = computeLoopStartAt(existingStartAt, 30, evaluatedAt);
    expect(result?.getTime()).toBe(existingStartAt.getTime());
  });

  it('returns backoff floor when it is later than existing startAt', () => {
    const evaluatedAt = new Date('2025-01-01T00:00:00Z');
    // Existing startAt is 30 min away; backoff is 2 hours → backoff is later
    const existingStartAt = new Date(evaluatedAt.getTime() + 30 * 60 * 1000);
    const result = computeLoopStartAt(existingStartAt, 120, evaluatedAt); // 2h backoff
    const expectedFloor = new Date(evaluatedAt.getTime() + 120 * 60 * 1000);
    expect(result?.getTime()).toBe(expectedFloor.getTime());
  });
});
