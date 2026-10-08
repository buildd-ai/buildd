import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockConnectorsFindFirst = mock(() => null as any);
const mockConnectorsUpdate = mock(() => ({
  set: mock(() => ({ where: mock(() => ({ returning: mock(() => [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }]) })) })),
}));
const mockConnectorsDelete = mock(() => ({ where: mock(() => Promise.resolve()) }));
const mockSecretsFindFirst = mock(() => null as any);
const mockSecretsFindMany = mock(() => [] as any[]);
const mockSecretsProviderSet = mock(() => Promise.resolve('secret-1'));
const mockSecretsProviderDelete = mock(() => Promise.resolve());
const mockDiscoverOAuthMetadata = mock(() => Promise.resolve({ authMode: 'none' as const }));
const mockRegisterClient = mock(() => Promise.resolve({ client_id: 'c1' }));
const mockGetCallbackUrl = mock(() => 'https://app.example.com/api/connectors/callback');
const mockEncrypt = mock((v: string) => `enc:${v}`);
class FakeRegistrationRejected extends Error {}
const mockRegistrationRefusalBody = mock((err: unknown) =>
  err instanceof FakeRegistrationRejected
    ? { error: 'needs_approved_client' as const, message: 'Vercel only lets MCP clients it has reviewed sign in.', actionUrl: 'https://vercel.com/docs' }
    : null);

import { fakeCan } from '@/lib/connector-team-auth.fixtures';

// The caller's role in the connector's team; null = no membership row.
let actorRole: string | null = 'owner';
mock.module('@/lib/permissions', () => ({ can: fakeCan(() => actorRole) }));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mockGetUserTeamIds }));
mock.module('@/lib/mcp-oauth', () => ({
  discoverOAuthMetadata: mockDiscoverOAuthMetadata,
  registerClient: mockRegisterClient,
  getCallbackUrl: mockGetCallbackUrl,
}));
mock.module('@/lib/connector-provision', () => ({ registrationRefusalBody: mockRegistrationRefusalBody }));
mock.module('@buildd/core/secrets', () => ({
  getSecretsProvider: () => ({ set: mockSecretsProviderSet, delete: mockSecretsProviderDelete }),
  encrypt: mockEncrypt,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      connectors: { findFirst: mockConnectorsFindFirst },
      secrets: { findFirst: mockSecretsFindFirst, findMany: mockSecretsFindMany },
    },
    update: () => mockConnectorsUpdate(),
    delete: () => mockConnectorsDelete(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b, op: 'eq' }),
  and: (...args: any[]) => ({ args, op: 'and' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  connectors: { id: 'id', teamId: 'teamId' },
  secrets: { teamId: 'teamId', purpose: 'purpose', label: 'label', id: 'id' },
}));

const originalNodeEnv = process.env.NODE_ENV;

import { GET, PATCH, DELETE } from './route';

const PARAMS = Promise.resolve({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });

function makeReq(method = 'GET', headers: Record<string, string> = {}, body?: any) {
  return new NextRequest('http://localhost:3000/api/connectors/conn-1', {
    method,
    headers: new Headers(headers),
    body: body ? JSON.stringify(body) : undefined,
  });
}

const CONNECTOR = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', teamId: 'team-1', name: 'Test', url: 'https://mcp.example.com', authMode: 'oauth' as const };

describe('GET /api/connectors/[id]', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockConnectorsFindFirst.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
  });
  afterAll(() => { process.env.NODE_ENV = originalNodeEnv; });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET(makeReq(), { params: PARAMS });
    expect(res.status).toBe(401);
  });

  it('returns 404 when connector not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockConnectorsFindFirst.mockResolvedValue(null);
    const res = await GET(makeReq(), { params: PARAMS });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-UUID id (e.g. a short 8-hex id) without querying the db', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await GET(makeReq(), { params: Promise.resolve({ id: 'a1b2c3d4' }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('UUID');
    expect(mockConnectorsFindFirst).not.toHaveBeenCalled();
  });

  it('returns 404 when connector belongs to different team (team scoping)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockConnectorsFindFirst.mockResolvedValue({ ...CONNECTOR, teamId: 'other-team' });
    const res = await GET(makeReq(), { params: PARAMS });
    expect(res.status).toBe(404);
  });

  it('returns connector for correct team', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockConnectorsFindFirst.mockResolvedValue(CONNECTOR);
    const res = await GET(makeReq(), { params: PARAMS });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connector.id).toBe('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  });

  it('returns 404 for API key from wrong team', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'other-team', level: 'admin' });
    mockConnectorsFindFirst.mockResolvedValue(CONNECTOR);
    const res = await GET(makeReq('GET', { authorization: 'Bearer bld_key' }), { params: PARAMS });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/connectors/[id]', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    actorRole = 'owner';
    mockSecretsProviderSet.mockClear();
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockConnectorsFindFirst.mockReset();
    mockSecretsFindFirst.mockReset();
    mockConnectorsUpdate.mockReset();
    mockDiscoverOAuthMetadata.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockConnectorsFindFirst.mockResolvedValue(CONNECTOR);
    mockSecretsFindFirst.mockResolvedValue(null);
    mockDiscoverOAuthMetadata.mockResolvedValue({ authMode: 'none' as const });
    mockConnectorsUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [{ ...CONNECTOR, name: 'Updated' }]),
        })),
      })),
    });
  });
  afterAll(() => { process.env.NODE_ENV = originalNodeEnv; });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockConnectorsFindFirst.mockResolvedValue(null);
    const res = await PATCH(makeReq('PATCH', { 'content-type': 'application/json' }, { name: 'New' }), { params: PARAMS });
    expect(res.status).toBe(401);
  });

  it('returns 404 when connector not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockConnectorsFindFirst.mockResolvedValue(null);
    const res = await PATCH(makeReq('PATCH', { 'content-type': 'application/json' }, { name: 'New' }), { params: PARAMS });
    expect(res.status).toBe(404);
  });

  it('updates connector name', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await PATCH(makeReq('PATCH', { 'content-type': 'application/json' }, { name: 'Updated' }), { params: PARAMS });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connector.name).toBe('Updated');
  });

  it('updates assertionAudience and assertionTokenEndpoint on assertion connector', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    let captured: any;
    mockConnectorsUpdate.mockReturnValue({
      set: mock((v: any) => { captured = v; return {
        where: mock(() => ({ returning: mock(() => [{
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', authMode: 'assertion',
          assertionAudience: 'https://cue.buildd.dev/api/mcp',
          assertionTokenEndpoint: 'https://cue.buildd.dev/api/oauth/token',
        }]) })),
      }; }),
    });
    const res = await PATCH(makeReq('PATCH', { 'content-type': 'application/json' }, {
      assertionAudience: 'https://cue.buildd.dev/api/mcp',
      assertionTokenEndpoint: 'https://cue.buildd.dev/api/oauth/token',
    }), { params: PARAMS });
    expect(res.status).toBe(200);
    expect(captured.assertionAudience).toBe('https://cue.buildd.dev/api/mcp');
    expect(captured.assertionTokenEndpoint).toBe('https://cue.buildd.dev/api/oauth/token');
  });

  // Reconnect re-runs DCR; a provider that only admits approved clients (Vercel)
  // used to surface as a bare 500 "Failed to update connector".
  it('returns 422 needs_approved_client when rediscovery DCR is refused', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockConnectorsFindFirst.mockResolvedValue({ ...CONNECTOR, url: 'https://mcp.vercel.com', clientId: null });
    mockDiscoverOAuthMetadata.mockResolvedValue({
      authMode: 'oauth',
      authorizationServer: { registration_endpoint: 'https://api.vercel.com/login/oauth/register' },
    } as any);
    mockRegisterClient.mockRejectedValueOnce(new FakeRegistrationRejected('DCR failed (400)'));
    const res = await PATCH(makeReq('PATCH', { 'content-type': 'application/json' }, { rediscover: true }), { params: PARAMS });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toBe('needs_approved_client');
    expect(data.actionUrl).toMatch(/^https:\/\/vercel\.com\//);
    expect(mockConnectorsUpdate).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/connectors/[id] requires manage_connectors', () => {
  const HEADER_CONNECTOR = { ...CONNECTOR, authMode: 'header' as const };
  const patchReq = (body: any, headers: Record<string, string> = {}) =>
    makeReq('PATCH', { 'content-type': 'application/json', ...headers }, body);

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockConnectorsFindFirst.mockReset();
    mockSecretsFindFirst.mockReset();
    mockSecretsProviderSet.mockClear();
    mockConnectorsUpdate.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockConnectorsFindFirst.mockResolvedValue(HEADER_CONNECTOR);
    mockSecretsFindFirst.mockResolvedValue({ id: 'secret-1' });
    mockConnectorsUpdate.mockReturnValue({
      set: mock(() => ({ where: mock(() => ({ returning: mock(() => [HEADER_CONNECTOR]) })) })),
    });
  });
  afterAll(() => { process.env.NODE_ENV = originalNodeEnv; });

  it('a member is refused 403 and neither the connector nor its credential is written', async () => {
    actorRole = 'member';
    const res = await PATCH(patchReq({ name: 'Renamed', headerValue: 'new-token' }), { params: PARAMS });
    expect(res.status).toBe(403);
    expect(mockConnectorsUpdate).not.toHaveBeenCalled();
    expect(mockSecretsProviderSet).not.toHaveBeenCalled();
  });

  it('a user with no membership row in the owning team is refused (fails closed)', async () => {
    actorRole = null;
    const res = await PATCH(patchReq({ headerValue: 'new-token' }), { params: PARAMS });
    expect(res.status).toBe(403);
    expect(mockConnectorsUpdate).not.toHaveBeenCalled();
    expect(mockSecretsProviderSet).not.toHaveBeenCalled();
  });

  for (const role of ['admin', 'owner']) {
    it(`an ${role} may update the connector and replace its credential`, async () => {
      actorRole = role;
      const res = await PATCH(patchReq({ name: 'Renamed', headerValue: 'new-token' }), { params: PARAMS });
      expect(res.status).toBe(200);
      expect(mockConnectorsUpdate).toHaveBeenCalled();
      expect(mockSecretsProviderSet).toHaveBeenCalledWith('secret-1', 'new-token', expect.objectContaining({ teamId: 'team-1' }));
    });
  }

  it('an admin-level API key of the owning team may update', async () => {
    actorRole = null;
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1', level: 'admin' });
    const res = await PATCH(patchReq({ headerValue: 'new-token' }, { authorization: 'Bearer bld_key' }), { params: PARAMS });
    expect(res.status).toBe(200);
    expect(mockSecretsProviderSet).toHaveBeenCalled();
  });

  it('a worker-level API key is refused and nothing is written', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1', level: 'worker' });
    const res = await PATCH(patchReq({ headerValue: 'new-token' }, { authorization: 'Bearer bld_key' }), { params: PARAMS });
    expect(res.status).toBe(401);
    expect(mockConnectorsUpdate).not.toHaveBeenCalled();
    expect(mockSecretsProviderSet).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/connectors/[id]', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    actorRole = 'owner';
    mockSecretsProviderDelete.mockClear();
    mockConnectorsDelete.mockClear();
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockConnectorsFindFirst.mockReset();
    mockSecretsFindMany.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockConnectorsFindFirst.mockResolvedValue(CONNECTOR);
    mockSecretsFindMany.mockResolvedValue([]);
  });
  afterAll(() => { process.env.NODE_ENV = originalNodeEnv; });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockConnectorsFindFirst.mockResolvedValue(null);
    const res = await DELETE(makeReq('DELETE'), { params: PARAMS });
    expect(res.status).toBe(401);
  });

  it('returns 404 when connector belongs to different team', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockConnectorsFindFirst.mockResolvedValue({ ...CONNECTOR, teamId: 'other-team' });
    const res = await DELETE(makeReq('DELETE'), { params: PARAMS });
    expect(res.status).toBe(404);
  });

  it('deletes connector and secrets', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockSecretsFindMany.mockResolvedValue([{ id: 'secret-1' }]);
    const res = await DELETE(makeReq('DELETE'), { params: PARAMS });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(mockSecretsProviderDelete).toHaveBeenCalledWith('secret-1');
  });

  it('a member is refused 403 and neither the connector nor its credential is deleted', async () => {
    actorRole = 'member';
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockSecretsFindMany.mockResolvedValue([{ id: 'secret-1' }]);
    const res = await DELETE(makeReq('DELETE'), { params: PARAMS });
    expect(res.status).toBe(403);
    expect(mockConnectorsDelete).not.toHaveBeenCalled();
    expect(mockSecretsProviderDelete).not.toHaveBeenCalled();
  });

  it('a user with no membership row in the owning team is refused (fails closed)', async () => {
    actorRole = null;
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await DELETE(makeReq('DELETE'), { params: PARAMS });
    expect(res.status).toBe(403);
    expect(mockConnectorsDelete).not.toHaveBeenCalled();
  });

  for (const role of ['admin', 'owner']) {
    it(`an ${role} may delete`, async () => {
      actorRole = role;
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      const res = await DELETE(makeReq('DELETE'), { params: PARAMS });
      expect(res.status).toBe(200);
      expect(mockConnectorsDelete).toHaveBeenCalled();
    });
  }

  it('an admin-level API key of the owning team may delete', async () => {
    actorRole = null;
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1', level: 'admin' });
    const res = await DELETE(makeReq('DELETE', { authorization: 'Bearer bld_key' }), { params: PARAMS });
    expect(res.status).toBe(200);
    expect(mockConnectorsDelete).toHaveBeenCalled();
  });
});
