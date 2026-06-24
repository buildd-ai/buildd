import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(true as any));
const mockWorkspacesFindFirst = mock(() => null as any);
const mockInstallationsFindFirst = mock(() => null as any);
const mockIsGitHubAppConfigured = mock(() => true);
const mockGithubApi = mock((_installationId: number, _path: string, _opts?: any) =>
  Promise.resolve({
    id: 555,
    full_name: 'acme/new-repo',
    name: 'new-repo',
    owner: { login: 'acme' },
    private: true,
    default_branch: 'main',
    html_url: 'https://github.com/acme/new-repo',
    description: null,
  } as any)
);

// db.insert(...).values(...).onConflictDoUpdate(...).returning()
const mockReturning = mock(() => [{ id: 'repo-db-1' }]);
const mockOnConflict = mock(() => ({ returning: mockReturning }));
const mockInsertValues = mock(() => ({ onConflictDoUpdate: mockOnConflict }));
// db.update(...).set(...).where(...)
const mockUpdateWhere = mock(() => Promise.resolve());
const mockUpdateSet = mock(() => ({ where: mockUpdateWhere }));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ verifyWorkspaceAccess: mockVerifyWorkspaceAccess }));
mock.module('@/lib/github', () => ({
  githubApi: mockGithubApi,
  isGitHubAppConfigured: mockIsGitHubAppConfigured,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      githubInstallations: { findFirst: mockInstallationsFindFirst },
    },
    insert: () => ({ values: mockInsertValues }),
    update: () => ({ set: mockUpdateSet }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workspaces: { id: 'id' },
  githubInstallations: { accountLogin: 'accountLogin' },
  githubRepos: { repoId: 'repoId' },
}));

import { POST } from './route';

function postReq(body?: any): NextRequest {
  const init: RequestInit = {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
  };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest('http://localhost:3000/api/workspaces/ws-1/create-repo', init);
}

const params = Promise.resolve({ id: 'ws-1' });

describe('POST /api/workspaces/[id]/create-repo', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockInstallationsFindFirst.mockReset();
    mockIsGitHubAppConfigured.mockReset();
    mockGithubApi.mockReset();
    mockReturning.mockReset();

    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockIsGitHubAppConfigured.mockReturnValue(true);
    mockReturning.mockReturnValue([{ id: 'repo-db-1' }]);
    mockGithubApi.mockResolvedValue({
      id: 555,
      full_name: 'acme/new-repo',
      name: 'new-repo',
      owner: { login: 'acme' },
      private: true,
      default_branch: 'main',
      html_url: 'https://github.com/acme/new-repo',
      description: null,
    });
  });

  afterAll(() => {});

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await POST(postReq({ name: 'new-repo' }), { params });
    expect(res.status).toBe(401);
  });

  it('returns 400 when name is missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await POST(postReq({}), { params });
    expect(res.status).toBe(400);
  });

  it('returns 422 when GitHub App is not configured', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', githubInstallationId: 'inst-1' });
    mockIsGitHubAppConfigured.mockReturnValue(false);
    const res = await POST(postReq({ name: 'new-repo' }), { params });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.hint).toBeDefined();
  });

  it('uses the org endpoint for Organization installations', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-1',
      githubInstallationId: 'inst-1',
      githubInstallation: { id: 'inst-1', installationId: 1234, accountLogin: 'acme', accountType: 'Organization' },
    });
    const res = await POST(postReq({ name: 'new-repo' }), { params });
    expect(res.status).toBe(200);
    expect(mockGithubApi).toHaveBeenCalled();
    expect(mockGithubApi.mock.calls[0][1]).toBe('/orgs/acme/repos');
  });

  it('uses the user endpoint for User (personal) installations', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-1',
      githubInstallationId: 'inst-1',
      githubInstallation: { id: 'inst-1', installationId: 1234, accountLogin: 'maxjacu', accountType: 'User' },
    });
    const res = await POST(postReq({ name: 'new-repo' }), { params });
    expect(res.status).toBe(200);
    expect(mockGithubApi).toHaveBeenCalled();
    expect(mockGithubApi.mock.calls[0][1]).toBe('/user/repos');
  });

  it('returns 422 when workspace has no linked installation and no org match', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', githubInstallationId: null });
    mockInstallationsFindFirst.mockResolvedValue(null);
    const res = await POST(postReq({ name: 'new-repo', org: 'ghost-org' }), { params });
    expect(res.status).toBe(422);
  });
});
