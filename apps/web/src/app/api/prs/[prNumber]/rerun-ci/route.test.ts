import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockGetUserWorkspaceIds = mock(() => Promise.resolve([] as string[]));
const mockGithubApi = mock((_i: number, _p: string, _o?: any) => Promise.resolve(null) as any);
const mockRecordRedRerun = mock((_i: any) => Promise.resolve(null) as any);
const mockWorkspacesFindFirst = mock(() => Promise.resolve(null) as any);
const mockGithubReposFindFirst = mock(() => Promise.resolve(null) as any);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({ getUserWorkspaceIds: mockGetUserWorkspaceIds }));
mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));
mock.module('@/lib/red-check-record', () => ({ recordRedRerun: mockRecordRedRerun }));
mock.module('@buildd/core/db', () => ({
  db: { query: { workspaces: { findFirst: mockWorkspacesFindFirst }, githubRepos: { findFirst: mockGithubReposFindFirst } } },
}));

import { POST } from './route';

const call = (body: unknown = { workspaceId: 'ws-1' }) =>
  POST(new NextRequest('http://localhost/api/prs/42/rerun-ci', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ prNumber: '42' }) });

/** GitHub as the route reads it: the PR, its failed runs, and the re-run call. */
function github(opts: { pr?: any; runs?: any[]; rerunFails?: boolean } = {}) {
  mockGithubApi.mockImplementation(async (_i: number, path: string, o?: any) => {
    if (path.endsWith('/pulls/42')) return opts.pr ?? { number: 42, state: 'open', head: { sha: 'head1' } };
    if (path.includes('/actions/runs?head_sha=head1&status=failure')) return { workflow_runs: opts.runs ?? [{ id: 900, run_attempt: 1 }] };
    if (path.endsWith('/rerun-failed-jobs') && o?.method === 'POST') {
      if (opts.rerunFails) throw new Error('GitHub API error: 403 forbidden');
      return {};
    }
    throw new Error(`unexpected GitHub call ${path}`);
  });
}

describe('POST /api/prs/[prNumber]/rerun-ci (surface-ia §11 R-4, AC-54)', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset().mockResolvedValue({ id: 'user-1' });
    mockGetUserWorkspaceIds.mockReset().mockResolvedValue(['ws-1']);
    mockWorkspacesFindFirst.mockReset().mockResolvedValue({ id: 'ws-1', githubRepoId: 'repo-1', githubInstallationId: 'inst-row' });
    mockGithubReposFindFirst.mockReset().mockResolvedValue({ fullName: 'o/r', installation: { installationId: 77 } });
    mockGithubApi.mockReset();
    mockRecordRedRerun.mockReset().mockResolvedValue(null);
  });

  it('re-runs only the failed jobs of the head\'s failed run and records who did it', async () => {
    github();
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, runId: 900, headSha: 'head1', recorded: true });
    const posts = mockGithubApi.mock.calls.filter(c => c[2]?.method === 'POST');
    expect(posts.map(c => c[1])).toEqual(['/repos/o/r/actions/runs/900/rerun-failed-jobs']);
    expect(mockRecordRedRerun).toHaveBeenCalledWith({ repoFullName: 'o/r', prNumber: 42, headSha: 'head1', runId: 900, by: 'user-1' });
  });

  it('refuses without a signed-in person or workspace access', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserWorkspaceIds.mockResolvedValue([]);
    expect((await call()).status).toBe(403);
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('a closed PR, or a head with no failed run, re-runs nothing', async () => {
    github({ pr: { number: 42, state: 'closed', merged: true, head: { sha: 'head1' } } });
    expect((await call()).status).toBe(409);
    github({ runs: [] });
    expect((await call()).status).toBe(409);
    expect(mockGithubApi.mock.calls.some(c => c[2]?.method === 'POST')).toBe(false);
    expect(mockRecordRedRerun).not.toHaveBeenCalled();
  });

  it('a re-run GitHub refused is not recorded', async () => {
    github({ rerunFails: true });
    expect((await call()).status).toBe(502);
    expect(mockRecordRedRerun).not.toHaveBeenCalled();
  });

  it('a re-run GitHub accepted but that could not be recorded still reports success, with recorded false', async () => {
    github();
    mockRecordRedRerun.mockRejectedValue(new Error('db down'));
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).recorded).toBe(false);
  });
});
