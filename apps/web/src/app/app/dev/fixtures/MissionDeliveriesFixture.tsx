/**
 * `?state=mission-deliveries`: the mission page's delivery line and scope
 * updates (docs/specs/workflow-kernel-library.md §6) in each state, from the
 * same derivations the page uses: a pre-delivery mission PR, delivery 1
 * merged with delivery 2 still being built, delivery 2's PR open, and every
 * delivery shipped. A route screenshot of a real mission reaches only the one
 * state that mission is in.
 */
import { deriveMissionIntegrationPr, type MissionDeliveryLike } from '@/lib/mission-integration-pr';
import { describeScopeUpdates } from '@/lib/mission-scope-view';
import { MissionPrLine, MissionScopeUpdates } from '../../(protected)/missions/[id]/MissionPrLine';

const BRANCH = 'mission/checkout-redesign-1a2b3c4d';
const MISSION = { workingBranch: BRANCH, integrationBranchEnabled: true };
const d = (epoch: number, state: 'open' | 'merged', prNumber: number | null): MissionDeliveryLike =>
  ({ epoch, branch: epoch === 1 ? BRANCH : `${BRANCH}-delivery-${epoch}`, state, prNumber, repoFullName: 'example/app' });
const ownerTask = { id: 'owner', title: 'Ship mission: Checkout redesign', taskClass: 'bookkeeping', workers: [{ prUrl: 'https://github.com/example/app/pull/120', prNumber: 120, mergedAt: new Date('2026-10-14T10:00:00Z'), prLifecycleStatus: 'merged' }] };

const CASES: Array<{ title: string; deliveries: MissionDeliveryLike[] | null }> = [
  { title: 'Before delivery records (one mission PR, merged)', deliveries: null },
  { title: 'Delivery 1 merged; delivery 2 still being built', deliveries: [d(1, 'merged', 120), d(2, 'open', null)] },
  { title: "Delivery 2's PR open", deliveries: [d(1, 'merged', 120), d(2, 'open', 131)] },
  { title: 'Every delivery shipped', deliveries: [d(1, 'merged', 120), d(2, 'merged', 131)] },
];

const TITLES: Record<string, string> = { t1: 'Add Apple Pay to checkout', t2: 'Drop the slow test gate' };
const SCOPE = describeScopeUpdates([
  { sourceTaskId: 't1', decision: 'amend_scope', status: 'applied', scopeVersionAfter: 2, createdAt: '2026-10-14T11:00:00Z' },
  { sourceTaskId: 't2', decision: 'amend_scope', status: 'held', scopeVersionAfter: null, createdAt: '2026-10-14T12:00:00Z' },
], (id) => TITLES[id] ?? null);

export default function MissionDeliveriesFixture() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4">
      {CASES.map((c) => {
        const pr = deriveMissionIntegrationPr({ mission: MISSION, tasks: [ownerTask], deliveries: c.deliveries });
        return (
          <section key={c.title} className="space-y-2 border border-border-default p-3">
            <h2 className="text-meta font-semibold text-text-muted">{c.title}</h2>
            {pr && <MissionPrLine pr={pr} />}
          </section>
        );
      })}
      <section className="space-y-2 border border-border-default p-3">
        <h2 className="text-meta font-semibold text-text-muted">Scope updates</h2>
        <MissionScopeUpdates lines={SCOPE} />
      </section>
    </div>
  );
}
