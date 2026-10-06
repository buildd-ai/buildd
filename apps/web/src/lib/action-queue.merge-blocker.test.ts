/**
 * A PR that conflicts with its base cannot be merged by retrying the merge.
 * These tests pin how Home reads one: the conflict-retry machinery owns it
 * (RESOLVING, outside "Needs you") until automatic fixes are exhausted or
 * switched off, and only then does it become a person's decision (BLOCKED).
 * The card is always the compact merge-blocker view, never a MERGE/REVIEW card
 * with reviewer prose, a merge Retry or a Dismiss.
 */
import { describe, it, expect } from 'bun:test';
import { buildActionQueue, isActionableChip, type EscalationRawItem } from './action-queue';
import { describeConflictReason, describeMergeBlocker } from './merge-blocker';
import { resolveCiGate } from './ci-gate';
import { splitWaitingOnYou } from '../app/app/(protected)/home/home-view';

const NOW = new Date('2026-10-05T12:00:00Z');
const PR_URL = 'https://github.com/org/repo/pull/4100';
const REVIEWER_ESSAY =
  'Implementation matches the spec, but the PR touches the schema and a generated migration, which the workspace policy marks as human-review-required. Earlier: migration number collision with another open PR.';

function esc(overrides: Partial<EscalationRawItem> = {}): EscalationRawItem {
  return {
    workerId: 'w-1',
    taskId: 't-1',
    taskTitle: 'feat: keep integration branches merged up',
    workspaceId: 'ws-1',
    workspaceName: 'buildd',
    prNumber: 4100,
    prUrl: PR_URL,
    policyTier: 'agent-review',
    escalationReason: REVIEWER_ESSAY,
    hasEscalationNote: true,
    recommendation: 'Have a person review the migration before merging.',
    waitingMinutes: 600,
    prOpenedAt: NOW,
    prLifecycleVerifiedAt: NOW,
    prLifecycleStatus: 'conflict',
    prLifecycleUpdatedAt: NOW,
    ciGate: resolveCiGate({ prLifecycleStatus: 'conflict' }),
    conflictAutoResolve: true,
    ...overrides,
  };
}

const card = (overrides: Partial<EscalationRawItem> = {}) =>
  buildActionQueue([], [esc(overrides)], { now: NOW })[0];

describe('dirty PR, conflict retry dispatchable', () => {
  it('is a concise RESOLVING card outside Needs you, with no merge CTA', () => {
    const item = card({ conflictReason: 'Migration 0235 collides with another change' });
    expect(item.chip).toBe('RESOLVING');
    expect(isActionableChip(item.chip)).toBe(false);
    expect(splitWaitingOnYou([item]).needsYou).toHaveLength(0);

    const view = describeMergeBlocker(item)!;
    expect(view.needsYou).toBe(false);
    expect(view.state).toBe('Resolving merge conflict');
    expect(view.reason).toBe('Migration 0235 collides with another change');
    expect(view.action).toEqual({ kind: 'fixing', label: 'Fixing…' });
  });

  it('keeps the reviewer essay and suggestion out of the reason, in Details', () => {
    const view = describeMergeBlocker(card())!;
    expect(view.reason).not.toContain('policy');
    expect(view.details).toContain(REVIEWER_ESSAY);
    expect(view.details.some((d) => d.includes('review the migration'))).toBe(true);
    expect(view.details.some((d) => /conflicts with its base/.test(d))).toBe(true);
  });

  it('never reads MERGE or REVIEW while the PR conflicts, whatever the policy tier', () => {
    for (const policyTier of ['human', 'agent-review', 'auto-threshold']) {
      expect(card({ policyTier }).chip).toBe('RESOLVING');
    }
    expect(card({ autoMerge: true }).chip).toBe('RESOLVING');
  });
});

describe('dirty PR, conflict retry already live', () => {
  it('links to the live attempt instead of dispatching another', () => {
    const item = card({ conflictRetryTaskId: 'retry-2', conflictRetryIteration: 2 });
    expect(item.chip).toBe('RESOLVING');
    const view = describeMergeBlocker(item)!;
    expect(view.action).toEqual({ kind: 'view_task', label: 'View task', taskId: 'retry-2' });
    expect(view.details).toContain('Automatic fix attempt 2');
  });

  it('an open reviewer-fix attempt still outranks the queued-conflict reading', () => {
    const item = card({
      ciGate: resolveCiGate({ prLifecycleStatus: 'conflict', liveFixTaskId: 'fix-1', liveFixKind: 'review' }),
    });
    expect(item.chip).toBe('FIXING_REVIEW');
    expect(describeMergeBlocker(item)).toBeNull();
  });
});

describe('dirty PR, automation exhausted or off', () => {
  it('exhausted => a Needs-you card with one concrete action, not the reviewer essay', () => {
    const item = card({
      deadZoneExhausted: true,
      deadZoneLastRetryTaskId: 'retry-3',
      conflictReason: 'Migration 0235 collides with another change',
    });
    expect(item.chip).toBe('BLOCKED');
    expect(isActionableChip(item.chip)).toBe(true);
    expect(splitWaitingOnYou([item]).needsYou).toHaveLength(1);

    const view = describeMergeBlocker(item)!;
    expect(view.needsYou).toBe(true);
    expect(view.state).toBe('Merge blocked · automatic fixes ran out');
    expect(view.reason).toBe('Migration 0235 collides with another change');
    expect(view.action).toEqual({ kind: 'fix_conflict', label: 'Fix conflict' });
    expect(view.details).toContain(REVIEWER_ESSAY);
  });

  it('automatic resolution off => BLOCKED on a person, saying so', () => {
    const item = card({ conflictAutoResolve: false });
    expect(item.chip).toBe('BLOCKED');
    const view = describeMergeBlocker(item)!;
    expect(view.needsYou).toBe(true);
    expect(view.state).toBe('Merge blocked · automatic fixes are off');
    expect(view.reason).toBe('Conflicts with recent changes on the base branch');
  });
});

describe('not a merge conflict', () => {
  it('a red-CI BLOCKED card keeps its own card', () => {
    const item = card({
      prLifecycleStatus: 'ci_failed',
      ciGate: resolveCiGate({ prLifecycleStatus: 'ci_failed', maxCiRetries: 3, attemptsConsumed: 3 }),
    });
    expect(item.chip).toBe('BLOCKED');
    expect(item.mergeConflict).toBeUndefined();
    expect(describeMergeBlocker(item)).toBeNull();
  });

  it('a clean PR is unaffected', () => {
    const item = card({ prLifecycleStatus: 'ci_green', ciGate: resolveCiGate({ prLifecycleStatus: 'ci_green' }) });
    expect(item.chip).toBe('REVIEW');
    expect(describeMergeBlocker(item)).toBeNull();
  });
});

describe('describeConflictReason', () => {
  it('names the colliding migration index', () => {
    expect(describeConflictReason({
      errorType: 'migration_collision',
      summary: "PR #12's migration 0235_first_change.sql collides with open PR #13's migration 0235_second_change.sql. Renumber off the colliding slot.",
    })).toBe('Migration 0235 collides with another change');
  });

  it('falls back to a plain line per conflict kind, and null for nothing usable', () => {
    expect(describeConflictReason({ errorType: 'migration_collision', summary: '' }))
      .toBe('A migration number collides with another change');
    expect(describeConflictReason({ errorType: 'merge_conflict' })).toBe('Conflicts with recent changes on the base branch');
    expect(describeConflictReason({ errorType: 'semantic_conflict' })).toBe('Edits the same code as a recent change on the base branch');
    expect(describeConflictReason(null)).toBeNull();
    expect(describeConflictReason({ errorType: 'ci_failure' })).toBeNull();
  });
});
