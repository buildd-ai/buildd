import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { generateKeyPairSync } from 'crypto';

// Generate a real RSA key for generateAppJWT (it uses Node crypto internally)
const { privateKey: testPrivateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Save and set env vars before any imports
const originalEnv = { ...process.env };
process.env.GITHUB_APP_ID = '12345';
process.env.GITHUB_APP_PRIVATE_KEY = testPrivateKey;

// --- Mock functions ---

const mockAuth = mock(() => null as any);
const mockInstallationsFindFirst = mock(() => null as any);

const mockInsertReturning = mock(() => [{ id: 'inst-db-new' }]);
const mockInsertValues = mock(() => ({
  returning: mockInsertReturning,
}));

const mockUpdateWhere = mock(() => Promise.resolve());
const mockUpdateSet = mock(() => ({
  where: mockUpdateWhere,
}));

// --- Module mocks ---

mock.module('@/auth', () => ({
  auth: mockAuth,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      githubInstallations: { findFirst: mockInstallationsFindFirst },
    },
    insert: () => ({
      values: mockInsertValues,
    }),
    update: () => ({
      set: mockUpdateSet,
    }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  githubInstallations: 'githubInstallations',
}));

// --- Mock global fetch ---

const originalFetch = globalThis.fetch;
const mockFetch = mock(() =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        account: {
          login: 'testorg',
          avatar_url: 'https://example.com/avatar',
          type: 'Organization',
          id: 123,
        },
        permissions: { issues: 'read', contents: 'write' },
        repository_selection: 'all',
        suspended_at: null,
      }),
      { status: 200 }
    )
  )
);

// Import handler AFTER mocks
import { GET } from './route';

// --- Helpers ---

function createRequest(searchParams?: Record<string, string>): NextRequest {
  let url = 'http://localhost:3000/api/github/callback';
  if (searchParams) {
    const params = new URLSearchParams(searchParams);
    url += `?${params.toString()}`;
  }
  return new NextRequest(url);
}

function makeState(data: Record<string, string>): string {
  return Buffer.from(JSON.stringify(data)).toString('base64url');
}

// --- Tests ---

describe('GET /api/github/callback', () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockInstallationsFindFirst.mockReset();
    mockInstallationsFindFirst.mockImplementation(() => null);
    mockInsertReturning.mockReset();
    mockInsertReturning.mockImplementation(() => [{ id: 'inst-db-new' }]);
    mockInsertValues.mockReset();
    mockInsertValues.mockImplementation(() => ({
      returning: mockInsertReturning,
    }));
    mockUpdateSet.mockReset();
    mockUpdateWhere.mockReset();
    mockUpdateWhere.mockImplementation(() => Promise.resolve());
    mockUpdateSet.mockImplementation(() => ({
      where: mockUpdateWhere,
    }));
    mockFetch.mockReset();
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            account: {
              login: 'testorg',
              avatar_url: 'https://example.com/avatar',
              type: 'Organization',
              id: 123,
            },
            permissions: { issues: 'read', contents: 'write' },
            repository_selection: 'all',
            suspended_at: null,
          }),
          { status: 200 }
        )
      )
    );
    globalThis.fetch = mockFetch as any;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    process.env.GITHUB_APP_ID = originalEnv.GITHUB_APP_ID;
    process.env.GITHUB_APP_PRIVATE_KEY = originalEnv.GITHUB_APP_PRIVATE_KEY;
    process.env.GITHUB_APP_PRIVATE_KEY_BASE64 = originalEnv.GITHUB_APP_PRIVATE_KEY_BASE64;
  });

  it('redirects to signin when not authenticated', async () => {
    mockAuth.mockResolvedValue(null);

    const response = await GET(createRequest({ installation_id: '999' }));

    expect(response.status).toBe(307);
    const location = response.headers.get('location');
    expect(location).toContain('/app/auth/signin');
  });

  it('redirects with error when no installation_id param', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'test@test.com' } });

    const response = await GET(createRequest());

    expect(response.status).toBe(307);
    const location = response.headers.get('location')!;
    expect(location).toContain('/app/workspaces');
    expect(location).toContain('error=no_installation_id');
  });

  it('redirects with error when GitHub API fetch fails', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'test@test.com' } });
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response('Unauthorized', { status: 401 })
      )
    );

    const response = await GET(
      createRequest({ installation_id: '55555' })
    );

    expect(response.status).toBe(307);
    const location = response.headers.get('location')!;
    expect(location).toContain('error=fetch_failed');
  });

  it('creates new installation when none exists in DB', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'test@test.com' } });
    mockInstallationsFindFirst.mockImplementation(() => null);

    const response = await GET(
      createRequest({ installation_id: '77777' })
    );

    expect(response.status).toBe(307);
    const location = response.headers.get('location')!;
    expect(location).toContain('github_connected=true');
    expect(location).toContain('org=testorg');

    // Verify insert was called (not update)
    expect(mockInsertValues).toHaveBeenCalled();
  });

  it('updates existing installation when found in DB', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'test@test.com' } });
    mockInstallationsFindFirst.mockImplementation(() => ({
      id: 'inst-db-existing',
      installationId: 88888,
    }));

    const response = await GET(
      createRequest({ installation_id: '88888' })
    );

    expect(response.status).toBe(307);
    const location = response.headers.get('location')!;
    expect(location).toContain('github_connected=true');
    expect(location).toContain('org=testorg');

    // Verify update was called (not insert)
    expect(mockUpdateSet).toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('redirects with db_error when database operation fails', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'test@test.com' } });
    mockInstallationsFindFirst.mockImplementation(() => {
      throw new Error('Connection refused');
    });

    const response = await GET(
      createRequest({ installation_id: '99999' })
    );

    expect(response.status).toBe(307);
    const location = response.headers.get('location')!;
    expect(location).toContain('error=db_error');
  });

  it('uses returnUrl from state parameter on success', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'test@test.com' } });
    mockInstallationsFindFirst.mockImplementation(() => null);

    const state = makeState({
      userId: 'test@test.com',
      returnUrl: '/app/workspaces/ws-custom',
    });

    const response = await GET(
      createRequest({ installation_id: '55555', state })
    );

    expect(response.status).toBe(307);
    const location = response.headers.get('location')!;
    expect(location).toContain('/app/workspaces/ws-custom');
    expect(location).toContain('github_connected=true');
  });

  it('uses returnUrl from state parameter on db_error', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'test@test.com' } });
    mockInstallationsFindFirst.mockImplementation(() => {
      throw new Error('DB error');
    });

    const state = makeState({
      userId: 'test@test.com',
      returnUrl: '/app/workspaces/ws-456',
    });

    const response = await GET(
      createRequest({ installation_id: '55555', state })
    );

    expect(response.status).toBe(307);
    const location = response.headers.get('location')!;
    expect(location).toContain('/app/workspaces/ws-456');
    expect(location).toContain('error=db_error');
  });

});
