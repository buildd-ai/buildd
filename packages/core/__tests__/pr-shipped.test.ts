import { describe, it, expect } from 'bun:test';
import {
  prShipState,
  isPrShipped,
  deriveLineageSupersession,
  summarizePrShipStates,
  countDistinctPrs,
} from '../pr-shipped';

const pr = (n: number) => `https://github.com/org/repo/pull/${n}`;

describe('prShipState — the one shipped predicate', () => {
  it('no PR is no_pr, and not shipped (nothing to judge)', () => {
    expect(prShipState({ prUrl: null })).toBe('no_pr');
    expect(prShipState(undefined)).toBe('no_pr');
    expect(isPrShipped({ prUrl: null })).toBe(false);
  });

  it('merged is shipped', () => {
    expect(prShipState({ prUrl: pr(1), mergedAt: '2026-01-01' })).toBe('merged');
    expect(isPrShipped({ prUrl: pr(1), mergedAt: '2026-01-01' })).toBe(true);
  });

  it('closed with a supersession edge is shipped', () => {
    const w = { prUrl: pr(1), prLifecycleStatus: 'closed', supersededByPrNumber: 2 };
    expect(prShipState(w)).toBe('superseded');
    expect(isPrShipped(w)).toBe(true);
  });

  it('closed with no edge is closed_unsuperseded, not shipped', () => {
    const w = { prUrl: pr(1), prLifecycleStatus: 'closed' };
    expect(prShipState(w)).toBe('closed_unsuperseded');
    expect(isPrShipped(w)).toBe(false);
  });

  it('open / CI-failing / conflicted are open, not shipped', () => {
    for (const s of ['pr_open', 'ci_failed', 'conflict', null]) {
      expect(prShipState({ prUrl: pr(1), prLifecycleStatus: s })).toBe('open');
    }
  });
});

describe('deriveLineageSupersession — mechanical, attempt-lineage only', () => {
  const tasks = [
    { id: 'root', taskClass: 'work', parentTaskId: null },
    { id: 'retry', taskClass: 'attempt', parentTaskId: 'root' },
    { id: 'retry2', taskClass: 'attempt', parentTaskId: 'retry' },
    // A spawned builder under a plan: has a parent, but is its own deliverable.
    { id: 'sibling', taskClass: 'work', parentTaskId: 'root' },
  ];

  it('a closed PR followed by a merged PR from its own attempt chain is derived superseded', () => {
    const out = deriveLineageSupersession(tasks, [
      { taskId: 'root', prUrl: pr(10), prNumber: 10, prLifecycleStatus: 'closed' },
      { taskId: 'retry2', prUrl: pr(12), prNumber: 12, mergedAt: '2026-01-02' },
    ]);
    expect(out[0].supersededByPrNumber).toBe(12);
    expect(out[0].supersededByPrUrl).toBe(pr(12));
    expect(out[0].supersessionDerived).toBe(true);
    expect(prShipState(out[0])).toBe('superseded');
  });

  it('never derives for an OPEN PR (M4) — it is still awaiting merge', () => {
    const out = deriveLineageSupersession(tasks, [
      { taskId: 'root', prUrl: pr(10), prNumber: 10, prLifecycleStatus: 'pr_open' },
      { taskId: 'retry', prUrl: pr(12), prNumber: 12, mergedAt: '2026-01-02' },
    ]);
    expect(out[0].supersededByPrNumber).toBeUndefined();
    expect(prShipState(out[0])).toBe('open');
  });

  it('never derives from an EARLIER merged PR — the successor must come after', () => {
    const out = deriveLineageSupersession(tasks, [
      { taskId: 'retry', prUrl: pr(14), prNumber: 14, prLifecycleStatus: 'closed' },
      { taskId: 'root', prUrl: pr(10), prNumber: 10, mergedAt: '2026-01-02' },
    ]);
    expect(prShipState(out[0])).toBe('closed_unsuperseded');
  });

  it('never derives across independent deliverables, even parent/child spawned builders', () => {
    const out = deriveLineageSupersession(tasks, [
      { taskId: 'root', prUrl: pr(10), prNumber: 10, prLifecycleStatus: 'closed' },
      { taskId: 'sibling', prUrl: pr(12), prNumber: 12, mergedAt: '2026-01-02' },
    ]);
    expect(prShipState(out[0])).toBe('closed_unsuperseded');
  });

  it('leaves a recorded edge untouched', () => {
    const out = deriveLineageSupersession(tasks, [
      { taskId: 'root', prUrl: pr(10), prNumber: 10, prLifecycleStatus: 'closed', supersededByPrNumber: 99 },
      { taskId: 'retry', prUrl: pr(12), prNumber: 12, mergedAt: '2026-01-02' },
    ]);
    expect(out[0].supersededByPrNumber).toBe(99);
    expect(out[0].supersessionDerived).toBeUndefined();
  });

  it('reads the PR number from the URL when prNumber is absent', () => {
    const out = deriveLineageSupersession(tasks, [
      { taskId: 'root', prUrl: pr(10), prLifecycleStatus: 'closed' },
      { taskId: 'retry', prUrl: pr(12), mergedAt: '2026-01-02' },
    ]);
    expect(out[0].supersededByPrNumber).toBe(12);
  });
});

describe('summarizePrShipStates — one verdict per PR', () => {
  it('a PR two workers carried counts as merged when either row saw the merge', () => {
    const out = summarizePrShipStates([
      { taskId: 't', prUrl: pr(5), prNumber: 5, mergedAt: null },
      { taskId: 't', prUrl: pr(5), prNumber: 5, mergedAt: '2026-01-01' },
    ]);
    expect(out).toEqual([{ prUrl: pr(5), prNumber: 5, state: 'merged', supersededByPrNumber: null }]);
  });
});

// A CI-retry task (`[builder · after CI #1] …`) pushes to its parent's PR, so
// the mission has two worker rows carrying one PR. Every display count is of
// PRs, not of rows.
describe('countDistinctPrs — PRs by identity, not by worker row', () => {
  it('a parent and its CI retry sharing one PR count once', () => {
    expect(countDistinctPrs([
      { prUrl: pr(7), prNumber: 7, mergedAt: '2026-01-01' },
      { prUrl: pr(7), prNumber: 7, mergedAt: null },
    ])).toBe(1);
  });

  it('distinct PRs count separately and rows without a PR count as nothing', () => {
    expect(countDistinctPrs([
      { prUrl: pr(1) },
      { prUrl: pr(2) },
      { prUrl: null },
      { prUrl: undefined },
      { prUrl: '' },
    ])).toBe(2);
  });

  it('same number in different repos is two PRs', () => {
    expect(countDistinctPrs([
      { prUrl: 'https://github.com/org/a/pull/3' },
      { prUrl: 'https://github.com/org/b/pull/3' },
    ])).toBe(2);
  });

  it('merged filter counts a PR once when any row saw the merge', () => {
    const rows = [
      { prUrl: pr(7), mergedAt: null },
      { prUrl: pr(7), mergedAt: '2026-01-01' },
      { prUrl: pr(8), mergedAt: null },
    ];
    expect(countDistinctPrs(rows, { mergedOnly: true })).toBe(1);
  });
});
