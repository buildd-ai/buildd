import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const FOREIGN_WORKSPACE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(true));

const mockReturning = mock(() => Promise.resolve([{ nextNumber: 107 }]));
const mockUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => ({
      returning: mockReturning,
    })),
  })),
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/team-access', () => ({
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    update: mockUpdate,
  },
}));

import { POST } from './route';

function makeRequest(workspaceId: string, body: unknown = {}, apiKey: string | null = 'bld_test') {
  return new NextRequest(`http://localhost/api/workspaces/${workspaceId}/migration-slot`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/workspaces/[id]/migration-slot', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockUpdate.mockClear();
    mockReturning.mockClear();
    mockReturning.mockResolvedValue([{ nextNumber: 107 }]);
  });

  it('returns 401 when no API key is supplied', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const res = await POST(makeRequest(WORKSPACE_ID, {}, null), {
      params: Promise.resolve({ id: WORKSPACE_ID }),
    });

    expect(res.status).toBe(401);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects an account that cannot reach the workspace and does not increment the counter', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-attacker', level: 'admin' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);

    const res = await POST(makeRequest(FOREIGN_WORKSPACE_ID, { currentMax: 5 }), {
      params: Promise.resolve({ id: FOREIGN_WORKSPACE_ID }),
    });

    expect(res.status).toBe(404);
    // The cross-tenant write must never reach the DB.
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockVerifyAccountWorkspaceAccess).toHaveBeenCalledWith('acc-attacker', FOREIGN_WORKSPACE_ID);
  });

  it('reserves the next number for an account with workspace access', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'worker' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);

    const res = await POST(makeRequest(WORKSPACE_ID, { currentMax: 106 }), {
      params: Promise.resolve({ id: WORKSPACE_ID }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ nextNumber: 107, formatted: '0107' });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when the workspace row does not exist', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'worker' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockReturning.mockResolvedValue([]);

    const res = await POST(makeRequest(WORKSPACE_ID), {
      params: Promise.resolve({ id: WORKSPACE_ID }),
    });

    expect(res.status).toBe(404);
  });
});
