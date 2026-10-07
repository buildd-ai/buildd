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
import { deliverySettled, deliveryShipped, ownerDeliveryDisplays, toDeliveryDisplay, type DeliveryDisplay } from './delivery-display';
import { DELIVERY_STATES, type DeliverySnapshot, type DeliveryState } from './types';
import { deriveStage, stageForDelivery } from '../stage';
import { boardStatusForDelivery } from '../mission-board';
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

      const yours = d.needsYou;
      expect(card === 'WAITING_INPUT').toBe(yours);
      expect(tile === 'waiting').toBe(yours);
      expect(feed.state === 'needs_you' && feed.needsYou === 'pr').toBe(yours);
      expect(dock.label === 'Needs you').toBe(yours);
      expect(chat.tone === 'attention').toBe(yours);

      const shipped = deliveryShipped(d);
      expect(tile === 'merged').toBe(shipped);
      expect(dock.label === 'Landed').toBe(shipped);
      if (shipped) expect(card).toBe('DONE');

      const failed = state === 'FAILED';
      expect(card === 'FAILED').toBe(failed);
      expect(tile === 'failed').toBe(failed);
      expect(dock.label === 'Stopped').toBe(failed);

      if (LIVE.includes(state) && state !== 'CLOSED_UNMERGED') {
        // A non-human owner: nothing says "yours", nothing says done or failed.
        expect(['FIXING', 'REVIEWING', 'BLOCKED', 'MERGE']).toContain(card);
        expect(['fixing', 'review']).toContain(tile);
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
    expect(taskDockModel(taskView(d, { prLifecycleStatus: 'merged', mergedAt: 1 })).badge.label).toBe('Fixing');
    expect(taskState(taskView(d, { prLifecycleStatus: 'merged', mergedAt: 1 })).label).toBe('#7 fixing');
  });

  test('a worker\'s own question stays a question (§13.2 dev. 3)', () => {
    const d = display('FIXING');
    expect(deriveStage({ taskStatus: 'in_progress', workerStatus: 'waiting_input', delivery: d })).toBe('WAITING_INPUT');
    expect(taskDockModel(taskView(d, { status: 'waiting_input', waiting: true })).badge.label).toBe('Needs you');
  });

  test('a failed owner attempt of a live delivery reads the delivery, not FAILED (S35)', () => {
    expect(deriveStage({ taskStatus: 'failed', delivery: display('AWAITING_REVIEW') })).toBe('REVIEWING');
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
