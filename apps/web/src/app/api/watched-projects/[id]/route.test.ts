import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(false));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(false));
const mockWatchedProjectsFindFirst = mock(() => null as any);
const mockParseUpdateInput = mock((body: any) => body);
let updateCalls: any[] = [];
let deleteCalls: any[] = [];

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));
mock.module('@/lib/watched-project-input', () => ({ parseUpdateInput: mockParseUpdateInput }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: { watchedProjects: { findFirst: mockWatchedProjectsFindFirst } },
    update: (table: any) => ({
      set: (set: any) => ({
        where: () => ({
          returning: () => {
            updateCalls.push(set);
            return Promise.resolve([{ id: ROW_ID, ...set }]);
          },
        }),
      }),
    }),
    delete: (table: any) => ({
      where: () => {
        deleteCalls.push(table);
        return Promise.resolve();
      },
    }),
  },
}));
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));
mock.module('@buildd/core/db/schema', () => ({
  watchedProjects: { id: 'id', workspaceId: 'workspaceId' },
}));

import { GET, PATCH, DELETE } from './route';

const ROW_ID = '11111111-1111-4111-8111-111111111111';
const ROW = { id: ROW_ID, workspaceId: 'ws-1', repo: 'org/repo' };

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (id: string, init?: RequestInit) =>
  new NextRequest(`http://localhost:3000/api/watched-projects/${id}`, init);

beforeEach(() => {
  mockGetCurrentUser.mockReset();
  mockAuthenticateApiKey.mockReset();
  mockVerifyWorkspaceAccess.mockReset();
  mockVerifyAccountWorkspaceAccess.mockReset();
  mockWatchedProjectsFindFirst.mockReset();
  mockParseUpdateInput.mockReset();
  mockParseUpdateInput.mockImplementation((body: any) => body);
  updateCalls = [];
  deleteCalls = [];

  mockAuthenticateApiKey.mockResolvedValue(null);
  mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
  mockVerifyWorkspaceAccess.mockResolvedValue(true);
  mockWatchedProjectsFindFirst.mockResolvedValue(ROW);
});

describe('GET /api/watched-projects/[id]', () => {
  it('returns 404 for a non-UUID id without querying the db', async () => {
    const res = await GET(req('not-a-uuid'), ctx('not-a-uuid'));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('UUID');
    expect(mockWatchedProjectsFindFirst).not.toHaveBeenCalled();
  });

  it('returns the watched project', async () => {
    const res = await GET(req(ROW_ID), ctx(ROW_ID));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.watchedProject.id).toBe(ROW_ID);
  });

  it('returns 404 when the row does not exist', async () => {
    mockWatchedProjectsFindFirst.mockResolvedValue(null);
    const res = await GET(req(ROW_ID), ctx(ROW_ID));
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/watched-projects/[id]', () => {
  it('returns 404 for a non-UUID id without querying the db', async () => {
    const res = await PATCH(req('not-a-uuid', { method: 'PATCH', body: JSON.stringify({}) }), ctx('not-a-uuid'));
    expect(res.status).toBe(404);
    expect(mockWatchedProjectsFindFirst).not.toHaveBeenCalled();
  });

  it('updates the watched project', async () => {
    const res = await PATCH(
      req(ROW_ID, { method: 'PATCH', body: JSON.stringify({ enabled: false }) }),
      ctx(ROW_ID),
    );
    expect(res.status).toBe(200);
    expect(updateCalls[0].enabled).toBe(false);
  });
});

describe('DELETE /api/watched-projects/[id]', () => {
  it('returns 404 for a non-UUID id without querying the db', async () => {
    const res = await DELETE(req('not-a-uuid', { method: 'DELETE' }), ctx('not-a-uuid'));
    expect(res.status).toBe(404);
    expect(mockWatchedProjectsFindFirst).not.toHaveBeenCalled();
  });

  it('deletes the watched project', async () => {
    const res = await DELETE(req(ROW_ID, { method: 'DELETE' }), ctx(ROW_ID));
    expect(res.status).toBe(200);
    expect(deleteCalls.length).toBe(1);
  });
});
