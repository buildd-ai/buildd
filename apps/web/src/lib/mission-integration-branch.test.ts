/**
 * `ensureMissionIntegrationBranch` — the IO half of Option A′.
 *
 * The interesting behaviour is all in how it reads GitHub's 4xx bodies. Ref
 * creation returns 422 for the case we WANT ("Reference already exists", a
 * concurrent caller won the race) and 422 for several cases that mean the
 * branch does not exist and never will on this input — a bad or GC'd sha, an
 * invalid ref name, a generic validation failure. Reporting success for those
 * is the worst available outcome: the caller posts no note, nothing points at
 * the branch, and every task PR for the mission then fails to open against a
 * base ref that is absent.
 *
 * So each test here drives a real GitHub error body through the same string
 * shape `githubApi` throws (`GitHub API error: <status> <body>`).
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

const mockMissionsFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockGithubReposFindFirst = mock(() => null as any);
const mockGithubApi = mock(() => Promise.resolve(null as any));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: mockMissionsFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
      githubRepos: { findFirst: mockGithubReposFindFirst },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: { id: 'id' },
  workspaces: { id: 'id' },
  githubRepos: { id: 'id' },
}));

mock.module('@/lib/github', () => ({
  githubApi: mockGithubApi,
}));

import { ensureMissionIntegrationBranch } from './mission-integration-branch';

const BRANCH = 'mission/example-slug-0a1b2c3d';
const REPO_FULL_NAME = 'example-org/example-repo';

/** The exact string shape `githubApi` throws on a non-2xx response. */
function githubError(status: number, body: unknown): Error {
  return new Error(
    `GitHub API error: ${status} ${typeof body === 'string' ? body : JSON.stringify(body)}`,
  );
}

function withOptedInMission() {
  mockMissionsFindFirst.mockResolvedValue({
    workingBranch: BRANCH,
    integrationBranchEnabled: true,
    workspaceId: 'ws-1',
  });
  mockWorkspacesFindFirst.mockResolvedValue({
    githubRepoId: 'repo-1',
    githubInstallationId: 'inst-row-1',
    gitConfig: { targetBranch: 'trunk-branch' },
  });
  mockGithubReposFindFirst.mockResolvedValue({
    fullName: REPO_FULL_NAME,
    defaultBranch: 'trunk-branch',
    installation: { installationId: 4242 },
  });
}

/**
 * Wire the two GitHub calls the create path makes: the existence probe (404 —
 * not there yet) and the trunk head lookup (a sha), then let the caller decide
 * how `POST /git/refs` fails.
 */
function createPathWith(postOutcome: { throws?: Error; resolves?: unknown }) {
  mockGithubApi.mockImplementation(((_installationId: number, path: string, options?: RequestInit) => {
    if (path.endsWith(`/git/ref/heads/${BRANCH}`)) {
      return Promise.reject(githubError(404, { message: 'Not Found' }));
    }
    if (path.endsWith('/git/ref/heads/trunk-branch')) {
      return Promise.resolve({ object: { sha: 'a'.repeat(40) } });
    }
    if (path.endsWith('/git/refs') && options?.method === 'POST') {
      return postOutcome.throws
        ? Promise.reject(postOutcome.throws)
        : Promise.resolve(postOutcome.resolves ?? {});
    }
    return Promise.resolve(null);
  }) as any);
}

describe('ensureMissionIntegrationBranch', () => {
  beforeEach(() => {
    mockMissionsFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockGithubReposFindFirst.mockReset();
    mockGithubApi.mockReset();
  });

  it('creates the branch when it is absent', async () => {
    withOptedInMission();
    createPathWith({ resolves: { ref: `refs/heads/${BRANCH}` } });

    expect(await ensureMissionIntegrationBranch('m-1')).toEqual({
      ok: true,
      branch: BRANCH,
      created: true,
    });
  });

  it('treats a 422 that says the reference already exists as success', async () => {
    // The race we designed for: a concurrent caller created the ref between our
    // probe and our POST. The post-condition holds, so this is not an error.
    withOptedInMission();
    createPathWith({
      throws: githubError(422, {
        message: 'Reference already exists',
        documentation_url: 'https://docs.github.com/rest/git/refs#create-a-reference',
      }),
    });

    expect(await ensureMissionIntegrationBranch('m-1')).toEqual({
      ok: true,
      branch: BRANCH,
      created: false,
    });
  });

  it('matches the already-exists message case-insensitively', async () => {
    withOptedInMission();
    createPathWith({ throws: githubError(422, { message: 'reference already EXISTS' }) });

    const result = await ensureMissionIntegrationBranch('m-1');
    expect(result.ok).toBe(true);
  });

  it('reports api_error for a 422 whose sha does not exist', async () => {
    // A GC'd or mistyped sha. The branch was NOT created, so calling this a
    // success is how a mission ends up with every task PR failing to open and
    // nothing in the feed pointing at the branch.
    withOptedInMission();
    createPathWith({
      throws: githubError(422, {
        message: 'Object does not exist',
        errors: [{ resource: 'Reference', code: 'custom', field: 'sha', message: 'Object does not exist' }],
      }),
    });

    const result = await ensureMissionIntegrationBranch('m-1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('api_error');
    expect(result.detail).toContain('Object does not exist');
  });

  it('reports api_error for a 422 that rejects the ref name', async () => {
    withOptedInMission();
    createPathWith({
      throws: githubError(422, { message: 'Reference cannot be updated' }),
    });

    const result = await ensureMissionIntegrationBranch('m-1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('api_error');
  });

  it('reports api_error for a generic 422 validation failure', async () => {
    withOptedInMission();
    createPathWith({
      throws: githubError(422, { message: 'Validation Failed', errors: [{ resource: 'Reference' }] }),
    });

    const result = await ensureMissionIntegrationBranch('m-1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('api_error');
  });

  it('reports empty_repo for the 409 an unborn repository returns', async () => {
    // Ref creation can never succeed here, and the fix is not "retry" — it is
    // "push a first commit". Its own reason so the caller can say that.
    withOptedInMission();
    createPathWith({ throws: githubError(409, { message: 'Git Repository is empty.' }) });

    const result = await ensureMissionIntegrationBranch('m-1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('empty_repo');
  });

  it('reports empty_repo when the existence probe itself hits an empty repository', async () => {
    withOptedInMission();
    mockGithubApi.mockImplementation((() =>
      Promise.reject(githubError(409, { message: 'Git Repository is empty.' }))) as any);

    const result = await ensureMissionIntegrationBranch('m-1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('empty_repo');
  });

  it('reports the branch as already present without creating anything', async () => {
    withOptedInMission();
    mockGithubApi.mockImplementation((() => Promise.resolve({ object: { sha: 'b'.repeat(40) } })) as any);

    expect(await ensureMissionIntegrationBranch('m-1')).toEqual({
      ok: true,
      branch: BRANCH,
      created: false,
    });
    // Probe only — no trunk lookup, no POST.
    expect(mockGithubApi).toHaveBeenCalledTimes(1);
  });

  it('reports not_opted_in without touching GitHub', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      workingBranch: BRANCH,
      integrationBranchEnabled: false,
      workspaceId: 'ws-1',
    });

    const result = await ensureMissionIntegrationBranch('m-1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('not_opted_in');
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('reports no_working_branch when the mission has no branch name yet', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      workingBranch: null,
      integrationBranchEnabled: true,
      workspaceId: 'ws-1',
    });

    const result = await ensureMissionIntegrationBranch('m-1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('no_working_branch');
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('reports api_error when trunk has no resolvable head', async () => {
    withOptedInMission();
    mockGithubApi.mockImplementation(((_installationId: number, path: string) => {
      if (path.endsWith(`/git/ref/heads/${BRANCH}`)) {
        return Promise.reject(githubError(404, { message: 'Not Found' }));
      }
      return Promise.resolve({ object: {} });
    }) as any);

    const result = await ensureMissionIntegrationBranch('m-1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('api_error');
  });
});
