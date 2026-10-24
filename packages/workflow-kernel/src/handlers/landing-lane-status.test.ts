/**
 * e07ee9cf: an approved PR whose behind refresh waits in the landing lane says so on GitHub
 * ("Approved, queued to merge … queued behind PR #N"), never "Branch update in progress",
 * whichever of the refresh and the status publish drains first. Fake ports.
 */
import { describe, expect, test } from 'bun:test';
import { landingHandlers, laneWaitDetail } from './landing';
import type { KernelPorts } from '../ports';
import type { DeliverySnapshot } from '../types';

const HEAD = 'abcdef1234';
const delivery = (o: Partial<DeliverySnapshot> = {}) => ({
  id: 'd1', workspaceId: 'w1', repoFullName: 'acme/app', prNumber: 12, baseRef: 'dev', state: 'REPAIRING', stateReason: 'behind', version: 4,
  currentHeadSha: HEAD, approvedHeads: [HEAD], approvalBasis: 'verdict', compositionHeads: [], currentRound: 1, ...o,
}) as unknown as DeliverySnapshot;
const approvedRound = { id: 'r1', round: 1, headSha: HEAD, kind: 'full', status: 'decided', verdict: 'approve', effectiveVerdict: 'approve', failureCount: 0, reviewerTaskId: 'rev1' };

function harness(o: { d?: DeliverySnapshot; lane?: 'off' | 'shadow' | 'enforce'; holder?: { deliveryId: string; prNumber: number | null } | null } = {}) {
  const d = o.d ?? delivery();
  const published: Array<{ state: string; description: string; context: string }> = [];
  const github = {
    readPr: async () => null,
    statusOf: async () => null,
    writes: { publishStatus: async (s: { state: string; description: string; context: string }) => { published.push(s); } },
  };
  const ports = {
    store: {
      loadView: async () => ({ delivery: d, rounds: [approvedRound], attempts: [], findings: [] }),
      laneHolder: async () => (o.holder === undefined ? { deliveryId: 'd0', prNumber: 7 } : o.holder),
    },
    policy: { forWorkspace: async () => ({ landingLane: o.lane ?? 'enforce' }) },
    github,
  } as unknown as KernelPorts;
  return { ports, d, published };
}
const effect = (payload: Record<string, unknown> = { version: 4 }) =>
  ({ id: 'e1', deliveryId: 'd1', transitionId: 't1', kind: 'publish_landing_status', dedupeKey: 'k', payload, attemptCount: 1, delivery: null, transition: null, authority: 'kernel' }) as never;

describe('laneWaitDetail', () => {
  test('another delivery holds the lane under enforce: queued behind it', async () => {
    const h = harness();
    expect(await laneWaitDetail(h.ports, h.d)).toBe('queued behind PR #7, which is merging into dev first');
  });
  test('this delivery holds the lane, or nobody does: not waiting', async () => {
    expect(await laneWaitDetail(harness({ holder: { deliveryId: 'd1', prNumber: 12 } }).ports, delivery())).toBeNull();
    expect(await laneWaitDetail(harness({ holder: null }).ports, delivery())).toBeNull();
  });
  test('shadow or off never parks, so never says queued', async () => {
    expect(await laneWaitDetail(harness({ lane: 'shadow' }).ports, delivery())).toBeNull();
    expect(await laneWaitDetail(harness({ lane: 'off' }).ports, delivery())).toBeNull();
  });
  test('only a behind refresh waits in the lane', async () => {
    expect(await laneWaitDetail(harness().ports, delivery({ stateReason: 'ci' }))).toBeNull();
    expect(await laneWaitDetail(harness().ports, delivery({ state: 'APPROVED', stateReason: null }))).toBeNull();
  });
});

describe('publish_landing_status for a refresh waiting in the lane', () => {
  test('publishes queued, pending, naming the PR ahead', async () => {
    const h = harness();
    expect(await landingHandlers(h.ports).publish_landing_status!(effect())).toEqual({ outcome: 'ok:pending' });
    expect(h.published).toEqual([expect.objectContaining({
      context: 'Buildd / Review approval', state: 'pending',
      description: 'Approved, queued to merge: review approved abcdef1; queued behind PR #7, which is merging into dev first',
    })]);
  });
  test('holding the lane itself: the branch update is in progress', async () => {
    const h = harness({ holder: { deliveryId: 'd1', prNumber: 12 } });
    await landingHandlers(h.ports).publish_landing_status!(effect());
    expect(h.published[0]?.description).toMatch(/^Branch update in progress/);
  });
});
