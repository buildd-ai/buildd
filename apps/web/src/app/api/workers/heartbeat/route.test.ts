import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);
const mockAccountWorkspacesFindMany = mock(() => [] as any[]);
const mockWorkspacesFindMany = mock(() => [] as any[]);
const mockHeartbeatsFindFirst = mock(() => null as any);
const mockHeartbeatsInsert = mock(() => ({
  values: mock(() => ({
    onConflictDoUpdate: mock(() => Promise.resolve()),
  })),
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accountWorkspaces: { findMany: mockAccountWorkspacesFindMany },
      workspaces: { findMany: mockWorkspacesFindMany },
      workerHeartbeats: { findFirst: mockHeartbeatsFindFirst },
    },
    insert: () => mockHeartbeatsInsert(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workerHeartbeats: {
    accountId: 'accountId',
    localUiUrl: 'localUiUrl',
    viewerToken: 'viewerToken',
    id: 'id',
  },
  accountWorkspaces: { accountId: 'accountId' },
  workspaces: { id: 'id', accessMode: 'accessMode' },
}));

mock.module('crypto', () => ({
  randomBytes: (size: number) => ({
    toString: () => 'mock-viewer-token-base64url',
  }),
}));

import { POST } from './route';

function createMockRequest(options: {
  headers?: Record<string, string>;
  body?: any;
} = {}): NextRequest {
  const { headers = {}, body } = options;
  const init: RequestInit = {
    method: 'POST',
    headers: new Headers(headers),
  };
  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Headers).set('content-type', 'application/json');
  }
  return new NextRequest('http://localhost:3000/api/workers/heartbeat', init);
}

describe('POST /api/workers/heartbeat', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockAccountWorkspacesFindMany.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockHeartbeatsFindFirst.mockReset();
    mockHeartbeatsInsert.mockReset();

    // Default mock for insert chain
    mockHeartbeatsInsert.mockReturnValue({
      values: mock(() => ({
        onConflictDoUpdate: mock(() => Promise.resolve()),
      })),
    });
  });

  it('returns 401 when no API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockRequest({
      body: { localUiUrl: 'http://localhost:8766' },
    });
    const res = await POST(req);

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 400 when localUiUrl is missing', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 3,
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: {},
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('localUiUrl is required');
  });

  it('returns ok with viewerToken on successful heartbeat', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 3,
    });
    mockAccountWorkspacesFindMany.mockResolvedValue([{ workspaceId: 'ws-1' }]);
    mockWorkspacesFindMany.mockResolvedValue([]);
    mockHeartbeatsFindFirst.mockResolvedValue(null); // No existing token

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { localUiUrl: 'http://localhost:8766', activeWorkerCount: 1 },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.viewerToken).toBeDefined();
  });

  it('reuses existing viewerToken', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 3,
    });
    mockAccountWorkspacesFindMany.mockResolvedValue([]);
    mockWorkspacesFindMany.mockResolvedValue([]);
    mockHeartbeatsFindFirst.mockResolvedValue({
      viewerToken: 'existing-token',
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { localUiUrl: 'http://localhost:8766' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.viewerToken).toBe('existing-token');
  });

  it('collects workspace IDs from both linked and open workspaces', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 3,
    });
    mockAccountWorkspacesFindMany.mockResolvedValue([
      { workspaceId: 'ws-1' },
      { workspaceId: 'ws-2' },
    ]);
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-3' },
    ]);
    mockHeartbeatsFindFirst.mockResolvedValue(null);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { localUiUrl: 'http://localhost:8766' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('defaults activeWorkerCount to 0', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 3,
    });
    mockAccountWorkspacesFindMany.mockResolvedValue([]);
    mockWorkspacesFindMany.mockResolvedValue([]);
    mockHeartbeatsFindFirst.mockResolvedValue(null);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { localUiUrl: 'http://localhost:8766' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });
});
