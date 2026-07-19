import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockConnectorsFindFirst = mock(() => null as any);
const mockConnectorsUpdate = mock(() => ({
  set: mock(() => ({ where: mock(() => ({ returning: mock(() => [{ id: 'conn-1' }]) })) })),
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

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mockGetUserTeamIds }));
mock.module('@/lib/mcp-oauth', () => ({
  discoverOAuthMetadata: mockDiscoverOAuthMetadata,
  registerClient: mockRegisterClient,
  getCallbackUrl: mockGetCallbackUrl,
}));
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

const PARAMS = Promise.resolve({ id: 'conn-1' });

function makeReq(method = 'GET', headers: Record<string, string> = {}, body?: any) {
  return new NextRequest('http://localhost:3000/api/connectors/conn-1', {
    method,
    headers: new Headers(headers),
    body: body ? JSON.stringify(body) : undefined,
  });
}

const CONNECTOR = { id: 'conn-1', teamId: 'team-1', name: 'Test', url: 'https://mcp.example.com', authMode: 'oauth' as const };

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
    expect(data.connector.id).toBe('conn-1');
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
          id: 'conn-1', authMode: 'assertion',
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
});

describe('DELETE /api/connectors/[id]', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
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
});
