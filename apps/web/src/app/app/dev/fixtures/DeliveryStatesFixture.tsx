'use client';

/**
 * `?state=delivery-states`: how a kernel-owned delivery reads on Home and on
 * the task page (workflow-state-kernel §17.5). Each card and pill comes from
 * the real projection (`deriveDeliveryView` → `buildActionQueue`), fed
 * illustrative deliveries: a fix that has not reached GitHub, a stalled
 * conflict fix, a release whose composition verified, and an escalation.
 */
import { ActionQueueCard } from '../../(protected)/home/ActionQueueCard';
import { HeaderStatusPill } from '../../(protected)/tasks/[id]/TaskSidePanel';
import RealTimeWorkerView from '../../(protected)/tasks/[id]/RealTimeWorkerView';
import { buildActionQueue, type EscalationRawItem } from '@/lib/action-queue';
import { deriveDeliveryView, type DeliverySnapshot, type DeliveryView, type DeliveryViewInput } from '@/lib/workflow/projections';
import { mockWorkers } from './fixtures-data';

const NOW = new Date(1_720_008_000_000);
const MIN = 60_000;

const delivery = (o: Partial<DeliverySnapshot>): DeliverySnapshot => ({
  id: 'fx-d', workspaceId: 'fx-ws', ownerTaskId: 'fx-t', repoFullName: 'acme/widgets', prNumber: 412, baseRef: 'dev',
  state: 'WORKING', stateReason: null, version: 6, currentHeadSha: '9f3c2a17e0', currentRound: 1, maxRounds: 3,
  boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: [], approvalBasis: null,
  compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null,
  mergeCommitSha: null, supersededByPr: null, ...o,
});

interface Case { key: string; title: string; prNumber: number; input: DeliveryViewInput }

const CASES: Case[] = [
  {
    key: 'awaiting-push', title: 'fix(auth): check the caller task, not the owner', prNumber: 412,
    input: { view: { delivery: delivery({ id: 'd1', ownerTaskId: 't1', prNumber: 412, state: 'AWAITING_PUSH' }), rounds: [], attempts: [] } },
  },
  {
    key: 'conflict-stalled', title: 'feat(home): group cards by mission', prNumber: 418,
    input: {
      view: { delivery: delivery({ id: 'd2', ownerTaskId: 't2', prNumber: 418, state: 'AWAITING_REVIEW', mergeable: 'dirty', mergeableHeadSha: '9f3c2a17e0' }), rounds: [], attempts: [] },
      remediation: { taskId: 'cf-418', family: 'conflict', taskStatus: 'pending', stalled: true, stallReason: 'the conflict fix has waited 42m with no runner claim' },
    },
  },
  {
    key: 'composition', title: 'Ship mission: workflow kernel', prNumber: 420,
    input: { view: { delivery: delivery({ id: 'd3', ownerTaskId: 't3', prNumber: 420, state: 'APPROVED', approvalBasis: 'composition', compositionHeads: ['9f3c2a17e0'] }), rounds: [], attempts: [] } },
  },
  {
    key: 'escalated', title: 'feat(api): rotate runner tokens', prNumber: 423,
    input: {
      view: { delivery: delivery({ id: 'd4', ownerTaskId: 't4', prNumber: 423, state: 'ESCALATED', stateReason: 'review_escalated' }), rounds: [], attempts: [] },
      lastTransition: { command: 'ReviewVerdictRecorded', fromState: 'AWAITING_REVIEW', toState: 'ESCALATED', evidence: { reason: 'Changes the token scope check; a person should confirm the new boundary.' }, createdAt: NOW.toISOString() },
    },
  },
];

const views = new Map<string, DeliveryView>(CASES.map((c) => [c.input.view.delivery!.ownerTaskId, deriveDeliveryView(c.input)!]));

const raw = (c: Case): EscalationRawItem => ({
  workerId: `w-${c.key}`, taskId: c.input.view.delivery!.ownerTaskId, taskTitle: c.title, workspaceId: 'fx-ws', workspaceName: 'acme',
  prNumber: c.prNumber, prUrl: `https://github.com/acme/widgets/pull/${c.prNumber}`, policyTier: 'agent-review',
  escalationReason: null, waitingMinutes: 12, prOpenedAt: new Date(NOW.getTime() - 90 * MIN), prLifecycleVerifiedAt: NOW,
  prLifecycleStatus: c.key === 'conflict-stalled' ? 'conflict' : 'ci_green', prLifecycleUpdatedAt: NOW,
  missionId: 'fx-m', missionTitle: 'Workflow kernel',
});

export default function DeliveryStatesFixture() {
  const queue = buildActionQueue([], CASES.map(raw), { now: NOW, deliveryViews: views });
  const awaiting = views.get('t1')!;
  return (
    <main className="mx-auto max-w-2xl space-y-10 p-4" data-testid="delivery-states-fixture">
      <section className="space-y-3">
        <h2 className="font-mono text-[11px] uppercase tracking-[1.2px] text-text-muted">Home · Needs you and in flight</h2>
        {queue.map((item) => (
          <div key={item.subjectKey} data-testid="delivery-card" data-chip={item.chip}>
            <ActionQueueCard item={item} />
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="font-mono text-[11px] uppercase tracking-[1.2px] text-text-muted">Task header</h2>
        <div className="flex flex-wrap gap-2">
          {CASES.map((c) => {
            const v = views.get(c.input.view.delivery!.ownerTaskId)!;
            return (
              <span key={c.key} data-testid="delivery-pill">
                <HeaderStatusPill status="running" merged={false} delivery={{ headline: v.headline, owner: v.owner, needsYou: v.needsYou, stage: v.stage, detail: v.detail }} />
              </span>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-mono text-[11px] uppercase tracking-[1.2px] text-text-muted">Task page · worker stopped, platform owns the next move</h2>
        <RealTimeWorkerView
          taskId="fixture-task"
          taskStatus="in_progress"
          initialWorker={mockWorkers['waiting-input'] as never}
          delivery={{ headline: awaiting.headline, owner: awaiting.owner, needsYou: awaiting.needsYou, detail: awaiting.detail }}
        />
      </section>
    </main>
  );
}
