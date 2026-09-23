import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Write-back stores refreshed Codex tokens as the workspace team's credential,
// so only an account of that team — or a runner account that has run a worker
// in this workspace — may write them.

const mockAuthenticateApiKey = mock(async () => null as any);
const mockWorkspacesFindFirst = mock(async () => null as any);
const mockWorkersFindFirst = mock(async () => null as any);
const mockWriteBack = mock(async () => undefined);

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/codex-credential', () => ({ writeBackCodexTokens: mockWriteBack }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      workers: { findFirst: mockWorkersFindFirst },
    },
  },
}));

import { POST } from './route';

const params = Promise.resolve({ id: 'ws-1' });

function req(body: unknown = { accessToken: 'a', refreshToken: 'r' }) {
  return new NextRequest('http://localhost:3000/api/workspaces/ws-1/codex-credential/write-back', {
    method: 'POST',
    headers: { authorization: 'Bearer bld_key', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockAuthenticateApiKey.mockReset();
  mockWorkspacesFindFirst.mockReset();
  mockWorkersFindFirst.mockReset();
  mockWriteBack.mockReset();
  mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
  mockWorkersFindFirst.mockResolvedValue(null);
});

describe('POST /api/workspaces/[id]/codex-credential/write-back', () => {
  it('accepts a worker-level account of the workspace team', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', teamId: 'team-1', level: 'worker' });
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    expect(mockWriteBack).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for an account of another team with no worker in this workspace', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-2', teamId: 'team-2', level: 'admin' });
    const res = await POST(req(), { params });
    expect(res.status).toBe(404);
    expect(mockWriteBack).not.toHaveBeenCalled();
  });

  it('accepts a runner account that has run a worker in this workspace', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-linked', teamId: 'team-2', level: 'worker' });
    mockWorkersFindFirst.mockResolvedValue({ id: 'worker-1' });
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    expect(mockWriteBack).toHaveBeenCalledTimes(1);
  });

  it('rejects trigger-level tokens', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', teamId: 'team-1', level: 'trigger' });
    const res = await POST(req(), { params });
    expect(res.status).toBe(403);
  });
});
