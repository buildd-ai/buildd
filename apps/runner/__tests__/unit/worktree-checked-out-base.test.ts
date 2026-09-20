import { describe, expect, test } from 'bun:test';
import { buildPromptWithComposition } from '../../src/prompt-builder';

/**
 * The "checked out with latest code from" line in the Git Workflow block must
 * name the ref the worktree was ACTUALLY cut from, not always the workspace
 * default branch.
 *
 * Root cause of task 3075cfe5 ("[friction] Mission worktree migration
 * baseline lags dev"): for an Option A′ mission-integration task, the worktree
 * is cut from the mission's integration branch (worktree-utils.ts's
 * `resolveWorktreeBase` reads `context.baseBranch`, which task-creation fills
 * in as the integration branch). But this line unconditionally claimed
 * "latest code from `origin/<defaultBranch>`" regardless — so an agent
 * generating a Drizzle migration believed it already had dev's latest
 * migration index and skipped the divergence check the schema-change skill
 * requires, reusing an index dev had since occupied.
 */

const INTEGRATION_BRANCH = 'mission/checkout-arc-1a2b3c4d';
const WORKER_BRANCH = 'buildd/abc12345-do-the-thing';

const GIT_CONFIG = {
  branchingStrategy: 'trunk',
  defaultBranch: 'dev',
  targetBranch: 'dev',
  requiresPR: true,
  useBuildBranch: true,
  commitStyle: 'conventional',
};

function ctx(taskOverrides: Record<string, unknown> = {}) {
  return {
    task: {
      id: '510c4619-e02e-47bb-a018-e6336d1ff989',
      title: 'Do the thing',
      description: 'Do the thing properly',
      ...taskOverrides,
    },
    worker: { id: 'worker-1', workspaceName: 'demo', branch: WORKER_BRANCH, worktreePath: '/tmp/wt' },
    gitConfig: GIT_CONFIG,
    isConfigured: true,
    compactResult: { count: 0 },
    taskSearchResults: [],
    fullObservations: [],
    inputPolicy: 'autonomous',
    hasApiKey: true,
  } as any;
}

function checkedOutFrom(task: Record<string, unknown>): string | null {
  const built = buildPromptWithComposition(ctx(task));
  const m = /is already checked out with latest code from `([^`]+)`/.exec(built.promptText);
  return m ? m[1] : null;
}

describe('Git Workflow "checked out with latest code from" line', () => {
  test('a mission-integration task: names the integration branch, not the default branch', () => {
    const task = {
      mission: { workingBranch: INTEGRATION_BRANCH, integrationBranchEnabled: true },
      missionId: 'mission-1',
    };
    expect(checkedOutFrom(task)).toBe(`origin/${INTEGRATION_BRANCH}`);
  });

  test('a mission-integration task: warns that sequential-index files can lag the default branch', () => {
    const task = {
      mission: { workingBranch: INTEGRATION_BRANCH, integrationBranchEnabled: true },
      missionId: 'mission-1',
    };
    const built = buildPromptWithComposition(ctx(task));
    expect(built.promptText).toContain('sequential');
    expect(built.promptText).toContain(`origin/${GIT_CONFIG.defaultBranch}`);
  });

  test('a task with no mission: still names the default branch', () => {
    expect(checkedOutFrom({})).toBe(`origin/${GIT_CONFIG.defaultBranch}`);
  });

  test('a mission that never opted in: still names the default branch', () => {
    const task = {
      mission: { workingBranch: INTEGRATION_BRANCH, integrationBranchEnabled: false },
      missionId: 'mission-1',
    };
    expect(checkedOutFrom(task)).toBe(`origin/${GIT_CONFIG.defaultBranch}`);
  });

  test('a stacked plan phase: names the predecessor branch', () => {
    const task = {
      mission: { workingBranch: INTEGRATION_BRANCH, integrationBranchEnabled: true },
      missionId: 'mission-1',
      context: { baseBranch: 'buildd/99999999-phase-1' },
    };
    expect(checkedOutFrom(task)).toBe('origin/buildd/99999999-phase-1');
  });

  test('the sequential-index warning is absent when the default branch is the answer', () => {
    const built = buildPromptWithComposition(ctx({}));
    expect(built.promptText).not.toContain('sequential-index');
  });
});
