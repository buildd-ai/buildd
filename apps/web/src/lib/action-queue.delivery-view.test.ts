/**
 * S36/S35 on Home: for a kernel-owned delivery the Needs You chip is the
 * kernel's owner of the next move (DeliveryView), never an inference from raw
 * worker/reviewer/task columns. A task with no kernel view keeps today's chip.
 */
import { describe, expect, it } from 'bun:test';
import { buildActionQueue, isActionableChip, kernelInboxMembership, type EscalationRawItem, type WaitingOnYouRawItem } from './action-queue';
import { deriveDeliveryView } from './workflow/projections';
import type { DeliverySnapshot, DeliveryState } from './workflow/types';

const NOW = new Date('2026-10-05T12:00:00Z');
const esc = (o: Partial<EscalationRawItem> = {}): EscalationRawItem => ({
  workerId: 'w-1', taskId: 't-1', taskTitle: 'fix: something', workspaceId: 'ws-1', workspaceName: 'buildd',
  prNumber: 3600, prUrl: 'https://github.com/org/repo/pull/3600', policyTier: 'human',
  escalationReason: 'Human Gate · manual merge required', waitingMinutes: 5, prOpenedAt: NOW,
  prLifecycleVerifiedAt: NOW, prLifecycleStatus: 'ci_green', prLifecycleUpdatedAt: NOW, ...o,
});
const D = (o: Partial<DeliverySnapshot>): DeliverySnapshot => ({
  id: 'd1', workspaceId: 'ws-1', ownerTaskId: 't-1', repoFullName: 'org/repo', prNumber: 3600, baseRef: 'dev',
  state: 'WORKING', stateReason: null, version: 3, currentHeadSha: 'H1', currentRound: 1, maxRounds: 3,
  boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: [], approvalBasis: null,
  compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null,
  mergeCommitSha: null, supersededByPr: null, ...o,
});
const viewOf = (o: Partial<DeliverySnapshot>, extra: Parameters<typeof deriveDeliveryView>[0] extends infer I ? Partial<I> : never = {}) =>
  deriveDeliveryView({ view: { delivery: D(o), rounds: [], attempts: [] }, ...extra })!;
const build = (items: EscalationRawItem[], views: Array<[string, ReturnType<typeof viewOf>]>, woy: WaitingOnYouRawItem[] = []) =>
  buildActionQueue(woy, items, { now: NOW, deliveryViews: new Map(views) });

describe('S36 — Needs You renders only canonical human-owned states', () => {
  it('a raw human-review escalation on a kernel delivery that is AWAITING_PUSH is agent-handled', () => {
    const [card] = build(
      [esc({ humanReview: { reason: 'worker ended waiting for input' } as EscalationRawItem['humanReview'] })],
      [['t-1', viewOf({ state: 'AWAITING_PUSH' })]],
    );
    expect(isActionableChip(card.chip)).toBe(false);
    expect(card.delivery?.owner).toBe('platform');
    expect(card.delivery?.headline).toBe('Waiting for the fix to reach GitHub');
    expect(card.delivery?.detail).toContain('PR #3600');
  });

  it('ESCALATED is the one state that asks a person, with its evidence', () => {
    const v = viewOf({ state: 'ESCALATED', stateReason: 'review_exhausted' }, {
      lastTransition: { command: 'ReviewVerdictRecorded', fromState: 'FIXING', toState: 'ESCALATED', evidence: { reason: 'three rounds, still failing the auth test' }, createdAt: NOW.toISOString() },
    });
    const [card] = build([esc({ prLifecycleStatus: 'ci_running' })], [['t-1', v]]);
    expect(isActionableChip(card.chip)).toBe(true);
    expect(card.delivery?.detail).toBe('three rounds, still failing the auth test');
  });

  it('every non-ESCALATED, non-landing state is agent-handled whatever the raw columns say', () => {
    const states: DeliveryState[] = ['WORKING', 'AWAITING_PUSH', 'AWAITING_REVIEW', 'CHANGES_REQUESTED', 'FIXING', 'REPAIRING', 'BLOCKED_ON_TRUNK'];
    for (const s of states) {
      const [card] = build([esc()], [['t-1', viewOf({ state: s, stateReason: s === 'REPAIRING' ? 'ci' : null })]]);
      expect({ s, actionable: isActionableChip(card.chip) }).toEqual({ s, actionable: false });
    }
  });

  it('an approved PR a person merges (human tier) is the MERGE card', () => {
    const [card] = build([esc()], [['t-1', viewOf({ state: 'APPROVED', approvalBasis: 'composition', compositionHeads: ['H1'] }, { approvedNeedsPerson: true })]]);
    expect(card.chip).toBe('MERGE');
    expect(isActionableChip(card.chip)).toBe(true);
    expect(card.delivery?.compositionVerified).toBe(true);
    expect(card.delivery?.headline).toBe('Release composition verified');
  });

  it('a kernel approval a person merges turns a legacy REVIEW reading (no reviewer-task approve on record) into MERGE', () => {
    const [legacy] = buildActionQueue([], [esc({ policyTier: 'agent-review' })], { now: NOW });
    expect(legacy.chip).toBe('REVIEW');
    const [card] = build([esc({ policyTier: 'agent-review' })], [['t-1', viewOf({ state: 'APPROVED', approvalBasis: 'verdict', approvedHeads: ['H1'] }, { approvedNeedsPerson: true })]]);
    expect(card.chip).toBe('MERGE');
  });

  it('an approved PR the landing path merges (approve-and-merge, auto-threshold) is merging, not needs you', () => {
    for (const legacyTier of ['agent-review', 'human'] as const) {
      const [card] = build([esc({ policyTier: legacyTier })], [['t-1', viewOf({ state: 'APPROVED', approvalBasis: 'verdict', approvedHeads: ['H1'] })]]);
      expect(card.delivery?.owner).toBe('landing');
      expect({ legacyTier, chip: card.chip, actionable: isActionableChip(card.chip) }).toEqual({ legacyTier, chip: 'AUTO_MERGE', actionable: false });
    }
  });

  it('a task with no kernel view keeps today\'s projection', () => {
    const [legacy] = buildActionQueue([], [esc()], { now: NOW });
    const [same] = build([esc()], [['other-task', viewOf({ state: 'AWAITING_PUSH' })]]);
    expect(same.chip).toBe(legacy.chip);
    expect(same.delivery).toBeUndefined();
  });

  it('S37: a stalled conflict fix on a kernel delivery is RESOLVING with the repair CTA, not a human merge card', () => {
    const v = viewOf({ state: 'AWAITING_REVIEW', mergeable: 'dirty', mergeableHeadSha: 'H1' }, {
      remediation: { taskId: 'cf-1', family: 'conflict', taskStatus: 'pending', stalled: true, stallReason: 'waited 40m' },
    });
    const [card] = build([esc({ prLifecycleStatus: 'conflict' })], [['t-1', v]]);
    expect(card.chip).toBe('RESOLVING');
    expect(card.delivery?.headline).toBe('Conflict fix stalled');
    expect(card.delivery?.cta).toEqual({ action: 'repair_remediation', label: 'Run fix', taskId: 'cf-1' });
  });
});

describe('S35 — a replaced predecessor is not a FAILED card', () => {
  const failed = (taskId: string): WaitingOnYouRawItem => ({ kind: 'failed', taskId, taskTitle: 'fix attempt', failureMessage: 'agent crashed' } as WaitingOnYouRawItem);

  it('a failed attempt of a live delivery is dropped', () => {
    const q = build([], [['fix-1', viewOf({ state: 'FIXING' })]], [failed('fix-1')]);
    expect(q.find((c) => c.chip === 'FAILED')).toBeUndefined();
  });

  it('a failed attempt of a merged delivery is dropped', () => {
    const q = build([], [['fix-1', viewOf({ state: 'MERGED' })]], [failed('fix-1')]);
    expect(q).toHaveLength(0);
  });

  it('a FAILED delivery still shows its failure; a legacy task is untouched', () => {
    expect(build([], [['t-1', viewOf({ state: 'FAILED', prNumber: null })]], [failed('t-1')])[0].chip).toBe('FAILED');
    expect(build([], [], [failed('t-9')])[0].chip).toBe('FAILED');
  });

  it('inside a FAILED delivery, an older superseded attempt is dropped and the current attempt stays', () => {
    const v = viewOf({ state: 'FAILED', stateReason: 'attempt_failed', prNumber: null }, {
      attemptTasks: [
        { taskId: 't-1', role: 'owner', status: 'completed', createdAt: '2026-10-05T09:00:00Z' },
        { taskId: 'fix-1', role: 'fix', status: 'failed', createdAt: '2026-10-05T10:00:00Z' },
        { taskId: 'fix-2', role: 'fix', status: 'failed', createdAt: '2026-10-05T11:00:00Z' },
      ],
    });
    const q = build([], [['fix-1', v], ['fix-2', v]], [failed('fix-1'), failed('fix-2')]);
    expect(q.filter((c) => c.chip === 'FAILED').map((c) => c.subjectKey)).toEqual(['task:fix-2']);
  });
});

describe('S36 — Needs You membership follows DeliveryView.needsYou', () => {
  it('ESCALATED for a non-review reason with no notes is admitted', () => {
    const v = viewOf({ state: 'ESCALATED', stateReason: 'push_undeliverable' });
    expect(kernelInboxMembership(v, false)).toBe(true);
    const [card] = build([esc({ policyTier: 'agent-review', escalationReason: null })], [['t-1', v]]);
    expect(isActionableChip(card.chip)).toBe(true);
  });

  it('AWAITING_PUSH with a stale reviewer_escalated note is not admitted', () => {
    const v = viewOf({ state: 'AWAITING_PUSH' });
    expect(kernelInboxMembership(v, true)).toBe(false);
    const [card] = build([esc({ hasEscalationNote: true })], [['t-1', v]]);
    expect(isActionableChip(card.chip)).toBe(false);
  });

  it('a task without a view keeps the legacy predicate', () => {
    expect(kernelInboxMembership(undefined, true)).toBe(true);
    expect(kernelInboxMembership(undefined, false)).toBe(false);
  });
});

describe('a kernel reviewer escalation is a verdict on the Home REVIEW card', () => {
  const escalated = (stateReason: 'review_escalated' | 'review_exhausted' | 'push_undeliverable' | 'review_unavailable') => viewOf({ state: 'ESCALATED', stateReason }, {
    lastTransition: { command: 'ReviewVerdictRecorded', fromState: 'AWAITING_REVIEW', toState: 'ESCALATED', evidence: { reason: 'Changes the token scope check; a person should confirm the new boundary.' }, createdAt: NOW.toISOString() },
  });

  it('ESCALATED by a reviewer verdict carries the escalation even with no legacy note or verdict summary', () => {
    for (const reason of ['review_escalated', 'review_exhausted'] as const) {
      const [card] = build([esc({ policyTier: 'agent-review', escalationReason: null, hasEscalationNote: false, verdictSummary: null })], [['t-1', escalated(reason)]]);
      expect(card.chip).toBe('REVIEW');
      expect({ reason, note: card.hasEscalationNote, kernel: card.reviewerEscalated }).toEqual({ reason, note: true, kernel: true });
    }
  });

  it('an escalation with no reviewer verdict behind it keeps the legacy no-verdict reading', () => {
    for (const reason of ['push_undeliverable', 'review_unavailable'] as const) {
      const [card] = build([esc({ policyTier: 'agent-review', escalationReason: null, hasEscalationNote: false })], [['t-1', escalated(reason)]]);
      expect({ reason, note: card.hasEscalationNote, kernel: card.reviewerEscalated ?? false }).toEqual({ reason, note: false, kernel: false });
    }
  });
});
