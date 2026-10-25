/**
 * 221c7b95: an approved, behind PR parked in the landing lane waits a bounded time. A park
 * hands its attempt back, so before this a waiter could re-park every backstop for as long as
 * other PRs kept taking the lane (#5658 sat 11.5h at "Branch update in progress" while dev
 * took a merge every ~15 min). Past LANE_MAX_WAIT_MS it refreshes beside the lane. Fake ports.
 */
import { describe, expect, test } from 'bun:test';
import { conflictHandlers } from './conflict';
import { LANE_MAX_WAIT_MS, LANE_PARK_BACKSTOP_MS } from '../landing-lane';
import type { KernelPorts } from '../ports';

const HEAD = 'abcdef1234';
const delivery = {
  id: 'd1', workspaceId: 'w1', repoFullName: 'acme/app', prNumber: 12, baseRef: 'dev', state: 'REPAIRING', stateReason: 'behind', version: 4,
  currentHeadSha: HEAD, boundAttemptId: 'a1', approvedHeads: [HEAD], approvalBasis: 'verdict', compositionHeads: [], currentRound: 1, ci: 'green', ciHeadSha: HEAD,
};
const attempt = { id: 'a1', family: 'conflict', mode: 'mechanical', status: 'queued', triggerReason: 'behind', boundHeadSha: HEAD, attemptNo: 1, maxAttempts: 1 };

function harness(o: { lane?: 'off' | 'shadow' | 'enforce'; acquired?: boolean } = {}) {
  const calls = { refresh: 0, ingested: 0, acquire: 0 };
  const github = {
    readPr: async () => ({ state: 'open', merged: false, headSha: HEAD, baseRef: 'dev', mergeableState: 'behind' }),
    statusOf: async () => null,
    writes: { publishStatus: async () => {} },
  };
  const ports = {
    store: {
      loadView: async () => ({ delivery, rounds: [], attempts: [attempt], findings: [] }),
      acquireLane: async () => { calls.acquire++; return o.acquired ?? false; },
      laneHolder: async () => ({ deliveryId: 'd0', prNumber: 7 }),
    },
    policy: { forWorkspace: async () => ({ landingLane: o.lane ?? 'enforce', maxConflictIterations: 3 }) },
    conflicts: {
      botOwned: async () => false,
      refresh: async () => { calls.refresh++; return { kind: 'updated' }; },
    },
    ingest: { ingest: async () => { calls.ingested++; return { result: 'applied' }; } },
    github,
  } as unknown as KernelPorts;
  return { ports, calls };
}
const effect = (ageMs?: number) =>
  ({ id: 'e1', deliveryId: 'd1', transitionId: 't1', kind: 'refresh_branch', dedupeKey: 'k', payload: { attemptId: 'a1' }, attemptCount: 1, ...(ageMs !== undefined ? { ageMs } : {}) }) as never;

describe('refresh_branch parked behind the landing lane', () => {
  test('under the wait bound: parks, due again no later than the bound', async () => {
    const h = harness();
    const r = await conflictHandlers(h.ports).refresh_branch!(effect(LANE_MAX_WAIT_MS - 60_000));
    expect(r).toEqual({ outcome: 'parked:lane_busy:#7', park: { delayMs: 60_000 } });
    expect(h.calls.refresh).toBe(0);
  });

  test('a fresh waiter parks for the backstop', async () => {
    const h = harness();
    const r = await conflictHandlers(h.ports).refresh_branch!(effect(0));
    expect(r).toEqual({ outcome: 'parked:lane_busy:#7', park: { delayMs: LANE_PARK_BACKSTOP_MS } });
  });

  test('past the wait bound: refreshes beside the lane instead of parking again', async () => {
    const h = harness();
    const r = await conflictHandlers(h.ports).refresh_branch!(effect(LANE_MAX_WAIT_MS));
    expect(r).toEqual({ outcome: 'ok:updated(lane:wait_spent:#7)' });
    expect(h.calls.refresh).toBe(1);
    // The new head is read at once, so landing does not wait for the webhook.
    expect(h.calls.ingested).toBe(1);
  });

  test('a store that does not say how old the row is never ends the wait by age (backstop only)', async () => {
    const h = harness();
    const r = await conflictHandlers(h.ports).refresh_branch!(effect());
    expect(r).toEqual({ outcome: 'parked:lane_busy:#7', park: { delayMs: LANE_PARK_BACKSTOP_MS } });
  });

  test('counter-case: the lane is free, the refresh takes it and runs (normal path)', async () => {
    const h = harness({ acquired: true });
    expect(await conflictHandlers(h.ports).refresh_branch!(effect(0))).toEqual({ outcome: 'ok:updated' });
    expect(h.calls.refresh).toBe(1);
  });

  test('counter-case: shadow never parks, at any age', async () => {
    const h = harness({ lane: 'shadow' });
    expect(await conflictHandlers(h.ports).refresh_branch!(effect(0))).toEqual({ outcome: 'ok:updated(lane:would_wait:#7)' });
  });
});
