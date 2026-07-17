import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersQuery = mock(() => null as any);
const mockTasksQuery = mock(() => null as any);
const mockConnectorsQuery = mock(() => null as any);
const mockConnectorWorkspacesQuery = mock(() => null as any);
const mockGetActiveSigningKey = mock(() => null as any);
const mockSignAssertion = mock(() => Promise.resolve('header.payload.sig') as any);

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersQuery },
      tasks: { findFirst: mockTasksQuery },
      connectors: { findFirst: mockConnectorsQuery },
      connectorWorkspaces: { findFirst: mockConnectorWorkspacesQuery },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b }),
  and: (...args: any[]) => args,
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: 'workers_table',
  tasks: 'tasks_table',
  connectors: 'connectors_table',
  connectorWorkspaces: 'connector_workspaces_table',
}));

mock.module('@/lib/signing-keys', () => ({
  getActiveSigningKey: mockGetActiveSigningKey,
  signAssertion: mockSignAssertion,
}));

// Redis mock — no-op (rate limit disabled in tests)
mock.module('@upstash/redis', () => ({
  Redis: class MockRedis {
    async incr() { return 1; }
    async expire() {}
  },
}));

import { POST } from './route';

function makeRequest(body: object, apiKey = 'bld_test'): NextRequest {
  return new NextRequest('http://localhost/api/connectors/connector-1/assertion', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
}

const mockParams = Promise.resolve({ id: 'connector-1' });

// Healthy defaults
const account = { id: 'account-1', teamId: 'team-1' };
const worker = { id: 'worker-1', accountId: 'account-1', taskId: 'task-1', workspaceId: 'ws-1', status: 'running' };
const task = { id: 'task-1', workspaceId: 'ws-1', accountId: 'account-1' };
const connector = {
  id: 'connector-1',
  teamId: 'team-1',
  authMode: 'assertion',
  assertionAudience: 'https://cue.buildd.dev/api/mcp',
  assertionTokenEndpoint: 'https://cue.buildd.dev/api/oauth/token',
};
const activeKey = { id: 'key-1', kid: 'buildd-2026-07', privateKeyJwk: {}, publicKeyJwk: {}, createdAt: new Date() };

describe('POST /api/connectors/[id]/assertion', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkersQuery.mockReset();
    mockTasksQuery.mockReset();
    mockConnectorsQuery.mockReset();
    mockConnectorWorkspacesQuery.mockReset();
    mockGetActiveSigningKey.mockReset();
    mockSignAssertion.mockReset();

    // Default happy path
    mockAuthenticateApiKey.mockResolvedValue(account);
    mockWorkersQuery.mockResolvedValue(worker);
    mockTasksQuery.mockResolvedValue(task);
    mockConnectorsQuery.mockResolvedValue(connector);
    mockConnectorWorkspacesQuery.mockResolvedValue({ enabled: true });
    mockGetActiveSigningKey.mockResolvedValue(activeKey);
    mockSignAssertion.mockResolvedValue('header.payload.sig');
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  it('returns 401 when no API key is provided', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const req = new NextRequest('http://localhost/api/connectors/connector-1/assertion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: 'worker-1', taskId: 'task-1' }),
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('returns 401 when API key is invalid', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const res = await POST(makeRequest({ workerId: 'w', taskId: 't' }, 'bad-key'), { params: mockParams });
    expect(res.status).toBe(401);
  });

  // ── Worker ownership ──────────────────────────────────────────────────────

  it('returns 401 when workerId belongs to a different account', async () => {
    mockWorkersQuery.mockResolvedValue({ ...worker, accountId: 'account-OTHER' });
    const res = await POST(makeRequest({ workerId: 'worker-1', taskId: 'task-1' }), { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('returns 401 when worker status is completed (token revoked)', async () => {
    mockWorkersQuery.mockResolvedValue({ ...worker, status: 'completed' });
    const res = await POST(makeRequest({ workerId: 'worker-1', taskId: 'task-1' }), { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('returns 401 when worker status is error (token revoked)', async () => {
    mockWorkersQuery.mockResolvedValue({ ...worker, status: 'error' });
    const res = await POST(makeRequest({ workerId: 'worker-1', taskId: 'task-1' }), { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('returns 403 when taskId does not match worker active task', async () => {
    mockWorkersQuery.mockResolvedValue({ ...worker, taskId: 'task-OTHER' });
    const res = await POST(makeRequest({ workerId: 'worker-1', taskId: 'task-1' }), { params: mockParams });
    expect(res.status).toBe(403);
  });

  // ── Connector validation ──────────────────────────────────────────────────

  it('returns 404 when connector does not exist', async () => {
    mockConnectorsQuery.mockResolvedValue(null);
    const res = await POST(makeRequest({ workerId: 'worker-1', taskId: 'task-1' }), { params: mockParams });
    expect(res.status).toBe(404);
  });

  it('returns 403 when connector authMode is not assertion', async () => {
    mockConnectorsQuery.mockResolvedValue({ ...connector, authMode: 'header' });
    const res = await POST(makeRequest({ workerId: 'worker-1', taskId: 'task-1' }), { params: mockParams });
    expect(res.status).toBe(403);
  });

  it('returns 403 when connector is explicitly disabled for workspace', async () => {
    mockConnectorWorkspacesQuery.mockResolvedValue({ enabled: false });
    const res = await POST(makeRequest({ workerId: 'worker-1', taskId: 'task-1' }), { params: mockParams });
    expect(res.status).toBe(403);
  });

  it('allows minting when no connectorWorkspaces row (missing = enabled)', async () => {
    mockConnectorWorkspacesQuery.mockResolvedValue(undefined);
    const res = await POST(makeRequest({ workerId: 'worker-1', taskId: 'task-1' }), { params: mockParams });
    expect(res.status).toBe(200);
  });

  it('returns 500 when connector is missing assertionAudience', async () => {
    mockConnectorsQuery.mockResolvedValue({ ...connector, assertionAudience: null });
    const res = await POST(makeRequest({ workerId: 'worker-1', taskId: 'task-1' }), { params: mockParams });
    expect(res.status).toBe(500);
  });

  it('returns 500 when connector is missing assertionTokenEndpoint', async () => {
    mockConnectorsQuery.mockResolvedValue({ ...connector, assertionTokenEndpoint: null });
    const res = await POST(makeRequest({ workerId: 'worker-1', taskId: 'task-1' }), { params: mockParams });
    expect(res.status).toBe(500);
  });

  it('returns 500 when no active signing key exists', async () => {
    mockGetActiveSigningKey.mockResolvedValue(null);
    const res = await POST(makeRequest({ workerId: 'worker-1', taskId: 'task-1' }), { params: mockParams });
    expect(res.status).toBe(500);
  });

  // ── Successful mint ───────────────────────────────────────────────────────

  it('returns 200 with assertion and exchange metadata on happy path', async () => {
    const res = await POST(makeRequest({ workerId: 'worker-1', taskId: 'task-1' }), { params: mockParams });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assertion).toBe('header.payload.sig');
    expect(body.audience).toBe('https://cue.buildd.dev/api/mcp');
    expect(body.tokenEndpoint).toBe('https://cue.buildd.dev/api/oauth/token');
    expect(typeof body.expiresAt).toBe('string');
    // expiresAt must be ~5 minutes from now
    const expiresAt = new Date(body.expiresAt);
    const diff = expiresAt.getTime() - Date.now();
    expect(diff).toBeGreaterThan(270_000); // at least 270s
    expect(diff).toBeLessThanOrEqual(310_000); // at most 310s
  });

  it('signs assertion with correct claim shape', async () => {
    await POST(makeRequest({ workerId: 'worker-1', taskId: 'task-1' }), { params: mockParams });

    expect(mockSignAssertion).toHaveBeenCalledTimes(1);
    const [payload, , kid] = mockSignAssertion.mock.calls[0];

    expect(payload.iss).toBe('https://buildd.dev');
    expect(payload.sub).toBe('account-1:team-1'); // accountId:teamId
    expect(payload.aud).toBe('https://cue.buildd.dev/api/mcp');
    expect(payload.act.sub).toBe('worker:worker-1');
    expect(payload.act.tid).toBe('task-1');
    expect(typeof payload.jti).toBe('string');
    expect(payload.jti).toHaveLength(32); // 16 bytes hex = 32 chars
    expect(payload.exp - payload.iat).toBe(300);
    expect(kid).toBe('buildd-2026-07');
  });

  it('each mint call uses a unique jti', async () => {
    await POST(makeRequest({ workerId: 'worker-1', taskId: 'task-1' }), { params: mockParams });
    await POST(makeRequest({ workerId: 'worker-1', taskId: 'task-1' }), { params: mockParams });

    const jti1 = mockSignAssertion.mock.calls[0][0].jti;
    const jti2 = mockSignAssertion.mock.calls[1][0].jti;
    expect(jti1).not.toBe(jti2);
  });

  // ── Input validation ──────────────────────────────────────────────────────

  it('returns 400 when workerId is missing', async () => {
    const res = await POST(makeRequest({ taskId: 'task-1' }), { params: mockParams });
    expect(res.status).toBe(400);
  });

  it('returns 400 when taskId is missing', async () => {
    const res = await POST(makeRequest({ workerId: 'worker-1' }), { params: mockParams });
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid JSON body', async () => {
    const req = new NextRequest('http://localhost/api/connectors/connector-1/assertion', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer bld_test' },
      body: 'not-json',
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(400);
  });
});
