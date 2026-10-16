/**
 * workflow-kernel-library.md §7: a delivery-owned task's PR lifecycle is the
 * delivery's, read on the way in, so every derivation that reads worker rows
 * agrees with the kernel; and a worker row that disagrees is named (AC-26).
 */
import { describe, expect, test } from 'bun:test';
import { deliveryDisagreements, overlayDeliveryLifecycle, prLifecycleFor, workerLifecycleOf } from './delivery-overlay';
import type { DeliveryView } from './workflow/projections';

const V = (o: Partial<DeliveryView> = {}): DeliveryView => ({
  deliveryId: 'd1', ownerTaskId: 't1', repoFullName: 'acme/app', prNumber: 7, state: 'AWAITING_REVIEW', stateReason: null, version: 3,
  headSha: 'H1', stage: 'review', owner: 'reviewer', needsYou: false, headline: 'Review queued', detail: null, compositionVerified: false,
  attempts: {}, currentAttempt: null, history: [], cta: null, prState: 'ci_passed', mergedAt: null, supersededBy: null, lastTransition: null,
  rounds: [], ledger: [], approvedCurrentHead: false, approvalBasis: null, findings: [], openFindings: 0, ...o,
});
const MERGED_AT = new Date('2026-10-01T00:00:00Z');
const task = (workers: Array<Record<string, unknown>>, id = 't1') => ({ id, title: 'feat: x', workers });

describe('workerLifecycleOf', () => {
  test('each delivery state in the worker columns\' own words', () => {
    expect(workerLifecycleOf(V())).toEqual({ mergedAt: null, prLifecycleStatus: 'ci_green' });
    expect(workerLifecycleOf(V({ prState: 'awaiting_ci' }))).toEqual({ mergedAt: null, prLifecycleStatus: 'pr_open' });
    expect(workerLifecycleOf(V({ state: 'REPAIRING', stateReason: 'conflict', prState: 'conflict' }))).toEqual({ mergedAt: null, prLifecycleStatus: 'conflict' });
    expect(workerLifecycleOf(V({ state: 'MERGED', prState: 'merged', mergedAt: MERGED_AT.toISOString() }))).toEqual({ mergedAt: MERGED_AT, prLifecycleStatus: 'merged' });
    expect(workerLifecycleOf(V({ state: 'CLOSED_UNMERGED', prState: 'closed' }))).toEqual({ mergedAt: null, prLifecycleStatus: 'closed' });
  });
});

describe('overlayDeliveryLifecycle', () => {
  test('AC-26: a worker row that says merged reads in review when its delivery is in review', () => {
    const [t] = overlayDeliveryLifecycle([task([{ id: 'w1', prNumber: 7, prUrl: 'u', mergedAt: MERGED_AT, prLifecycleStatus: 'merged' }])], new Map([['t1', V()]]));
    expect(t!.workers[0]).toMatchObject({ id: 'w1', mergedAt: null, prLifecycleStatus: 'ci_green' });
  });

  test('a delivery merge reads merged even before the worker row is stamped', () => {
    const v = V({ state: 'MERGED', prState: 'merged', mergedAt: MERGED_AT.toISOString() });
    const [t] = overlayDeliveryLifecycle([task([{ id: 'w1', prNumber: 7, prUrl: 'u', mergedAt: null, prLifecycleStatus: 'ci_green' }])], new Map([['t1', v]]));
    expect(t!.workers[0]).toMatchObject({ mergedAt: MERGED_AT, prLifecycleStatus: 'merged' });
  });

  test('a task without a delivery, an attempt task, and a worker on another PR keep their rows', () => {
    const legacy = task([{ id: 'w1', prNumber: 9, mergedAt: MERGED_AT, prLifecycleStatus: 'merged' }], 'legacy');
    const attempt = task([{ id: 'w2', prNumber: 7, mergedAt: MERGED_AT, prLifecycleStatus: 'merged' }], 'fix1');
    const other = task([{ id: 'w3', prNumber: 8, mergedAt: MERGED_AT, prLifecycleStatus: 'merged' }]);
    const views = new Map([['t1', V()], ['fix1', V()]]);
    const out = overlayDeliveryLifecycle([legacy, attempt, other], views);
    expect(out[0]).toBe(legacy);
    expect(out[1]).toBe(attempt);
    expect(out[2]!.workers[0]).toMatchObject({ mergedAt: MERGED_AT, prLifecycleStatus: 'merged' });
  });

  test('never mutates its input', () => {
    const w = { id: 'w1', prNumber: 7, mergedAt: MERGED_AT, prLifecycleStatus: 'merged' };
    overlayDeliveryLifecycle([task([w])], new Map([['t1', V()]]));
    expect(w.mergedAt).toBe(MERGED_AT);
  });
});

describe('deliveryDisagreements (AC-26)', () => {
  test('names a worker row that says merged while the delivery is not', () => {
    const d = deliveryDisagreements([task([{ id: 'w1', prNumber: 7, mergedAt: MERGED_AT, prLifecycleStatus: 'merged' }])], new Map([['t1', V()]]));
    expect(d).toEqual([{ taskId: 't1', title: 'feat: x', workerId: 'w1', prNumber: 7, worker: 'merged', delivery: 'AWAITING_REVIEW', headline: 'Review queued' }]);
  });
  test('and the other way: the delivery merged, the worker row still open', () => {
    const d = deliveryDisagreements([task([{ id: 'w1', prNumber: 7, mergedAt: null, prLifecycleStatus: 'ci_green' }])], new Map([['t1', V({ state: 'MERGED', prState: 'merged', headline: 'Merged' })]]));
    expect(d).toMatchObject([{ worker: 'open', delivery: 'MERGED' }]);
  });
  test('agreement, and rows with no delivery, are not disagreements', () => {
    expect(deliveryDisagreements([task([{ id: 'w1', prNumber: 7, mergedAt: null, prLifecycleStatus: 'ci_green' }])], new Map([['t1', V()]]))).toEqual([]);
    expect(deliveryDisagreements([task([{ id: 'w1', prNumber: 7, mergedAt: MERGED_AT }])], new Map())).toEqual([]);
  });
});

describe('prLifecycleFor (the task page)', () => {
  const w = { id: 'w1', prNumber: 7, mergedAt: MERGED_AT, prLifecycleStatus: 'merged' };
  test('AC-26: the delivery\'s reading for the PR it owns', () => {
    expect(prLifecycleFor(w, V(), 't1')).toEqual({ mergedAt: null, prLifecycleStatus: 'ci_green' });
  });
  test('the worker\'s own columns without a delivery, for another task\'s delivery, or another PR', () => {
    expect(prLifecycleFor(w, null, 't1')).toEqual({ mergedAt: MERGED_AT, prLifecycleStatus: 'merged' });
    expect(prLifecycleFor(w, V({ ownerTaskId: 'other' }), 't1')).toEqual({ mergedAt: MERGED_AT, prLifecycleStatus: 'merged' });
    expect(prLifecycleFor({ ...w, prNumber: 8 }, V(), 't1')).toEqual({ mergedAt: MERGED_AT, prLifecycleStatus: 'merged' });
    expect(prLifecycleFor(null, V(), 't1')).toEqual({ mergedAt: null, prLifecycleStatus: null });
  });
});
