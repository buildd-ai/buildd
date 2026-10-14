import { describe, it, expect } from 'bun:test';
import { taskPrFacts, taskHeaderMerged, isFallbackSummary } from './task-sections';

const pr = {
  prUrl: 'https://github.com/org/repo/pull/7',
  prNumber: 7,
  prLifecycleStatus: 'ci_running' as string | null,
  mergedAt: null as string | null,
  linesAdded: 10,
  linesRemoved: 2,
  filesChanged: 3,
};

describe('taskPrFacts: the PR card both the page and the sheet render', () => {
  it('is null without a PR', () => {
    expect(taskPrFacts(null)).toBeNull();
    expect(taskPrFacts({ ...pr, prUrl: null })).toBeNull();
    expect(taskPrFacts({ ...pr, prNumber: null })).toBeNull();
  });

  it('is null for a closed PR', () => {
    expect(taskPrFacts({ ...pr, prLifecycleStatus: 'closed' })).toBeNull();
  });

  it('reads a merged PR as merged whatever the column says', () => {
    const facts = taskPrFacts({ ...pr, mergedAt: '2026-10-13T10:00:00Z' })!;
    expect(facts.prLifecycleStatus).toBe('merged');
    expect(facts.prState).toBe('merged');
  });

  it("takes the delivery's state when the kernel owns the PR", () => {
    expect(taskPrFacts(pr, { prState: 'conflict' })!.prState).toBe('conflict');
    expect(taskPrFacts(pr, { prState: 'closed' })).toBeNull();
  });

  it('carries the diff size and the link', () => {
    expect(taskPrFacts(pr)).toMatchObject({ prUrl: pr.prUrl, prNumber: 7, linesAdded: 10, linesRemoved: 2, filesChanged: 3 });
  });
});

describe('taskHeaderMerged', () => {
  it('is true only for an ended task whose PR merged', () => {
    expect(taskHeaderMerged({ ...pr, mergedAt: 'x' }, 'completed')).toBe(true);
    expect(taskHeaderMerged({ ...pr, prLifecycleStatus: 'merged' }, 'completed')).toBe(true);
    expect(taskHeaderMerged({ ...pr, mergedAt: 'x' }, 'in_progress')).toBe(false);
    expect(taskHeaderMerged(pr, 'completed')).toBe(false);
    expect(taskHeaderMerged(null, 'completed')).toBe(false);
  });
});

describe('isFallbackSummary', () => {
  it('flags a summary taken from the last message', () => {
    expect(isFallbackSummary({ summarySource: 'fallback' })).toBe(true);
    expect(isFallbackSummary({ summarySource: 'worker' })).toBe(false);
    expect(isFallbackSummary(null)).toBe(false);
  });
});
