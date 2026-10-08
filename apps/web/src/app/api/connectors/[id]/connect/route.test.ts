import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

process.env.OAUTH_JWT_SECRET = 'test-secret-do-not-use-in-prod-32-chars-min';
process.env.OAUTH_ISSUER = 'https://buildd.test';

const CONNECTOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const mockGetCurrentUser = mock(async () => ({ id: 'user-admin' }) as any);
const mockUserTeamIds = mock(async (_u: string) => ['team-1']);
const mockCheckBlocked = mock(async (_c: any, _t: string) => null as any);
const mockConnectorFindFirst = mock(async () => null as any);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => null }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mockUserTeamIds }));
import { fakeCan } from '@/lib/connector-team-auth.fixtures';

// The caller's role in the connector's team; null = no membership row. The
// real connector-team-auth gate runs against the registry defaults.
let actorRole: string | null = 'admin';
mock.module('@/lib/permissions', () => ({ can: fakeCan(() => actorRole) }));
mock.module('@/lib/connector-access-policy', () => ({
  checkConnectorBlocked: mockCheckBlocked,
  blockedBody: (b: any) => ({ error: 'blocked_by_policy', slug: b.slug, message: `${b.name} is blocked` }),
}));
mock.module('@buildd/core/db', () => ({
  db: { query: { connectors: { findFirst: mockConnectorFindFirst } } },
}));

const { POST } = await import('./route');
const { verifyOAuthState, OAUTH_STATE_COOKIE } = await import('@/lib/mcp-oauth');

/** An Axiom connector as catalog install leaves it: discovery + DCR done. */
const axiom = () => ({
  id: CONNECTOR_ID,
  teamId: 'team-1',
  url: 'https://mcp.axiom.co/mcp',
  authMode: 'oauth',
  clientId: 'client-from-dcr',
  discoveredMetadata: {
    authMode: 'oauth',
    authorizationServer: {
      authorization_endpoint: 'https://authorization.axiom.co/oauth2/authorize',
      token_endpoint: 'https://authorization.axiom.co/oauth2/token',
      scopes_supported: ['email', 'offline_access', 'openid', 'profile'],
    },
  },
});

const call = () => POST(
  new NextRequest(`https://buildd.test/api/connectors/${CONNECTOR_ID}/connect`, { method: 'POST' }),
  { params: Promise.resolve({ id: CONNECTOR_ID }) },
);

beforeEach(() => {
  mockGetCurrentUser.mockReset();
  mockGetCurrentUser.mockResolvedValue({ id: 'user-admin' });
  mockUserTeamIds.mockReset();
  mockUserTeamIds.mockResolvedValue(['team-1']);
  actorRole = 'admin';
  mockCheckBlocked.mockReset();
  mockCheckBlocked.mockResolvedValue(null);
  mockConnectorFindFirst.mockReset();
  mockConnectorFindFirst.mockResolvedValue(axiom());
});

describe('POST /api/connectors/[id]/connect', () => {
  it('gives a team admin a PKCE authorization URL bound to this connector, user and callback', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const { authorizationUrl } = await res.json();
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://authorization.axiom.co/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-from-dcr');
    expect(url.searchParams.get('redirect_uri')).toBe('https://buildd.test/api/connectors/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // offline_access comes from the AS metadata, so Axiom issues a refresh token.
    expect(url.searchParams.get('scope')).toContain('offline_access');

    const cookie = res.cookies.get(OAUTH_STATE_COOKIE)?.value;
    const claims = await verifyOAuthState(cookie!);
    expect(claims).toMatchObject({ connectorId: CONNECTOR_ID, userId: 'user-admin', state: url.searchParams.get('state') });
  });

  it('refuses a plain team member: connecting writes the team-wide credential', async () => {
    actorRole = 'member';
    const res = await call();
    expect(res.status).toBe(403);
    expect(res.cookies.get(OAUTH_STATE_COOKIE)).toBeUndefined();
  });

  it('refuses a user with no membership row in the owning team (fails closed)', async () => {
    actorRole = null;
    const res = await call();
    expect(res.status).toBe(403);
    expect(res.cookies.get(OAUTH_STATE_COOKIE)).toBeUndefined();
  });

  it('lets an owner start the flow', async () => {
    actorRole = 'owner';
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.cookies.get(OAUTH_STATE_COOKIE)).toBeDefined();
  });

  it("hides another team's connector", async () => {
    mockUserTeamIds.mockResolvedValue(['team-2']);
    expect((await call()).status).toBe(404);
  });

  it('refuses to start OAuth for a connector the team has blocked', async () => {
    mockCheckBlocked.mockResolvedValue({ slug: 'axiom', name: 'Axiom', blockedByTeamId: 'team-1' });
    const res = await call();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('blocked_by_policy');
  });

  it('says reconnect-by-reinstall when the provider never issued buildd a client', async () => {
    mockConnectorFindFirst.mockResolvedValue({ ...axiom(), clientId: null });
    expect((await call()).status).toBe(400);
  });
});
