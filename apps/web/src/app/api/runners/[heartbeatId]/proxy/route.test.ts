import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';
import { NextRequest } from 'next/server';

// --- Mock modules before any imports of the module under test ---

const mockGetCurrentUser = mock(() => Promise.resolve(null as any));
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));
const mockGetUserWorkspaceIds = mock(() => Promise.resolve([] as string[]));

const mockHbFindFirst = mock(() => Promise.resolve(null as any));
const mockSelectDistinct = mock(() => ({
  from: mock(() => ({
    where: mock(() => Promise.resolve([] as any[])),
  })),
}));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
  getUserWorkspaceIds: mockGetUserWorkspaceIds,
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: { workerHeartbeats: { findFirst: mockHbFindFirst } },
    selectDistinct: () => mockSelectDistinct(),
  },
}));
mock.module('@buildd/core/db/schema', () => ({
  workerHeartbeats: { id: 'id', accountId: 'accountId' },
  accountWorkspaces: { accountId: 'accountId', workspaceId: 'workspaceId' },
  workers: { accountId: 'accountId', workspaceId: 'workspaceId' },
}));
mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  inArray: (a: any, b: any) => ({ type: 'inArray', a, b }),
}));

import { GET } from './route';

function req(heartbeatId: string, path: string | null): NextRequest {
  const url = `http://localhost:3000/api/runners/${heartbeatId}/proxy${path ? `?path=${encodeURIComponent(path)}` : ''}`;
  return new NextRequest(url);
}

function makeParams(heartbeatId: string) {
  return Promise.resolve({ heartbeatId });
}

const VALID_HB = {
  id: 'hb-1',
  accountId: 'acc-1',
  localUiUrl: 'https://runner.example.com',
  viewerToken: 'tok-abc',
  account: { teamId: 'team-1' },
};

const DOCTOR_RESPONSE = {
  timestamp: '2026-01-01T00:00:00.000Z',
  checks: [{ name: 'runner-process', status: 'ok', message: 'Running' }],
  summary: { ok: 1, warn: 0, error: 0 },
};

beforeEach(() => {
  mockGetCurrentUser.mockReset();
  mockGetUserTeamIds.mockReset();
  mockGetUserWorkspaceIds.mockReset();
  mockHbFindFirst.mockReset();
  mockSelectDistinct.mockReset();

  // Default: user is authenticated, in team-1, owns ws-1
  mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
  mockGetUserTeamIds.mockResolvedValue(['team-1']);
  mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
  mockHbFindFirst.mockResolvedValue(VALID_HB);

  // Default selectDistinct chain returns empty (no explicit link/work history needed
  // when team matches)
  mockSelectDistinct.mockReturnValue({
    from: mock(() => ({
      where: mock(() => Promise.resolve([])),
    })),
  });
});

describe('GET /api/runners/[heartbeatId]/proxy', () => {
  it('returns 401 when user is not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET(req('hb-1', 'doctor'), { params: makeParams('hb-1') });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Unauthorized');
  });

  it('returns 400 when path is missing', async () => {
    const res = await GET(req('hb-1', null), { params: makeParams('hb-1') });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('path');
  });

  it('returns 400 when path is not in the allowlist', async () => {
    const res = await GET(req('hb-1', '../../etc/passwd'), { params: makeParams('hb-1') });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('path');
  });

  it('returns 400 for an unrecognised but non-traversal path', async () => {
    const res = await GET(req('hb-1', 'debug/internals'), { params: makeParams('hb-1') });
    expect(res.status).toBe(400);
  });

  it('returns 404 when heartbeat does not exist', async () => {
    mockHbFindFirst.mockResolvedValue(null);
    const res = await GET(req('hb-1', 'doctor'), { params: makeParams('hb-1') });
    expect(res.status).toBe(404);
  });

  it('returns 403 when runner belongs to a different team and user has no link/work history', async () => {
    mockGetUserTeamIds.mockResolvedValue(['team-OTHER']);
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    // No workspace link or work history
    mockSelectDistinct.mockReturnValue({
      from: mock(() => ({
        where: mock(() => Promise.resolve([])),
      })),
    });
    const res = await GET(req('hb-1', 'doctor'), { params: makeParams('hb-1') });
    expect(res.status).toBe(403);
  });

  it("grants access when runner account is in the user's team", async () => {
    // team-1 matches VALID_HB.account.teamId
    globalThis.fetch = mock(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(DOCTOR_RESPONSE) } as any),
    );
    const res = await GET(req('hb-1', 'doctor'), { params: makeParams('hb-1') });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.summary.ok).toBe(1);
  });

  it('forwards Authorization header with viewer token to runner', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = mock((url: string, init: RequestInit) => {
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return Promise.resolve({ ok: true, json: () => Promise.resolve(DOCTOR_RESPONSE) } as any);
    });
    await GET(req('hb-1', 'doctor'), { params: makeParams('hb-1') });
    expect(capturedHeaders['authorization']).toBe('Bearer tok-abc');
  });

  it('calls the correct runner URL for doctor path', async () => {
    let capturedUrl = '';
    globalThis.fetch = mock((url: string) => {
      capturedUrl = url;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(DOCTOR_RESPONSE) } as any);
    });
    await GET(req('hb-1', 'doctor'), { params: makeParams('hb-1') });
    expect(capturedUrl).toBe('https://runner.example.com/api/doctor');
  });

  it('calls the correct runner URL for history/stats path', async () => {
    let capturedUrl = '';
    globalThis.fetch = mock((url: string) => {
      capturedUrl = url;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ totalSessions: 42 }) } as any);
    });
    await GET(req('hb-1', 'history/stats'), { params: makeParams('hb-1') });
    expect(capturedUrl).toBe('https://runner.example.com/api/history/stats');
  });

  it('returns 502 when runner fetch throws a network error', async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error('Connection refused')));
    const res = await GET(req('hb-1', 'doctor'), { params: makeParams('hb-1') });
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('returns 502 when runner responds with non-ok status', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) } as any),
    );
    const res = await GET(req('hb-1', 'doctor'), { params: makeParams('hb-1') });
    expect(res.status).toBe(502);
  });

  it('grants access via workspace link when team does not match', async () => {
    mockGetUserTeamIds.mockResolvedValue(['team-OTHER']);
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    // First selectDistinct call (for accountWorkspaces) returns a match
    let callCount = 0;
    mockSelectDistinct.mockReturnValue({
      from: mock(() => ({
        where: mock(() => {
          callCount++;
          return Promise.resolve(callCount === 1 ? [{ accountId: 'acc-1' }] : []);
        }),
      })),
    });
    globalThis.fetch = mock(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(DOCTOR_RESPONSE) } as any),
    );
    const res = await GET(req('hb-1', 'doctor'), { params: makeParams('hb-1') });
    expect(res.status).toBe(200);
  });

  it('accepts debug/claims as an allowed path', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as any),
    );
    const res = await GET(req('hb-1', 'debug/claims'), { params: makeParams('hb-1') });
    expect(res.status).toBe(200);
  });
});
