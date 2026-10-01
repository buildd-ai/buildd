import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockWorkspacesFindFirst = mock(() => null as any);
const mockMissionsFindFirst = mock(() => null as any);
const mockGithubApi = mock((_installationId: number, _path: string) => Promise.resolve(null as any));

// Any write reaching the db fails the test: the route is read-only.
const mockWrite = mock(() => {
  throw new Error('readiness must not write');
});

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ verifyWorkspaceAccess: mockVerifyWorkspaceAccess }));
mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      missions: { findFirst: mockMissionsFindFirst },
    },
    insert: mockWrite,
    update: mockWrite,
    delete: mockWrite,
    execute: mockWrite,
  },
}));
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
}));
mock.module('@buildd/core/db/schema', () => ({
  workspaces: { id: 'id', teamId: 'teamId' },
  missions: { id: 'id', workspaceId: 'workspaceId' },
}));

import { GET } from './route';

const params = Promise.resolve({ id: 'ws-1' });
const get = (headers?: Record<string, string>) =>
  GET(new NextRequest('http://localhost:3000/api/workspaces/ws-1/readiness', { headers: new Headers(headers) }), { params });

const repo = { fullName: 'acme/svc', installation: { installationId: 42 } };
const workspace = (over: Record<string, unknown> = {}) => ({
  id: 'ws-1',
  teamId: 'team-1',
  gitConfig: { defaultBranch: 'main' },
  configStatus: 'unconfigured',
  releaseConfig: null,
  githubRepo: repo,
  ...over,
});

// A Python/uv service with no buildd layout at all.
const PYPROJECT = '[project]\nname = "svc"\n[tool.pytest.ini_options]\n';
const tree = (paths: string[], extra: Record<string, unknown> = {}) => ({
  tree: paths.map((path) => ({ path, type: 'blob', size: 100 })),
  ...extra,
});
const PY_FILES = ['pyproject.toml', 'uv.lock', 'src/svc/__init__.py', 'tests/test_svc.py'];

function githubRoutes(opts: { files?: string[]; truncated?: boolean; treeError?: Error; deploymentsError?: Error } = {}) {
  mockGithubApi.mockImplementation(async (_id: number, path: string) => {
    if (path.includes('/git/trees/')) {
      if (opts.treeError) throw opts.treeError;
      return tree(opts.files ?? PY_FILES, { truncated: opts.truncated ?? false });
    }
    if (path.includes('/contents/pyproject.toml')) {
      return { encoding: 'base64', content: Buffer.from(PYPROJECT).toString('base64') };
    }
    if (path.includes('/deployments')) {
      if (opts.deploymentsError) throw opts.deploymentsError;
      return [];
    }
    if (path.includes('/branches')) return [{ name: 'main' }];
    throw new Error(`unexpected github call: ${path}`);
  });
}

describe('GET /api/workspaces/[id]/readiness', () => {
  beforeEach(() => {
    for (const m of [
      mockGetCurrentUser,
      mockAuthenticateApiKey,
      mockVerifyWorkspaceAccess,
      mockWorkspacesFindFirst,
      mockMissionsFindFirst,
      mockGithubApi,
      mockWrite,
    ]) {
      m.mockReset();
    }
    mockWrite.mockImplementation(() => {
      throw new Error('readiness must not write');
    });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });
    mockWorkspacesFindFirst.mockResolvedValue(workspace());
    mockMissionsFindFirst.mockResolvedValue(null);
    githubRoutes();
  });

  describe('auth', () => {
    it('401 with no session and no API key', async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      const res = await get();
      expect(res.status).toBe(401);
    });

    it('serves a session user with access to the workspace', async () => {
      const res = await get();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skill).toBe('workspace-onboarding');
      expect(Array.isArray(body.items)).toBe(true);
    });

    it('404 for a session user without access (no existence leak)', async () => {
      mockVerifyWorkspaceAccess.mockResolvedValue(null);
      const res = await get();
      expect(res.status).toBe(404);
      expect(mockGithubApi).not.toHaveBeenCalled();
    });

    it('serves an API key of the workspace team', async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', teamId: 'team-1', level: 'worker' });
      const res = await get({ Authorization: 'Bearer bld_test' });
      expect(res.status).toBe(200);
    });

    it('authenticates the API key against this request, so scoped tokens get their route check', async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', teamId: 'team-1', level: 'worker' });
      await get({ Authorization: 'Bearer bld_test' });
      const call = mockAuthenticateApiKey.mock.calls[0] as any[];
      expect(call[0]).toBe('bld_test');
      expect(call[1]?.url).toContain('/api/workspaces/ws-1/readiness');
    });

    it('404 for an API key of another team', async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-2', teamId: 'team-2', level: 'admin' });
      const res = await get({ Authorization: 'Bearer bld_other' });
      expect(res.status).toBe(404);
      expect(mockGithubApi).not.toHaveBeenCalled();
    });

    it('404 for an API key when the workspace does not exist', async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', teamId: 'team-1', level: 'admin' });
      mockWorkspacesFindFirst.mockResolvedValue(null);
      const res = await get({ Authorization: 'Bearer bld_test' });
      expect(res.status).toBe(404);
    });
  });

  describe('no repository', () => {
    it("returns nextStep 'link-repo', calls GitHub never, writes nothing", async () => {
      mockWorkspacesFindFirst.mockResolvedValue(workspace({ githubRepo: null }));
      const res = await get();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.nextStep).toBe('link-repo');
      expect(body.items.every((i: any) => i.status === 'unknown')).toBe(true);
      expect(mockGithubApi).not.toHaveBeenCalled();
      expect(mockWrite).not.toHaveBeenCalled();
    });

    it('treats a repo whose installation is gone the same way', async () => {
      mockWorkspacesFindFirst.mockResolvedValue(workspace({ githubRepo: { fullName: 'acme/svc', installation: null } }));
      const body = await (await get()).json();
      expect(body.nextStep).toBe('link-repo');
      expect(mockGithubApi).not.toHaveBeenCalled();
    });
  });

  describe('report', () => {
    it('derives commands from the repo manifests, not from buildd', async () => {
      const body = await (await get()).json();
      const test = body.items.find((i: any) => i.id === 'test-command');
      expect(test.status).toBe('detected');
      expect(JSON.stringify(test)).not.toMatch(/bun run|apps\/web|docs\/specs/);
      expect(body.truncated).toBe(false);
    });

    it('a truncated tree yields unknown, never missing, and truncated: true', async () => {
      githubRoutes({ files: ['README.md'], truncated: true });
      const body = await (await get()).json();
      expect(body.truncated).toBe(true);
      expect(body.items.filter((i: any) => i.status === 'missing')).toEqual([]);
      const instructions = body.items.find((i: any) => i.id === 'agent-instructions');
      expect(instructions.status).toBe('unknown');
    });

    it('an unreadable manifest degrades to unknown instead of failing the route', async () => {
      mockGithubApi.mockImplementation(async (_id: number, path: string) => {
        if (path.includes('/git/trees/')) return tree(PY_FILES);
        if (path.includes('/contents/')) throw new Error('GitHub API error: 500');
        if (path.includes('/deployments')) return [];
        return [];
      });
      const res = await get();
      expect(res.status).toBe(200);
    });

    it('a workspace with no GitHub deployment access still gets the rest of the report', async () => {
      githubRoutes({ deploymentsError: new Error('GitHub API error: 403') });
      const res = await get();
      expect(res.status).toBe(200);
      const body = await res.json();
      const qa = body.items.find((i: any) => i.id === 'visual-qa-source');
      expect(['detected', 'missing', 'unknown']).toContain(qa.status);
      expect(body.items.find((i: any) => i.id === 'test-command').status).toBe('detected');
    });

    it('an empty repository reports the repo as empty, not an error', async () => {
      mockGithubApi.mockImplementation(async (_id: number, path: string) => {
        if (path.includes('/git/trees/')) throw new Error('GitHub API error: 409 {"message":"Git Repository is empty."}');
        return [];
      });
      const res = await get();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.nextStep).not.toBe('link-repo');
    });

    it('502 when the tree cannot be fetched for another reason', async () => {
      githubRoutes({ treeError: new Error('GitHub API error: 500 boom') });
      const res = await get();
      expect(res.status).toBe(502);
    });

    it("reads the repo's own default branch when gitConfig does not name one", async () => {
      mockWorkspacesFindFirst.mockResolvedValue(
        workspace({ gitConfig: {}, githubRepo: { ...repo, defaultBranch: 'master' } }),
      );
      const res = await get();
      expect(res.status).toBe(200);
      const treeCall = mockGithubApi.mock.calls.find((c) => String(c[1]).includes('/git/trees/'));
      expect(String(treeCall?.[1])).toContain('/git/trees/master?');
    });

    it('applies owner waivers from gitConfig.onboarding', async () => {
      mockWorkspacesFindFirst.mockResolvedValue(
        workspace({ gitConfig: { defaultBranch: 'main', onboarding: { waived: { 'build-command': { reason: 'no build step', at: '2026-01-01T00:00:00Z' } } } } }),
      );
      const body = await (await get()).json();
      expect(body.items.find((i: any) => i.id === 'build-command').waived).toEqual({ reason: 'no build step', at: '2026-01-01T00:00:00Z' });
    });
  });

  describe('bounded IO', () => {
    it('reads at most 12 manifests, each through the contents API, and never a blob over 64 KB', async () => {
      const files = [
        'package.json',
        'Makefile',
        'go.mod',
        'Cargo.toml',
        'pyproject.toml',
        ...Array.from({ length: 20 }, (_, i) => `.github/workflows/ci-${i}.yml`),
        ...Array.from({ length: 20 }, (_, i) => `docs/specs/spec-${i}.md`),
      ];
      const big = 'Cargo.toml';
      const requested: string[] = [];
      mockGithubApi.mockImplementation(async (_id: number, path: string) => {
        if (path.includes('/git/trees/')) {
          return { tree: files.map((p) => ({ path: p, type: 'blob', size: p === big ? 65 * 1024 : 50 })), truncated: false };
        }
        if (path.includes('/contents/')) {
          requested.push(path);
          return { encoding: 'base64', content: Buffer.from('x').toString('base64') };
        }
        return [];
      });
      await get();
      expect(requested.length).toBeLessThanOrEqual(12);
      expect(requested.length).toBeGreaterThan(0);
      expect(requested.some((p) => p.includes('/contents/Cargo.toml'))).toBe(false);
    });
  });

  describe('read-only and idempotent', () => {
    it('two calls return the same report and perform no db writes', async () => {
      const first = await (await get()).json();
      const second = await (await get()).json();
      expect(second).toEqual(first);
      expect(mockWrite).not.toHaveBeenCalled();
    });

    it('does not write on the no-repo path either', async () => {
      mockWorkspacesFindFirst.mockResolvedValue(workspace({ githubRepo: null }));
      const first = await (await get()).json();
      const second = await (await get()).json();
      expect(second).toEqual(first);
      expect(mockWrite).not.toHaveBeenCalled();
    });
  });
});
