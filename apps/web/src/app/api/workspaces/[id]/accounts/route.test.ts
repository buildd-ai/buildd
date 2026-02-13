// Ensure production mode — routes short-circuit in development
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockAuth = mock(() => null as any);
const mockAccountWorkspacesFindMany = mock(() => [] as any[]);
const mockAccountWorkspacesFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockInsert = mock(() => ({
  values: mock(() => Promise.resolve()),
}));
const mockUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));
const mockDelete = mock(() => ({
  where: mock(() => Promise.resolve()),
}));

// Mock auth (NextAuth session)
mock.module('@/auth', () => ({
  auth: mockAuth,
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accountWorkspaces: {
        findMany: mockAccountWorkspacesFindMany,
        findFirst: mockAccountWorkspacesFindFirst,
      },
      workspaces: { findFirst: mockWorkspacesFindFirst },
      accounts: { findFirst: mockAccountsFindFirst },
    },
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  accounts: { id: 'id' },
  accountWorkspaces: { workspaceId: 'workspaceId', accountId: 'accountId' },
  workspaces: { id: 'id' },
}));

// Import handlers AFTER mocks
import { GET, POST, DELETE } from './route';

afterAll(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

// Helper to create mock NextRequest
function createMockRequest(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  searchParams?: Record<string, string>;
} = {}): NextRequest {
  const { method = 'GET', headers = {}, body, searchParams = {} } = options;

  let url = 'http://localhost:3000/api/workspaces/ws-1/accounts';
  const params = new URLSearchParams(searchParams);
  if (params.toString()) {
    url += `?${params.toString()}`;
  }

  const init: RequestInit = {
    method,
    headers: new Headers(headers),
  };

  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Headers).set('content-type', 'application/json');
  }

  return new NextRequest(url, init);
}

// Helper to call route handler with params
async function callHandler(
  handler: Function,
  request: NextRequest,
  id: string
) {
  return handler(request, { params: Promise.resolve({ id }) });
}

describe('GET /api/workspaces/[id]/accounts', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockAuth.mockReset();
    mockAccountWorkspacesFindMany.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockAuth.mockResolvedValue(null);

    const request = createMockRequest();
    const response = await callHandler(GET, request, 'ws-1');

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns accounts list', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockAccountWorkspacesFindMany.mockResolvedValue([
      {
        accountId: 'account-1',
        canClaim: true,
        canCreate: false,
        account: { name: 'Runner 1', type: 'user' },
      },
      {
        accountId: 'account-2',
        canClaim: true,
        canCreate: true,
        account: { name: 'Runner 2', type: 'org' },
      },
    ]);

    const request = createMockRequest();
    const response = await callHandler(GET, request, 'ws-1');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.accounts).toHaveLength(2);
    expect(data.accounts[0]).toEqual({
      accountId: 'account-1',
      accountName: 'Runner 1',
      accountType: 'user',
      canClaim: true,
      canCreate: false,
    });
    expect(data.accounts[1]).toEqual({
      accountId: 'account-2',
      accountName: 'Runner 2',
      accountType: 'org',
      canClaim: true,
      canCreate: true,
    });
  });
});

describe('POST /api/workspaces/[id]/accounts', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockAuth.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockAccountsFindFirst.mockReset();
    mockAccountWorkspacesFindFirst.mockReset();
    mockInsert.mockReset();
    mockUpdate.mockReset();

    // Default mock returns for insert/update chains
    mockInsert.mockReturnValue({
      values: mock(() => Promise.resolve()),
    });
    mockUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
  });

  it('returns 401 when not authenticated', async () => {
    mockAuth.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'POST',
      body: { accountId: 'account-1' },
    });
    const response = await callHandler(POST, request, 'ws-1');

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 400 when accountId missing', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });

    const request = createMockRequest({
      method: 'POST',
      body: {},
    });
    const response = await callHandler(POST, request, 'ws-1');

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('accountId is required');
  });

  it('returns 404 when workspace not found', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockWorkspacesFindFirst.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'POST',
      body: { accountId: 'account-1' },
    });
    const response = await callHandler(POST, request, 'ws-1');

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Workspace not found');
  });

  it('returns 404 when account not found', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockAccountsFindFirst.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'POST',
      body: { accountId: 'account-1' },
    });
    const response = await callHandler(POST, request, 'ws-1');

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Account not found');
  });

  it('creates new connection', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-1' });
    mockAccountWorkspacesFindFirst.mockResolvedValue(null); // No existing connection

    const mockValues = mock(() => Promise.resolve());
    mockInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      body: { accountId: 'account-1', canClaim: true, canCreate: false },
    });
    const response = await callHandler(POST, request, 'ws-1');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.accountId).toBe('account-1');
    expect(data.workspaceId).toBe('ws-1');
    expect(data.canClaim).toBe(true);
    expect(data.canCreate).toBe(false);
    expect(mockInsert).toHaveBeenCalled();
  });

  it('updates existing connection', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-1' });
    mockAccountWorkspacesFindFirst.mockResolvedValue({
      accountId: 'account-1',
      workspaceId: 'ws-1',
      canClaim: true,
      canCreate: false,
    }); // Existing connection

    const mockWhere = mock(() => Promise.resolve());
    const mockSet = mock(() => ({ where: mockWhere }));
    mockUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'POST',
      body: { accountId: 'account-1', canClaim: true, canCreate: true },
    });
    const response = await callHandler(POST, request, 'ws-1');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.canCreate).toBe(true);
    expect(mockUpdate).toHaveBeenCalled();
  });
});

describe('DELETE /api/workspaces/[id]/accounts', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockAuth.mockReset();
    mockDelete.mockReset();

    // Default mock return for delete chain
    mockDelete.mockReturnValue({
      where: mock(() => Promise.resolve()),
    });
  });

  it('returns 401 when not authenticated', async () => {
    mockAuth.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'DELETE',
      searchParams: { accountId: 'account-1' },
    });
    const response = await callHandler(DELETE, request, 'ws-1');

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 400 when accountId missing', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });

    const request = createMockRequest({
      method: 'DELETE',
    });
    const response = await callHandler(DELETE, request, 'ws-1');

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('accountId is required');
  });

  it('deletes connection successfully', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });

    const mockWhere = mock(() => Promise.resolve());
    mockDelete.mockReturnValue({ where: mockWhere });

    const request = createMockRequest({
      method: 'DELETE',
      searchParams: { accountId: 'account-1' },
    });
    const response = await callHandler(DELETE, request, 'ws-1');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(mockDelete).toHaveBeenCalled();
  });
});
