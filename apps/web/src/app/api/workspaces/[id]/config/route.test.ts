import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/**
 * Regression test: OAuth tokens must be authorized on POST /api/workspaces/[id]/config.
 * Prior to the fix, POST only checked getCurrentUser() — OAuth JWTs have no session,
 * so they always got 401. The fix adds authenticateApiKey() dual-auth (same as PATCH
 * /api/workspaces/[id]) so an OAuth token from the owner authorizes.
 */

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockWorkspacesUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(false));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    update: () => mockWorkspacesUpdate(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workspaces: { id: 'id', teamId: 'teamId' },
}));

const originalNodeEnv = process.env.NODE_ENV;

import { resolveBranchStrategy } from '@buildd/core/branch-strategy';
import { GET, POST, PATCH } from './route';

const mockParams = Promise.resolve({ id: 'ws-1' });

describe('GET /api/workspaces/[id]/config', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockWorkspacesFindFirst.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated and no API key', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('allows an API key of the workspace team', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', teamId: 'team-1', level: 'worker' });
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-1',
      teamId: 'team-1',
      gitConfig: { defaultBranch: 'main' },
      configStatus: 'admin_confirmed',
    });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      headers: new Headers({ Authorization: 'Bearer bld_test' }),
    });
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.gitConfig).toBeDefined();
  });

  it('returns 401 for a Bearer token that authenticates no account', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1', gitConfig: {} });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      headers: new Headers({ Authorization: 'Bearer bld_unknown' }),
    });
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('returns 404 for an API key of another team without a link', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-2', teamId: 'team-2', level: 'admin' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1', accessMode: 'open', gitConfig: {} });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      headers: new Headers({ Authorization: 'Bearer bld_other' }),
    });
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(404);
    expect(mockVerifyAccountWorkspaceAccess).toHaveBeenCalledWith('acct-2', 'ws-1');
  });

  it('returns 404 for a session user without access to the workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-2' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1', gitConfig: {} });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('returns config when workspace found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-1',
      gitConfig: {
        defaultBranch: 'main',
        branchingStrategy: 'feature',
      },
      configStatus: 'admin_confirmed',
    });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.gitConfig.defaultBranch).toBe('main');
    expect(data.configStatus).toBe('admin_confirmed');
  });

  it('returns maxConcurrentTasks=3 with source=default when not explicitly set', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-1',
      gitConfig: null,
      configStatus: null,
      releaseConfig: null,
      maxConcurrentTasks: null,
    });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.maxConcurrentTasks).toBe(3);
    expect(data.maxConcurrentTasksSource).toBe('default');
  });

  it('reading a workspace with no branchStrategy resolves to mission-branch (opt-out default)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-1',
      gitConfig: { defaultBranch: 'main' },
      configStatus: 'admin_confirmed',
    });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.gitConfig.branchStrategy).toBeUndefined();
    expect(resolveBranchStrategy(data.gitConfig)).toBe('mission-branch');
  });

  it('returns explicit maxConcurrentTasks with source=explicit when set', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-1',
      gitConfig: null,
      configStatus: null,
      releaseConfig: null,
      maxConcurrentTasks: 5,
    });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.maxConcurrentTasks).toBe(5);
    expect(data.maxConcurrentTasksSource).toBe('explicit');
  });
});

describe('POST /api/workspaces/[id]/config', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesUpdate.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    process.env.NODE_ENV = 'production';

    mockWorkspacesUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ defaultBranch: 'main' }),
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ defaultBranch: 'main' }),
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  // This handler writes `bypassPermissions`, which widens what every agent in
  // the workspace may do without asking. An `accessMode: 'open'` workspace
  // resolves ANY authenticated user to role 'member', so 'member' cannot be
  // enough here — otherwise a passer-by could grant bypass to themselves.
  it('refuses a member — writing bypassPermissions requires admin', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ bypassPermissions: true }),
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(403);
    // A member can see the workspace, so 404 would be a confusing lie.
    expect(await res.json()).toMatchObject({ error: 'Requires workspace admin' });
  });

  it('admits an admin', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'admin' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ defaultBranch: 'main' }),
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
  });

  it('saves git config successfully', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        defaultBranch: 'develop',
        branchingStrategy: 'gitflow',
        requiresPR: true,
        autoCreatePR: true,
      }),
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.gitConfig.defaultBranch).toBe('develop');
    expect(data.gitConfig.branchingStrategy).toBe('gitflow');
    expect(data.gitConfig.requiresPR).toBe(true);
  });

  it('uses defaults for missing fields', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({}),
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.gitConfig.defaultBranch).toBe('main');
    expect(data.gitConfig.branchingStrategy).toBe('feature');
    // Legacy autoMerge* fields are not written by the handler; mergePolicy is the canonical field
    expect(data.gitConfig.autoMergePR).toBeUndefined();
    expect(data.gitConfig.autoMergeOnGreenCI).toBeUndefined();
  });

  it('persists mergePolicy when provided and validates unknown keys', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    // Valid policy accepted
    const validReq = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        mergePolicy: { tier: 'auto-threshold', threshold: { maxLines: 500 } },
      }),
    });
    const validRes = await POST(validReq, { params: mockParams });
    expect(validRes.status).toBe(200);
    const data = await validRes.json();
    expect(data.gitConfig.mergePolicy).toMatchObject({ tier: 'auto-threshold', threshold: { maxLines: 500 } });

    // Unknown key rejected with 422
    const invalidReq = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        mergePolicy: { tier: 'auto-threshold', approvalMode: 'lgtm' },
      }),
    });
    const invalidRes = await POST(invalidReq, { params: mockParams });
    expect(invalidRes.status).toBe(422);
    const errData = await invalidRes.json();
    expect(errData.error).toMatch(/unknown field/i);
  });

  it('persists branchStrategy=direct and round-trips it', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ branchStrategy: 'direct' }),
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.gitConfig.branchStrategy).toBe('direct');
    expect(resolveBranchStrategy(data.gitConfig)).toBe('direct');
  });

  it('rejects an invalid branchStrategy with 400 rather than silently storing it', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ branchStrategy: 'squash-merge' }),
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Invalid branchStrategy/);
  });

  it('allows an OAuth JWT token (owner) to update config', async () => {
    // authenticateApiKey() resolves OAuth JWTs to an account with level='admin'
    mockAuthenticateApiKey.mockImplementation((key: string) => {
      if (key.startsWith('eyJ')) return { id: 'acc-owner', level: 'admin', teamId: 'team-1', authType: 'oauth' };
      return null;
    });
    // workspace team check passes
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1', accessMode: 'restricted' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({
        'content-type': 'application/json',
        authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.fakeJwt',
      }),
      body: JSON.stringify({ releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main' } }),
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('rejects an OAuth JWT when workspace belongs to a different team', async () => {
    mockAuthenticateApiKey.mockImplementation((key: string) => {
      if (key.startsWith('eyJ')) return { id: 'acc-owner', level: 'admin', teamId: 'team-A', authType: 'oauth' };
      return null;
    });
    // workspace owned by team-B
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-B', accessMode: 'restricted' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({
        'content-type': 'application/json',
        authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.fakeJwt',
      }),
      body: JSON.stringify({ releaseConfig: { enabled: true } }),
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(404);
  });

  it('returns 401 when no auth (no session, no token)', async () => {
    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ defaultBranch: 'main' }),
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('accepts trigger field in releaseConfig', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        releaseConfig: {
          enabled: true,
          strategy: 'branch_merge',
          prodBranch: 'main',
          trigger: 'on_mission_complete',
        },
      }),
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.releaseConfig.trigger).toBe('on_mission_complete');
  });

  describe('merges into the existing gitConfig instead of rebuilding it', () => {
    // Captures the object handed to db.update().set() so assertions check what is
    // actually written, not just what the response echoes.
    let setArgs: any[];
    beforeEach(() => {
      setArgs = [];
      mockWorkspacesUpdate.mockReturnValue({
        set: mock((arg: any) => {
          setArgs.push(arg);
          return { where: mock(() => Promise.resolve()) };
        }),
      });
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    });

    const post = (body: Record<string, unknown>) =>
      POST(
        new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
          method: 'POST',
          headers: new Headers({ 'content-type': 'application/json' }),
          body: JSON.stringify(body),
        }),
        { params: mockParams },
      );

    // Shape of the body GitConfigForm sends on a plain save (sandbox enabled).
    const formBody = {
      defaultBranch: 'dev',
      branchingStrategy: 'feature',
      useBuildBranch: false,
      commitStyle: 'conventional',
      requiresPR: true,
      autoCreatePR: true,
      autoMergeOnGreenCI: true,
      useClaudeMd: true,
      bypassPermissions: false,
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        network: { allowedDomains: ['example.com'], allowLocalBinding: false },
        excludedCommands: ['docker'],
      },
      debug: false,
    };

    it('leaves every field the form does not manage untouched', async () => {
      const seeded = {
        defaultBranch: 'main',
        branchingStrategy: 'feature',
        policyConfig: { rules: ['keep-me'] },
        autoMergePR: false,
        autoMergeDenyPaths: ['packages/core/drizzle/'],
        autoMergeMaxLines: 400,
        conflictSurfaces: ['docs/specs/INDEX.md'],
        sequenceNamespaces: [{ dir: 'packages/core/drizzle' }],
        maxCiRetries: 2,
        useWorktreeIsolation: true,
        autoResolveMergeConflicts: false,
        maxBudgetUsd: 5,
        blockConfigChanges: true,
        sandbox: {
          enabled: false,
          credentials: { files: [{ path: '~/.aws/credentials', mode: 'deny' }] },
        },
      };
      mockWorkspacesFindFirst.mockResolvedValue({ gitConfig: seeded });

      const res = await post(formBody);
      expect(res.status).toBe(200);

      const written = setArgs[0].gitConfig;
      for (const key of [
        'policyConfig', 'autoMergePR', 'autoMergeDenyPaths', 'autoMergeMaxLines',
        'conflictSurfaces', 'sequenceNamespaces', 'maxCiRetries', 'useWorktreeIsolation',
        'autoResolveMergeConflicts', 'maxBudgetUsd', 'blockConfigChanges',
      ] as const) {
        expect(written[key]).toEqual((seeded as any)[key]);
      }
      expect(written.sandbox.credentials).toEqual(seeded.sandbox.credentials);
      // Form-managed fields are still applied
      expect(written.defaultBranch).toBe('dev');
      expect(written.sandbox.enabled).toBe(true);
      expect(written.sandbox.excludedCommands).toEqual(['docker']);
    });

    // Hand-written merge-policy paths are refused; the repo scan owns paths.
    it('rejects each removed hand-written path field with a 400 that points to Re-scan repo', async () => {
      mockWorkspacesFindFirst.mockResolvedValue({ gitConfig: {} });
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ autoMergeDenyPaths: ['drizzle/'] }, 'autoMergeDenyPaths'],
        [{ escalateToPaths: ['infra/'] }, 'escalateToPaths'],
        [{ mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'r', escalateToPaths: ['infra/'] } } }, 'mergePolicy.agentReview.escalateToPaths'],
        [{ mergePolicy: { tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: [] } } }, 'mergePolicy.threshold.denyPaths'],
        [{ policyConfig: { preset: 'balanced', riskClasses: [{ name: 'auth_and_secrets', detectedPaths: [], userPaths: ['x'] }] } }, 'policyConfig.riskClasses[0].userPaths'],
      ];
      for (const [extra, field] of cases) {
        const res = await post({ ...formBody, ...extra });
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.field).toBe(field);
        expect(json.error).toContain('Re-scan repo');
      }
      expect(setArgs).toHaveLength(0);
    });

    it('a form save without those fields behaves exactly as before', async () => {
      mockWorkspacesFindFirst.mockResolvedValue({ gitConfig: { autoMergeMaxLines: 400 } });
      const res = await post({ ...formBody, mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'r' } } });
      expect(res.status).toBe(200);
      expect(setArgs[0].gitConfig.mergePolicy).toEqual({ tier: 'agent-review', agentReview: { reviewerRole: 'r' } });
      expect(setArgs[0].gitConfig.autoMergeMaxLines).toBe(400);
    });

    it('keeps sandbox credentials when the form disables the sandbox', async () => {
      const credentials = { environment: [{ name: 'GITHUB_TOKEN', mode: 'mask' }] };
      mockWorkspacesFindFirst.mockResolvedValue({
        gitConfig: { sandbox: { enabled: true, credentials } },
      });

      const { sandbox: _omit, ...withoutSandbox } = formBody;
      const res = await post(withoutSandbox);
      expect(res.status).toBe(200);
      expect(setArgs[0].gitConfig.sandbox.enabled).toBe(false);
      expect(setArgs[0].gitConfig.sandbox.credentials).toEqual(credentials);
    });

    it('persists defaultBackend and autoMergeOnGreenCI', async () => {
      mockWorkspacesFindFirst.mockResolvedValue({ gitConfig: { autoMergeOnGreenCI: true } });

      const res = await post({ ...formBody, defaultBackend: 'codex', autoMergeOnGreenCI: false });
      expect(res.status).toBe(200);
      expect(setArgs[0].gitConfig.defaultBackend).toBe('codex');
      expect(setArgs[0].gitConfig.autoMergeOnGreenCI).toBe(false);
    });

    it('clears defaultBackend when the form sends Default (field omitted)', async () => {
      mockWorkspacesFindFirst.mockResolvedValue({ gitConfig: { defaultBackend: 'codex' } });

      const res = await post(formBody);
      expect(res.status).toBe(200);
      expect(setArgs[0].gitConfig.defaultBackend).toBeUndefined();
    });

    it("treats defaultBackend 'default' and null as clearing", async () => {
      for (const value of ['default', null]) {
        setArgs.length = 0;
        mockWorkspacesFindFirst.mockResolvedValue({ gitConfig: { defaultBackend: 'claude' } });
        const res = await post({ ...formBody, defaultBackend: value });
        expect(res.status).toBe(200);
        expect(setArgs[0].gitConfig.defaultBackend).toBeUndefined();
      }
    });

    it('rejects an unknown defaultBackend with 400 and writes nothing', async () => {
      mockWorkspacesFindFirst.mockResolvedValue({ gitConfig: {} });

      const res = await post({ ...formBody, defaultBackend: 'gpt' });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/Invalid defaultBackend/);
      expect(setArgs).toHaveLength(0);
    });

    it('clears a form-managed optional field when the form omits it', async () => {
      mockWorkspacesFindFirst.mockResolvedValue({
        gitConfig: { fallbackModel: 'claude-sonnet-5', effort: 'high', debug: true, agentInstructions: 'old' },
      });

      const res = await post(formBody);
      expect(res.status).toBe(200);
      const written = setArgs[0].gitConfig;
      expect(written.fallbackModel).toBeUndefined();
      expect(written.effort).toBeUndefined();
      expect(written.debug).toBeUndefined();
      expect(written.agentInstructions).toBeUndefined();
    });

    describe('criteriaGrader', () => {
      it('persists api and runner', async () => {
        for (const value of ['api', 'runner']) {
          setArgs.length = 0;
          mockWorkspacesFindFirst.mockResolvedValue({ gitConfig: {} });
          const res = await post({ ...formBody, criteriaGrader: value });
          expect(res.status).toBe(200);
          expect(setArgs[0].gitConfig.criteriaGrader).toBe(value);
        }
      });

      it("stores 'auto' and null as absent — missing means auto", async () => {
        for (const value of ['auto', null]) {
          setArgs.length = 0;
          mockWorkspacesFindFirst.mockResolvedValue({ gitConfig: { criteriaGrader: 'runner' } });
          const res = await post({ ...formBody, criteriaGrader: value });
          expect(res.status).toBe(200);
          expect(setArgs[0].gitConfig.criteriaGrader).toBeUndefined();
        }
      });

      it('keeps the existing grader when the body omits the field', async () => {
        mockWorkspacesFindFirst.mockResolvedValue({ gitConfig: { criteriaGrader: 'api' } });
        const res = await post(formBody);
        expect(res.status).toBe(200);
        expect(setArgs[0].gitConfig.criteriaGrader).toBe('api');
      });

      it('rejects an unknown grader with 400 and writes nothing', async () => {
        mockWorkspacesFindFirst.mockResolvedValue({ gitConfig: {} });
        const res = await post({ ...formBody, criteriaGrader: 'llm' });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/Invalid criteriaGrader/);
        expect(setArgs).toHaveLength(0);
      });
    });
  });

});

describe('PATCH /api/workspaces/[id]/config', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesUpdate.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    process.env.NODE_ENV = 'production';

    mockWorkspacesUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ releaseConfig: { enabled: true } }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ releaseConfig: { enabled: true } }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(404);
  });

  it('returns 400 when body missing releaseConfig and branchStrategy', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ foo: 'bar' }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(400);
  });

  it('persists branchStrategy=direct via PATCH, preserving other gitConfig fields', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ gitConfig: { defaultBranch: 'dev', branchingStrategy: 'feature' } });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ branchStrategy: 'direct' }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.gitConfig.branchStrategy).toBe('direct');
    expect(data.gitConfig.defaultBranch).toBe('dev');
  });

  it('rejects an invalid branchStrategy via PATCH with 400', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ branchStrategy: 'squash-merge' }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(400);
  });

  it('null branchStrategy via PATCH clears the override', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ gitConfig: { defaultBranch: 'dev', branchStrategy: 'direct' } });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ branchStrategy: null }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.gitConfig.branchStrategy).toBeUndefined();
  });

  it('saves branch_merge releaseConfig with trigger', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        releaseConfig: {
          enabled: true,
          strategy: 'branch_merge',
          prodBranch: 'main',
          trigger: 'on_mission_complete',
        },
      }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.releaseConfig.strategy).toBe('branch_merge');
    expect(data.releaseConfig.trigger).toBe('on_mission_complete');
    expect(data.releaseConfig.prodBranch).toBe('main');
  });

  it('saves workflow_dispatch releaseConfig', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        releaseConfig: {
          enabled: true,
          strategy: 'workflow_dispatch',
          workflowFile: 'release.yml',
          ref: 'dev',
          trigger: 'every_merge',
        },
      }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.releaseConfig.workflowFile).toBe('release.yml');
    expect(data.releaseConfig.ref).toBe('dev');
  });

  it('rejects invalid strategy', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        releaseConfig: { enabled: true, strategy: 'foobar' },
      }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(422);
  });

  it('rejects invalid trigger', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        releaseConfig: { enabled: true, trigger: 'invalid_trigger' },
      }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(422);
  });

  it('strategy=none disables releases', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        releaseConfig: { strategy: 'none' },
      }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.releaseConfig.enabled).toBe(false);
  });

  it('null releaseConfig disables releases', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ releaseConfig: null }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.releaseConfig).toBeNull();
  });

  it('accepts all valid trigger values', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    for (const trigger of ['every_merge', 'on_mission_complete', 'manual', 'scheduled']) {
      const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
        method: 'PATCH',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ releaseConfig: { enabled: true, trigger } }),
      });
      const res = await PATCH(req, { params: mockParams });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.releaseConfig.trigger).toBe(trigger);
    }
  });

  it('OAuth token with matching team can update', async () => {
    mockAuthenticateApiKey.mockImplementation((key: string) => {
      if (key.startsWith('eyJ')) return { id: 'acc-1', level: 'admin', teamId: 'team-1', authType: 'oauth' };
      return null;
    });
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1', accessMode: 'restricted' });

    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
      method: 'PATCH',
      headers: new Headers({
        'content-type': 'application/json',
        authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.fakeJwt',
      }),
      body: JSON.stringify({ releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main' } }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/workspaces/[id]/config — policyConfig (apply proposed policy)', () => {
  let setArgs: any[];
  const policyConfig = {
    preset: 'balanced',
    riskClasses: [{ name: 'destructive_schema_change', detectedPaths: ['db/migrations/'] }],
    reviewerRole: 'reviewer',
  };

  beforeEach(() => {
    setArgs = [];
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockWorkspacesFindFirst.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'admin' });
    mockWorkspacesUpdate.mockReset();
    mockWorkspacesUpdate.mockReturnValue({
      set: mock((arg: any) => {
        setArgs.push(arg);
        return { where: mock(() => Promise.resolve()) };
      }),
    });
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  const patch = (body: unknown, headers: Record<string, string> = {}) =>
    PATCH(
      new NextRequest('http://localhost:3000/api/workspaces/ws-1/config', {
        method: 'PATCH',
        headers: new Headers({ 'content-type': 'application/json', ...headers }),
        body: JSON.stringify(body),
      }),
      { params: mockParams },
    );

  it('writes gitConfig.policyConfig and confirms the config in one update', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ gitConfig: { defaultBranch: 'dev', autoMergeMaxLines: 400 } });

    const res = await patch({ policyConfig });
    expect(res.status).toBe(200);
    expect(setArgs).toHaveLength(1);
    expect(setArgs[0].configStatus).toBe('admin_confirmed');
    expect(setArgs[0].gitConfig.policyConfig).toEqual(policyConfig);
    // merge, not rebuild
    expect(setArgs[0].gitConfig.defaultBranch).toBe('dev');
    expect(setArgs[0].gitConfig.autoMergeMaxLines).toBe(400);
  });

  it('refuses a member with 403 and writes nothing', async () => {
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });
    const res = await patch({ policyConfig });
    expect(res.status).toBe(403);
    expect(setArgs).toHaveLength(0);
  });

  it('refuses a non-admin API key with 403', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'worker', teamId: 'team-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1', accessMode: 'restricted', gitConfig: {} });
    const res = await patch({ policyConfig }, { authorization: 'Bearer bld_worker' });
    expect(res.status).toBe(403);
    expect(setArgs).toHaveLength(0);
  });

  it('admits an admin API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'admin', teamId: 'team-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1', accessMode: 'restricted', gitConfig: {} });
    const res = await patch({ policyConfig }, { authorization: 'Bearer bld_admin' });
    expect(res.status).toBe(200);
    expect(setArgs[0].configStatus).toBe('admin_confirmed');
  });

  it('rejects a hand-written userPaths entry with a 400 that points to Re-scan repo', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ gitConfig: {} });
    const res = await patch({
      policyConfig: { ...policyConfig, riskClasses: [{ name: 'destructive_schema_change', detectedPaths: [], userPaths: ['db/seed.sql'] }] },
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.field).toBe('policyConfig.riskClasses[0].userPaths');
    expect(json.error).toContain('Re-scan repo');
    expect(setArgs).toHaveLength(0);
  });

  it('rejects a malformed policyConfig with 400', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ gitConfig: {} });
    for (const bad of [
      null,
      'balanced',
      { preset: 'reckless', riskClasses: [] },
      { preset: 'balanced' },
      { preset: 'balanced', riskClasses: [{ name: 'not_a_class', detectedPaths: [] }] },
      { preset: 'balanced', riskClasses: [{ name: 'dependency_bump', detectedPaths: 'x' }] },
    ]) {
      const res = await patch({ policyConfig: bad });
      expect(res.status).toBe(400);
    }
    expect(setArgs).toHaveLength(0);
  });
});
