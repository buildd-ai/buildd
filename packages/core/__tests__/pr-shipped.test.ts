import { describe, it, expect } from 'bun:test';
import {
  prShipState,
  isPrShipped,
  isPrUnshipped,
  deriveLineageSupersession,
  summarizePrShipStates,
  countDistinctPrs,
  withDeliveryShip,
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

  it('closed and declared abandoned is settled: neither shipped nor blocking', () => {
    const w = { prUrl: pr(1), prLifecycleStatus: 'closed', abandonedAt: '2026-01-02' };
    expect(prShipState(w)).toBe('abandoned');
    expect(isPrShipped(w)).toBe(false);
    expect(isPrUnshipped(w)).toBe(false);
  });

  it('abandonedAt on a PR that is still open changes nothing', () => {
    const w = { prUrl: pr(1), prLifecycleStatus: 'pr_open', abandonedAt: '2026-01-02' };
    expect(prShipState(w)).toBe('open');
    expect(isPrUnshipped(w)).toBe(true);
  });

  it('open / CI-failing / conflicted are open, not shipped', () => {
    for (const s of ['pr_open', 'ci_failed', 'conflict', null]) {
      expect(prShipState({ prUrl: pr(1), prLifecycleStatus: s })).toBe('open');
    }
  });
});

// Slice D of the workflow kernel (docs/specs/workflow-state-kernel.md §17.3, S16): for a PR
// the kernel owns, the delivery is the authority and the worker columns are only its
// projection, which can lag (the projection is an effect). Absent delivery = today's answer.
describe('prShipState — reads the delivery when the kernel owns the PR', () => {
  const open = { prUrl: pr(1), prLifecycleStatus: 'pr_open' };

  it('maps every delivery state onto the same five answers', () => {
    expect(prShipState({ ...open, delivery: { state: 'MERGED' } })).toBe('merged');
    expect(prShipState({ ...open, delivery: { state: 'SUPERSEDED' } })).toBe('superseded');
    expect(prShipState({ ...open, delivery: { state: 'ABANDONED' } })).toBe('abandoned');
    expect(prShipState({ ...open, delivery: { state: 'CLOSED_UNMERGED' } })).toBe('closed_unsuperseded');
    for (const s of ['WORKING', 'AWAITING_PUSH', 'AWAITING_REVIEW', 'CHANGES_REQUESTED', 'FIXING', 'REPAIRING', 'BLOCKED_ON_TRUNK', 'APPROVED', 'LANDING', 'ESCALATED']) {
      expect(prShipState({ ...open, delivery: { state: s } })).toBe('open');
    }
  });

  it('the delivery wins over a projection that has not caught up, in both directions', () => {
    // Merged by the kernel; stamp_pr_rows not run yet.
    expect(prShipState({ ...open, mergedAt: null, delivery: { state: 'MERGED' } })).toBe('merged');
    // A stray supersession column on a delivery the kernel still reads as closed is not an edge.
    const stray = { prUrl: pr(1), prLifecycleStatus: 'closed', supersededByPrNumber: 2, delivery: { state: 'CLOSED_UNMERGED' } };
    expect(prShipState(stray)).toBe('closed_unsuperseded');
    expect(isPrUnshipped(stray)).toBe(true);
  });

  it('lineage-derived supersession still applies to a kernel-closed PR (a read-time proof, not a write)', () => {
    const tasks = [
      { id: 'root', taskClass: 'work', parentTaskId: null },
      { id: 'retry', taskClass: 'attempt', parentTaskId: 'root' },
    ];
    const [derived] = deriveLineageSupersession(tasks, [
      { taskId: 'root', prUrl: pr(10), prNumber: 10, prLifecycleStatus: 'closed', delivery: { state: 'CLOSED_UNMERGED' } },
      { taskId: 'retry', prUrl: pr(11), prNumber: 11, mergedAt: '2026-01-03' },
    ]);
    expect(derived.supersessionDerived).toBe(true);
    expect(prShipState(derived)).toBe('superseded');
  });

  it('no delivery (legacy, released, or never opened): identical to the column answer', () => {
    for (const w of [
      { prUrl: pr(1), mergedAt: '2026-01-01' },
      { prUrl: pr(1), prLifecycleStatus: 'closed', supersededByPrNumber: 2 },
      { prUrl: pr(1), prLifecycleStatus: 'closed', abandonedAt: '2026-01-02' },
      { prUrl: pr(1), prLifecycleStatus: 'closed' },
      { prUrl: pr(1), prLifecycleStatus: 'ci_failed' },
    ]) {
      expect(prShipState({ ...w, delivery: null })).toBe(prShipState(w));
    }
  });

  it('a FAILED delivery carries no PR: the columns answer', () => {
    expect(prShipState({ prUrl: pr(1), mergedAt: '2026-01-01', delivery: { state: 'FAILED' } })).toBe('merged');
  });
});

describe('withDeliveryShip — the delivery onto the row a mission reader judges', () => {
  const row = { prUrl: pr(1), prNumber: 1, prLifecycleStatus: 'closed', supersededByPrNumber: null, supersededByPrUrl: null, supersededReason: null, abandonedReason: null };

  it('no delivery: the row, untouched', () => {
    expect(withDeliveryShip(row, null)).toBe(row);
  });

  it('a superseded delivery whose projection has not run yet still names its PR', () => {
    const w = withDeliveryShip(row, { state: 'SUPERSEDED', supersededByPr: 9, supersededByUrl: pr(9), supersededReason: 'landed in #9' });
    expect(prShipState(w)).toBe('superseded');
    expect(w).toMatchObject({ supersededByPrNumber: 9, supersededByPrUrl: pr(9), supersededReason: 'landed in #9' });
  });

  it('an abandoned delivery carries the person\'s reason; an open one reads open whatever the columns say', () => {
    expect(withDeliveryShip(row, { state: 'ABANDONED', stateReason: 'plan changed' })).toMatchObject({ abandonedReason: 'plan changed' });
    expect(prShipState(withDeliveryShip(row, { state: 'AWAITING_REVIEW' }))).toBe('open');
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
