process.env.NODE_ENV = 'test';

import { describe, it, expect, mock, beforeEach } from 'bun:test';

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

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: mockTasksFindFirst },
      workers: { findFirst: mockWorkersFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
      githubRepos: { findFirst: mockGithubReposFindFirst },
    },
    insert: mockDbInsert,
  },
}));

const mockDetectArchetype = mock(() => 'none' as any);
mock.module('@buildd/core/release-archetype', () => ({ detectArchetype: mockDetectArchetype }));

const mockAttributeRelease = mock(() => Promise.resolve({ attributed: 0, skipped: 0 }));
mock.module('@buildd/core/release-attribution', () => ({ attributeRelease: mockAttributeRelease }));

mock.module('@/lib/github', () => ({
  githubApi: mockGithubApi,
}));

// Mimic production resolve logic: absent strategy => branch_merge
mock.module('@buildd/core/release-strategy', () => ({
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
import { findReleasePr, executeRelease } from './release-executor';

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
      name: 'moa-ops',
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
      targetRef: 'main',
      sourceRef: 'buildd/my-feat',
      strategy: 'branch_merge',
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

  it('does not insert a releases row for a gated workspace (trigger route owns that)', async () => {
    // Gated workspace with releaseBranch — executeRelease skips row creation
    mockTasksFindFirst.mockResolvedValue({ release: 'inherit' });
    setupWorker();
    setupGatedWorkspace();
    setupRepo();

    // releaseBranch path: task release flag is 'inherit' so it returns skipped early
    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.status).toBe('skipped');
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
