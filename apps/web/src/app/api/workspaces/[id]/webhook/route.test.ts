import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockWorkspacesUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    update: () => mockWorkspacesUpdate(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workspaces: { id: 'id', ownerId: 'ownerId' },
}));

import { POST } from './route';

const mockParams = Promise.resolve({ id: 'ws-1' });

function createMockRequest(body: any): NextRequest {
  return new NextRequest('http://localhost:3000/api/workspaces/ws-1/webhook', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

describe('POST /api/workspaces/[id]/webhook', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesUpdate.mockReset();

    mockWorkspacesUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const req = createMockRequest({ url: 'https://hook.example.com' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue(null);

    const req = createMockRequest({ url: 'https://hook.example.com' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('saves webhook config with url', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const req = createMockRequest({
      url: 'https://hook.example.com',
      token: 'secret-token',
      enabled: true,
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.webhookConfig.url).toBe('https://hook.example.com');
    expect(data.webhookConfig.enabled).toBe(true);
  });

  it('clears webhook config when no url provided', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const req = createMockRequest({});
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.webhookConfig).toBeNull();
  });

  it('defaults token to empty string', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const req = createMockRequest({ url: 'https://hook.example.com' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.webhookConfig.token).toBe('');
  });

  it('defaults enabled to false', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const req = createMockRequest({ url: 'https://hook.example.com' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.webhookConfig.enabled).toBe(false);
  });
});
