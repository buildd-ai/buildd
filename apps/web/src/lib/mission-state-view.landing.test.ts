/**
 * Regression "dirty PR mislabeled ready" (spec workflow-state-kernel §13.11
 * rule 3): explain reported a PR READY FOR REVIEW / "ready to merge" while the
 * newest pr_landing row said mergeable_state dirty plus a migration collision,
 * and every repair attempt had ended without touching the PR.
 */
import { describe, it, expect } from 'bun:test';
import { deriveMissionStateView, isGated, missionNeedsYou, type MissionStateInput } from './mission-state-view';
import { deriveLandingBlocker } from './landing-blocker';

const base: MissionStateInput = { status: 'active', isHeld: false, activeAgents: 0, health: 'NOMINAL' };
const PR = { taskId: 'task-a', title: 'Ship mission', prNumber: 77, prUrl: 'https://example.invalid/pr/77' };
const DIRTY_ROW = {
  occurredAt: '2026-01-02T03:00:00.000Z',
  outcome: 'deferred',
  reason: 'PR has conflicts (mergeable_state: dirty) — needs rebase onto base branch; also refused: migration number collision: <n>_a.sql is at or below <n>_b.sql, already on the base',
  headSha: 'h1',
};

describe('deriveLandingBlocker', () => {
  it('a dirty, colliding PR whose repairs all ended is the owner\'s, not ready', () => {
    const b = deriveLandingBlocker({
      ...PR, landing: DIRTY_ROW,
      repairs: [{ status: 'completed', claimed: true, completedAt: '2026-01-02T01:00:00.000Z' }],
    });
    expect(b).toMatchObject({ cause: 'repair_exhausted', owner: 'person' });
  });

  it('an open repair makes it platform-owned: queued or running', () => {
    expect(deriveLandingBlocker({ ...PR, landing: DIRTY_ROW, repairs: [{ status: 'pending', claimed: false }] }))
      .toMatchObject({ cause: 'repair_queued', owner: 'platform' });
    expect(deriveLandingBlocker({ ...PR, landing: DIRTY_ROW, repairs: [{ status: 'in_progress', claimed: true }] }))
      .toMatchObject({ cause: 'repair_running', owner: 'platform' });
  });

  it('a landing row older than a completed (evidence-gated) repair is stale and ignored', () => {
    expect(deriveLandingBlocker({ ...PR, landing: DIRTY_ROW, repairs: [{ status: 'completed', claimed: true, completedAt: '2026-01-02T05:00:00.000Z' }] }))
      .toBeNull();
  });

  it('kernel: a row about another head is stale; the delivery state wins', () => {
    const delivery = { state: 'AWAITING_REVIEW', headSha: 'h2', prState: 'open', headline: '', detail: null, currentAttempt: null, owner: 'reviewer' } as never;
    expect(deriveLandingBlocker({ ...PR, landing: DIRTY_ROW, delivery })).toBeNull();
    const escalated = { state: 'ESCALATED', headSha: 'h2', prState: 'conflict', headline: 'Needs a person', detail: 'Refresh keeps conflicting', currentAttempt: null, owner: 'human' } as never;
    expect(deriveLandingBlocker({ ...PR, delivery: escalated })).toMatchObject({ cause: 'human_decision', owner: 'person' });
  });

  it('legacy conflict fact alone is a platform-owned conflict', () => {
    expect(deriveLandingBlocker({ ...PR, prLifecycleStatus: 'conflict' })).toMatchObject({ cause: 'conflicted', owner: 'platform' });
  });

  it('a migration collision alone, and CI still running, are named as such', () => {
    expect(deriveLandingBlocker({ ...PR, landing: { ...DIRTY_ROW, reason: 'migration number collision: x' } })?.cause).toBe('migration_collision');
    expect(deriveLandingBlocker({ ...PR, landing: { ...DIRTY_ROW, reason: 'CI checks still pending or failed: build (in_progress)' } })?.cause).toBe('ci_pending');
  });

  it('shadow-mode (warned) and allowed rows are not facts', () => {
    expect(deriveLandingBlocker({ ...PR, landing: { ...DIRTY_ROW, outcome: 'warned' } })).toBeNull();
    expect(deriveLandingBlocker({ ...PR, landing: { ...DIRTY_ROW, outcome: 'allowed' } })).toBeNull();
  });
});

describe('deriveMissionStateView with a landing blocker', () => {
  it('a dirty PR with ended repairs is BLOCKED and needs you, never READY FOR REVIEW', () => {
    const blocker = deriveLandingBlocker({ ...PR, landing: DIRTY_ROW, repairs: [{ status: 'completed', claimed: true, completedAt: '2026-01-02T01:00:00.000Z' }] })!;
    const view = deriveMissionStateView({ ...base, unmergedPrs: [PR], landingBlocked: [blocker] });
    expect(view.kind).toBe('blocked');
    expect(view.chip.label).not.toBe('READY FOR REVIEW');
    expect(view.situation.headline).not.toContain('ready to merge');
    if (!isGated(view)) throw new Error('expected gated');
    expect(view.waitingOn).toMatchObject({ kind: 'landing_blocked', cause: 'repair_exhausted', owner: 'person', prNumbers: [77] });
    expect(view.nextAction).toContain('resolve the conflicts');
    expect(missionNeedsYou(view)).toBe(true);
  });

  it('a queued repair is waiting on buildd, not on you', () => {
    const blocker = deriveLandingBlocker({ ...PR, prLifecycleStatus: 'conflict', repairs: [{ status: 'pending', claimed: false }] })!;
    const view = deriveMissionStateView({
      ...base,
      completion: { ok: false, code: 'awaiting_merge', reason: 'unmerged', awaitingMerge: 1, awaitingMergeDetails: [PR] },
      landingBlocked: [blocker],
    });
    expect(view.kind).toBe('waiting');
    expect(view.chip.label).not.toBe('READY FOR REVIEW');
    if (!isGated(view)) throw new Error('expected gated');
    expect(view.waitingOn).toMatchObject({ kind: 'landing_blocked', cause: 'repair_queued', owner: 'platform' });
  });

  it('without a blocker the ordinary ready-to-merge reading is unchanged', () => {
    const view = deriveMissionStateView({ ...base, unmergedPrs: [PR], landingBlocked: [] });
    expect(view.kind).toBe('awaiting_merge');
    expect(view.chip.label).toBe('READY FOR REVIEW');
  });
});
