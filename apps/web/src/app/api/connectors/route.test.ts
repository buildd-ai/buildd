import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));
const mockConnectorsFindMany = mock(() => [] as any[]);
const mockSecretsFindMany = mock(() => [] as any[]);
const mockConnectorsInsert = mock(() => ({
  values: mock(() => ({
    returning: mock(() => [{ id: 'conn-1', name: 'Test', url: 'https://mcp.example.com', authMode: 'oauth', teamId: 'team-1' }]),
  })),
}));
const mockDiscoverOAuthMetadata = mock(() => Promise.resolve({ authMode: 'none' as const }));
const mockRegisterClient = mock(() => Promise.resolve({ client_id: 'client-1' }));
const mockGetCallbackUrl = mock(() => 'https://app.example.com/api/connectors/callback');
const mockSecretsProviderSet = mock(() => Promise.resolve('secret-1'));
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
  getSecretsProvider: () => ({ set: mockSecretsProviderSet }),
  encrypt: mockEncrypt,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      connectors: { findMany: mockConnectorsFindMany },
      secrets: { findMany: mockSecretsFindMany },
    },
    insert: () => mockConnectorsInsert(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b, op: 'eq' }),
  and: (...args: any[]) => ({ args, op: 'and' }),
  inArray: (a: any, b: any) => ({ a, b, op: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  connectors: { teamId: 'teamId', id: 'id' },
  secrets: { teamId: 'teamId', purpose: 'purpose', label: 'label' },
}));

const originalNodeEnv = process.env.NODE_ENV;

import { GET, POST } from './route';

function makeGetReq(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost:3000/api/connectors', { headers: new Headers(headers) });
}

function makePostReq(body: any) {
  return new NextRequest('http://localhost:3000/api/connectors', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

describe('GET /api/connectors', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockGetUserTeamIds.mockReset();
    mockConnectorsFindMany.mockReset();
    mockSecretsFindMany.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockConnectorsFindMany.mockResolvedValue([]);
    mockSecretsFindMany.mockResolvedValue([]);
  });

  afterAll(() => { process.env.NODE_ENV = originalNodeEnv; });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET(makeGetReq());
    expect(res.status).toBe(401);
  });

  it('returns connector list for session auth', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockConnectorsFindMany.mockResolvedValue([
      { id: 'conn-1', name: 'Test', url: 'https://mcp.example.com', authMode: 'oauth' },
    ]);
    const res = await GET(makeGetReq());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connectors).toHaveLength(1);
    expect(data.connectors[0].status).toBe('not_connected');
  });

  it('returns connector list for API key auth', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1', level: 'admin' });
    mockConnectorsFindMany.mockResolvedValue([
      { id: 'conn-1', name: 'Test', url: 'https://mcp.example.com', authMode: 'header' },
    ]);
    mockSecretsFindMany.mockResolvedValue([
      { label: 'conn-1', tokenExpiresAt: null },
    ]);
    const res = await GET(makeGetReq({ authorization: 'Bearer bld_key' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connectors[0].status).toBe('connected');
  });

  it('returns 401 for non-admin API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1', level: 'worker' });
    const res = await GET(makeGetReq({ authorization: 'Bearer bld_key' }));
    expect(res.status).toBe(401);
  });

  it('marks connector as expired when tokenExpiresAt is in the past', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockConnectorsFindMany.mockResolvedValue([{ id: 'conn-1', name: 'OAuth', url: 'https://mcp.example.com', authMode: 'oauth' }]);
    mockSecretsFindMany.mockResolvedValue([{ label: 'conn-1', tokenExpiresAt: new Date('2020-01-01') }]);
    const res = await GET(makeGetReq());
    const data = await res.json();
    expect(data.connectors[0].status).toBe('expired');
  });
});

describe('POST /api/connectors', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockGetUserTeamIds.mockReset();
    mockDiscoverOAuthMetadata.mockReset();
    mockConnectorsInsert.mockReset();
    mockSecretsProviderSet.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockDiscoverOAuthMetadata.mockResolvedValue({ authMode: 'none' as const });
    mockSecretsProviderSet.mockResolvedValue('secret-1');
    mockConnectorsInsert.mockReturnValue({
      values: mock(() => ({
        returning: mock(() => [{ id: 'conn-new', name: 'New', url: 'https://mcp.example.com', authMode: 'oauth', teamId: 'team-1' }]),
      })),
    });
  });

  afterAll(() => { process.env.NODE_ENV = originalNodeEnv; });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await POST(makePostReq({ name: 'Test', url: 'https://mcp.example.com' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 when name or url missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await POST(makePostReq({ name: 'Test' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/required/);
  });

  it('creates connector with oauth auth mode', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await POST(makePostReq({ name: 'MCP Server', url: 'https://mcp.example.com', authMode: 'oauth' }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.connector.id).toBe('conn-new');
  });

  it('creates connector with header auth and stores secret', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockConnectorsInsert.mockReturnValue({
      values: mock(() => ({
        returning: mock(() => [{ id: 'conn-hdr', name: 'Header', url: 'https://mcp.example.com', authMode: 'header', teamId: 'team-1' }]),
      })),
    });
    const res = await POST(makePostReq({
      name: 'Header Connector',
      url: 'https://mcp.example.com',
      authMode: 'header',
      headerName: 'Authorization',
      headerValue: 'Bearer secret-token',
    }));
    expect(res.status).toBe(201);
    expect(mockSecretsProviderSet).toHaveBeenCalledWith(null, 'Bearer secret-token', expect.objectContaining({
      purpose: 'mcp_connector_credential',
      label: 'conn-hdr',
    }));
  });

  it('runs DCR when oauth + no clientId + registration_endpoint available', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockDiscoverOAuthMetadata.mockResolvedValue({
      authMode: 'oauth' as const,
      protectedResource: { resource: 'https://mcp.example.com', authorization_servers: ['https://as.example.com'] },
      authorizationServer: {
        issuer: 'https://as.example.com',
        authorization_endpoint: 'https://as.example.com/authorize',
        token_endpoint: 'https://as.example.com/token',
        registration_endpoint: 'https://as.example.com/register',
      },
    });
    mockRegisterClient.mockResolvedValue({ client_id: 'dynamic-client', client_secret: 'dcr-secret' });
    const res = await POST(makePostReq({ name: 'OAuth MCP', url: 'https://mcp.example.com' }));
    expect(res.status).toBe(201);
    expect(mockRegisterClient).toHaveBeenCalled();
  });
});
