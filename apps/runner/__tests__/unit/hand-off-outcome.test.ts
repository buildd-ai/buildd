/**
 * S30 (docs/specs/workflow-state-kernel.md §6.6): a hand-off failure after work
 * is reported as `outcome: 'unproven'` with the local head and commit count, so
 * the server can tell "the work is not on GitHub" from "the work failed".
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/hand-off-outcome.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { handOffUnproven, isHandOffRefusal } from '../../src/hand-off-outcome';

describe('handOffUnproven', () => {
  test('carries the local head and the commit count the worktree reported', () => {
    expect(handOffUnproven({ lastCommitSha: 'abc123', commitCount: 3, dirtyWorktree: true }))
      .toEqual({ outcome: 'unproven', localHeadSha: 'abc123', commitCount: 3 });
  });

  test('nothing local: an explicit null head and zero commits (a requeue server-side, never AWAITING_PUSH)', () => {
    expect(handOffUnproven({})).toEqual({ outcome: 'unproven', localHeadSha: null, commitCount: 0 });
  });

  test('falls back to the commits the session tracked when git could not count them', () => {
    expect(handOffUnproven({}, 2)).toEqual({ outcome: 'unproven', localHeadSha: null, commitCount: 2 });
    expect(handOffUnproven({ commitCount: 0 }, 2).commitCount).toBe(0);
  });
});

describe('isHandOffRefusal', () => {
  test('the output-requirement gate is a hand-off failure (commits but no PR, uncommitted changes, no confirmed outcome, delivery_not_advanced)', () => {
    expect(isHandOffRefusal({ gate: 'output_requirement' })).toBe(true);
  });
  test('every other refusal is about the request, not the deliverable', () => {
    expect(isHandOffRefusal({})).toBe(false);
    expect(isHandOffRefusal({ gate: 'worker_patch_refused' })).toBe(false);
  });
});
