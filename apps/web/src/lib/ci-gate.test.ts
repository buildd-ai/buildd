import { describe, it, expect } from 'bun:test';
import { resolveCiGate } from './ci-gate';

describe('resolveCiGate', () => {
  it('returns null when the PR has no CI state', () => {
    expect(resolveCiGate({ prLifecycleStatus: 'pr_open' })).toBeNull();
    expect(resolveCiGate({ prLifecycleStatus: null })).toBeNull();
  });

  it('returns null once CI is green — the merge is genuinely on the human', () => {
    expect(resolveCiGate({ prLifecycleStatus: 'ci_green' })).toBeNull();
  });

  it('reports checks in progress as a running gate', () => {
    expect(resolveCiGate({ prLifecycleStatus: 'ci_running' })).toEqual({
      kind: 'running',
      label: 'CI running',
    });
  });

  it('reports a live fix attempt with its iteration', () => {
    expect(resolveCiGate({
      prLifecycleStatus: 'ci_failed',
      liveFixTaskId: 'fix-1',
      liveFixIteration: 2,
      maxCiRetries: 3,
    })).toEqual({
      kind: 'fixing',
      label: 'Fixing CI · attempt 2 of 3',
      taskId: 'fix-1',
    });
  });

  it('drops the iteration from the label when it is unknown', () => {
    expect(resolveCiGate({ prLifecycleStatus: 'ci_failed', liveFixTaskId: 'fix-1' })).toEqual({
      kind: 'fixing',
      label: 'Fixing CI',
      taskId: 'fix-1',
    });
  });

  it('treats a live fix on a still-running suite as fixing, not running', () => {
    const gate = resolveCiGate({ prLifecycleStatus: 'ci_running', liveFixTaskId: 'fix-1' });
    expect(gate?.kind).toBe('fixing');
  });

  it('blocks with the exhausted count when retries ran out', () => {
    expect(resolveCiGate({
      prLifecycleStatus: 'ci_failed',
      maxCiRetries: 3,
      attemptsConsumed: 3,
      recommendation: 'Pin the flaky migration test, then re-run.',
    })).toEqual({
      kind: 'blocked',
      reason: 'CI failing — 3 fix attempts exhausted',
      recommendation: 'Pin the flaky migration test, then re-run.',
    });
  });

  it('singularises a single exhausted attempt', () => {
    const gate = resolveCiGate({ prLifecycleStatus: 'ci_failed', maxCiRetries: 1, attemptsConsumed: 1 });
    expect(gate).toEqual({
      kind: 'blocked',
      reason: 'CI failing — 1 fix attempt exhausted',
      recommendation: null,
    });
  });

  it('says so when automatic retries are disabled for the workspace', () => {
    expect(resolveCiGate({ prLifecycleStatus: 'ci_failed', maxCiRetries: 0 })).toEqual({
      kind: 'blocked',
      reason: 'CI failing — automatic fix retries are disabled',
      recommendation: null,
    });
  });

  it('blocks with no fix in flight when retries remain but nothing is running', () => {
    expect(resolveCiGate({
      prLifecycleStatus: 'ci_failed',
      maxCiRetries: 3,
      attemptsConsumed: 1,
    })).toEqual({
      kind: 'blocked',
      reason: 'CI failing — no fix in flight',
      recommendation: null,
    });
  });
});
