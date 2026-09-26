import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@buildd/core/db', () => ({
  db: {
    query: {
      taskSchedules: {
        findMany: vi.fn(),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(),
      })),
    })),
  },
}));

vi.mock('@/lib/auth-helpers', () => ({
  getCurrentUser: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({
  authenticateApiKey: vi.fn(),
}));

vi.mock('@/lib/team-access', () => ({
  verifyWorkspaceAccess: vi.fn(),
  verifyAccountWorkspaceAccess: vi.fn(),
}));

vi.mock('@/lib/schedule-helpers', () => ({
  validateCronExpression: vi.fn(),
  computeNextRunAt: vi.fn(),
}));

vi.mock('@/lib/team-timezone', () => ({
  getWorkspaceTimezone: vi.fn(),
}));

import { GET, POST } from './route';
import { db } from '@buildd/core/db';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { NextRequest } from 'next/server';

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

function makeRequest(method: string, body?: unknown, authHeader?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authHeader) headers['authorization'] = authHeader;

  return new NextRequest(`http://localhost/api/workspaces/${WORKSPACE_ID}/schedules`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const params = Promise.resolve({ id: WORKSPACE_ID });

beforeEach(() => {
  vi.clearAllMocks();
  (db.query.taskSchedules.findMany as any).mockResolvedValue([]);
});

describe('GET /schedules', () => {
  it('returns 401 when no session and no API key are present at all', async () => {
    (getCurrentUser as any).mockResolvedValue(null);
    (authenticateApiKey as any).mockResolvedValue(null);

    const res = await GET(makeRequest('GET'), { params });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  // Regression: a valid admin API key for a workspace outside its scope (or a
  // stale/out-of-scope workspaceId) previously fell into the same generic 401
  // as a missing/invalid key, misreading as an expired or revoked token during
  // a live key rotation. A real, authenticated principal with the wrong scope
  // must be distinguishable from no principal at all.
  it('returns 403 (not 401) when a valid account is authenticated but out of scope for the workspace', async () => {
    (getCurrentUser as any).mockResolvedValue(null);
    (authenticateApiKey as any).mockResolvedValue({ id: 'account-1', level: 'admin' });
    (verifyAccountWorkspaceAccess as any).mockResolvedValue(false);

    const res = await GET(makeRequest('GET', undefined, 'Bearer bld_validkey'), { params });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');
    expect(body.workspaceId).toBe(WORKSPACE_ID);
  });

  it('returns 403 (not 401) when a session user is authenticated but not a member of the workspace team', async () => {
    (getCurrentUser as any).mockResolvedValue({ id: 'user-1' });
    (verifyWorkspaceAccess as any).mockResolvedValue(null);
    (authenticateApiKey as any).mockResolvedValue(null);

    const res = await GET(makeRequest('GET'), { params });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');
  });

  it('returns schedules for an in-scope admin API key', async () => {
    (getCurrentUser as any).mockResolvedValue(null);
    (authenticateApiKey as any).mockResolvedValue({ id: 'account-1', level: 'admin' });
    (verifyAccountWorkspaceAccess as any).mockResolvedValue(true);
    (db.query.taskSchedules.findMany as any).mockResolvedValue([{ id: 's1', workspaceId: WORKSPACE_ID }]);

    const res = await GET(makeRequest('GET', undefined, 'Bearer bld_validkey'), { params });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schedules).toHaveLength(1);
  });

  it('accepts a non-admin (worker/trigger level) key for read access', async () => {
    (getCurrentUser as any).mockResolvedValue(null);
    (authenticateApiKey as any).mockResolvedValue({ id: 'account-1', level: 'worker' });
    (verifyAccountWorkspaceAccess as any).mockResolvedValue(true);

    const res = await GET(makeRequest('GET', undefined, 'Bearer bld_workerkey'), { params });

    expect(res.status).toBe(200);
  });
});

describe('POST /schedules', () => {
  it('returns 401 when no session and no API key are present at all', async () => {
    (getCurrentUser as any).mockResolvedValue(null);
    (authenticateApiKey as any).mockResolvedValue(null);

    const res = await POST(makeRequest('POST', { name: 'x', cronExpression: '* * * * *', taskTemplate: { title: 't' } }), { params });

    expect(res.status).toBe(401);
  });

  it('returns 403 (not 401) for a valid non-admin key, since POST requires admin', async () => {
    (getCurrentUser as any).mockResolvedValue(null);
    (authenticateApiKey as any).mockResolvedValue({ id: 'account-1', level: 'worker' });

    const res = await POST(makeRequest('POST', { name: 'x', cronExpression: '* * * * *', taskTemplate: { title: 't' } }), { params });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');
  });

  it('returns 403 (not 401) when a valid admin key is out of scope for the workspace', async () => {
    (getCurrentUser as any).mockResolvedValue(null);
    (authenticateApiKey as any).mockResolvedValue({ id: 'account-1', level: 'admin' });
    (verifyAccountWorkspaceAccess as any).mockResolvedValue(false);

    const res = await POST(makeRequest('POST', { name: 'x', cronExpression: '* * * * *', taskTemplate: { title: 't' } }), { params });

    expect(res.status).toBe(403);
  });
});
