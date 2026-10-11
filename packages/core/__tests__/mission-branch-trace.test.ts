/**
 * `mission_branch_unresolved` — one stable signature for a mission integration
 * branch that could not be resolved, wherever resolution ran.
 *
 * The acceptance bar is grouping: repeats across missions and branches must
 * land on ONE rollup row (error traces GROUP BY pattern; the gate ledger groups
 * by `gateFrictionSignature(gate, reason)`), not show up as singletons.
 */
import { describe, it, expect } from 'bun:test';
import {
  MISSION_BRANCH_UNRESOLVED,
  describeWorktreeFallback,
  missionBranchUnresolvedDetail,
  missionBranchUnresolvedExcerpt,
  missionBranchUnresolvedReason,
} from '../mission-branch-trace';
import { GATE_SLUGS } from '../gate-slugs';
import { gateFrictionSignature } from '../gate-friction-signature';

const A = { missionId: '6341fe61-mission-a', branch: 'mission/prompt-cache-6341fe61' };
const B = { missionId: '0a1b2c3d-mission-b', branch: 'mission/other-work-0a1b2c3d' };

describe('mission_branch_unresolved signature', () => {
  it('uses one name for the gate slug and the error-trace pattern', () => {
    expect(GATE_SLUGS.MISSION_BRANCH_UNRESOLVED).toBe(MISSION_BRANCH_UNRESOLVED);
  });

  it('keeps branch and mission out of the reason, so repeats share a friction signature', () => {
    const shape = { where: 'create_pr', cause: 'no_repo', fallback: 'trunk_pr_base' } as const;
    const ra = missionBranchUnresolvedReason({ ...A, ...shape });
    const rb = missionBranchUnresolvedReason({ ...B, ...shape });
    expect(ra).toBe(rb);
    expect(ra).not.toContain(A.branch);
    expect(gateFrictionSignature(MISSION_BRANCH_UNRESOLVED, ra))
      .toBe(gateFrictionSignature(MISSION_BRANCH_UNRESOLVED, rb));
  });

  it('distinguishes where it ran and what fallback was taken', () => {
    const recut = missionBranchUnresolvedReason({ where: 'create_pr', cause: 'missing', fallback: 'recut_from_trunk' });
    const trunk = missionBranchUnresolvedReason({ where: 'create_pr', cause: 'no_repo', fallback: 'trunk_pr_base' });
    expect(gateFrictionSignature(MISSION_BRANCH_UNRESOLVED, recut))
      .not.toBe(gateFrictionSignature(MISSION_BRANCH_UNRESOLVED, trunk));
  });

  it('carries mission, expected branch, site and fallback as evidence', () => {
    const input = { ...A, where: 'runner_worktree', cause: 'missing', fallback: 'trunk_worktree', detail: 'x' } as const;
    const excerpt = missionBranchUnresolvedExcerpt(input);
    expect(excerpt).toContain(A.branch);
    expect(excerpt).toContain('6341fe61');
    expect(excerpt).toContain('runner_worktree');
    expect(excerpt).toContain('trunk_worktree');
    // Short id only — never a full row UUID in an excerpt.
    expect(excerpt).not.toContain(A.missionId);
    expect(missionBranchUnresolvedDetail(input)).toEqual({
      branch: A.branch, where: 'runner_worktree', cause: 'missing', fallback: 'trunk_worktree', detail: 'x',
    });
  });
});

describe('describeWorktreeFallback', () => {
  it('reports a missing mission integration branch under mission_branch_unresolved, not as a resume fallback', () => {
    const d = describeWorktreeFallback({
      candidate: A.branch, reason: 'missing', defaultBranch: 'dev',
      integrationBase: A.branch, missionId: A.missionId,
    });
    expect(d.pattern).toBe(MISSION_BRANCH_UNRESOLVED);
    expect(d.excerpt).toContain(A.branch);
    expect(d.excerpt).toContain('6341fe61');
    expect(d.excerpt).not.toContain('A new PR will be opened instead of updating');
  });

  it('keeps resume_branch_fallback for a prior attempt branch', () => {
    const d = describeWorktreeFallback({
      candidate: 'buildd/abcd1234-some-task', reason: 'missing', defaultBranch: 'dev', integrationBase: A.branch,
    });
    expect(d.pattern).toBe('resume_branch_fallback');
    expect(d.excerpt).toBe('Branch "buildd/abcd1234-some-task" was missing on remote — starting fresh from "dev".');
  });

  it('never promises a PR: the runner does not know whether one existed', () => {
    for (const reason of ['missing', 'diverged'] as const) {
      const d = describeWorktreeFallback({ candidate: 'buildd/abcd1234-some-task', reason, defaultBranch: 'dev' });
      expect(d.excerpt).not.toMatch(/\bPR\b/);
    }
  });

  it('keeps resume_branch_fallback for a diverged branch, even a mission one', () => {
    const d = describeWorktreeFallback({
      candidate: A.branch, reason: 'diverged', defaultBranch: 'dev', integrationBase: A.branch,
    });
    expect(d.pattern).toBe('resume_branch_fallback');
  });

  it('falls back to the mission/ shape when the runner does not know the mission, excluding worker-scoped diversions', () => {
    expect(describeWorktreeFallback({ candidate: A.branch, reason: 'missing', defaultBranch: 'dev' }).pattern)
      .toBe(MISSION_BRANCH_UNRESOLVED);
    expect(describeWorktreeFallback({
      candidate: `${A.branch}-w0a1b2c3d`, reason: 'missing', defaultBranch: 'dev',
    }).pattern).toBe('resume_branch_fallback');
  });

  it('two missions hitting it produce the same pattern (grouped, not singletons)', () => {
    const a = describeWorktreeFallback({ candidate: A.branch, reason: 'missing', defaultBranch: 'dev', integrationBase: A.branch });
    const b = describeWorktreeFallback({ candidate: B.branch, reason: 'missing', defaultBranch: 'main', integrationBase: B.branch });
    expect(a.pattern).toBe(b.pattern);
  });
});
