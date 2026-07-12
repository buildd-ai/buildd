import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));
const mockConnectorsFindMany = mock(() => [] as any[]);
const mockConnectorsFindFirst = mock(() => null as any);
const mockTeamMembersFindFirst = mock(() => null as any);
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
      connectors: { findMany: mockConnectorsFindMany, findFirst: mockConnectorsFindFirst },
      secrets: { findMany: mockSecretsFindMany },
      teamMembers: { findFirst: mockTeamMembersFindFirst },
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
  connectors: { teamId: 'teamId', id: 'id', name: 'name' },
  secrets: { teamId: 'teamId', purpose: 'purpose', label: 'label' },
  teamMembers: { userId: 'userId', teamId: 'teamId' },
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
      { id: 'conn-1', name: 'Test', url: 'https://mcp.example.com', authMode: 'oauth', transport: 'http' },
    ]);
    const res = await GET(makeGetReq());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connectors).toHaveLength(1);
    expect(data.connectors[0].status).toBe('not_connected');
    // Role picker renders transport + authMode badges from the list response.
    expect(data.connectors[0].transport).toBe('http');
    expect(data.connectors[0].authMode).toBe('oauth');
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
    mockConnectorsFindFirst.mockReset();
    mockTeamMembersFindFirst.mockReset();
    mockSecretsProviderSet.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockDiscoverOAuthMetadata.mockResolvedValue({ authMode: 'none' as const });
    mockConnectorsFindFirst.mockResolvedValue(null);
    // Default: session user is an admin/owner of the team (no member row => personal team => allowed).
    mockTeamMembersFindFirst.mockResolvedValue({ role: 'owner' });
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

  // §1 AC-2: header authMode requires headerName
  it('returns 400 header_name_required when header authMode has no headerName', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await POST(makePostReq({
      name: 'Header Connector',
      url: 'https://mcp.example.com',
      authMode: 'header',
    }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('header_name_required');
  });

  // §1 AC-3: stdio transport requires command
  it('returns 400 command_required when stdio transport has no command', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await POST(makePostReq({
      name: 'Stdio Connector',
      transport: 'stdio',
    }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('command_required');
  });

  it('creates a stdio connector with command/args/envMapping (authMode none, url optional)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    let captured: any;
    mockConnectorsInsert.mockReturnValue({
      values: mock((v: any) => { captured = v; return {
        returning: mock(() => [{ id: 'conn-stdio', name: 'Stdio', transport: 'stdio', authMode: 'none', teamId: 'team-1' }]),
      }; }),
    });
    const res = await POST(makePostReq({
      name: 'Stdio Connector',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@some/mcp-server'],
      envMapping: { API_KEY: 'my-secret-label' },
    }));
    expect(res.status).toBe(201);
    expect(captured.transport).toBe('stdio');
    expect(captured.command).toBe('npx');
    expect(captured.args).toEqual(['-y', '@some/mcp-server']);
    expect(captured.envMapping).toEqual({ API_KEY: 'my-secret-label' });
    expect(captured.authMode).toBe('none');
  });

  // §1 AC-4: (teamId, name) uniqueness on the plain create path
  it('returns 409 connector_name_taken when a connector with the same (teamId,name) exists', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockConnectorsFindFirst.mockResolvedValue({ id: 'conn-existing', name: 'Dup', url: 'https://mcp.example.com', teamId: 'team-1' });
    const res = await POST(makePostReq({ name: 'Dup', url: 'https://mcp.example.com', authMode: 'none' }));
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe('connector_name_taken');
  });

  // §5 AC-3: create-or-reuse — installing an existing (teamId,name) reuses it (no 409)
  it('reuses an existing connector when reuseIfExists is set', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const existing = { id: 'conn-existing', name: 'Dup', url: 'https://mcp.example.com', teamId: 'team-1' };
    mockConnectorsFindFirst.mockResolvedValue(existing);
    const res = await POST(makePostReq({ name: 'Dup', url: 'https://mcp.example.com', authMode: 'none', reuseIfExists: true }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connector.id).toBe('conn-existing');
    expect(data.reused).toBe(true);
    // Must NOT insert a duplicate row.
    expect(mockConnectorsInsert).not.toHaveBeenCalled();
  });

  // §6: non-admin team member cannot create a connector
  it('returns 403 when a non-admin team member creates a connector', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockTeamMembersFindFirst.mockResolvedValue({ role: 'member' });
    const res = await POST(makePostReq({ name: 'Test', url: 'https://mcp.example.com', authMode: 'none' }));
    expect(res.status).toBe(403);
  });
});
