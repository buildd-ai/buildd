process.env.NODE_ENV = 'test';

import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ── Mocks (must be set up before any import of the module under test) ─────────

const mockGithubApi = mock(() => Promise.resolve(null) as any);
const mockTasksFindFirst = mock(() => Promise.resolve(null) as any);
const mockWorkersFindFirst = mock(() => Promise.resolve(null) as any);
const mockWorkspacesFindFirst = mock(() => Promise.resolve(null) as any);
const mockGithubReposFindFirst = mock(() => Promise.resolve(null) as any);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: mockTasksFindFirst },
      workers: { findFirst: mockWorkersFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
      githubRepos: { findFirst: mockGithubReposFindFirst },
    },
  },
}));

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
        strategy: { kind, prodBranch: config.prodBranch, releaseBranch: config.releaseBranch },
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
    mockGithubApi.mockRejectedValueOnce(new Error('merge conflict'));

    const result = await executeRelease({ taskId: 't', workerId: 'w', workspaceId: 'ws-1' });
    expect(result.status).toBe('failed');
    expect(result.message).toContain('could not merge');
  });
});
