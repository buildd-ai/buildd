import { describe, expect, test } from 'bun:test';
import { resolveTaskPrBase } from '@buildd/core/mission-integration';
import { buildPromptWithComposition } from '../../src/prompt-builder';

/**
 * The prompt a worker reads and the base `create_pr` derives must be the same
 * answer, because a worker cannot tell them apart from inside the sandbox.
 *
 * They diverged in production. The runner's Git Workflow block read
 * `gitConfig.targetBranch` directly and never looked at the mission, so a task
 * on an integration-branch mission was instructed "Changes require PR to
 * <trunk>" — while the server, deriving the base from the mission, refused
 * trunk for that exact task. The agent did as it was told, got a 400, tried
 * omitting the base, and hit a 422 on a branch that had since been deleted.
 * There was no third option available to it.
 *
 * So this file asserts AGREEMENT, not correctness: whatever the shared function
 * decides, the prompt must say it. The `create_pr` side of the pair is the same
 * `resolveTaskPrBase` call the route makes (apps/web/src/app/api/github/pr).
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

/**
 * What `create_pr` will derive for this task — the same call the route makes,
 * with the route's own (longer) fallback chain. The chains differ in their tail
 * on purpose: the server can see `context.targetBranch` and the repo's own
 * default, the runner cannot. The mission-integration answer, which is the one
 * that was wrong, does not depend on the tail at all.
 */
function serverSideBase(task: Record<string, unknown>) {
  return resolveTaskPrBase({
    mission: (task as any).mission,
    task: task as any,
    head: WORKER_BRANCH,
    fallbacks: [undefined, GIT_CONFIG.targetBranch, GIT_CONFIG.defaultBranch, 'main'],
  }).base;
}

/** The `- Changes require PR to \`X\`` line, as the prompt renders it. */
function promptPrTarget(task: Record<string, unknown>): string | null {
  const built = buildPromptWithComposition(ctx(task));
  const m = /- Changes require PR to `([^`]+)`/.exec(built.promptText);
  return m ? m[1] : null;
}

describe('prompt/guard agreement on a task PR base', () => {
  test('a mission-integration task: the prompt names the integration branch, not trunk', () => {
    const task = {
      mission: { workingBranch: INTEGRATION_BRANCH, integrationBranchEnabled: true },
      missionId: 'mission-1',
    };
    expect(serverSideBase(task)).toBe(INTEGRATION_BRANCH);
    expect(promptPrTarget(task)).toBe(INTEGRATION_BRANCH);
    // And it says WHY, so the agent does not "fix" it by retargeting trunk.
    const built = buildPromptWithComposition(ctx(task));
    expect(built.promptText).toContain("this mission's integration branch, NOT trunk");
    expect(built.promptText).toContain(`targets \`${INTEGRATION_BRANCH}\` automatically`);
  });

  test('a task with no mission: both still say trunk', () => {
    const task = {};
    expect(serverSideBase(task)).toBe('dev');
    expect(promptPrTarget(task)).toBe('dev');
  });

  test('a mission that never opted in: both still say trunk', () => {
    const task = {
      mission: { workingBranch: INTEGRATION_BRANCH, integrationBranchEnabled: false },
      missionId: 'mission-1',
    };
    expect(serverSideBase(task)).toBe('dev');
    expect(promptPrTarget(task)).toBe('dev');
  });

  test('a stacked plan phase: both name the predecessor branch', () => {
    const task = {
      mission: { workingBranch: INTEGRATION_BRANCH, integrationBranchEnabled: true },
      missionId: 'mission-1',
      context: { baseBranch: 'buildd/99999999-phase-1' },
    };
    expect(serverSideBase(task)).toBe('buildd/99999999-phase-1');
    expect(promptPrTarget(task)).toBe('buildd/99999999-phase-1');
  });

  test('the mission-PR owner: both say trunk, because its base IS trunk', () => {
    const task = {
      title: 'Ship mission: Checkout arc',
      taskClass: 'bookkeeping',
      mission: { workingBranch: INTEGRATION_BRANCH, integrationBranchEnabled: true },
      missionId: 'mission-1',
    };
    expect(serverSideBase(task)).toBe('dev');
    expect(promptPrTarget(task)).toBe('dev');
  });

  test('the mission-integration note is absent when trunk is the answer', () => {
    // The extra instruction is load-bearing only in the A′ case; emitting it
    // everywhere would teach every agent in every workspace to distrust trunk.
    const built = buildPromptWithComposition(ctx({}));
    expect(built.promptText).not.toContain('integration branch, NOT trunk');
  });
});
