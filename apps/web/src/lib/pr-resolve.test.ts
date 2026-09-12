import { describe, it, expect, beforeEach, mock } from 'bun:test';

const mockGetUserWorkspaceIds = mock(() => Promise.resolve([] as string[]));
const mockGetTeamWorkspaceIds = mock(() => Promise.resolve([] as string[]));
const mockWorkersFindMany = mock(() => Promise.resolve([] as any[]));
const mockWorkspacesFindMany = mock(() => Promise.resolve([] as any[]));

mock.module('@/lib/team-access', () => ({
  getUserWorkspaceIds: mockGetUserWorkspaceIds,
  getTeamWorkspaceIds: mockGetTeamWorkspaceIds,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      workspaces: { findMany: mockWorkspacesFindMany },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  inArray: (a: any, b: any) => ({ type: 'inArray', a, b }),
  isNotNull: (a: any) => ({ type: 'isNotNull', a }),
  isNull: (a: any) => ({ type: 'isNull', a }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: { workspaceId: 'workspaceId', prNumber: 'prNumber', prUrl: 'prUrl', mergedAt: 'mergedAt', id: 'id' },
  workspaces: { id: 'id', name: 'name', repo: 'repo' },
}));

const { resolveOpenWorkerForUser } = await import('./pr-resolve');

describe('resolveOpenWorkerForUser', () => {
  beforeEach(() => {
    mockGetUserWorkspaceIds.mockReset();
    mockWorkersFindMany.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockWorkspacesFindMany.mockResolvedValue([]);
  });

  it('returns 403 when the user has no accessible workspaces', async () => {
    mockGetUserWorkspaceIds.mockResolvedValue([]);
    const result = await resolveOpenWorkerForUser('u-1', 42, undefined);
    expect(result.status).toBe(403);
  });

  it('returns 404 when no open worker matches the PR number', async () => {
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockResolvedValue([]);
    const result = await resolveOpenWorkerForUser('u-1', 42, undefined);
    expect(result.status).toBe(404);
    expect(result.error).toMatch(/already merged/i);
  });

  it('returns the worker when exactly one workspace matches', async () => {
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    const worker = { id: 'w-1', workspaceId: 'ws-1', prNumber: 42, task: { id: 't-1' } };
    mockWorkersFindMany.mockResolvedValue([worker]);
    const result = await resolveOpenWorkerForUser('u-1', 42, undefined);
    expect(result).toBe(worker);
  });

  it('returns 409 with candidates when the PR number is ambiguous across workspaces', async () => {
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1', 'ws-2']);
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w-1', workspaceId: 'ws-1', prNumber: 42 },
      { id: 'w-2', workspaceId: 'ws-2', prNumber: 42 },
    ]);
    const result = await resolveOpenWorkerForUser('u-1', 42, undefined);
    expect(result.status).toBe(409);
    expect(result.candidates).toEqual(expect.arrayContaining(['ws-1', 'ws-2']));
  });

  it('rejects an unresolved workspaceId instead of widening the search', async () => {
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1', name: 'my-repo', repo: 'org/my-repo' }]);
    const result = await resolveOpenWorkerForUser('u-1', 42, 'totally-unknown');
    expect(result.status).toBe(403);
    expect(mockWorkersFindMany).not.toHaveBeenCalled();
  });

  it('resolves a repo-name workspaceId and scopes the search to it', async () => {
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1', 'ws-2']);
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-1', name: 'my-repo', repo: 'org/my-repo' },
      { id: 'ws-2', name: 'other-repo', repo: 'org/other-repo' },
    ]);
    const worker = { id: 'w-1', workspaceId: 'ws-1', prNumber: 42 };
    mockWorkersFindMany.mockResolvedValue([worker]);
    const result = await resolveOpenWorkerForUser('u-1', 42, 'my-repo');
    expect(result).toBe(worker);
    expect(mockWorkersFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          args: expect.arrayContaining([expect.objectContaining({ b: ['ws-1'] })]),
        }),
      }),
    );
  });
});
