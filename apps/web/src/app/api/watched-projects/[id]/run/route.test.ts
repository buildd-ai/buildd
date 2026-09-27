import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(false));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(false));
const mockWatchedProjectsFindFirst = mock(() => null as any);
const mockRunWatcherForProject = mock(() => Promise.resolve({ ran: true }) as any);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));
mock.module('@/lib/health-watcher', () => ({ runWatcherForProject: mockRunWatcherForProject }));
mock.module('@buildd/core/db', () => ({
  db: { query: { watchedProjects: { findFirst: mockWatchedProjectsFindFirst } } },
}));
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));
mock.module('@buildd/core/db/schema', () => ({
  watchedProjects: { id: 'id', workspaceId: 'workspaceId' },
}));

import { POST } from './route';

const ROW_ID = '11111111-1111-4111-8111-111111111111';
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (id: string) => new NextRequest(`http://localhost:3000/api/watched-projects/${id}/run`, { method: 'POST' });

beforeEach(() => {
  mockGetCurrentUser.mockReset();
  mockAuthenticateApiKey.mockReset();
  mockVerifyWorkspaceAccess.mockReset();
  mockVerifyAccountWorkspaceAccess.mockReset();
  mockWatchedProjectsFindFirst.mockReset();
  mockRunWatcherForProject.mockReset();

  mockAuthenticateApiKey.mockResolvedValue(null);
  mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
  mockVerifyWorkspaceAccess.mockResolvedValue(true);
  mockWatchedProjectsFindFirst.mockResolvedValue({ id: ROW_ID, workspaceId: 'ws-1' });
  mockRunWatcherForProject.mockResolvedValue({ ran: true });
});

describe('POST /api/watched-projects/[id]/run', () => {
  it('returns 404 for a non-UUID id without querying the db', async () => {
    const res = await POST(req('not-a-uuid'), ctx('not-a-uuid'));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('UUID');
    expect(mockWatchedProjectsFindFirst).not.toHaveBeenCalled();
  });

  it('runs the watcher for an authorized project', async () => {
    const res = await POST(req(ROW_ID), ctx(ROW_ID));
    expect(res.status).toBe(200);
    expect(mockRunWatcherForProject).toHaveBeenCalledWith(ROW_ID);
  });

  it('returns 404 when the project does not exist', async () => {
    mockWatchedProjectsFindFirst.mockResolvedValue(null);
    const res = await POST(req(ROW_ID), ctx(ROW_ID));
    expect(res.status).toBe(404);
  });
});
