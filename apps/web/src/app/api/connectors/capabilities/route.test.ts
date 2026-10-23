import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_WORKSPACE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(false));
const mockLoadDiscoveryInput = mock((..._args: any[]) => Promise.resolve(null as any));
const mockTaskFindFirst = mock(() => Promise.resolve(null as any));
const mockWorkerFindFirst = mock(() => Promise.resolve(null as any));
const mockRecordCapabilityDecision = mock((_row: any) => Promise.resolve());

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));
mock.module('@/lib/connector-capabilities-store', () => ({ loadDiscoveryInput: mockLoadDiscoveryInput }));
mock.module('@buildd/core/db', () => ({ db: { query: { tasks: { findFirst: mockTaskFindFirst }, workers: { findFirst: mockWorkerFindFirst } } } }));
mock.module('@/lib/agent-capabilities/audit', () => ({ recordCapabilityDecision: mockRecordCapabilityDecision }));

import { GET } from './route';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog';

function discoveryInput(roleSlug: string | null) {
  return {
    teamId: 'team-1',
    catalog: CONNECTOR_CATALOG.map(e => ({ ...e, id: null, source: 'builtin', policy: 'available' })),
    connectors: [{ id: 'c-axiom', name: 'axiom', url: 'https://mcp.axiom.co/mcp', authMode: 'oauth', transport: 'http', command: null, ownerTeamId: 'team-1' }],
    workspaceEnablement: new Map([['c-axiom', true]]),
    credentials: new Map([['c-axiom', { tokenExpiresAt: new Date(Date.now() + 3_600_000), lastVerificationError: null, healthStatus: 'healthy' }]]),
    roles: [{ slug: 'builder', connectorRefs: ['c-axiom'], allowedTools: [] }],
    roleSlug,
    operatorGrant: null,
    now: new Date(),
  };
}

function makeRequest(query: Record<string, string> = { workspaceId: WORKSPACE_ID }) {
  const qs = new URLSearchParams(query).toString();
  return new NextRequest(`http://localhost/api/connectors/capabilities${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: 'Bearer bld_test' },
  });
}

describe('GET /api/connectors/capabilities', () => {
  beforeEach(() => {
    for (const m of [mockGetCurrentUser, mockAuthenticateApiKey, mockVerifyWorkspaceAccess, mockVerifyAccountWorkspaceAccess, mockLoadDiscoveryInput, mockTaskFindFirst, mockWorkerFindFirst, mockRecordCapabilityDecision]) m.mockReset();
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'worker', teamId: 'team-1' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockLoadDiscoveryInput.mockImplementation((_ws: string, role: string | null) => Promise.resolve(discoveryInput(role)));
  });

  it('rejects unauthenticated requests', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    expect((await GET(makeRequest())).status).toBe(401);
  });

  it('requires workspaceId', async () => {
    expect((await GET(makeRequest({}))).status).toBe(400);
  });

  it('resolves one capability to ranked candidates', async () => {
    const res = await GET(makeRequest({ workspaceId: WORKSPACE_ID, capability: 'observability:query', roleSlug: 'builder' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.capability).toBe('observability:query');
    expect(body.candidates[0]).toMatchObject({ provider: { slug: 'axiom' }, access: 'permitted', availableNow: true });
    expect(mockLoadDiscoveryInput).toHaveBeenCalledWith(WORKSPACE_ID, 'builder');
  });

  it('shows one provider at an access, whatever its category', async () => {
    const res = await GET(makeRequest({ workspaceId: WORKSPACE_ID, provider: 'axiom', access: 'write', roleSlug: 'builder' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.capability).toBe('axiom:write');
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]).toMatchObject({ provider: { slug: 'axiom' }, access: 'permitted', risk: { requested: 'write' } });
    expect((await GET(makeRequest({ workspaceId: WORKSPACE_ID, provider: 'axiom', access: 'query' }))).status).toBe(400);
  });

  it('lists capabilities when none is named', async () => {
    const body = await (await GET(makeRequest())).json();
    expect(body.capabilities.map((c: { capability: string }) => c.capability)).toContain('observability:query');
  });

  it('400s an unknown capability with the vocabulary', async () => {
    const res = await GET(makeRequest({ workspaceId: WORKSPACE_ID, capability: 'telemetry:read' }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/observability/);
  });

  it('400s a malformed roleSlug before any read', async () => {
    const res = await GET(makeRequest({ workspaceId: WORKSPACE_ID, roleSlug: "x' or 1=1" }));
    expect(res.status).toBe(400);
    expect(mockLoadDiscoveryInput).not.toHaveBeenCalled();
  });

  it('404s a workspace the account cannot reach, without reading it', async () => {
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);
    expect((await GET(makeRequest())).status).toBe(404);
    expect(mockLoadDiscoveryInput).not.toHaveBeenCalled();
  });

  it('authenticates a session user via verifyWorkspaceAccess', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });
    expect((await GET(makeRequest())).status).toBe(200);
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith('user-1', WORKSPACE_ID);
  });

  it('never returns credential fields', async () => {
    const text = await (await GET(makeRequest({ workspaceId: WORKSPACE_ID, capability: 'observability:query' }))).text();
    expect(text).not.toMatch(/tokenExpiresAt|encrypted|secret/i);
  });

  describe('per-task token', () => {
    const scoped = (workspaceId: string) => ({
      id: 'acc-1', level: 'worker', teamId: 'team-1', taskScope: { taskId: 't-1', workspaceId, expiresAt: Date.now() + 60_000 },
    });

    it('defaults roleSlug to its own task\'s role', async () => {
      mockAuthenticateApiKey.mockResolvedValue(scoped(WORKSPACE_ID));
      mockTaskFindFirst.mockResolvedValue({ roleSlug: 'builder' });
      const res = await GET(makeRequest({ workspaceId: WORKSPACE_ID, capability: 'observability:query' }));
      expect(res.status).toBe(200);
      expect(mockLoadDiscoveryInput).toHaveBeenCalledWith(WORKSPACE_ID, 'builder');
      expect((await res.json()).role).toEqual({ slug: 'builder', found: true });
    });

    it('404s another workspace the account reaches, without reading it', async () => {
      mockAuthenticateApiKey.mockResolvedValue(scoped(OTHER_WORKSPACE_ID));
      expect((await GET(makeRequest())).status).toBe(404);
      expect(mockLoadDiscoveryInput).not.toHaveBeenCalled();
    });
  });

  describe('recording the search against the caller worker (blockedByCapability reads it)', () => {
    const WORKER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    it('records a search that found a provider as served, with the providers', async () => {
      mockWorkerFindFirst.mockResolvedValue({ id: WORKER_ID, accountId: 'acc-1', taskId: 't-1', workspaceId: WORKSPACE_ID });
      const res = await GET(makeRequest({ workspaceId: WORKSPACE_ID, capability: 'observability:query', roleSlug: 'builder', workerId: WORKER_ID }));
      expect(res.status).toBe(200);
      expect(mockRecordCapabilityDecision).toHaveBeenCalledTimes(1);
      expect(mockRecordCapabilityDecision.mock.calls[0][0]).toMatchObject({
        capability: 'capability.resolve', workerId: WORKER_ID, taskId: 't-1', reasonCode: 'served',
        sideEffect: { capability: 'observability:query', providers: ['axiom'] },
      });
    });

    it('records a search nothing serves as none', async () => {
      mockWorkerFindFirst.mockResolvedValue({ id: WORKER_ID, accountId: 'acc-1', taskId: 't-1', workspaceId: WORKSPACE_ID });
      mockLoadDiscoveryInput.mockImplementation(() => Promise.resolve({ ...discoveryInput('builder'), connectors: [], roles: [] }));
      await GET(makeRequest({ workspaceId: WORKSPACE_ID, provider: 'axiom', access: 'read', workerId: WORKER_ID }));
      expect(mockRecordCapabilityDecision.mock.calls[0][0]).toMatchObject({ reasonCode: 'none', sideEffect: { provider: 'axiom', access: 'read' } });
    });

    it('records nothing for a worker of another account, and answers the same', async () => {
      mockWorkerFindFirst.mockResolvedValue({ id: WORKER_ID, accountId: 'acc-2', taskId: 't-1', workspaceId: WORKSPACE_ID });
      const res = await GET(makeRequest({ workspaceId: WORKSPACE_ID, capability: 'observability:query', workerId: WORKER_ID }));
      expect(res.status).toBe(200);
      expect(mockRecordCapabilityDecision).not.toHaveBeenCalled();
    });

    it('records nothing without a workerId', async () => {
      await GET(makeRequest({ workspaceId: WORKSPACE_ID, capability: 'observability:query' }));
      expect(mockWorkerFindFirst).not.toHaveBeenCalled();
      expect(mockRecordCapabilityDecision).not.toHaveBeenCalled();
    });
  });

  it('404s when the workspace has no team', async () => {
    mockLoadDiscoveryInput.mockResolvedValue(null);
    expect((await GET(makeRequest())).status).toBe(404);
  });
});
