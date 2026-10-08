import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));
const mockConnectorsFindMany = mock(() => [] as any[]);
const mockConnectorsFindFirst = mock(() => null as any);
const mockConnectorSharesFindMany = mock(() => [] as any[]);
const mockTeamMembersFindFirst = mock(() => null as any);
const mockSecretsFindMany = mock(() => [] as any[]);
const mockPoliciesFindMany = mock(async () => [] as any[]);
const mockLoadTeamCatalog = mock(async (_t: string) => [] as any[]);
mock.module('@/lib/connector-catalog-store', () => ({ loadTeamCatalog: mockLoadTeamCatalog }));
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
const mockResolveConnectorIcon = mock(() => Promise.resolve(null as string | null));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mockGetUserTeamIds }));
class FakeRegistrationRejected extends Error {
  readonly needsApprovedClient = true;
  readonly description = 'The provided redirect URIs are not approved for use by this authorization server.';
}
mock.module('@/lib/mcp-oauth', () => ({
  ClientRegistrationRejectedError: FakeRegistrationRejected,
  discoverOAuthMetadata: mockDiscoverOAuthMetadata,
  registerClient: mockRegisterClient,
  getCallbackUrl: mockGetCallbackUrl,
}));
const mockScheduleStaleIconRefresh = mock((_rows: unknown[]) => {});
mock.module('@/lib/connector-icon', () => ({ resolveConnectorIcon: mockResolveConnectorIcon, resolveConnectorIconData: mockResolveConnectorIcon }));
mock.module('@/lib/connector-icon-refresh', () => ({ scheduleStaleIconRefresh: mockScheduleStaleIconRefresh }));
mock.module('@buildd/core/secrets', () => ({
  getSecretsProvider: () => ({ set: mockSecretsProviderSet }),
  encrypt: mockEncrypt,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: { teams: { findFirst: async () => null },
      connectors: { findMany: mockConnectorsFindMany, findFirst: mockConnectorsFindFirst },
      connectorShares: { findMany: mockConnectorSharesFindMany },
      secrets: { findMany: mockSecretsFindMany },
      teamMembers: { findFirst: mockTeamMembersFindFirst },
      connectorCatalogTeamPolicies: { findMany: mockPoliciesFindMany },
    },
    insert: () => mockConnectorsInsert(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b, op: 'eq' }),
  and: (...args: any[]) => ({ args, op: 'and' }),
  inArray: (a: any, b: any) => ({ a, b, op: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({ teams: { id: 'teams.id', permissionOverrides: 'teams.permission_overrides' },
  connectors: { teamId: 'teamId', id: 'id', name: 'name' },
  connectorShares: { connectorId: 'connectorId', sharedWithTeamId: 'sharedWithTeamId' },
  secrets: { teamId: 'teamId', purpose: 'purpose', label: 'label' },
  teamMembers: { userId: 'userId', teamId: 'teamId' },
  connectorCatalogTeamPolicies: { teamId: 'teamId', policy: 'policy' },
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
    mockConnectorSharesFindMany.mockReset();
    mockSecretsFindMany.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockConnectorsFindMany.mockResolvedValue([]);
    mockConnectorSharesFindMany.mockResolvedValue([]);
    mockSecretsFindMany.mockResolvedValue([]);
    mockPoliciesFindMany.mockReset();
    mockPoliciesFindMany.mockResolvedValue([]);
    mockLoadTeamCatalog.mockReset();
    mockLoadTeamCatalog.mockResolvedValue([]);
  });

  afterAll(() => { process.env.NODE_ENV = originalNodeEnv; });

  it('keeps a connector the team blocked in the list, flagged blockedByPolicy', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockConnectorsFindMany.mockResolvedValue([
      { id: 'conn-ax', teamId: 'team-1', name: 'Axiom', url: 'https://mcp.axiom.co/mcp', authMode: 'oauth', transport: 'http' },
      { id: 'conn-ok', teamId: 'team-1', name: 'Other', url: 'https://mcp.example.com', authMode: 'none', transport: 'http' },
    ]);
    mockPoliciesFindMany.mockResolvedValue([{ teamId: 'team-1' }]);
    mockLoadTeamCatalog.mockResolvedValue([{ slug: 'axiom', name: 'Axiom', url: 'https://mcp.axiom.co/mcp', policy: 'blocked' }]);
    const data = await (await GET(makeGetReq())).json();
    expect(data.connectors.map((c: any) => [c.id, c.blockedByPolicy])).toEqual([['conn-ax', true], ['conn-ok', false]]);
  });

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
    expect(data.connectors[0].iconUrl).toBeNull();
    // Role picker renders transport + authMode badges from the list response.
    expect(data.connectors[0].transport).toBe('http');
    expect(data.connectors[0].authMode).toBe('oauth');
  });

  it('schedules a lazy icon lookup for the listed rows', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockConnectorsFindMany.mockResolvedValue([
      { id: 'conn-1', name: 'Test', url: 'https://mcp.example.com', authMode: 'oauth', transport: 'http', iconUrl: null, iconCheckedAt: null },
    ]);
    mockScheduleStaleIconRefresh.mockClear();
    await GET(makeGetReq());
    expect((mockScheduleStaleIconRefresh.mock.calls.at(-1)?.[0] as any[]).map(r => r.id)).toEqual(['conn-1']);
  });

  it('defaults the list to the active-team cookie, not the first team', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1', 'team-2']);
    await GET(makeGetReq({ cookie: 'buildd-team=team-2' }));
    const where = (mockConnectorsFindMany.mock.calls.at(-1)?.[0] as any)?.where;
    expect(where?.b).toBe('team-2');
  });

  it('honors an explicit ?teamId over the cookie', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1', 'team-2', 'team-3']);
    const req = new NextRequest('http://localhost:3000/api/connectors?teamId=team-3', {
      headers: new Headers({ cookie: 'buildd-team=team-2' }),
    });
    await GET(req);
    const where = (mockConnectorsFindMany.mock.calls.at(-1)?.[0] as any)?.where;
    expect(where?.b).toBe('team-3');
  });

  it('ignores a cookie team the user does not belong to, falling back to first team', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    await GET(makeGetReq({ cookie: 'buildd-team=team-999' }));
    const where = (mockConnectorsFindMany.mock.calls.at(-1)?.[0] as any)?.where;
    expect(where?.b).toBe('team-1');
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

  // §1b: visibility = owned ∪ shared-in. Shared-in entries are marked
  // { shared: true, ownerTeamId, ownerTeamName } and MUST stay credential-free.
  it('includes shared-in connectors marked shared, without credential internals', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockConnectorsFindMany.mockResolvedValue([
      { id: 'conn-own', name: 'owned-mcp', url: 'https://owned.example.com', authMode: 'none', transport: 'http', teamId: 'team-1' },
    ]);
    mockConnectorSharesFindMany.mockResolvedValue([
      {
        connectorId: 'conn-shared',
        sharedWithTeamId: 'team-1',
        connector: {
          id: 'conn-shared', name: 'shared-mcp', url: 'https://shared.example.com', authMode: 'oauth', transport: 'http',
          teamId: 'team-owner', clientId: 'owner-client', encryptedClientSecret: 'enc:owner-secret',
          team: { name: 'Owner Team' },
        },
      },
    ]);
    const res = await GET(makeGetReq());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connectors).toHaveLength(2);

    const owned = data.connectors.find((c: any) => c.id === 'conn-own');
    expect(owned.shared).toBeUndefined();

    const shared = data.connectors.find((c: any) => c.id === 'conn-shared');
    expect(shared.shared).toBe(true);
    expect(shared.ownerTeamId).toBe('team-owner');
    expect(shared.ownerTeamName).toBe('Owner Team');
    // Grantee visibility MUST NOT include credential internals (§1b).
    expect(shared).not.toHaveProperty('clientId');
    expect(shared).not.toHaveProperty('encryptedClientSecret');
  });

  it('marks connector as expired when tokenExpiresAt is in the past', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockConnectorsFindMany.mockResolvedValue([{ id: 'conn-1', name: 'OAuth', url: 'https://mcp.example.com', authMode: 'oauth' }]);
    mockSecretsFindMany.mockResolvedValue([{ label: 'conn-1', tokenExpiresAt: new Date('2020-01-01') }]);
    const res = await GET(makeGetReq());
    const data = await res.json();
    expect(data.connectors[0].status).toBe('expired');
  });

  // Ground truth #4 regression: a dead credential is marked by the refresher with
  // tokenExpiresAt=null + lastVerificationError set. That must render 'expired'
  // (reconnect banner), not fall through to 'connected'.
  it('marks connector as expired when tokenExpiresAt is null but lastVerificationError is set', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockConnectorsFindMany.mockResolvedValue([{ id: 'conn-1', name: 'OAuth', url: 'https://mcp.example.com', authMode: 'oauth' }]);
    mockSecretsFindMany.mockResolvedValue([{ label: 'conn-1', tokenExpiresAt: null, lastVerificationError: 'HTTP 400 invalid_grant' }]);
    const res = await GET(makeGetReq());
    const data = await res.json();
    expect(data.connectors[0].status).toBe('expired');
  });

  it('marks connector as connected when tokenExpiresAt is null and no lastVerificationError', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockConnectorsFindMany.mockResolvedValue([{ id: 'conn-1', name: 'OAuth', url: 'https://mcp.example.com', authMode: 'oauth' }]);
    mockSecretsFindMany.mockResolvedValue([{ label: 'conn-1', tokenExpiresAt: null, lastVerificationError: null }]);
    const res = await GET(makeGetReq());
    const data = await res.json();
    expect(data.connectors[0].status).toBe('connected');
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
    mockResolveConnectorIcon.mockReset();
    mockResolveConnectorIcon.mockResolvedValue(null);
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

  // Regression: a URL missing its leading "h" ("ttps://…") passes the browser's
  // type=url check, then discovery threw and the user saw a bare 500.
  it('returns 400 invalid_url for a non-http(s) url, before any discovery', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await POST(makePostReq({ name: 'Axiom', url: 'ttps://mcp.axiom.co/mcp' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('invalid_url');
    expect(data.message).toMatch(/https:\/\//);
    expect(mockDiscoverOAuthMetadata).not.toHaveBeenCalled();
  });

  it('returns 422 discovery_failed with the reason when OAuth discovery throws', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockDiscoverOAuthMetadata.mockRejectedValue(new Error('Discovery probe failed: getaddrinfo ENOTFOUND'));
    const res = await POST(makePostReq({ name: 'Broken', url: 'https://mcp.nowhere.invalid/mcp' }));
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toBe('discovery_failed');
    expect(data.message).toMatch(/ENOTFOUND/);
  });

  // Vercel's DCR answers buildd's callback with invalid_redirect_uri: an
  // approval problem for the owner, not a reachability problem.
  it('returns 422 needs_approved_client when the provider refuses to register buildd', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockDiscoverOAuthMetadata.mockResolvedValue({
      authMode: 'oauth',
      authorizationServer: { registration_endpoint: 'https://api.vercel.com/login/oauth/register' },
    });
    mockRegisterClient.mockRejectedValueOnce(new FakeRegistrationRejected('DCR failed (400)'));
    const res = await POST(makePostReq({ name: 'Vercel', url: 'https://mcp.vercel.com' }));
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toBe('needs_approved_client');
    expect(data.message).toMatch(/Vercel/);
    expect(data.actionUrl).toMatch(/^https:\/\/vercel\.com\//);
    expect(mockConnectorsInsert).not.toHaveBeenCalled();
  });

  // Vercel's DCR answers buildd's callback with invalid_redirect_uri: an
  // approval problem for the owner, not a reachability problem.
  it('returns 422 needs_approved_client when the provider refuses to register buildd', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockDiscoverOAuthMetadata.mockResolvedValue({
      authMode: 'oauth',
      authorizationServer: { registration_endpoint: 'https://api.vercel.com/login/oauth/register' },
    });
    mockRegisterClient.mockRejectedValueOnce(new FakeRegistrationRejected('DCR failed (400)'));
    const res = await POST(makePostReq({ name: 'Vercel', url: 'https://mcp.vercel.com' }));
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toBe('needs_approved_client');
    expect(data.message).toMatch(/Vercel/);
    expect(data.actionUrl).toMatch(/^https:\/\/vercel\.com\//);
    expect(mockConnectorsInsert).not.toHaveBeenCalled();
  });

  it('stores the resolved icon on create', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockResolveConnectorIcon.mockResolvedValue('data:image/png;base64,AA');
    let captured: any;
    mockConnectorsInsert.mockReturnValue({
      values: mock((v: any) => { captured = v; return {
        returning: mock(() => [{ id: 'conn-icon', name: 'Custom', url: 'https://mcp.custom.dev/mcp', authMode: 'none', teamId: 'team-1', iconUrl: v.iconUrl }]),
      }; }),
    });
    const res = await POST(makePostReq({ name: 'Custom', url: 'https://mcp.custom.dev/mcp' }));
    expect(res.status).toBe(201);
    expect(mockResolveConnectorIcon).toHaveBeenCalledWith('https://mcp.custom.dev/mcp', { headers: undefined });
    expect(captured.iconUrl).toBe('data:image/png;base64,AA');
    expect(captured.iconCheckedAt).toBeInstanceOf(Date);
  });

  it('probes initialize with the header credential for a header-auth connector', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await POST(makePostReq({ name: 'Keyed', url: 'https://mcp.custom.dev/mcp', authMode: 'header', headerName: 'X-API-Key', headerValue: 'k' }));
    expect(res.status).toBe(201);
    expect(mockResolveConnectorIcon).toHaveBeenCalledWith('https://mcp.custom.dev/mcp', { headers: { 'X-API-Key': 'k' } });
  });

  it('still creates the connector when icon resolution fails', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    let captured: any;
    mockResolveConnectorIcon.mockRejectedValue(new Error('boom'));
    mockConnectorsInsert.mockReturnValue({
      values: mock((v: any) => { captured = v; return { returning: mock(() => [{ id: 'c', name: 'n', url: 'u', authMode: 'none', teamId: 'team-1' }]) }; }),
    });
    const res = await POST(makePostReq({ name: 'Custom', url: 'https://mcp.custom.dev/mcp' }));
    expect(res.status).toBe(201);
    expect(captured.iconUrl).toBeNull();
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

  // Assertion-mode connector validation (spec §E.2 invariants)
  it('returns 400 assertion_audience_required when assertion authMode has no assertionAudience', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await POST(makePostReq({
      name: 'Cue',
      url: 'https://cue.buildd.dev/api/mcp',
      authMode: 'assertion',
      assertionTokenEndpoint: 'https://cue.buildd.dev/api/oauth/token',
    }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('assertion_audience_required');
  });

  it('returns 400 assertion_token_endpoint_required when assertion authMode has no assertionTokenEndpoint', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await POST(makePostReq({
      name: 'Cue',
      url: 'https://cue.buildd.dev/api/mcp',
      authMode: 'assertion',
      assertionAudience: 'https://cue.buildd.dev/api/mcp',
    }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('assertion_token_endpoint_required');
  });

  it('creates assertion connector with audience and tokenEndpoint persisted', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    let captured: any;
    mockConnectorsInsert.mockReturnValue({
      values: mock((v: any) => { captured = v; return {
        returning: mock(() => [{
          id: 'conn-assert', name: 'cue', url: 'https://cue.buildd.dev/api/mcp',
          authMode: 'assertion', teamId: 'team-1',
          assertionAudience: 'https://cue.buildd.dev/api/mcp',
          assertionTokenEndpoint: 'https://cue.buildd.dev/api/oauth/token',
        }]),
      }; }),
    });
    const res = await POST(makePostReq({
      name: 'cue',
      url: 'https://cue.buildd.dev/api/mcp',
      authMode: 'assertion',
      assertionAudience: 'https://cue.buildd.dev/api/mcp',
      assertionTokenEndpoint: 'https://cue.buildd.dev/api/oauth/token',
    }));
    expect(res.status).toBe(201);
    expect(captured.authMode).toBe('assertion');
    expect(captured.assertionAudience).toBe('https://cue.buildd.dev/api/mcp');
    expect(captured.assertionTokenEndpoint).toBe('https://cue.buildd.dev/api/oauth/token');
    // Must not try to discover OAuth metadata for assertion connectors
    expect(mockDiscoverOAuthMetadata).not.toHaveBeenCalled();
  });
});
