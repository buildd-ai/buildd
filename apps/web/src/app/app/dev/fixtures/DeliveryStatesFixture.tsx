'use client';

/**
 * `?state=delivery-states`: how a kernel-owned delivery reads on Home, the task
 * page, the task list, the mission board and strip, and the chat tile and dock
 * (workflow-state-kernel §17.5). Each card, chip and pill comes from the real
 * projection (`deriveDeliveryView` → `buildActionQueue` / `toDeliveryDisplay`),
 * fed illustrative deliveries: a fix that has not reached GitHub, a stalled
 * conflict fix, a release whose composition verified, an escalation, and (on
 * the list surfaces) a CI fix in flight and a merged PR.
 */
import { ActionQueueCard } from '../../(protected)/home/ActionQueueCard';
import { HeaderStatusPill } from '../../(protected)/tasks/[id]/TaskSidePanel';
import RealTimeWorkerView from '../../(protected)/tasks/[id]/RealTimeWorkerView';
import { buildActionQueue, type EscalationRawItem } from '@/lib/action-queue';
import { deriveDeliveryView, type DeliverySnapshot, type DeliveryView, type DeliveryViewInput } from '@/lib/workflow/projections';
import { mockWorkers } from './fixtures-data';
import { useEffect, useState } from 'react';
import { TaskCard } from '@/components/TaskCard';
import MissionBoard from '../../(protected)/missions/[id]/MissionBoard';
import { buildMissionBoard, type BoardTaskInput, type BoardWorkerInput, type MissionBoardModel } from '@/lib/mission-board';
import { toDeliveryDisplay } from '@/lib/workflow/delivery-display';
import { TaskDockCard } from '@/components/chat/ChatDock';
import { taskDockModel } from '@/components/chat/dock-model';
import { TaskCard as ChatTaskTile } from '@/components/chat/objects/TaskObject';
import type { TaskObjectView } from '@/components/chat/objects/object-views';

const MIN = 60_000;
// Relative to now, so every "12m ago" reads like a live page. Floored to the
// minute, so the server render and the client's hydration agree.
export const NOW = new Date(Math.floor(Date.now() / MIN) * MIN);

const delivery = (o: Partial<DeliverySnapshot>): DeliverySnapshot => ({
  id: 'fx-d', workspaceId: 'fx-ws', ownerTaskId: 'fx-t', repoFullName: 'acme/widgets', prNumber: 412, baseRef: 'dev',
  state: 'WORKING', stateReason: null, version: 6, currentHeadSha: '9f3c2a17e0', currentRound: 1, maxRounds: 3,
  boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: [], approvalBasis: null,
  compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null,
  mergeCommitSha: null, supersededByPr: null, ...o,
});

interface Case { key: string; title: string; prNumber: number; input: DeliveryViewInput }

export const CASES: Case[] = [
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
    input: { view: { delivery: delivery({ id: 'd3', ownerTaskId: 't3', prNumber: 420, state: 'APPROVED', approvalBasis: 'composition', compositionHeads: ['9f3c2a17e0'] }), rounds: [], attempts: [] }, approvedNeedsPerson: true },
  },
  {
    key: 'approved-landing', title: 'fix(web): trim the task list query', prNumber: 421,
    input: { view: { delivery: delivery({ id: 'd5', ownerTaskId: 't5', prNumber: 421, state: 'APPROVED', approvalBasis: 'verdict', approvedHeads: ['9f3c2a17e0'] }), rounds: [], attempts: [] } },
  },
  {
    key: 'escalated', title: 'feat(api): rotate runner tokens', prNumber: 423,
    input: {
      view: { delivery: delivery({ id: 'd4', ownerTaskId: 't4', prNumber: 423, state: 'ESCALATED', stateReason: 'review_escalated' }), rounds: [], attempts: [] },
      lastTransition: { command: 'ReviewVerdictRecorded', fromState: 'AWAITING_REVIEW', toState: 'ESCALATED', evidence: { reason: 'Changes the token scope check; a person should confirm the new boundary.' }, createdAt: NOW.toISOString() },
    },
  },
];

export const views = new Map<string, DeliveryView>(CASES.map((c) => [c.input.view.delivery!.ownerTaskId, deriveDeliveryView(c.input)!]));

export const raw = (c: Case): EscalationRawItem => ({
  workerId: `w-${c.key}`, taskId: c.input.view.delivery!.ownerTaskId, taskTitle: c.title, workspaceId: 'fx-ws', workspaceName: 'acme',
  prNumber: c.prNumber, prUrl: `https://github.com/acme/widgets/pull/${c.prNumber}`, policyTier: 'agent-review',
  escalationReason: null, waitingMinutes: 12, prOpenedAt: new Date(NOW.getTime() - 90 * MIN), prLifecycleVerifiedAt: NOW,
  prLifecycleStatus: c.key === 'conflict-stalled' ? 'conflict' : 'ci_green', prLifecycleUpdatedAt: NOW,
  missionId: 'fx-m', missionTitle: 'Workflow kernel',
});

// ─── Slice E: the list surfaces (task card, mission board/strip, chat) ─────────
// Two more states, so a CI fix in flight and a landed PR are on every surface.
const LIST_CASES: Case[] = [
  ...CASES,
  {
    key: 'ci-fix', title: 'fix(api): page the runner list', prNumber: 425,
    input: { view: { delivery: delivery({ id: 'd5', ownerTaskId: 't5', prNumber: 425, state: 'REPAIRING', stateReason: 'ci', ci: 'red', ciHeadSha: '9f3c2a17e0' }), rounds: [], attempts: [] } },
  },
  {
    key: 'merged', title: 'feat(ui): runner size picker', prNumber: 427,
    input: { view: { delivery: delivery({ id: 'd6', ownerTaskId: 't6', prNumber: 427, state: 'MERGED' }), rounds: [], attempts: [] } },
  },
];
const fxId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const listDisplays = LIST_CASES.map((c, i) => ({ c, id: fxId(i + 1), d: toDeliveryDisplay(deriveDeliveryView(c.input)!) }));
const prUrl = (n: number) => `https://github.com/acme/widgets/pull/${n}`;

/** The worker columns say "CI green" on every row on purpose: no surface may echo them. */
const boardTask = ({ c, id, d }: (typeof listDisplays)[number], i: number, now: number): BoardTaskInput => {
  const w: BoardWorkerInput = {
    id: `w-${c.key}`, status: 'completed', runner: 'alpha', startedAt: now - (40 - i) * MIN, completedAt: now - (30 - i) * MIN, updatedAt: now - (30 - i) * MIN,
    mergedAt: null, prNumber: c.prNumber, prUrl: prUrl(c.prNumber), prLifecycleStatus: 'ci_green', currentAction: null, waitingFor: null,
    milestones: [], linesAdded: 40, linesRemoved: 6,
  };
  return {
    id, title: c.title, status: 'completed', taskClass: 'work', createdAt: new Date(now - (50 - i) * MIN), missionPhaseIndex: 1, missionPhaseLabel: 'Build it',
    roleSlug: 'builder', outputRequirement: 'pr_required', backend: 'claude', workers: [w], delivery: d,
    worker: { status: w.status, startedAt: new Date(w.startedAt!), updatedAt: new Date(w.updatedAt!), prNumber: w.prNumber, prUrl: w.prUrl, prLifecycleStatus: w.prLifecycleStatus, mergedAt: null },
  };
};

export const chatView = ({ c, id, d }: (typeof listDisplays)[number]): TaskObjectView => ({
  kind: 'task', id, workspaceId: 'fx-ws', title: c.title, scope: c.title.match(/\(([^)]+)\)/)?.[1] ?? null, label: c.title.replace(/^[a-z]+\([^)]*\):\s*/, ''),
  status: 'completed', roleName: 'Builder', roleColor: null, missionId: null, missionTitle: 'Workflow kernel', now: null, renderedAt: NOW.getTime(), delivery: d,
  worker: {
    id: `w-${c.key}`, status: 'completed', runner: null, startedAt: null, completedAt: null, currentAction: null, waiting: false,
    prNumber: c.prNumber, prUrl: prUrl(c.prNumber), mergedAt: null, prLifecycleStatus: 'ci_green', turns: 41, updatedAt: null,
  },
  attempts: 2, happened: [],
});

function ListSurfaces() {
  // Built after mount: the board's clocks read the real now, so server and client render alike.
  const [board, setBoard] = useState<MissionBoardModel | null>(null);
  useEffect(() => {
    const now = Date.now();
    setBoard(buildMissionBoard({ now, missionCreatedAt: now - 60 * MIN, missionStatus: 'active', tasks: listDisplays.map((x, i) => boardTask(x, i, now)) }));
  }, []);
  return (
    <>
      <section className="space-y-3">
        <h2 className="font-mono text-[11px] uppercase tracking-[1.2px] text-text-muted">Task list · stage chip</h2>
        <div className="border border-border-default">
          {listDisplays.map(({ c, id, d }, i) => (
            <div key={c.key} data-testid="delivery-task-card" data-stage={d.stage}>
              <TaskCard
                id={id} title={c.title} taskStatus="completed" workerStatus="completed"
                taskCreatedAt={new Date(NOW.getTime() - (50 - i) * MIN).toISOString()} taskUpdatedAt={new Date(NOW.getTime() - (30 - i) * MIN).toISOString()}
                prUrl={prUrl(c.prNumber)} prNumber={c.prNumber} prLifecycleStatus="ci_green" delivery={d} density="row"
              />
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-mono text-[11px] uppercase tracking-[1.2px] text-text-muted">Mission page · board and Landed strip</h2>
        {board ? <MissionBoard model={board} missionId={fxId(900)} workspaceId={fxId(901)} executor="runner" /> : <div className="h-40" />}
      </section>

      <section className="space-y-3">
        <h2 className="font-mono text-[11px] uppercase tracking-[1.2px] text-text-muted">Chat · task tile and dock</h2>
        <div className="space-y-3">
          {listDisplays.map((x) => (
            <div key={x.c.key} data-testid="delivery-chat-tile">
              <ChatTaskTile objRef={{ kind: 'task', id: x.id, workspaceId: 'fx-ws', fallbackText: x.c.title }} view={chatView(x)} />
            </div>
          ))}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {listDisplays.map((x) => {
            const v = chatView(x);
            return (
              <div key={x.c.key} data-testid="delivery-dock-card">
                <TaskDockCard view={v} model={taskDockModel(v)} />
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

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
                <HeaderStatusPill status="running" merged={false} delivery={{ headline: v.headline, owner: v.owner, needsYou: v.needsYou, stage: v.stage, detail: v.detail, state: v.state }} />
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
          delivery={{ headline: awaiting.headline, owner: awaiting.owner, needsYou: awaiting.needsYou, detail: awaiting.detail, prState: awaiting.prState, state: awaiting.state }}
        />
      </section>

      <ListSurfaces />
    </main>
  );
}
