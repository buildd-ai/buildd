import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';
import { NextRequest } from 'next/server';

// Set env vars before any imports
process.env.OAUTH_JWT_SECRET = 'test-secret-do-not-use-in-prod-32-chars-min';
process.env.OAUTH_ISSUER = 'https://buildd.test';
process.env.ENCRYPTION_KEY = 'test-encryption-key-32-chars-min-1234';

// ─── Mock DB ──────────────────────────────────────────────────────────────────

const mockConnectorsFindFirst = mock(() => null as any);
const mockSecretsFindFirst = mock(() => null as any);
const mockInsertValues = mock(() => Promise.resolve());
const mockUpdateSet = mock(() => ({
  where: mock(() => Promise.resolve()),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      connectors: { findFirst: mockConnectorsFindFirst },
      secrets: { findFirst: mockSecretsFindFirst },
    },
    insert: () => ({ values: mockInsertValues }),
    update: () => ({ set: mockUpdateSet }),
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  connectors: 'connectors',
  secrets: 'secrets',
}));

mock.module('drizzle-orm', () => ({
  eq: (_f: any, _v: any) => ({ type: 'eq' }),
  and: (..._args: any[]) => ({ type: 'and' }),
}));

// ─── Mock crypto encrypt/decrypt ──────────────────────────────────────────────

const mockEncrypt = mock((v: string) => `enc:${v}`);
const mockDecrypt = mock((v: string) => v.replace('enc:', ''));

mock.module('@buildd/core/secrets', () => ({
  encrypt: mockEncrypt,
  decrypt: mockDecrypt,
}));

// ─── Mock next/headers cookies ────────────────────────────────────────────────

const mockCookiesGet = mock((_name: string) => undefined as any);
const mockCookiesDelete = mock((_name: string) => {});

mock.module('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: mockCookiesGet,
      delete: mockCookiesDelete,
    }),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { signOAuthState } from '@/lib/mcp-oauth';
import { GET } from './route';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL('https://buildd.test/api/connectors/callback');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url.toString());
}

const mockConnector = {
  id: 'conn-uuid-1',
  teamId: 'team-uuid-1',
  url: 'https://mcp.example.com',
  authMode: 'oauth',
  clientId: 'my-client-id',
  encryptedClientSecret: null,
  discoveredMetadata: {
    authorizationServer: {
      issuer: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
    },
  },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/connectors/callback', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockConnectorsFindFirst.mockReset();
    mockSecretsFindFirst.mockReset();
    mockInsertValues.mockReset();
    mockUpdateSet.mockReset();
    mockEncrypt.mockReset();
    mockDecrypt.mockReset();
    mockCookiesGet.mockReset();
    fetchSpy?.mockRestore();

    mockEncrypt.mockImplementation((v: string) => `enc:${v}`);
    mockDecrypt.mockImplementation((v: string) => v.replace('enc:', ''));
    mockUpdateSet.mockReturnValue({ where: mock(() => Promise.resolve()) });
  });

  it('redirects to /app/connections?error=missing_code_or_state when code absent', async () => {
    const req = makeRequest({ state: 'abc' });
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('error=missing_code_or_state');
  });

  it('redirects with AS-returned error description', async () => {
    const req = makeRequest({ error: 'access_denied', error_description: 'User denied' });
    const res = await GET(req);
    expect(res.status).toBe(307);
    const loc = res.headers.get('location') ?? '';
    // URL encoding: space → + or %20
    expect(decodeURIComponent(loc.replace(/\+/g, ' '))).toContain('User denied');
  });

  it('redirects with error when state cookie is missing', async () => {
    mockCookiesGet.mockReturnValue(undefined);
    const req = makeRequest({ code: 'authcode', state: 'somestate' });
    const res = await GET(req);
    expect(res.headers.get('location')).toContain('error=missing_state_cookie');
  });

  it('redirects with error when state cookie is invalid JWT', async () => {
    mockCookiesGet.mockReturnValue({ value: 'invalid.cookie.value' });
    const req = makeRequest({ code: 'authcode', state: 'somestate' });
    const res = await GET(req);
    expect(res.headers.get('location')).toContain('error=invalid_state_cookie');
  });

  it('redirects with error on state mismatch', async () => {
    const stateCookie = await signOAuthState({
      state: 'correct-state',
      connectorId: 'conn-uuid-1',
      codeVerifier: 'pkce-verifier',
      userId: 'user-1',
    });
    mockCookiesGet.mockReturnValue({ value: stateCookie });

    const req = makeRequest({ code: 'authcode', state: 'wrong-state' });
    const res = await GET(req);
    expect(res.headers.get('location')).toContain('error=state_mismatch');
  });

  it('redirects with error when connector not found', async () => {
    const stateCookie = await signOAuthState({
      state: 'my-state',
      connectorId: 'nonexistent',
      codeVerifier: 'verifier',
      userId: 'user-1',
    });
    mockCookiesGet.mockReturnValue({ value: stateCookie });
    mockConnectorsFindFirst.mockResolvedValue(null);

    const req = makeRequest({ code: 'code', state: 'my-state' });
    const res = await GET(req);
    expect(res.headers.get('location')).toContain('error=connector_not_found');
  });

  it('happy path: exchanges code, validates audience, stores token, redirects', async () => {
    const state = 'happy-state';
    const stateCookie = await signOAuthState({
      state,
      connectorId: 'conn-uuid-1',
      codeVerifier: 'pkce-verifier-value',
      userId: 'user-uuid-1',
    });
    mockCookiesGet.mockReturnValue({ value: stateCookie });
    mockConnectorsFindFirst.mockResolvedValue(mockConnector);
    mockSecretsFindFirst.mockResolvedValue(null); // no existing secret → insert

    // Build a fake JWT with aud = connector URL (no sig check in validateTokenAudience)
    const fakeJwtPayload = Buffer.from(
      JSON.stringify({ aud: 'https://mcp.example.com', sub: 'user-1' }),
    ).toString('base64url');
    const fakeAccessToken = `eyJhbGciOiJIUzI1NiJ9.${fakeJwtPayload}.fakesig`;

    const tokenResponse = {
      access_token: fakeAccessToken,
      refresh_token: 'rt_refresh_value',
      expires_in: 3600,
      token_type: 'bearer',
    };

    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(tokenResponse), { status: 200 }),
    );

    const req = makeRequest({ code: 'authcode123', state });
    const res = await GET(req);

    // Should redirect to /app/connections?connected=...
    expect(res.status).toBe(307);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('/app/connections');
    expect(loc).toContain('connected=conn-uuid-1');

    // Token exchange was called
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [tokenUrl, tokenOpts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe('https://auth.example.com/token');
    const body = new URLSearchParams(tokenOpts.body as string);
    expect(body.get('code')).toBe('authcode123');
    expect(body.get('code_verifier')).toBe('pkce-verifier-value');

    // Encrypted blob was written
    expect(mockEncrypt).toHaveBeenCalled();
    const encryptedArg = (mockEncrypt.mock.calls[0] as [string])[0];
    const blob = JSON.parse(encryptedArg);
    expect(blob.access_token).toBe(fakeAccessToken);
    expect(blob.refresh_token).toBe('rt_refresh_value');

    // Insert was called (no existing secret)
    expect(mockInsertValues).toHaveBeenCalled();
  });

  it('updates existing secret row instead of inserting', async () => {
    const state = 'update-state';
    const stateCookie = await signOAuthState({
      state,
      connectorId: 'conn-uuid-1',
      codeVerifier: 'verifier',
      userId: 'user-1',
    });
    mockCookiesGet.mockReturnValue({ value: stateCookie });
    mockConnectorsFindFirst.mockResolvedValue(mockConnector);
    mockSecretsFindFirst.mockResolvedValue({ id: 'existing-secret-id' }); // existing → update

    const fakeJwtPayload = Buffer.from(
      JSON.stringify({ aud: 'https://mcp.example.com' }),
    ).toString('base64url');
    const fakeAt = `h.${fakeJwtPayload}.s`;

    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: fakeAt, token_type: 'bearer' }), {
        status: 200,
      }),
    );

    const req = makeRequest({ code: 'code2', state });
    await GET(req);

    // update should be called, insert should not
    expect(mockUpdateSet).toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('redirects with error on token exchange failure', async () => {
    const state = 'fail-state';
    const stateCookie = await signOAuthState({
      state,
      connectorId: 'conn-uuid-1',
      codeVerifier: 'verifier',
      userId: 'user-1',
    });
    mockCookiesGet.mockReturnValue({ value: stateCookie });
    mockConnectorsFindFirst.mockResolvedValue(mockConnector);

    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('invalid_grant', { status: 400 }),
    );

    const req = makeRequest({ code: 'bad-code', state });
    const res = await GET(req);
    expect(res.headers.get('location')).toContain('error=token_exchange_failed');
  });

  it('redirects with error on audience mismatch', async () => {
    const state = 'aud-state';
    const stateCookie = await signOAuthState({
      state,
      connectorId: 'conn-uuid-1',
      codeVerifier: 'verifier',
      userId: 'user-1',
    });
    mockCookiesGet.mockReturnValue({ value: stateCookie });
    mockConnectorsFindFirst.mockResolvedValue(mockConnector);

    // Token has wrong audience
    const wrongPayload = Buffer.from(
      JSON.stringify({ aud: 'https://wrong.example.com' }),
    ).toString('base64url');
    const badAt = `h.${wrongPayload}.s`;

    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: badAt, token_type: 'bearer' }), {
        status: 200,
      }),
    );

    const req = makeRequest({ code: 'code', state });
    const res = await GET(req);
    expect(res.headers.get('location')).toContain('error=invalid_token_audience');
  });
});
