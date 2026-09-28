import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/** GET /api/prs — backs the `list_prs` MCP action and chat tool. */

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockListReachable = mock(async (_caller: unknown) => [] as string[]);
const mockListPrs = mock(async (_opts: any) => [] as any[]);
const mockRefresh = mock(async (_ids: string[]) => {});

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/workspace-access', () => ({ listReachableWorkspaceIds: mockListReachable }));
mock.module('@/lib/pr-state-refresh', () => ({ refreshStaleWorkersForWorkspaces: mockRefresh }));
mock.module('next/server', () => {
  const real = require('next/server');
  return { ...real, after: (fn: () => unknown) => { void fn(); } };
});
mock.module('@/lib/pr-list', () => {
  const real = require('@/lib/pr-list');
  return { ...real, listPrsQuery: mockListPrs };
});

import { GET } from './route';

const req = (qs = '') => new NextRequest(`http://localhost/api/prs${qs}`, { headers: { Authorization: 'Bearer bld_test' } });

beforeEach(() => {
  mockGetCurrentUser.mockReset().mockResolvedValue(null);
  mockAuthenticateApiKey.mockReset().mockResolvedValue({ id: 'acc', teamId: 'team', level: 'worker' });
  mockListReachable.mockReset().mockResolvedValue(['ws-a', 'ws-b']);
  mockListPrs.mockReset().mockResolvedValue([]);
  mockRefresh.mockReset().mockResolvedValue(undefined);
});

describe('GET /api/prs', () => {
  it('401 without a caller', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });

  it('lists open PRs across every reachable workspace by default', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(mockListPrs.mock.calls[0][0]).toMatchObject({ workspaceIds: ['ws-a', 'ws-b'], state: 'open' });
    expect(await res.json()).toMatchObject({ state: 'open', workspaceCount: 2, prs: [] });
  });

  it('a requested workspace is intersected with reach, never widened', async () => {
    await GET(req('?workspaceId=ws-b'));
    expect(mockListPrs.mock.calls[0][0].workspaceIds).toEqual(['ws-b']);
    await GET(req('?workspaceId=ws-foreign'));
    expect(mockListPrs.mock.calls[1][0].workspaceIds).toEqual([]);
  });

  it('refuses closed with a pointer to get_pr', async () => {
    const res = await GET(req('?state=closed'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('get_pr');
  });

  it('merged uses a window, default 7 days', async () => {
    const before = Date.now();
    await GET(req('?state=merged'));
    const since: Date = mockListPrs.mock.calls[0][0].since;
    expect(before - since.getTime()).toBeGreaterThanOrEqual(7 * 864e5 - 1000);
    expect(before - since.getTime()).toBeLessThan(7 * 864e5 + 60_000);
  });

  it('heals stale PR state for the listed workspaces after responding', async () => {
    await GET(req('?workspaceId=ws-a'));
    expect(mockRefresh.mock.calls[0][0]).toEqual(['ws-a']);
  });
});
