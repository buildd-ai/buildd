process.env.NODE_ENV = 'test';

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

// ── Mocks (must be set up before any import of the module under test) ─────────

const mockGithubApi = mock(() => Promise.resolve(null) as any);
const mockTasksFindFirst = mock(() => Promise.resolve(null) as any);
const mockWorkersFindFirst = mock(() => Promise.resolve(null) as any);
const mockWorkspacesFindFirst = mock(() => Promise.resolve(null) as any);
const mockGithubReposFindFirst = mock(() => Promise.resolve(null) as any);

// Releases insert chain: insert().values().onConflictDoNothing().returning()
const mockDbInsertReturning = mock(() => Promise.resolve([] as any[]));
const mockDbInsertOnConflict = mock(() => ({ returning: mockDbInsertReturning }));
const mockDbInsertValues = mock(() => ({ onConflictDoNothing: mockDbInsertOnConflict }));
const mockDbInsert = mock(() => ({ values: mockDbInsertValues }));

// Healthy-promotion update chain: update().set().where().returning()
const mockDbUpdateReturning = mock(() => Promise.resolve([{ id: 'release-abc' }] as any[]));
const mockDbUpdateWhere = mock((_pred?: unknown) => ({ returning: mockDbUpdateReturning }));
const mockDbUpdateSet = mock((_values?: unknown) => ({ where: mockDbUpdateWhere }));
const mockDbUpdate = mock((_table?: unknown) => ({ set: mockDbUpdateSet }));

// recordDirectProdMerge's repo/workspace lookups: select().from(table).where()
const mockDbSelectGithubRepos = mock(() => Promise.resolve([] as any[]));
const mockDbSelectWorkspaces = mock(() => Promise.resolve([] as any[]));

/**
 * The QUERY ARGUMENTS, captured.
 *
 * The stubs below ignore what they are asked for, so a test that only checks the
 * returned decision cannot tell a correct query from a broken one. That is not
 * hypothetical here: deleting `prBaseRef`/`branch` from the workers `columns`, or
 * the `with: { mission: … }` relation from the task query, makes
 * `isMissionIntegrationBase` see undefined, the A′ refusal never fires, and every
 * refusal test still passes — while a task branch cut off the integration branch
 * merges straight into the prod branch. Capturing the args is what makes the
 * selection itself testable. Recorded in the module mock rather than inside the
 * `mock()` fns because tests reassign those with mockResolvedValue.
 */
let taskFindArgs: any[] = [];
let workerFindArgs: any[] = [];

// Real (unmocked) schema — used for select().from(<table>) identity so the
// stub can tell the githubRepos lookup apart from the workspaces lookup.
import { githubRepos as githubReposTable, workspaces as workspacesTable } from '@buildd/core/db/schema';

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: {
        findFirst: (args?: any) => {
          taskFindArgs.push(args);
          return mockTasksFindFirst(args as never);
        },
      },
      workers: {
        findFirst: (args?: any) => {
          workerFindArgs.push(args);
          return mockWorkersFindFirst(args as never);
        },
      },
      workspaces: { findFirst: mockWorkspacesFindFirst },
      githubRepos: { findFirst: mockGithubReposFindFirst },
    },
    insert: mockDbInsert,
    update: mockDbUpdate,
    select: (_cols?: any) => ({
      from: (table: any) => ({
        where: (_cond?: any) =>
          table === githubReposTable ? mockDbSelectGithubRepos() : mockDbSelectWorkspaces(),
      }),
    }),
  },
}));

const mockDetectArchetype = mock(() => 'none' as any);
mock.module('@buildd/core/release-archetype', () => ({ detectArchetype: mockDetectArchetype }));

const mockAttributeRelease = mock(() => Promise.resolve({ attributed: 0, skipped: 0 }));
mock.module('@buildd/core/release-attribution', () => ({ attributeRelease: mockAttributeRelease }));

mock.module('@/lib/github', () => ({
  githubApi: mockGithubApi,
}));

const mockTriggerEvent = mock(() => Promise.resolve());
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { workspace: (id: string) => `private-workspace-${id}` },
  events: { RELEASE_UPDATED: 'release:updated' },
}));

// Mimic production resolve logic: absent strategy => branch_merge
mock.module('@buildd/core/release-strategy', () => ({
  // Mirrors the real module: the trigger default lives in ONE place.
  resolveReleaseTrigger: (c: any) => c?.trigger ?? 'every_merge',
  resolveReleaseStrategy: (config: any) => {
    if (!config || !config.enabled) {
      return { ok: false, reason: 'not_configured', message: 'not configured' };
    }
    const kind = config.strategy ?? 'branch_merge';
    if (kind === 'branch_merge') {
      if (!config.prodBranch) return { ok: false, reason: 'invalid', message: 'needs prodBranch' };
      return {
        ok: true,
        strategy: { kind, prodBranch: config.prodBranch, releaseBranch: config.releaseBranch, deployTarget: config.deployTarget },
      };
    }
    return { ok: false, reason: 'invalid', message: `unknown strategy ${kind}` };
  },
}));

// classifyCheckRuns is a pure function — use the real implementation
import { classifyCheckRuns } from '@/lib/release/dispatch';
mock.module('@/lib/release/dispatch', () => ({ classifyCheckRuns }));

// ── Now import the module under test ─────────────────────────────────────────
import { findReleasePr, executeRelease, recordDirectProdMerge, _setSleeper } from './release-executor';

// The executor sleeps 8s before polling Vercel and 10s between polls. Real
// sleeps would blow the test timeout, so swap in a no-op (same injection
// pattern release-verification.ts already uses for its retry sleeper).
_setSleeper(() => Promise.resolve());

// ── findReleasePr ─────────────────────────────────────────────────────────────

describe('findReleasePr', () => {
  beforeEach(() => mockGithubApi.mockReset());

  it('returns null when no open PR exists', async () => {
    mockGithubApi.mockResolvedValue([]);
    expect(await findReleasePr(1, 'org/repo', 'dev', 'main')).toBeNull();
  });

  it('returns PR details when an open PR exists', async () => {
    mockGithubApi.mockResolvedValue([
      { number: 42, head: { sha: 'abc123' }, html_url: 'https://github.com/org/repo/pull/42', title: 'Release v1.2.0' },
    ]);
    const result = await findReleasePr(1, 'org/repo', 'dev', 'main');
    expect(result).toMatchObject({ number: 42, headSha: 'abc123', title: 'Release v1.2.0' });
  });

  it('returns null on API error', async () => {
    mockGithubApi.mockRejectedValue(new Error('network error'));
    expect(await findReleasePr(1, 'org/repo', 'dev', 'main')).toBeNull();
  });
});

// ── executeRelease contract (releaseBranch path) ──────────────────────────────

describe('executeRelease — releaseBranch', () => {
  function setupTask(release: string = 'true') {
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', release });
  }
  function setupWorker(branch = 'buildd/task-branch') {
    mockWorkersFindFirst.mockResolvedValue({ id: 'worker-1', branch, prNumber: null, prUrl: null });
  }
  function setupWorkspaceWithReleaseBranch() {
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-1',
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main', releaseBranch: 'dev' },
      githubRepoId: 'repo-1',
    });
  }
  function setupRepo() {
    mockGithubReposFindFirst.mockResolvedValue({
      id: 'repo-1',
      fullName: 'org/repo',
      installation: { installationId: 99 },
    });
  }

  beforeEach(() => {
    mockGithubApi.mockReset();
    mockTasksFindFirst.mockReset();
    mockWorkersFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockGithubReposFindFirst.mockReset();
    mockDbInsert.mockReset();
    mockDbInsertValues.mockReset();
    mockDbInsertOnConflict.mockReset();
    mockDbInsertReturning.mockReset();
    mockDbInsert.mockReturnValue({ values: mockDbInsertValues });
    mockDbInsertValues.mockReturnValue({ onConflictDoNothing: mockDbInsertOnConflict });
    mockDbInsertOnConflict.mockReturnValue({ returning: mockDbInsertReturning });
    mockDbInsertReturning.mockResolvedValue([]);
    mockAttributeRelease.mockReset();
    mockDetectArchetype.mockReturnValue('none');
  });

  it('returns not_configured when workspace has no releaseConfig', async () => {
    mockTasksFindFirst.mockResolvedValue({ release: 'inherit' });
    mockWorkersFindFirst.mockResolvedValue({ branch: 'buildd/x', prNumber: null });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', releaseConfig: null, githubRepoId: null });
    mockGithubReposFindFirst.mockResolvedValue(null);

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.status).toBe('not_configured');
  });

  it('returns failed when no open release PR is found', async () => {
    setupTask();
    setupWorker();
    setupWorkspaceWithReleaseBranch();
    setupRepo();
    mockGithubApi.mockResolvedValueOnce([]); // findReleasePr → no PRs

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.status).toBe('failed');
    expect(result.message).toContain('no open release PR');
  });

  it('returns pending_ci when CI is still running', async () => {
    setupTask();
    setupWorker();
    setupWorkspaceWithReleaseBranch();
    setupRepo();
    // findReleasePr
    mockGithubApi.mockResolvedValueOnce([
      { number: 47, head: { sha: 'deadbeef' }, html_url: 'https://github.com/org/repo/pull/47', title: 'Release v0.5.0' },
    ]);
    // check-runs — one still in_progress
    mockGithubApi.mockResolvedValueOnce({
      check_runs: [
        { name: 'build', status: 'in_progress', conclusion: null },
        { name: 'typecheck', status: 'completed', conclusion: 'success' },
      ],
    });

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.status).toBe('pending_ci');
    expect(result.releasePrNumber).toBe(47);
    expect(result.message).toContain('CI pending');
  });

  it('returns failed when CI is failing on the release PR', async () => {
    setupTask();
    setupWorker();
    setupWorkspaceWithReleaseBranch();
    setupRepo();
    mockGithubApi.mockResolvedValueOnce([
      { number: 47, head: { sha: 'deadbeef' }, html_url: 'https://github.com/org/repo/pull/47', title: 'Release v0.5.0' },
    ]);
    mockGithubApi.mockResolvedValueOnce({
      check_runs: [
        { name: 'build', status: 'completed', conclusion: 'failure' },
      ],
    });

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.status).toBe('failed');
    expect(result.message).toContain('CI failing');
    expect(result.releasePrNumber).toBe(47);
  });

  it('merges the PR and returns completed when CI is passing', async () => {
    setupTask();
    setupWorker();
    setupWorkspaceWithReleaseBranch();
    setupRepo();
    mockGithubApi.mockResolvedValueOnce([
      { number: 47, head: { sha: 'deadbeef' }, html_url: 'https://github.com/org/repo/pull/47', title: 'Release v0.5.0' },
    ]);
    mockGithubApi.mockResolvedValueOnce({
      check_runs: [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'lint', status: 'completed', conclusion: 'success' },
      ],
    });
    // previousSha ref lookup (before merge)
    mockGithubApi.mockResolvedValueOnce({ object: { sha: 'prevsha000' } });
    // merge PR
    mockGithubApi.mockResolvedValueOnce({ sha: 'mergesha123', merged: true, message: 'PR merged' });

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.status).toBe('completed');
    expect(result.mergedAt).toBeDefined();
  });

  it('returns failed when merge call rejects', async () => {
    setupTask();
    setupWorker();
    setupWorkspaceWithReleaseBranch();
    setupRepo();
    mockGithubApi.mockResolvedValueOnce([
      { number: 47, head: { sha: 'deadbeef' }, html_url: 'https://github.com/org/repo/pull/47', title: 'Release v0.5.0' },
    ]);
    mockGithubApi.mockResolvedValueOnce({ check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] });
    // previousSha ref lookup (before merge)
    mockGithubApi.mockResolvedValueOnce({ object: { sha: 'prevsha000' } });
    mockGithubApi.mockRejectedValueOnce(new Error('merge conflict'));

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.status).toBe('failed');
    expect(result.message).toContain('could not merge');
  });
});

// ── executeRelease — worker-branch (no releaseBranch) ─────────────────────────

describe('executeRelease — worker branch', () => {
  function setupTask() {
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', release: 'true' });
  }
  function setupWorker() {
    mockWorkersFindFirst.mockResolvedValue({ id: 'worker-1', branch: 'buildd/task-branch', prNumber: null, prUrl: null });
  }
  function setupWorkspace(extra: Record<string, unknown> = {}) {
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-1',
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main', ...extra },
      githubRepoId: 'repo-1',
    });
  }
  function setupRepo() {
    mockGithubReposFindFirst.mockResolvedValue({
      id: 'repo-1',
      fullName: 'org/repo',
      installation: { installationId: 99 },
    });
  }

  beforeEach(() => {
    mockGithubApi.mockReset();
    mockTasksFindFirst.mockReset();
    mockWorkersFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockGithubReposFindFirst.mockReset();
    mockDbInsert.mockReset();
    mockDbInsertValues.mockReset();
    mockDbInsertOnConflict.mockReset();
    mockDbInsertReturning.mockReset();
    mockDbInsert.mockReturnValue({ values: mockDbInsertValues });
    mockDbInsertValues.mockReturnValue({ onConflictDoNothing: mockDbInsertOnConflict });
    mockDbInsertOnConflict.mockReturnValue({ returning: mockDbInsertReturning });
    mockDbInsertReturning.mockResolvedValue([]);
    mockAttributeRelease.mockReset();
    mockDetectArchetype.mockReturnValue('none');
    delete process.env.VERCEL_TOKEN;
  });

  it('treats 404 "Head does not exist" as no-op success (branch already merged/deleted)', async () => {
    setupTask();
    setupWorker();
    setupWorkspace();
    setupRepo();
    // previousSha ref lookup (before merge)
    mockGithubApi.mockResolvedValueOnce({ object: { sha: 'prevsha000' } });
    // The /merges call throws a 404 "Head does not exist"
    mockGithubApi.mockRejectedValueOnce(
      new Error('GitHub API error: 404 {"message":"Head does not exist","status":"404"}')
    );

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.status).toBe('completed');
    expect(result.message).toContain('completed');
  });

  it('completes without Vercel verification when VERCEL_TOKEN is absent', async () => {
    setupTask();
    setupWorker();
    setupWorkspace({ deployTarget: { type: 'vercel', projectId: 'proj_abc' } });
    setupRepo();
    // previousSha ref lookup (before merge)
    mockGithubApi.mockResolvedValueOnce({ object: { sha: 'prevsha000' } });
    // Merge succeeds
    mockGithubApi.mockResolvedValueOnce({ sha: 'mergesha456', commit: {} });
    // VERCEL_TOKEN is not set (cleared in beforeEach)

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.status).toBe('completed');
    expect(result.deployState).toBe('SKIPPED');
    expect(result.message).toContain('Vercel unverified');
  });
});

// ── Trigger policy ─────────────────────────────────────────────────────────────

describe('executeRelease — trigger policy', () => {
  beforeEach(() => {
    mockTasksFindFirst.mockReset();
    mockWorkersFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockGithubReposFindFirst.mockReset();
    mockGithubApi.mockReset();
    mockDbInsert.mockReset();
    mockDbInsertValues.mockReset();
    mockDbInsertOnConflict.mockReset();
    mockDbInsertReturning.mockReset();
    mockDbInsert.mockReturnValue({ values: mockDbInsertValues });
    mockDbInsertValues.mockReturnValue({ onConflictDoNothing: mockDbInsertOnConflict });
    mockDbInsertOnConflict.mockReturnValue({ returning: mockDbInsertReturning });
    mockDbInsertReturning.mockResolvedValue([]);
    mockAttributeRelease.mockReset();
    mockDetectArchetype.mockReturnValue('none');
    taskFindArgs = [];
    workerFindArgs = [];

    // default: task with release='inherit', worker with branch
    mockTasksFindFirst.mockResolvedValue({ release: 'inherit' });
    mockWorkersFindFirst.mockResolvedValue({ branch: 'buildd/abc-feat', prNumber: null, prUrl: null });
  });

  it('skips release when trigger=manual', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main', trigger: 'manual' },
      githubRepoId: 'repo-1',
    });

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.status).toBe('skipped');
    expect(result.message).toContain('trigger=manual');
  });

  it('skips release when trigger=on_mission_complete', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main', trigger: 'on_mission_complete' },
      githubRepoId: 'repo-1',
    });

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.status).toBe('skipped');
    expect(result.message).toContain('on_mission_complete');
  });

  // ── Option A′: the integration branch is not a release source ─────────────
  //
  // The worker-branch path merges `worker.branch` straight into the prod branch.
  // A mission task's branch is cut from the integration branch, so releasing
  // from it would carry every sibling commit already on that branch and not yet
  // on trunk — shipping unreviewed work to production and bypassing the mission
  // PR, which is the one human gate A′ exists to create.

  const OPTED_IN_MISSION = {
    workingBranch: 'mission/checkout-arc-1a2b3c4d',
    integrationBranchEnabled: true,
  };

  it('refuses to release a task whose PR targets the mission integration branch', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main', trigger: 'every_merge' },
      githubRepoId: 'repo-1',
    });
    mockTasksFindFirst.mockResolvedValue({ release: 'inherit', missionId: 'm-1', mission: OPTED_IN_MISSION });
    mockWorkersFindFirst.mockResolvedValue({
      branch: 'buildd/abc-feat',
      prNumber: 7,
      prUrl: 'https://example.test/pr/7',
      prBaseRef: 'mission/checkout-arc-1a2b3c4d',
    });

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.status).toBe('skipped');
    expect(result.message).toContain('mission integration branch');
  });

  it('refuses even when isMissionRelease bypasses the trigger policy', async () => {
    // isMissionRelease exists to bypass cadence, not to bypass safety. Under A′
    // the mission's work reaches prod through the mission PR, never from a
    // worker branch cut off the integration branch.
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main', trigger: 'on_mission_complete' },
      githubRepoId: 'repo-1',
    });
    mockTasksFindFirst.mockResolvedValue({ release: 'inherit', missionId: 'm-1', mission: OPTED_IN_MISSION });
    mockWorkersFindFirst.mockResolvedValue({
      branch: 'buildd/abc-feat',
      prNumber: 7,
      prUrl: 'https://example.test/pr/7',
      prBaseRef: 'mission/checkout-arc-1a2b3c4d',
    });

    const result = await executeRelease({
      taskId: 't', workerId: 'w', workspaceId: 'ws-1', isMissionRelease: true,
    });
    expect(result.status).toBe('skipped');
    expect(result.message).toContain('mission integration branch');
  });

  it('still releases a mission task whose PR targets trunk', async () => {
    // A task of an opted-in mission that nonetheless lands on trunk — the
    // "nothing changes unless the base ref says so" guarantee.
    //
    // This test used to set `branch: 'mission/checkout-arc-1a2b3c4d'` and assert
    // no refusal, i.e. it PINNED the hole the second arm below closes: a row
    // whose base ref is trunk but whose branch IS the integration branch was
    // released by merging that branch straight into prod. The branch here is now
    // an ordinary task branch, which is what the assertion was ever about.
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main', trigger: 'every_merge' },
      githubRepoId: 'repo-1',
    });
    mockTasksFindFirst.mockResolvedValue({ release: 'inherit', missionId: 'm-1', mission: OPTED_IN_MISSION });
    mockWorkersFindFirst.mockResolvedValue({
      branch: 'buildd/abc-feat',
      prNumber: 9,
      prUrl: 'https://example.test/pr/9',
      prBaseRef: 'dev',
    });
    mockGithubReposFindFirst.mockResolvedValue(null); // stop past the refusal

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.message).not.toContain('mission integration branch');
  });

  it('still releases a task of a mission that has not opted in', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main', trigger: 'every_merge' },
      githubRepoId: 'repo-1',
    });
    mockTasksFindFirst.mockResolvedValue({
      release: 'inherit',
      missionId: 'm-1',
      mission: { ...OPTED_IN_MISSION, integrationBranchEnabled: false },
    });
    mockWorkersFindFirst.mockResolvedValue({
      branch: 'buildd/abc-feat',
      prNumber: 7,
      prUrl: 'https://example.test/pr/7',
      prBaseRef: 'mission/checkout-arc-1a2b3c4d',
    });
    mockGithubReposFindFirst.mockResolvedValue(null);

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.message).not.toContain('mission integration branch');
  });

  /**
   * ARM 2 — the release SOURCE must never be a mission integration branch.
   *
   * Arm 1 asks "does this task's PR target the integration branch", which catches
   * a deliverable task of an A′ mission. It does not catch the mission's own
   * bookkeeping owner row: that row's `prBaseRef` is TRUNK (the mission PR's base)
   * while its `workers.branch` is the integration branch itself. The worker-branch
   * path then calls mergeIntoProd(worker.branch) and merges `mission/<slug>`
   * directly into the prod branch — bypassing both the mission PR and trunk, and
   * shipping every sibling commit on that branch unreviewed.
   *
   * It is reachable: attemptMissionRelease picks the mission's most recently
   * updated completed task that has a worker (`tasks.updatedAt desc`), so whether
   * a mission got a refusal or a direct-to-prod merge of its integration branch
   * depended on which row that ordering happened to surface. Nondeterministic
   * release behaviour, worst outcome an unreviewed production deploy.
   */
  const MISSION_OWNER_ROW = {
    branch: 'mission/checkout-arc-1a2b3c4d',
    prNumber: 9,
    prUrl: 'https://example.test/pr/9',
    prBaseRef: 'dev', // the MISSION PR's base — trunk, so arm 1 says nothing
  };

  it('refuses when the release source branch IS the mission integration branch', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main', trigger: 'every_merge' },
      githubRepoId: 'repo-1',
    });
    mockTasksFindFirst.mockResolvedValue({ release: 'inherit', missionId: 'm-1', mission: OPTED_IN_MISSION });
    mockWorkersFindFirst.mockResolvedValue({ ...MISSION_OWNER_ROW });
    mockGithubReposFindFirst.mockResolvedValue(null);

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.status).toBe('skipped');
    expect(result.message).toContain('mission integration branch');
    // Names the branch, so the refusal is diagnosable from the feed alone.
    expect(result.message).toContain('mission/checkout-arc-1a2b3c4d');
  });

  it('refuses the integration-branch source even under isMissionRelease', async () => {
    // This is the path that actually fires it — the mission-complete hook.
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main', trigger: 'on_mission_complete' },
      githubRepoId: 'repo-1',
    });
    mockTasksFindFirst.mockResolvedValue({ release: 'inherit', missionId: 'm-1', mission: OPTED_IN_MISSION });
    mockWorkersFindFirst.mockResolvedValue({ ...MISSION_OWNER_ROW });
    mockGithubReposFindFirst.mockResolvedValue(null);

    const result = await executeRelease({
      taskId: 't', workerId: 'w', workspaceId: 'ws-1', isMissionRelease: true,
    });
    expect(result.status).toBe('skipped');
    expect(result.message).toContain('mission integration branch');
  });

  it('refuses the integration-branch source BEFORE the trigger policy can answer', async () => {
    // Position matters: if the refusal moved below the trigger block, a
    // trigger=every_merge workspace would fall straight through to the merge, and
    // the only test coverage would be a trigger=manual skip that happens to look
    // like a refusal. Pin the order by making the trigger permissive and asserting
    // the message is the refusal, not a cadence skip.
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main', trigger: 'every_merge' },
      githubRepoId: 'repo-1',
    });
    mockTasksFindFirst.mockResolvedValue({ release: 'true', missionId: 'm-1', mission: OPTED_IN_MISSION });
    mockWorkersFindFirst.mockResolvedValue({ ...MISSION_OWNER_ROW });
    mockGithubReposFindFirst.mockResolvedValue(null);

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.status).toBe('skipped');
    expect(result.message).toContain('mission integration branch');
    // No GitHub call was made — nothing was merged anywhere.
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('releases from a mission-shaped branch when the mission never opted in', async () => {
    // Flag-gated, like arm 1: a mission that never opted in behaves exactly as it
    // did before A′ existed, even though its working branch is named `mission/…`.
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main', trigger: 'every_merge' },
      githubRepoId: 'repo-1',
    });
    mockTasksFindFirst.mockResolvedValue({
      release: 'inherit',
      missionId: 'm-1',
      mission: { ...OPTED_IN_MISSION, integrationBranchEnabled: false },
    });
    mockWorkersFindFirst.mockResolvedValue({ ...MISSION_OWNER_ROW });
    mockGithubReposFindFirst.mockResolvedValue(null);

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.message).not.toContain('mission integration branch');
  });

  it('releases from a task branch of an opted-in mission that is not the integration branch', async () => {
    // The arm must not swallow ordinary releases: only the integration branch
    // itself is refused as a source.
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main', trigger: 'every_merge' },
      githubRepoId: 'repo-1',
    });
    mockTasksFindFirst.mockResolvedValue({ release: 'inherit', missionId: 'm-1', mission: OPTED_IN_MISSION });
    mockWorkersFindFirst.mockResolvedValue({
      branch: 'buildd/abc-feat', prNumber: 9, prUrl: 'https://example.test/pr/9', prBaseRef: 'dev',
    });
    mockGithubReposFindFirst.mockResolvedValue(null);

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.message).not.toContain('mission integration branch');
  });

  // ── The refusal's INPUTS, not just its output ──────────────────────────────
  // Every refusal test above still passes if the columns feeding the predicate
  // are dropped from the query, because the stubs ignore their arguments. These
  // two assert the selection itself.

  it('selects the worker columns the refusal reads', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main', trigger: 'every_merge' },
      githubRepoId: 'repo-1',
    });
    mockTasksFindFirst.mockResolvedValue({ release: 'inherit', missionId: 'm-1', mission: OPTED_IN_MISSION });
    mockWorkersFindFirst.mockResolvedValue({ ...MISSION_OWNER_ROW });
    mockGithubReposFindFirst.mockResolvedValue(null);

    await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });

    expect(workerFindArgs).toHaveLength(1);
    // Arm 1 reads prBaseRef; arm 2 reads branch. A column that is not selected
    // arrives as undefined and the predicate silently answers false.
    expect(workerFindArgs[0].columns.prBaseRef).toBe(true);
    expect(workerFindArgs[0].columns.branch).toBe(true);
  });

  it("selects the mission's integration-branch opt-in with the task", async () => {
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main', trigger: 'every_merge' },
      githubRepoId: 'repo-1',
    });
    mockTasksFindFirst.mockResolvedValue({ release: 'inherit', missionId: 'm-1', mission: OPTED_IN_MISSION });
    mockWorkersFindFirst.mockResolvedValue({ ...MISSION_OWNER_ROW });
    mockGithubReposFindFirst.mockResolvedValue(null);

    await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });

    expect(taskFindArgs).toHaveLength(1);
    // Without the relation the predicate has no mission and refuses nothing —
    // the flag gate degrades to "always allow", which is the wrong direction.
    expect(taskFindArgs[0].with.mission.columns.integrationBranchEnabled).toBe(true);
    expect(taskFindArgs[0].with.mission.columns.workingBranch).toBe(true);
  });

  it('still releases when the PR base ref is unknown', async () => {
    // Null base ref means "we do not know where this PR lands". It must not
    // silently suppress a release the workspace asked for.
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main', trigger: 'every_merge' },
      githubRepoId: 'repo-1',
    });
    mockTasksFindFirst.mockResolvedValue({ release: 'inherit', missionId: 'm-1', mission: OPTED_IN_MISSION });
    mockWorkersFindFirst.mockResolvedValue({
      branch: 'buildd/abc-feat', prNumber: 7, prUrl: 'https://example.test/pr/7', prBaseRef: null,
    });
    mockGithubReposFindFirst.mockResolvedValue(null);

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.message).not.toContain('mission integration branch');
  });

  it('proceeds when trigger=every_merge (default behavior)', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main', trigger: 'every_merge' },
      githubRepoId: 'repo-1',
    });
    // No repo returned → fails at repo lookup, but that's past the trigger check
    mockGithubReposFindFirst.mockResolvedValue(null);

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    // Should not return 'skipped' due to trigger policy
    expect(result.status).not.toBe('skipped');
  });

  it('proceeds when trigger is absent (back-compat default)', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main' },
      githubRepoId: 'repo-1',
    });
    mockGithubReposFindFirst.mockResolvedValue(null);

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.status).not.toBe('skipped');
  });

  it('bypasses trigger=on_mission_complete when isMissionRelease=true', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main', trigger: 'on_mission_complete' },
      githubRepoId: 'repo-1',
    });
    mockGithubReposFindFirst.mockResolvedValue({
      id: 'repo-1',
      fullName: 'org/repo',
      installation: { installationId: 99 },
    });
    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1', isMissionRelease: true });
    // Should not be skipped due to trigger — will proceed to branch_merge logic
    expect(result.status).not.toBe('skipped');
  });
});

// ── Releases row creation (continuous archetype) ──────────────────────────────

describe('executeRelease — releases row creation', () => {
  function setupTask() {
    mockTasksFindFirst.mockResolvedValue({ release: 'inherit' });
  }
  function setupWorker() {
    mockWorkersFindFirst.mockResolvedValue({ branch: 'buildd/my-feat', prNumber: null, prUrl: null });
  }
  function setupRepo() {
    mockGithubReposFindFirst.mockResolvedValue({
      id: 'repo-1',
      fullName: 'org/repo',
      installation: { installationId: 99 },
    });
  }
  function setupContinuousWorkspace() {
    mockWorkspacesFindFirst.mockResolvedValue({
      name: 'trunk-ops',
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main' },
      gitConfig: { requiresPR: false, defaultBranch: 'main' },
      githubRepoId: 'repo-1',
    });
    mockDetectArchetype.mockReturnValue('continuous');
  }
  function setupGatedWorkspace() {
    mockWorkspacesFindFirst.mockResolvedValue({
      name: 'buildd',
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main', releaseBranch: 'dev' },
      gitConfig: { requiresPR: true, defaultBranch: 'dev' },
      githubRepoId: 'repo-1',
    });
    mockDetectArchetype.mockReturnValue('gated');
  }

  beforeEach(() => {
    mockGithubApi.mockReset();
    mockTasksFindFirst.mockReset();
    mockWorkersFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockGithubReposFindFirst.mockReset();
    mockDbInsert.mockReset();
    mockDbInsertValues.mockReset();
    mockDbInsertOnConflict.mockReset();
    mockDbInsertReturning.mockReset();
    mockDbInsert.mockReturnValue({ values: mockDbInsertValues });
    mockDbInsertValues.mockReturnValue({ onConflictDoNothing: mockDbInsertOnConflict });
    mockDbInsertOnConflict.mockReturnValue({ returning: mockDbInsertReturning });
    mockDbInsertReturning.mockResolvedValue([{ id: 'release-abc' }]);
    mockAttributeRelease.mockReset();
    mockAttributeRelease.mockResolvedValue({ attributed: 1, skipped: 0 });
    mockDetectArchetype.mockReturnValue('none');
    delete process.env.VERCEL_TOKEN;
  });

  it('inserts a releases row with correct fields for a continuous workspace', async () => {
    setupTask();
    setupWorker();
    setupContinuousWorkspace();
    setupRepo();
    // ref lookup → previousSha
    mockGithubApi.mockResolvedValueOnce({ object: { sha: 'prevsha111' } });
    // merge succeeds
    mockGithubApi.mockResolvedValueOnce({ sha: 'headsha222', commit: {} });

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.status).toBe('completed');

    expect(mockDbInsert).toHaveBeenCalledTimes(1);
    expect(mockDbInsertValues).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1',
      archetype: 'continuous',
      state: 'deploying',
      triggeredBy: 'auto',
      headSha: 'headsha222',
      previousSha: 'prevsha111',
    }));
  });

  it('calls attributeRelease once when a row is inserted', async () => {
    setupTask();
    setupWorker();
    setupContinuousWorkspace();
    setupRepo();
    mockGithubApi.mockResolvedValueOnce({ object: { sha: 'prevsha111' } });
    mockGithubApi.mockResolvedValueOnce({ sha: 'headsha222', commit: {} });

    await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });

    // Wait for the fire-and-forget attribution promise to settle
    await new Promise((r) => setTimeout(r, 0));

    expect(mockAttributeRelease).toHaveBeenCalledTimes(1);
    expect(mockAttributeRelease).toHaveBeenCalledWith(expect.objectContaining({
      releaseId: 'release-abc',
      workspaceId: 'ws-1',
      headSha: 'headsha222',
      previousSha: 'prevsha111',
      archetype: 'continuous',
      repoFullName: 'org/repo',
      githubInstallationId: 99,
    }));
  });

  it('double-fire guard: second call with same headSha produces no duplicate row or attribution', async () => {
    setupTask();
    setupWorker();
    setupContinuousWorkspace();
    setupRepo();

    // First call — insert succeeds
    mockGithubApi.mockResolvedValueOnce({ object: { sha: 'prevsha111' } });
    mockGithubApi.mockResolvedValueOnce({ sha: 'headsha222', commit: {} });
    mockDbInsertReturning.mockResolvedValueOnce([{ id: 'release-abc' }]);

    await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    await new Promise((r) => setTimeout(r, 0));

    expect(mockAttributeRelease).toHaveBeenCalledTimes(1);

    // Second call — ON CONFLICT DO NOTHING → no rows returned
    mockGithubApi.mockResolvedValueOnce({ object: { sha: 'prevsha111' } });
    mockGithubApi.mockResolvedValueOnce({ sha: 'headsha222', commit: {} });
    mockDbInsertReturning.mockResolvedValueOnce([]);

    await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    await new Promise((r) => setTimeout(r, 0));

    // insert called twice total (one per executeRelease), but attribution only once
    expect(mockDbInsert).toHaveBeenCalledTimes(2);
    expect(mockAttributeRelease).toHaveBeenCalledTimes(1);
  });

  it('does not insert a releases row when archetype is none', async () => {
    setupTask();
    setupWorker();
    mockWorkspacesFindFirst.mockResolvedValue({
      name: 'My Workspace',
      releaseConfig: null,
      gitConfig: null,
      githubRepoId: 'repo-1',
    });
    mockDetectArchetype.mockReturnValue('none');
    setupRepo();

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    // Not configured — returns early before merge
    expect(result.status).toBe('not_configured');
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('writes no row when a feature task is skipped before any merge happens', async () => {
    // Renamed from "does not insert for a gated workspace (trigger route owns
    // that)": this case never reached the archetype check at all. With
    // releaseBranch set and release flag 'inherit', executeRelease returns
    // `skipped` long before maybeCreateReleaseRow, so the test proved only that
    // a no-op writes nothing — not anything about gated archetypes.
    mockTasksFindFirst.mockResolvedValue({ release: 'inherit' });
    setupWorker();
    setupGatedWorkspace();
    setupRepo();

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.status).toBe('skipped');
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  /**
   * Drive the gated path all the way to a merged release PR.
   *
   * githubApi call order in the releaseBranch branch:
   *   1. GET pulls?base=<prod>&head=<owner>:<releaseBranch>&state=open  → the release PR
   *   2. GET commits/<headSha>/check-runs                              → CI verdict
   *   3. GET git/ref/heads/<prod>                                      → previousSha
   *   4. PUT pulls/<n>/merge                                           → merge sha
   */
  function setupGatedReleasePrMerge() {
    mockGithubApi.mockResolvedValueOnce([
      { number: 77, head: { sha: 'prheadsha' }, html_url: 'https://github.com/org/repo/pull/77', title: 'Release v1.2.3' },
    ]);
    mockGithubApi.mockResolvedValueOnce({
      check_runs: [{ name: 'Build & Test', status: 'completed', conclusion: 'success' }],
    });
    mockGithubApi.mockResolvedValueOnce({ object: { sha: 'prevmain111' } });
    mockGithubApi.mockResolvedValueOnce({ sha: 'mergedmain222', commit: {} });
  }

  it('inserts a releases row for a gated workspace when the release PR merges', async () => {
    // The regression. A gated release IS a release: the release PR just landed on
    // the prod branch. Skipping the row wrote no release history and no
    // release_tasks edges, so a gated workspace had no task→release link and its
    // queue baseline fell through to the prod-branch-HEAD rung on every read.
    mockTasksFindFirst.mockResolvedValue({ release: 'true' });
    setupWorker();
    setupGatedWorkspace();
    setupRepo();
    setupGatedReleasePrMerge();

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.status).toBe('completed');

    expect(mockDbInsert).toHaveBeenCalledTimes(1);
    expect(mockDbInsertValues).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1',
      archetype: 'gated',
      state: 'deploying',
      headSha: 'mergedmain222',
      previousSha: 'prevmain111',
      // Matches api/releases/trigger: gated releases are HTTP-verifiable. Still
      // inert unless the workspace configures a verificationUrl.
      verificationStrategy: 'http',
    }));
  });

  it('attributes the gated release so release_tasks edges exist', async () => {
    mockTasksFindFirst.mockResolvedValue({ release: 'true' });
    setupWorker();
    setupGatedWorkspace();
    setupRepo();
    setupGatedReleasePrMerge();

    await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    await new Promise((r) => setTimeout(r, 0));

    expect(mockAttributeRelease).toHaveBeenCalledTimes(1);
    expect(mockAttributeRelease).toHaveBeenCalledWith(expect.objectContaining({
      releaseId: 'release-abc',
      workspaceId: 'ws-1',
      // gated → attribution walks the compare range by PR number
      archetype: 'gated',
      previousSha: 'prevmain111',
      headSha: 'mergedmain222',
    }));
  });

  it('marks a continuous release http-verifiable when the workspace configures a probe URL', async () => {
    // Regression: `archetype === 'gated' ? 'http' : 'none'` stamped every
    // continuous release `'none'`, and `verifyReleaseDeployment` returns early
    // unless the strategy is exactly `'http'`. So configuring a verificationUrl
    // on a continuous workspace made it strictly worse off — the probe never
    // ran and the row never left `deploying`.
    setupTask();
    setupWorker();
    mockWorkspacesFindFirst.mockResolvedValue({
      name: 'trunk-ops',
      releaseConfig: {
        enabled: true,
        strategy: 'branch_merge',
        prodBranch: 'main',
        verificationUrl: 'https://example.test/healthz',
      },
      gitConfig: { requiresPR: false, defaultBranch: 'main' },
      githubRepoId: 'repo-1',
    });
    mockDetectArchetype.mockReturnValue('continuous');
    setupRepo();
    mockGithubApi.mockResolvedValueOnce({ object: { sha: 'prevsha111' } });
    mockGithubApi.mockResolvedValueOnce({ sha: 'headsha222', commit: {} });

    await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });

    expect(mockDbInsertValues).toHaveBeenCalledWith(expect.objectContaining({
      archetype: 'continuous',
      verificationStrategy: 'http',
    }));
  });

  it('keeps a gated release http-verifiable with no probe URL, so the 24h sweep still sees it', async () => {
    // The additive half: gated rows must not lose `'http'`, or the cron's
    // stale-`deploying` sweep stops hard-failing them and they sit forever.
    mockTasksFindFirst.mockResolvedValue({ release: 'true' });
    setupWorker();
    setupGatedWorkspace();
    setupRepo();
    setupGatedReleasePrMerge();

    await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });

    expect(mockDbInsertValues).toHaveBeenCalledWith(expect.objectContaining({
      archetype: 'gated',
      verificationStrategy: 'http',
    }));
  });

  it('still writes no row for archetypes that are not this strategy', async () => {
    // store/package/none do not release via branch_merge, so widening the gate
    // to `gated` must not widen it to everything.
    mockTasksFindFirst.mockResolvedValue({ release: 'true' });
    setupWorker();
    setupGatedWorkspace();
    mockDetectArchetype.mockReturnValue('package');
    setupRepo();
    setupGatedReleasePrMerge();

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.status).toBe('completed');
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('skips attribution when headSha is undefined (already-merged no-op)', async () => {
    setupTask();
    setupWorker();
    setupContinuousWorkspace();
    setupRepo();
    // ref lookup
    mockGithubApi.mockResolvedValueOnce({ object: { sha: 'prevsha111' } });
    // merge returns no sha (already up-to-date, 204 path)
    mockGithubApi.mockResolvedValueOnce(null);

    await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    await new Promise((r) => setTimeout(r, 0));

    // headSha is undefined → early return in maybeCreateReleaseRow
    expect(mockDbInsert).not.toHaveBeenCalled();
    expect(mockAttributeRelease).not.toHaveBeenCalled();
  });
});

// ── Healthy promotion on deploy success ───────────────────────────────────────
//
// `state: 'healthy'` had exactly one writer (verifyReleaseDeployment) and that
// writer returns early unless the workspace has BOTH
// `verificationStrategy: 'http'` and a `releaseConfig.verificationUrl`. A
// workspace with no verificationUrl therefore had no path to `healthy` at all —
// its rows sat in `deploying` forever, so `MAX(healthy_at)` stayed NULL and the
// baseline ladder never reached its top rung.
//
// Policy: with no verificationUrl a successful deploy is the only health signal
// available, so READY promotes. SKIPPED means VERCEL_TOKEN was absent, i.e. the
// deploy was never verified at all — it MUST NOT promote. When a verificationUrl
// IS configured the HTTP probe stays authoritative and the executor promotes
// nothing.

const dialect = new PgDialect();

function renderPromotionWhere(): string {
  const pred = mockDbUpdateWhere.mock.calls[0]?.[0];
  return dialect.sqlToQuery(pred as any).sql.replace(/\s+/g, ' ').trim();
}

describe('executeRelease — healthy promotion on deploy success', () => {
  function setupTask() {
    mockTasksFindFirst.mockResolvedValue({ release: 'inherit' });
  }
  function setupWorker() {
    mockWorkersFindFirst.mockResolvedValue({ branch: 'buildd/my-feat', prNumber: null, prUrl: null });
  }
  function setupRepo() {
    mockGithubReposFindFirst.mockResolvedValue({
      id: 'repo-1',
      fullName: 'org/repo',
      installation: { installationId: 99 },
    });
  }
  function setupContinuousWorkspace(releaseConfigExtra: Record<string, unknown> = {}) {
    mockWorkspacesFindFirst.mockResolvedValue({
      name: 'trunk-ops',
      releaseConfig: {
        enabled: true,
        strategy: 'branch_merge',
        prodBranch: 'main',
        deployTarget: { type: 'vercel', projectId: 'proj_abc' },
        ...releaseConfigExtra,
      },
      gitConfig: { requiresPR: false, defaultBranch: 'main' },
      githubRepoId: 'repo-1',
    });
    mockDetectArchetype.mockReturnValue('continuous');
  }
  // ref lookup → previousSha, then the merge itself.
  function setupMerge() {
    mockGithubApi.mockResolvedValueOnce({ object: { sha: 'prevsha111' } });
    mockGithubApi.mockResolvedValueOnce({ sha: 'headsha222', commit: {} });
  }

  beforeEach(() => {
    mockGithubApi.mockReset();
    mockTasksFindFirst.mockReset();
    mockWorkersFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockGithubReposFindFirst.mockReset();
    mockDbInsert.mockReset();
    mockDbInsertValues.mockReset();
    mockDbInsertOnConflict.mockReset();
    mockDbInsertReturning.mockReset();
    mockDbInsert.mockReturnValue({ values: mockDbInsertValues });
    mockDbInsertValues.mockReturnValue({ onConflictDoNothing: mockDbInsertOnConflict });
    mockDbInsertOnConflict.mockReturnValue({ returning: mockDbInsertReturning });
    mockDbInsertReturning.mockResolvedValue([{ id: 'release-abc' }]);
    mockDbUpdate.mockReset();
    mockDbUpdateSet.mockReset();
    mockDbUpdateWhere.mockReset();
    mockDbUpdateReturning.mockReset();
    mockDbUpdate.mockReturnValue({ set: mockDbUpdateSet });
    mockDbUpdateSet.mockReturnValue({ where: mockDbUpdateWhere });
    mockDbUpdateWhere.mockReturnValue({ returning: mockDbUpdateReturning });
    mockDbUpdateReturning.mockResolvedValue([{ id: 'release-abc' }]);
    mockTriggerEvent.mockReset();
    mockTriggerEvent.mockResolvedValue(undefined as any);
    mockAttributeRelease.mockReset();
    mockAttributeRelease.mockResolvedValue({ attributed: 1, skipped: 0 });
    mockDetectArchetype.mockReturnValue('none');
    delete process.env.VERCEL_TOKEN;
    (globalThis as any).fetch = undefined;
  });

  it('promotes the inserted release to healthy when the deploy is READY and no verificationUrl is set', async () => {
    process.env.VERCEL_TOKEN = 'illustrative-token';
    (globalThis as any).fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ deployments: [{ uid: 'dpl_1', state: 'READY', url: 'example.invalid' }] }),
      } as any),
    );
    setupTask();
    setupWorker();
    setupContinuousWorkspace();
    setupRepo();
    setupMerge();

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });

    expect(result.status).toBe('completed');
    expect(result.deployState).toBe('READY');
    expect(mockDbUpdate).toHaveBeenCalledTimes(1);
    const setValues = mockDbUpdateSet.mock.calls[0]?.[0] as any;
    expect(setValues.state).toBe('healthy');
    expect(setValues.healthyAt).toBeInstanceOf(Date);
  });

  it('guards the promotion UPDATE on id AND state=deploying so it cannot resurrect a failed/degraded row', async () => {
    process.env.VERCEL_TOKEN = 'illustrative-token';
    (globalThis as any).fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ deployments: [{ uid: 'dpl_1', state: 'READY', url: 'example.invalid' }] }),
      } as any),
    );
    setupTask();
    setupWorker();
    setupContinuousWorkspace();
    setupRepo();
    setupMerge();

    await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });

    const where = renderPromotionWhere();
    expect(where).toContain('"releases"."id" = ');
    expect(where).toContain('"releases"."state" = ');
  });

  it('also guards the promotion UPDATE on head_sha IS NOT NULL — a release with no head sha can never become healthy', async () => {
    process.env.VERCEL_TOKEN = 'illustrative-token';
    (globalThis as any).fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ deployments: [{ uid: 'dpl_1', state: 'READY', url: 'example.invalid' }] }),
      } as any),
    );
    setupTask();
    setupWorker();
    setupContinuousWorkspace();
    setupRepo();
    setupMerge();

    await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });

    const where = renderPromotionWhere();
    expect(where).toContain('"releases"."head_sha" is not null');
  });

  it('emits RELEASE_UPDATED with state healthy so live surfaces do not stay on `deploying`', async () => {
    process.env.VERCEL_TOKEN = 'illustrative-token';
    (globalThis as any).fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ deployments: [{ uid: 'dpl_1', state: 'READY', url: 'example.invalid' }] }),
      } as any),
    );
    setupTask();
    setupWorker();
    setupContinuousWorkspace();
    setupRepo();
    setupMerge();

    await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });

    expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
    expect(mockTriggerEvent.mock.calls[0]?.[2]).toMatchObject({ releaseId: 'release-abc', state: 'healthy' });
  });

  it('does NOT promote on deployState SKIPPED — VERCEL_TOKEN absent means the deploy was never verified', async () => {
    // VERCEL_TOKEN stays unset (beforeEach), so pollVercelDeployment returns SKIPPED.
    setupTask();
    setupWorker();
    setupContinuousWorkspace();
    setupRepo();
    setupMerge();

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });

    expect(result.deployState).toBe('SKIPPED');
    expect(mockDbUpdate).not.toHaveBeenCalled();
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it('does NOT promote when the workspace configures a verificationUrl — the HTTP probe stays authoritative', async () => {
    process.env.VERCEL_TOKEN = 'illustrative-token';
    (globalThis as any).fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ deployments: [{ uid: 'dpl_1', state: 'READY', url: 'example.invalid' }] }),
      } as any),
    );
    setupTask();
    setupWorker();
    setupContinuousWorkspace({ verificationUrl: 'https://example.invalid/api/version' });
    setupRepo();
    setupMerge();

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });

    expect(result.deployState).toBe('READY');
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('does NOT promote when the insert conflicted — a retried release of the same sha owns no row to promote', async () => {
    process.env.VERCEL_TOKEN = 'illustrative-token';
    (globalThis as any).fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ deployments: [{ uid: 'dpl_1', state: 'READY', url: 'example.invalid' }] }),
      } as any),
    );
    // onConflictDoNothing returned no row.
    mockDbInsertReturning.mockResolvedValue([]);
    setupTask();
    setupWorker();
    setupContinuousWorkspace();
    setupRepo();
    setupMerge();

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });

    expect(result.status).toBe('completed');
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });
});

// The release PR (dev → prod) and hotfix PR (feature → prod) that ship this
// repo are opened via `scripts/release.sh` + the `gh` CLI and merged by CI or
// a human — no buildd worker ever owns either PR, so `executeRelease` (driven
// by a worker completing a task) never runs for them. `recordDirectProdMerge`
// is the webhook-driven path that records these merges independently of any
// worker, so a `branch_merge` workspace's release ledger reflects what
// actually shipped instead of only the fraction that happened to route
// through a worker's own PR.
describe('recordDirectProdMerge', () => {
  beforeEach(() => {
    mockDbSelectGithubRepos.mockReset();
    mockDbSelectWorkspaces.mockReset();
    mockDbInsert.mockReset();
    mockDbInsertValues.mockReset();
    mockDbInsertOnConflict.mockReset();
    mockDbInsertReturning.mockReset();
    mockDbInsert.mockReturnValue({ values: mockDbInsertValues });
    mockDbInsertValues.mockReturnValue({ onConflictDoNothing: mockDbInsertOnConflict });
    mockDbInsertOnConflict.mockReturnValue({ returning: mockDbInsertReturning });
    mockDbInsertReturning.mockResolvedValue([{ id: 'release-direct-1' }]);
    mockAttributeRelease.mockReset();
    mockAttributeRelease.mockResolvedValue({ attributed: 1, skipped: 0 });
    mockDetectArchetype.mockReset();
    mockDetectArchetype.mockReturnValue('gated');
  });

  function setupBoundBranchMergeWorkspace(overrides: Record<string, unknown> = {}) {
    mockDbSelectGithubRepos.mockResolvedValue([{ id: 'repo-1' }]);
    mockDbSelectWorkspaces.mockResolvedValue([
      {
        id: 'ws-1',
        name: 'buildd',
        releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main', releaseBranch: 'dev', ...overrides },
        gitConfig: {},
      },
    ]);
  }

  it('records a release for a merge with no owning worker (release PR / hotfix path)', async () => {
    setupBoundBranchMergeWorkspace();

    await recordDirectProdMerge({
      repoFullName: 'org/repo',
      installationId: 42,
      baseRef: 'main',
      headSha: 'merge-sha-1',
      previousSha: 'prev-sha-1',
    });

    expect(mockDbInsertValues).toHaveBeenCalledTimes(1);
    const values = mockDbInsertValues.mock.calls[0]?.[0] as any;
    expect(values).toMatchObject({ workspaceId: 'ws-1', headSha: 'merge-sha-1', previousSha: 'prev-sha-1' });
    expect(mockAttributeRelease).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no head sha is known', async () => {
    setupBoundBranchMergeWorkspace();

    await recordDirectProdMerge({
      repoFullName: 'org/repo',
      installationId: 42,
      baseRef: 'main',
      headSha: undefined,
      previousSha: 'prev-sha-1',
    });

    expect(mockDbSelectGithubRepos).not.toHaveBeenCalled();
    expect(mockDbInsertValues).not.toHaveBeenCalled();
  });

  it('skips a merge base that is not the configured prod branch (an ordinary feature merge into dev)', async () => {
    setupBoundBranchMergeWorkspace();

    await recordDirectProdMerge({
      repoFullName: 'org/repo',
      installationId: 42,
      baseRef: 'dev',
      headSha: 'merge-sha-1',
      previousSha: 'prev-sha-1',
    });

    expect(mockDbInsertValues).not.toHaveBeenCalled();
  });

  it('skips workspaces not on the branch_merge strategy — those record rows via the trigger route instead', async () => {
    mockDbSelectGithubRepos.mockResolvedValue([{ id: 'repo-1' }]);
    mockDbSelectWorkspaces.mockResolvedValue([
      { id: 'ws-1', name: 'buildd', releaseConfig: { enabled: true, strategy: 'workflow_dispatch' }, gitConfig: {} },
    ]);

    await recordDirectProdMerge({
      repoFullName: 'org/repo',
      installationId: 42,
      baseRef: 'main',
      headSha: 'merge-sha-1',
      previousSha: 'prev-sha-1',
    });

    expect(mockDbInsertValues).not.toHaveBeenCalled();
  });

  it('is a no-op (via the unique index) when a worker-owned merge already recorded the same head sha', async () => {
    setupBoundBranchMergeWorkspace();
    // Simulates the ON CONFLICT DO NOTHING path: insert returns no row.
    mockDbInsertReturning.mockResolvedValue([]);

    await recordDirectProdMerge({
      repoFullName: 'org/repo',
      installationId: 42,
      baseRef: 'main',
      headSha: 'merge-sha-1',
      previousSha: 'prev-sha-1',
    });

    expect(mockDbInsertValues).toHaveBeenCalledTimes(1);
    expect(mockAttributeRelease).not.toHaveBeenCalled();
  });

  it('does nothing when the repo is not bound to any workspace', async () => {
    mockDbSelectGithubRepos.mockResolvedValue([]);

    await recordDirectProdMerge({
      repoFullName: 'unbound/repo',
      installationId: 42,
      baseRef: 'main',
      headSha: 'merge-sha-1',
      previousSha: 'prev-sha-1',
    });

    expect(mockDbSelectWorkspaces).not.toHaveBeenCalled();
    expect(mockDbInsertValues).not.toHaveBeenCalled();
  });
});
