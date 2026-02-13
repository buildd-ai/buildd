import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockAuth = mock(() => null as any);
const mockIsGitHubAppConfigured = mock(() => false as boolean);
const mockGetGitHubAppConfig = mock(() => ({}) as any);

// Mock @/auth
mock.module('@/auth', () => ({
  auth: mockAuth,
}));

// Mock @/lib/github
mock.module('@/lib/github', () => ({
  isGitHubAppConfigured: mockIsGitHubAppConfigured,
  getGitHubAppConfig: mockGetGitHubAppConfig,
}));

// Import handler AFTER mocks
import { GET } from './route';

function createRequest(searchParams?: Record<string, string>): NextRequest {
  let url = 'http://localhost:3000/api/github/install';
  if (searchParams) {
    const params = new URLSearchParams(searchParams);
    url += `?${params.toString()}`;
  }
  return new NextRequest(url);
}

describe('GET /api/github/install', () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockIsGitHubAppConfigured.mockReset();
    mockGetGitHubAppConfig.mockReset();
  });

  it('redirects to signin when not authenticated', async () => {
    mockAuth.mockResolvedValue(null);

    const response = await GET(createRequest());

    expect(response.status).toBe(307);
    const location = response.headers.get('location');
    expect(location).toContain('/app/auth/signin');
  });

  it('returns 500 when GitHub app not configured', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'user@test.com' } });
    mockIsGitHubAppConfigured.mockReturnValue(false);

    const response = await GET(createRequest());
    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data.error).toContain('GitHub App not configured');
  });

  it('redirects to GitHub install URL with state parameter', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'user@test.com' } });
    mockIsGitHubAppConfigured.mockReturnValue(true);
    mockGetGitHubAppConfig.mockReturnValue({
      installUrl: 'https://github.com/apps/buildd/installations/new',
    });

    const response = await GET(createRequest());

    expect(response.status).toBe(307);
    const location = response.headers.get('location')!;
    expect(location).toContain('https://github.com/apps/buildd/installations/new');
    expect(location).toContain('state=');

    // Decode the state parameter
    const url = new URL(location);
    const state = url.searchParams.get('state')!;
    const decoded = JSON.parse(Buffer.from(state, 'base64url').toString());

    expect(decoded.userId).toBe('user@test.com');
    expect(decoded.returnUrl).toBe('/app/workspaces');
  });

  it('encodes returnUrl in state parameter', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
    mockIsGitHubAppConfigured.mockReturnValue(true);
    mockGetGitHubAppConfig.mockReturnValue({
      installUrl: 'https://github.com/apps/buildd/installations/new',
    });

    const response = await GET(createRequest({ returnUrl: '/app/workspaces/ws-123' }));

    expect(response.status).toBe(307);
    const location = response.headers.get('location')!;
    const url = new URL(location);
    const state = url.searchParams.get('state')!;
    const decoded = JSON.parse(Buffer.from(state, 'base64url').toString());

    expect(decoded.userId).toBe('admin@example.com');
    expect(decoded.returnUrl).toBe('/app/workspaces/ws-123');
  });
});
