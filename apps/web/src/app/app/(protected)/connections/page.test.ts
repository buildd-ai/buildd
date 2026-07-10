import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';

const mockGetCurrentUser = mock(() => null as any);
const mockRedirect = mock((_url: string): never => { throw new Error('NEXT_REDIRECT'); });

// Mock all transitive deps before any import so bun doesn't try to load them
mock.module('@buildd/core/db', () => ({ db: { query: {}, insert: mock(() => ({})), update: mock(() => ({})) } }));
mock.module('@buildd/core/db/schema', () => ({}));
mock.module('@buildd/core/secrets', () => ({}));
mock.module('@buildd/shared', () => ({ isSystemWorkspace: mock(() => false) }));
mock.module('drizzle-orm', () => ({ eq: mock(() => ({})), and: mock(() => ({})), inArray: mock(() => ({})) }));
mock.module('@/auth', () => ({ auth: mock(() => null) }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mock(() => null) }));
mock.module('@/lib/team-access', () => ({
  getUserWorkspaceIds: mock(() => Promise.resolve([])),
  getUserTeamIds: mock(() => Promise.resolve([])),
  getUserTeamsWithDetails: mock(() => Promise.resolve([])),
  verifyWorkspaceAccess: mock(() => null),
  verifyAccountWorkspaceAccess: mock(() => false),
}));
mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
  getUserFromRequest: mock(() => null),
}));
mock.module('next/navigation', () => ({ redirect: mockRedirect }));
mock.module('./ConnectionsClient', () => ({ default: (_props: unknown) => null }));
mock.module('next/headers', () => ({
  cookies: mock(() => Promise.resolve({ get: () => undefined })),
  headers: mock(() => Promise.resolve(new Headers())),
}));
mock.module('next-auth', () => ({
  default: mock(() => ({ handlers: {}, auth: mock(() => null), signIn: mock(() => null), signOut: mock(() => null) })),
}));
mock.module('next-auth/providers/google', () => ({ default: mock(() => ({})) }));
mock.module('next-auth/providers/github', () => ({ default: mock(() => ({})) }));
mock.module('next-auth/providers/credentials', () => ({ default: mock(() => ({})) }));

const originalNodeEnv = process.env.NODE_ENV;

import ConnectionsPage from './page';

describe('ConnectionsPage', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockGetCurrentUser.mockReset();
    mockRedirect.mockReset();
    mockRedirect.mockImplementation((_url: string): never => { throw new Error('NEXT_REDIRECT'); });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('redirects unauthenticated visitors to sign-in', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    let redirected = false;
    try {
      await ConnectionsPage({ searchParams: Promise.resolve({}) });
    } catch (e: any) {
      if (e?.message === 'NEXT_REDIRECT') redirected = true;
    }

    expect(redirected).toBe(true);
    expect(mockRedirect).toHaveBeenCalledWith('/app/auth/signin');
  });

  it('renders for authenticated users without redirecting', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@example.com' });

    let redirected = false;
    let result: unknown = null;
    try {
      result = await ConnectionsPage({ searchParams: Promise.resolve({}) });
    } catch (e: any) {
      if (e?.message === 'NEXT_REDIRECT') redirected = true;
    }

    expect(redirected).toBe(false);
    expect(result).not.toBeNull();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('passes connected param to client component', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@example.com' });
    const result = await ConnectionsPage({ searchParams: Promise.resolve({ connected: 'conn-abc' }) });
    expect(result).not.toBeNull();
  });

  it('passes error param to client component', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@example.com' });
    const result = await ConnectionsPage({ searchParams: Promise.resolve({ error: 'access_denied' }) });
    expect(result).not.toBeNull();
  });
});
