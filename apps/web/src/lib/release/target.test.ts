import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

// A release target resolves only among workspaces in the caller's scope: a
// workspaceId goes through the scoped resolver, and a `repo` resolves to a
// workspace owned by one of the scope's teams.

const mockResolveWorkspace = mock(async (..._args: unknown[]) => null as any);
const workspaceWheres: unknown[] = [];
let workspaceRow: Record<string, unknown> | undefined;
let repoRows: Array<Record<string, unknown>> = [];

mock.module('@/lib/workspace-resolver', () => ({ resolveWorkspace: mockResolveWorkspace }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: {
        findFirst: (opts: { where: unknown }) => {
          workspaceWheres.push(opts.where);
          return Promise.resolve(workspaceRow);
        },
      },
      githubRepos: {
        findFirst: async () => repoRows[0],
        findMany: async () => repoRows,
      },
    },
  },
}));

const { resolveReleaseTarget } = await import('./target');

const repo = {
  id: 'repo-row-1',
  owner: 'acme',
  name: 'app',
  fullName: 'acme/app',
  defaultBranch: 'main',
  installation: { installationId: 99 },
};

beforeEach(() => {
  mockResolveWorkspace.mockReset();
  mockResolveWorkspace.mockImplementation(async () => null);
  workspaceWheres.length = 0;
  workspaceRow = undefined;
  repoRows = [];
});

describe('resolveReleaseTarget — caller scope', () => {
  it('resolves a workspaceId through the scoped resolver', async () => {
    const res = await resolveReleaseTarget({ workspaceId: 'ws-1', scope: { teamIds: ['team-a'] } });
    expect(mockResolveWorkspace).toHaveBeenCalledWith('ws-1', { teamIds: ['team-a'] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });

  it('resolves a repo only to a workspace owned by a team in scope', async () => {
    repoRows = [repo];
    workspaceRow = undefined;
    const res = await resolveReleaseTarget({ repo: 'acme/app', scope: { teamIds: ['team-a'] } });
    expect(res.ok).toBe(false);
    expect(workspaceWheres.length).toBe(1);
    const q = new PgDialect().sqlToQuery(workspaceWheres[0] as any);
    expect(q.sql).toContain('"team_id" in');
    expect(q.params).toContain('team-a');
    expect(q.params).toContain('repo-row-1');
  });

  it('returns the target when the repo workspace is in scope', async () => {
    repoRows = [repo];
    workspaceRow = { id: 'ws-a', name: 'App', teamId: 'team-a', githubRepoId: 'repo-row-1', releaseConfig: null, gitConfig: null };
    const res = await resolveReleaseTarget({ repo: 'acme/app', scope: { teamIds: ['team-a'] } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.target.installationId).toBe(99);
  });

  it('resolves nothing for an empty scope', async () => {
    repoRows = [repo];
    const res = await resolveReleaseTarget({ repo: 'acme/app', scope: { teamIds: [] } });
    expect(res.ok).toBe(false);
    expect(workspaceWheres.length).toBe(0);
  });
});
