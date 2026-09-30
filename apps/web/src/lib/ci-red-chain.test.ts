import { describe, it, expect } from 'bun:test';
import { ciAttemptOrdinal, failingJobsFromSummary, deriveCiRedChain, deriveCiRedChains } from './ci-red-chain';

describe('ciAttemptOrdinal', () => {
  it('reads N from a CI-fix attempt title', () => {
    expect(ciAttemptOrdinal('[builder · after CI #3] Ship the thing')).toBe(3);
  });
  it('is null for other attempts and plain tasks', () => {
    expect(ciAttemptOrdinal('[builder · after review #2] Ship the thing')).toBeNull();
    expect(ciAttemptOrdinal('[reviewer #2] PR #9: x')).toBeNull();
    expect(ciAttemptOrdinal('Ship the thing')).toBeNull();
  });
});

describe('failingJobsFromSummary', () => {
  it('lists the failed job names the CI retry summary carries, once each', () => {
    const s = 'CI failed on o/r (run: u)\n\nJob "build" failed:\n  - Step "Type check" failed\n\nJob "Schema Drift / check" failed\n\nJob "build" failed';
    expect(failingJobsFromSummary(s)).toEqual(['build', 'Schema Drift / check']);
  });
  it('is empty for text with no job lines', () => {
    expect(failingJobsFromSummary('tsc failed')).toEqual([]);
    expect(failingJobsFromSummary(undefined)).toEqual([]);
  });
});

describe('deriveCiRedChain', () => {
  const pr = { taskId: 'root', prNumber: 12 };
  const attempt = (n: number, status: string, extra: Record<string, unknown> = {}) => ({
    id: `fix-${n}`, title: `[builder · after CI #${n}] Ship`, status, context: { prNumber: 12, ...((extra.context as object) ?? {}) }, workers: [], ...extra,
  });

  it('is a chain when CI is red, attempts have run, and none is open', () => {
    const chain = deriveCiRedChain({
      pr, prLifecycleStatus: 'ci_failed',
      tasks: [attempt(1, 'completed'), attempt(2, 'completed'), attempt(3, 'completed', {
        context: { prNumber: 12, failureContext: { summary: 'Job "build" failed:\n  - Step "x" failed' } },
      })],
    });
    expect(chain).toEqual({ taskId: 'root', prNumber: 12, attempts: 3, failing: ['build'] });
  });

  it('is null while an attempt is still open', () => {
    expect(deriveCiRedChain({ pr, prLifecycleStatus: 'ci_failed', tasks: [attempt(1, 'completed'), attempt(2, 'pending')] })).toBeNull();
  });

  it('is null unless the PR\'s CI is red', () => {
    for (const s of ['ci_green', 'ci_running', 'pr_open', null]) {
      expect(deriveCiRedChain({ pr, prLifecycleStatus: s, tasks: [attempt(1, 'completed')] })).toBeNull();
    }
  });

  it('is null when no CI-fix attempt ran (that is Home\'s "no fix in flight", not an exhausted chain)', () => {
    expect(deriveCiRedChain({ pr, prLifecycleStatus: 'ci_failed', tasks: [] })).toBeNull();
  });

  it('ignores attempts on another PR, and non-CI attempts', () => {
    expect(deriveCiRedChain({
      pr, prLifecycleStatus: 'ci_failed',
      tasks: [attempt(1, 'completed', { context: { prNumber: 99 } }), { id: 'r', title: '[builder · after review #1] x', status: 'completed', context: { prNumber: 12 }, workers: [] }],
    })).toBeNull();
  });

  it('matches an attempt by its worker\'s PR when the row carries no context', () => {
    const t = { id: 'fix-1', title: '[builder · after CI #1] Ship', status: 'completed', workers: [{ prNumber: 12 }] };
    expect(deriveCiRedChain({ pr, prLifecycleStatus: 'ci_failed', tasks: [t] })?.attempts).toBe(1);
  });
});

describe('deriveCiRedChains', () => {
  const owner = { id: 'root', title: 'Ship', status: 'completed', workers: [{ prNumber: 12, prLifecycleStatus: 'ci_failed' }] };
  const fix = (n: number, status = 'completed') => ({
    id: `fix-${n}`, title: `[builder · after CI #${n}] Ship`, status, parentTaskId: 'root',
    workers: [{ prNumber: 12, prLifecycleStatus: null }],
  });

  it('reads the lifecycle off the owner row and the attempts off its children', () => {
    expect(deriveCiRedChains([{ taskId: 'root', prNumber: 12 }], [owner, fix(1), fix(2)]))
      .toEqual([{ taskId: 'root', prNumber: 12, attempts: 2, failing: [] }]);
  });

  it('skips a PR whose owner is green, and one with no number', () => {
    const green = { ...owner, workers: [{ prNumber: 12, prLifecycleStatus: 'ci_green' }] };
    expect(deriveCiRedChains([{ taskId: 'root', prNumber: 12 }], [green, fix(1)])).toEqual([]);
    expect(deriveCiRedChains([{ taskId: 'root', prNumber: null }], [owner, fix(1)])).toEqual([]);
  });

  it('is empty while a fix is still open', () => {
    expect(deriveCiRedChains([{ taskId: 'root', prNumber: 12 }], [owner, fix(1, 'in_progress')])).toEqual([]);
  });
});
