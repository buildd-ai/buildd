/**
 * S17 (workflow-state-kernel §16, §17.5, Slice E): one DeliveryView drives
 * every projection. For every §4 state, the task card stage, the mission
 * strip tile, the mission feed, the chat dock badge, the chat task tile, the
 * PR pill and explain's history and unmerged-PR reading agree on the same
 * three questions: is it yours, is it shipped, is it moving. And none of them
 * reads the worker's fact-cache columns for a kernel-owned delivery.
 */
import { describe, expect, test } from 'bun:test';
import { deriveDeliveryView, deliveryPrState } from './projections';
import { deliveryReading, deliverySettled, deliveryShipped, ownerDeliveryDisplays, replacedFailedTaskIds, toDeliveryDisplay, type DeliveryDisplay, type DeliveryTone } from './delivery-display';
import { DELIVERY_STATES, type DeliverySnapshot, type DeliveryState } from './types';
import type { DeliveryViewInput } from './projections';
import { deriveStage, deriveStageReading, stageForDelivery } from '../stage';
import { boardStatusForDelivery, buildMissionBoard, type BoardTaskInput } from '../mission-board';
import { stripCountsLabel, stripSlotCounts, stripSlots, stripState } from '../mission-task-strip';
import { buildActionQueue, chipForDelivery, isActionableChip, kernelInboxMembership } from '../action-queue';
import { deriveGridTaskStage, type GridTask } from '@/app/app/(protected)/tasks/TaskGrid';
import { stripDrawerPill } from '@/app/app/(protected)/missions/[id]/MissionTaskStrip';
import { deriveFeedPrState, feedStateForDelivery } from '../mission-pulse';
import { resolvePrDisplayState } from '../pr-presentation';
import { dockToneForDelivery, taskDockModel } from '@/components/chat/dock-model';
import { taskState, taskStateForDelivery } from '@/components/chat/objects/TaskObject';
import type { TaskObjectView } from '@/components/chat/objects/object-views';

const D = (o: Partial<DeliverySnapshot> = {}): DeliverySnapshot => ({
  id: 'd1', workspaceId: 'w1', ownerTaskId: 't1', repoFullName: 'acme/widgets', prNumber: 7, baseRef: 'dev',
  state: 'WORKING', stateReason: null, version: 5, currentHeadSha: 'H1abcdef', currentRound: 1, maxRounds: 3,
  boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: [], approvalBasis: null,
  compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null,
  mergeCommitSha: null, supersededByPr: null, ...o,
});
const REASON: Partial<Record<DeliveryState, string>> = { REPAIRING: 'ci', ESCALATED: 'review_escalated', FAILED: 'attempt_failed' };
const display = (state: DeliveryState, o: Partial<DeliverySnapshot> = {}): DeliveryDisplay =>
  toDeliveryDisplay(deriveDeliveryView({ view: { delivery: D({ state, stateReason: REASON[state] ?? null, prNumber: state === 'FAILED' ? null : 7, ...o }), rounds: [], attempts: [] } })!);

const taskView = (d: DeliveryDisplay, worker: Partial<NonNullable<TaskObjectView['worker']>> = {}): TaskObjectView => ({
  kind: 'task', id: 't1', workspaceId: 'w1', title: 'feat: widgets', scope: null, label: 'widgets', status: 'completed',
  roleName: null, roleColor: null, missionId: null, missionTitle: null, now: null, renderedAt: 0, delivery: d,
  worker: {
    id: 'w', status: 'completed', runner: null, startedAt: null, completedAt: null, currentAction: null, waiting: false,
    // Columns that contradict every kernel state on purpose: no surface may read them.
    prNumber: 7, prUrl: 'https://github.com/acme/widgets/pull/7', mergedAt: null, prLifecycleStatus: 'ci_green', turns: 3, updatedAt: null,
    ...worker,
  },
});

const LIVE: DeliveryState[] = ['AWAITING_PUSH', 'AWAITING_REVIEW', 'CHANGES_REQUESTED', 'FIXING', 'REPAIRING', 'BLOCKED_ON_TRUNK', 'APPROVED', 'LANDING', 'CLOSED_UNMERGED'];

describe('S17: every surface agrees with the one DeliveryView', () => {
  for (const state of DELIVERY_STATES) {
    if (state === 'WORKING') continue;
    test(`${state}: yours / shipped / moving read the same on every surface`, () => {
      const d = display(state);
      const card = deriveStage({ taskStatus: 'completed', prUrl: 'u', prLifecycleStatus: 'ci_green', mergedAt: null, delivery: d });
      const tile = boardStatusForDelivery(d)!;
      const feed = feedStateForDelivery(d)!;
      const dock = taskDockModel(taskView(d)).badge;
      const chat = taskState(taskView(d));

      // Yours: a person's move (ESCALATED, or an approved PR waiting for its merge).
      const yours = deliveryReading(d)!.needsYou;
      expect(yours).toBe(state === 'ESCALATED');
      expect(card === 'WAITING_INPUT').toBe(yours);
      // The Board's `waiting` is an agent's question; a PR awaiting your decision reads `review`.
      expect(tile === 'waiting').toBe(false);
      if (yours) expect(tile).toBe('review');
      expect(feed.state === 'needs_you' && feed.needsYou === 'pr').toBe(yours);
      expect(dock.tone === 'needs' && dock.label !== 'Failed').toBe(yours);
      expect(chat.tone === 'attention').toBe(yours);

      const shipped = deliveryShipped(d);
      expect(tile === 'merged').toBe(shipped);
      expect(dock.tone === 'landed').toBe(shipped);
      if (shipped) expect(card).toBe('DONE');

      const failed = state === 'FAILED';
      expect(card === 'FAILED').toBe(failed);
      expect(tile === 'failed').toBe(failed);
      expect(dock.label === 'Failed').toBe(failed);

      if (LIVE.includes(state) && state !== 'CLOSED_UNMERGED' && !yours) {
        // A non-human owner: nothing says "yours", nothing says done or failed.
        expect(['FIXING', 'STALLED']).toContain(card);
        expect(tile).toBe('running');
        expect(feed.state).toBe('moving');
        expect(dock.tone).toBe('live');
      }
      if (deliverySettled(d)) expect(feed.state === 'done' || failed).toBe(true);
    });
  }

  test('WORKING defers to the owner attempt on every surface (its execution state is the reading)', () => {
    const d = display('WORKING');
    expect(stageForDelivery(d)).toBeNull();
    expect(boardStatusForDelivery(d)).toBeNull();
    expect(feedStateForDelivery(d)).toBeNull();
    expect(dockToneForDelivery(d)).toBeNull();
    expect(taskStateForDelivery(d)).toBeNull();
    expect(deriveStage({ taskStatus: 'in_progress', workerStatus: 'running', delivery: d })).toBe('RUNNING');
  });

  test('the fact-cache columns are never read for a kernel-owned PR', () => {
    // Worker says merged; the kernel says a CI fix is in flight.
    const d = display('REPAIRING', { ci: 'red', ciHeadSha: 'H1abcdef' });
    expect(deriveStage({ taskStatus: 'completed', prUrl: 'u', prLifecycleStatus: 'merged', mergedAt: '2026-01-01', delivery: d })).toBe('FIXING');
    expect(resolvePrDisplayState({ delivery: d, prLifecycleStatus: 'merged', mergedAt: new Date() })).toBe('ci_failed');
    expect(deriveFeedPrState({ status: 'completed', prNumber: 7, prLifecycleStatus: 'merged', mergedAt: new Date() }, d)).toEqual({ number: 7, state: 'ci_failed' });
    expect(taskDockModel(taskView(d, { prLifecycleStatus: 'merged', mergedAt: 1 })).badge.label).toBe('Fixing CI');
    expect(taskState(taskView(d, { prLifecycleStatus: 'merged', mergedAt: 1 })).label).toBe('#7 Fixing CI');
  });

  test('a worker\'s own question stays a question (§13.2 dev. 3)', () => {
    const d = display('FIXING');
    expect(deriveStage({ taskStatus: 'in_progress', workerStatus: 'waiting_input', delivery: d })).toBe('WAITING_INPUT');
    expect(taskDockModel(taskView(d, { status: 'waiting_input', waiting: true })).badge.label).toBe('Needs you');
  });

  test('a failed owner attempt of a live delivery reads the delivery, not FAILED (S35)', () => {
    expect(deriveStage({ taskStatus: 'failed', delivery: display('AWAITING_REVIEW') })).toBe('FIXING');
    expect(deriveStage({ taskStatus: 'failed', delivery: display('FAILED') })).toBe('FAILED');
    expect(deriveStage({ taskStatus: 'failed' })).toBe('FAILED');
  });

  test('the chat dock carries the kernel\'s evidence, never generic copy', () => {
    const d = display('AWAITING_PUSH', { currentHeadSha: 'abc1234deadbeef' });
    const m = taskDockModel(taskView(d));
    expect(m.insight?.text).toContain('Waiting for the fix to reach GitHub');
    expect(m.insight?.text).toContain('abc1234');
    const esc = taskDockModel(taskView(display('ESCALATED')));
    expect(esc.happened.at(-1)).toMatchObject({ ts: null, text: 'The reviewer escalated this PR.', needs: true });
  });
});

// ─── One label, one tone, one count per canonical state, on every surface ────
// The `delivery-states` fixture's deliveries plus the rest of the §4 states.
// Each surface maps the canonical tone through one total palette table; none
// maps a state.

interface Row { name: string; input: DeliveryViewInput; label: string; tone: DeliveryTone; action?: string }
const V = (o: Partial<DeliverySnapshot>, extra: Partial<DeliveryViewInput> = {}): DeliveryViewInput => ({ view: { delivery: D(o), rounds: [], attempts: [] }, ...extra });
const TABLE: Row[] = [
  { name: 'awaiting push', input: V({ state: 'AWAITING_PUSH' }), label: 'Waiting for push', tone: 'live' },
  {
    name: 'stalled conflict fix', label: 'Conflict fix stalled', tone: 'stalled', action: 'Run fix',
    input: V({ state: 'AWAITING_REVIEW', mergeable: 'dirty', mergeableHeadSha: 'H1abcdef' }, { remediation: { taskId: 'cf-1', family: 'conflict', taskStatus: 'pending', stalled: true, stallReason: 'no runner claim' } }),
  },
  { name: 'conflict, no fix filed', input: V({ state: 'REPAIRING', stateReason: 'conflict' }), label: 'Merge conflict', tone: 'stalled' },
  {
    name: 'conflict fix running', label: 'Resolving conflicts', tone: 'live',
    input: V({ state: 'REPAIRING', stateReason: 'conflict' }, { remediation: { taskId: 'cf-1', family: 'conflict', taskStatus: 'in_progress', stalled: false } }),
  },
  { name: 'CI fix in flight', input: V({ state: 'REPAIRING', stateReason: 'ci', ci: 'red', ciHeadSha: 'H1abcdef' }), label: 'Fixing CI', tone: 'live' },
  { name: 'composition verified, a person merges', input: V({ state: 'APPROVED', approvalBasis: 'composition', compositionHeads: ['H1abcdef'] }, { approvedNeedsPerson: true }), label: 'Ready to merge', tone: 'needs' },
  { name: 'approved, a person merges (human tier, approve-only, open handoff)', input: V({ state: 'APPROVED', approvalBasis: 'verdict', approvedHeads: ['H1abcdef'] }, { approvedNeedsPerson: true }), label: 'Ready to merge', tone: 'needs' },
  { name: 'approved, the landing path merges (approve-and-merge, auto-threshold)', input: V({ state: 'APPROVED', approvalBasis: 'verdict', approvedHeads: ['H1abcdef'] }), label: 'Approved · merging', tone: 'live' },
  { name: 'escalated', input: V({ state: 'ESCALATED', stateReason: 'review_escalated' }), label: 'Needs you', tone: 'needs' },
  { name: 'in review', input: V({ state: 'AWAITING_REVIEW' }), label: 'In review', tone: 'live' },
  { name: 'changes requested', input: V({ state: 'CHANGES_REQUESTED' }), label: 'Changes requested', tone: 'live' },
  { name: 'fixing review feedback', input: V({ state: 'FIXING' }), label: 'Fixing', tone: 'live' },
  { name: 'red base', input: V({ state: 'BLOCKED_ON_TRUNK' }), label: 'Blocked on base', tone: 'stalled' },
  { name: 'merging', input: V({ state: 'LANDING' }), label: 'Merging', tone: 'live' },
  { name: 'merged', input: V({ state: 'MERGED' }), label: 'Merged', tone: 'landed' },
  { name: 'superseded', input: V({ state: 'SUPERSEDED', supersededByPr: 9 }), label: 'Shipped elsewhere', tone: 'landed' },
  { name: 'closed', input: V({ state: 'CLOSED_UNMERGED' }), label: 'Closed', tone: 'closed' },
  { name: 'failed', input: V({ state: 'FAILED', stateReason: 'attempt_failed' }), label: 'Failed', tone: 'failed' },
];

// Each surface's palette, read back to the canonical tone.
const CARD_STAGE: Record<DeliveryTone, string> = { needs: 'WAITING_INPUT', live: 'FIXING', stalled: 'STALLED', landed: 'DONE', closed: 'DONE', failed: 'FAILED' };
const DOCK_TONE: Record<DeliveryTone, string> = { needs: 'needs', live: 'live', stalled: 'live', landed: 'landed', closed: 'idle', failed: 'needs' };
const CHAT_TONE: Record<DeliveryTone, string> = { needs: 'attention', live: 'live', stalled: 'neutral', landed: 'ok', closed: 'idle', failed: 'bad' };

// Unrelated titles, so the board never folds one row into another as its retry.
const ROW_SCOPES = ['auth', 'home', 'release', 'tokens', 'runners', 'picker'];
const boardInput = (d: DeliveryDisplay, i: number): BoardTaskInput => ({
  id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, title: `feat(${ROW_SCOPES[i]}): ${ROW_SCOPES[i]} rework ${i}`, status: 'completed', taskClass: 'work',
  createdAt: new Date(1_000 + i), missionPhaseIndex: 1, missionPhaseLabel: 'Build', roleSlug: 'builder', outputRequirement: 'pr_required', delivery: d,
  workers: [{ id: `w${i}`, status: 'completed', runner: 'alpha', startedAt: 1, completedAt: 2, updatedAt: 2, mergedAt: null, prNumber: 7, prUrl: 'u', prLifecycleStatus: 'ci_green', currentAction: null, waitingFor: null, milestones: [], linesAdded: 1, linesRemoved: 0 }],
  worker: { status: 'completed', startedAt: new Date(1), updatedAt: new Date(2), prNumber: 7, prUrl: 'u', prLifecycleStatus: 'ci_green', mergedAt: null },
} as BoardTaskInput);

const gridTask = (d: DeliveryDisplay): GridTask => ({
  id: 't1', title: 'x', status: 'completed', category: null, createdAt: '', updatedAt: '', workspaceName: 'w', prUrl: 'u', prNumber: 7,
  prLifecycleStatus: 'ci_green', delivery: d, summary: null, hasArtifact: false, filesChanged: null, waitingPrompt: null, missionId: null, missionTitle: null,
} as GridTask);

describe('S17: each canonical state reads the same label, tone and counts on every surface', () => {
  for (const row of TABLE) {
    test(row.name, () => {
      const view = deriveDeliveryView(row.input)!;
      const d = toDeliveryDisplay(view);
      const r = deliveryReading(d)!;
      expect({ label: r.label, tone: r.tone, action: r.action?.label }).toEqual({ label: row.label, tone: row.tone, action: row.action });
      expect(r.needsYou).toBe(row.tone === 'needs');
      expect(r.failed).toBe(row.tone === 'failed');

      // Task list: the chip's label and style, and the histogram's failed bucket.
      const card = deriveStageReading({ taskStatus: 'completed', prUrl: 'u', prLifecycleStatus: 'ci_green', delivery: d });
      expect(card).toEqual({ stage: CARD_STAGE[r.tone] as never, label: r.label });
      expect(deriveGridTaskStage(gridTask(d)) === 'FAILED').toBe(r.failed);

      // Mission board, strip and band.
      const model = buildMissionBoard({ now: 10_000, missionCreatedAt: 0, missionStatus: 'active', tasks: [boardInput(d, 0)] });
      const [id] = Object.keys(model.tasks);
      const bt = model.tasks[id];
      expect(bt.delivery?.label).toBe(r.label);
      expect(model.needsYou.includes(id)).toBe(r.needsYou);
      const slots = stripSlots(model);
      expect(stripSlotCounts(slots).failed > 0).toBe(r.failed);
      if (!r.failed) expect(stripCountsLabel(stripSlotCounts(slots))).not.toContain('failed');
      expect(stripDrawerPill(bt, stripState(model, id), 'runner')).toBe(r.label);

      // Mission feed.
      const feed = feedStateForDelivery(d)!;
      expect(feed.state === 'needs_you' && feed.needsYou === 'pr').toBe(r.needsYou);
      expect(feed.needsYou === 'failed').toBe(r.failed);

      // Chat: dock badge and task tile.
      const dock = taskDockModel(taskView(d));
      expect(dock.badge).toEqual({ label: r.label, tone: DOCK_TONE[r.tone] as never });
      const tile = taskState(taskView(d));
      expect(tile.label).toBe(`#7 ${r.label}`);
      expect(tile.tone).toBe(CHAT_TONE[r.tone] as never);
      if (r.action) expect(dock.actions.map(a => a.label)).toContain(r.action.label);

      // Home: the same ownership. A landing card keeps Home's legacy merge
      // rail, which an approved PR's MERGE chip already is.
      if (view.owner !== 'landing') expect(kernelInboxMembership(view, false)).toBe(r.needsYou);
      if (d.state === 'APPROVED') expect(chipForDelivery(view, 'REVIEW')).toBe('MERGE');
    });
  }

  test('the fixture deliveries: Home and the mission agree on who needs you and on nothing failed', () => {
    const rows = TABLE.filter(t => ['awaiting push', 'stalled conflict fix', 'composition verified, a person merges', 'escalated', 'CI fix in flight', 'merged'].includes(t.name));
    const displays = rows.map(t => toDeliveryDisplay(deriveDeliveryView(t.input)!));
    const model = buildMissionBoard({ now: 10_000, missionCreatedAt: 0, missionStatus: 'active', tasks: displays.map(boardInput) });
    expect(model.needsYou.length).toBe(2);
    expect(stripCountsLabel(stripSlotCounts(stripSlots(model)))).toBe('5 open');

    const views = new Map(rows.map((t, i) => [`t${i}`, deriveDeliveryView(t.input)!] as const));
    const queue = buildActionQueue([], rows.map((t, i) => ({
      workerId: `w${i}`, taskId: `t${i}`, taskTitle: t.name, workspaceId: 'w1', workspaceName: 'w', prNumber: 410 + i, prUrl: `https://github.com/acme/widgets/pull/${410 + i}`, policyTier: 'agent-review',
      escalationReason: null, waitingMinutes: 1, prOpenedAt: new Date(), prLifecycleVerifiedAt: new Date(), prLifecycleStatus: 'ci_green', prLifecycleUpdatedAt: new Date(),
    })), { now: new Date(), deliveryViews: views });
    expect(queue.filter(c => isActionableChip(c.chip)).length).toBe(model.needsYou.length);
  });
});

describe('legacy-owned rows keep the fact-cache projection', () => {
  test('no delivery → deriveStage reads the columns exactly as before', () => {
    expect(deriveStage({ taskStatus: 'completed', prUrl: 'u', prLifecycleStatus: 'ci_green' })).toBe('MERGE');
    expect(deriveStage({ taskStatus: 'completed', prUrl: 'u', prLifecycleStatus: 'ci_failed' })).toBe('CI_FAILING');
    expect(deriveStage({ taskStatus: 'completed', prUrl: 'u', prLifecycleStatus: 'ci_running' })).toBe('CI');
    expect(deriveStage({ taskStatus: 'completed', prUrl: 'u', prLifecycleStatus: null, mergedAt: '2026-01-01' })).toBe('DONE');
    expect(deriveStage({ taskStatus: 'completed', prUrl: 'u', prLifecycleStatus: 'closed' })).toBe('DONE');
    expect(deriveStage({ taskStatus: 'completed', prUrl: 'u', prLifecycleStatus: 'pr_open' })).toBe('OPEN');
  });

  test('chat dock: a completed task whose PR is still open is in review, not landed (§17.5)', () => {
    const legacy = (w: Partial<NonNullable<TaskObjectView['worker']>>): TaskObjectView => ({ ...taskView(display('MERGED')), delivery: null, worker: { ...taskView(display('MERGED')).worker!, ...w } });
    expect(taskDockModel(legacy({ prLifecycleStatus: 'ci_green', mergedAt: null })).badge.label).toBe('In review');
    expect(taskDockModel(legacy({ prLifecycleStatus: 'merged', mergedAt: null })).badge.label).toBe('Landed');
    expect(taskDockModel(legacy({ prNumber: null, prUrl: null, prLifecycleStatus: null })).badge.label).toBe('Landed');
    expect(taskDockModel(legacy({ prLifecycleStatus: 'ci_failed' })).badge.label).toBe('CI failed');
  });
});

describe('deliveryPrState: the PR pill from the delivery\'s own facts', () => {
  test('terminal states', () => {
    expect(deliveryPrState(D({ state: 'MERGED' }))).toBe('merged');
    for (const s of ['SUPERSEDED', 'ABANDONED', 'CLOSED_UNMERGED'] as const) expect(deliveryPrState(D({ state: s }))).toBe('closed');
    expect(deliveryPrState(D({ prNumber: null }))).toBeNull();
  });

  test('a CI or mergeable fact counts only on the current head', () => {
    expect(deliveryPrState(D({ state: 'AWAITING_REVIEW', ci: 'green', ciHeadSha: 'H1abcdef' }))).toBe('ci_passed');
    expect(deliveryPrState(D({ state: 'AWAITING_REVIEW', ci: 'green', ciHeadSha: 'OLD' }))).toBe('awaiting_ci');
    expect(deliveryPrState(D({ state: 'AWAITING_REVIEW', ci: 'red', ciHeadSha: 'H1abcdef' }))).toBe('ci_failed');
    expect(deliveryPrState(D({ state: 'AWAITING_REVIEW', mergeable: 'dirty', mergeableHeadSha: 'H1abcdef', ci: 'red', ciHeadSha: 'H1abcdef' }))).toBe('conflict');
    expect(deliveryPrState(D({ state: 'AWAITING_REVIEW', mergeable: 'dirty', mergeableHeadSha: 'OLD' }))).toBe('awaiting_ci');
  });

  test('the repair family names the PR state', () => {
    expect(deliveryPrState(D({ state: 'REPAIRING', stateReason: 'ci' }))).toBe('ci_failed');
    expect(deliveryPrState(D({ state: 'REPAIRING', stateReason: 'conflict' }))).toBe('conflict');
    expect(deliveryPrState(D({ state: 'BLOCKED_ON_TRUNK' }))).toBe('ci_failed');
  });
});

describe('ownerDeliveryDisplays', () => {
  test('only the owner task carries the delivery; attempt tasks keep their own execution reading', () => {
    const v = deriveDeliveryView({ view: { delivery: D({ state: 'FIXING' }), rounds: [], attempts: [] } })!;
    const out = ownerDeliveryDisplays(new Map([['t1', v], ['fix1', v]]));
    expect([...out.keys()]).toEqual(['t1']);
    expect(out.get('t1')).toMatchObject({ state: 'FIXING', stage: 'fixing', prNumber: 7 });
  });
});

describe('S35: the failed-task count and the delivery reading agree', () => {
  test('for every state, a failed owner task is replaced exactly when deliveryReading does not call it failed', () => {
    for (const state of DELIVERY_STATES) {
      const v = deriveDeliveryView({ view: { delivery: D({ state, stateReason: REASON[state] ?? null, prNumber: state === 'FAILED' ? null : 7 }), rounds: [], attempts: [] } })!;
      const failed = deliveryReading(toDeliveryDisplay(v))?.failed ?? false;
      expect({ state, replaced: replacedFailedTaskIds(new Map([['t1', v]]), ['t1']).has('t1') }).toEqual({ state, replaced: !failed });
    }
  });

  test('a task with no view is never replaced (legacy, or the view read failed)', () => {
    expect(replacedFailedTaskIds(new Map(), ['t1']).size).toBe(0);
  });
});
