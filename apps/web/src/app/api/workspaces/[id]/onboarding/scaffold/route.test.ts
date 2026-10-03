import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock((..._args: any[]) => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockWorkspacesFindFirst = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockGather = mock((_ws: any) => Promise.resolve(null as any));
const mockResolveCreator = mock((_p: any) =>
  Promise.resolve({ createdByAccountId: 'acct-1', createdByWorkerId: null, creationSource: 'dashboard', parentTaskId: null }),
);
const mockDispatch = mock((_task: any, _ws: any) => Promise.resolve());
let inserted: any[] = [];
const mockInsert = mock((_table: any) => ({
  values: (vals: any) => {
    inserted.push(vals);
    return { returning: () => Promise.resolve([{ id: 'task-onboard', ...vals }]) };
  },
}));
const mockOtherWrite = mock(() => {
  throw new Error('scaffold may only insert the one task');
});

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ verifyWorkspaceAccess: mockVerifyWorkspaceAccess }));
mock.module('@/lib/workspace-readiness-io', () => ({ gatherReadinessInput: mockGather }));
mock.module('@/lib/task-service', () => ({ resolveCreatorContext: mockResolveCreator }));
mock.module('@/lib/task-dispatch', () => ({ dispatchNewTask: mockDispatch }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: { workspaces: { findFirst: mockWorkspacesFindFirst }, tasks: { findFirst: mockTasksFindFirst } },
    insert: mockInsert,
    update: mockOtherWrite,
    delete: mockOtherWrite,
    execute: mockOtherWrite,
  },
}));
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  inArray: (field: any, value: any) => ({ field, value, type: 'inArray' }),
  sql: (strings: any, ...values: any[]) => ({ strings, values, type: 'sql' }),
}));
mock.module('@buildd/core/db/schema', () => ({
  workspaces: { id: 'id', teamId: 'teamId' },
  tasks: { id: 'id', workspaceId: 'workspaceId', status: 'status', context: 'context' },
}));

import { POST } from './route';
import { resolvePolicy } from '@/lib/merge-policy';

const params = Promise.resolve({ id: 'ws-1' });
const post = (body: unknown, headers?: Record<string, string>) =>
  POST(
    new NextRequest('http://localhost:3000/api/workspaces/ws-1/onboarding/scaffold', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json', ...headers }),
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params },
  );

const workspace = (over: Record<string, unknown> = {}) => ({
  id: 'ws-1',
  teamId: 'team-1',
  name: 'Ledger',
  gitConfig: { defaultBranch: 'trunk' },
  configStatus: 'unconfigured',
  releaseConfig: null,
  githubRepo: { fullName: 'acme/ledger', name: 'ledger', private: true, defaultBranch: 'trunk', installation: { installationId: 42 } },
  ...over,
});

// A Python/uv service with no buildd layout, no instructions, no specs.
const readinessInput = (over: Record<string, unknown> = {}) => ({
  files: ['pyproject.toml', 'uv.lock', 'src/ledger/__init__.py', 'tests/test_ledger.py'],
  truncated: false,
  manifests: { 'pyproject.toml': '[project]\nname = "ledger"\n[tool.pytest.ini_options]\n' },
  deployments: [],
  branches: ['trunk'],
  gitConfig: { defaultBranch: 'trunk' },
  configStatus: 'unconfigured',
  releaseConfig: null,
  ...over,
});

describe('POST /api/workspaces/[id]/onboarding/scaffold', () => {
  beforeEach(() => {
    for (const m of [
      mockGetCurrentUser, mockAuthenticateApiKey, mockVerifyWorkspaceAccess, mockWorkspacesFindFirst,
      mockTasksFindFirst, mockGather, mockResolveCreator, mockDispatch, mockInsert, mockOtherWrite,
    ]) m.mockReset();
    inserted = [];
    mockOtherWrite.mockImplementation(() => {
      throw new Error('scaffold may only insert the one task');
    });
    mockInsert.mockImplementation((_table: any) => ({
      values: (vals: any) => {
        inserted.push(vals);
        return { returning: () => Promise.resolve([{ id: 'task-onboard', ...vals }]) };
      },
    }));
    mockResolveCreator.mockResolvedValue({ createdByAccountId: 'acct-1', createdByWorkerId: null, creationSource: 'dashboard', parentTaskId: null });
    mockDispatch.mockResolvedValue(undefined);
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });
    mockWorkspacesFindFirst.mockResolvedValue(workspace());
    mockTasksFindFirst.mockResolvedValue(null);
    mockGather.mockResolvedValue(readinessInput());
  });

  describe('auth', () => {
    it('401 with no session and no API key', async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      expect((await post({ itemIds: ['agent-instructions'] })).status).toBe(401);
    });

    it('404 for a session user without access, with no repo read', async () => {
      mockVerifyWorkspaceAccess.mockResolvedValue(null);
      const res = await post({ itemIds: ['agent-instructions'], confirm: true });
      expect(res.status).toBe(404);
      expect(mockGather).not.toHaveBeenCalled();
      expect(inserted).toEqual([]);
    });

    it('404 for an API key of another team', async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-9', teamId: 'team-other', level: 'admin' });
      mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });
      const res = await post({ itemIds: ['agent-instructions'], confirm: true }, { Authorization: 'Bearer bld_test' });
      expect(res.status).toBe(404);
      expect(inserted).toEqual([]);
    });
  });

  describe('AC-7: nothing is created without naming items and confirming', () => {
    it('no itemIds: a no-op, no repo read, no task', async () => {
      const res = await post({});
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.files).toEqual([]);
      expect(body.task).toBeUndefined();
      expect(mockGather).not.toHaveBeenCalled();
      expect(inserted).toEqual([]);
    });

    it('confirm with no itemIds still creates nothing', async () => {
      const res = await post({ confirm: true, itemIds: [] });
      expect(res.status).toBe(200);
      expect(inserted).toEqual([]);
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it('itemIds alone is a dry run: rendered files and paths, no task', async () => {
      const res = await post({ itemIds: ['agent-instructions', 'env-manifest'] });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.dryRun).toBe(true);
      expect(body.files.map((f: any) => f.path)).toEqual(['CLAUDE.md', '.buildd/env.yaml']);
      expect(body.files[0].content).toContain('`trunk`');
      expect(body.task).toBeUndefined();
      expect(body.prs).toHaveLength(1);
      expect(inserted).toEqual([]);
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it('an explicit dryRun: true wins over confirm: true', async () => {
      const res = await post({ itemIds: ['agent-instructions'], dryRun: true, confirm: true });
      expect(res.status).toBe(200);
      expect((await res.json()).dryRun).toBe(true);
      expect(inserted).toEqual([]);
    });

    it('dryRun: false without confirm is refused, not treated as consent', async () => {
      const res = await post({ itemIds: ['agent-instructions'], dryRun: false });
      expect(res.status).toBe(400);
      expect(inserted).toEqual([]);
    });

    it('skipped items come back with a reason and nothing is made for them', async () => {
      mockGather.mockResolvedValue(readinessInput({ files: ['AGENTS.md', 'pyproject.toml', 'uv.lock'] }));
      const res = await post({ itemIds: ['agent-instructions', 'test-command'] });
      const body = await res.json();
      expect(body.files).toEqual([]);
      expect(body.skipped.map((s: any) => s.itemId)).toEqual(['agent-instructions', 'test-command']);
    });

    it('malformed itemIds are a 400', async () => {
      expect((await post({ itemIds: 'agent-instructions' })).status).toBe(400);
      expect((await post({ itemIds: [1, 2] })).status).toBe(400);
    });
  });

  describe('AC-8: confirm creates exactly one pr_required builder task', () => {
    it('inserts one task, dispatches it, and reports it', async () => {
      const res = await post({ itemIds: ['agent-instructions', 'spec-root', 'env-manifest'], confirm: true });
      expect(res.status).toBe(201);
      const body = await res.json();

      expect(inserted).toHaveLength(1);
      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockDispatch).toHaveBeenCalledTimes(1);
      expect(body.task).toMatchObject({ id: 'task-onboard', baseBranch: 'trunk' });
      expect(body.dryRun).toBe(false);

      const task = inserted[0];
      expect(task).toMatchObject({
        workspaceId: 'ws-1',
        roleSlug: 'builder',
        outputRequirement: 'pr_required',
        status: 'pending',
        createdByAccountId: 'acct-1',
      });
    });

    it('bases the PR on the workspace default branch and carries the onboarding skill', async () => {
      await post({ itemIds: ['agent-instructions'], confirm: true });
      const ctx = inserted[0].context;
      expect(ctx.baseBranch).toBe('trunk');
      expect(ctx.skillSlugs).toEqual(['workspace-onboarding']);
      expect(ctx.onboardingScaffold.itemIds).toEqual(['agent-instructions']);
      expect(ctx.headBranch).toBeUndefined();
    });

    it('hands the agent the rendered files and the verify-not-paste instruction', async () => {
      await post({ itemIds: ['agent-instructions'], confirm: true });
      const text: string = inserted[0].description;
      expect(text).toContain('CLAUDE.md');
      expect(text).toContain('uv run pytest');
      expect(text).toMatch(/verify/i);
      expect(text).toMatch(/do not paste/i);
    });

    it('tags the task human-review so the merge gate never auto-merges it (AC-9 input)', async () => {
      await post({ itemIds: ['agent-instructions'], confirm: true });
      expect(inserted[0].requiresReview).toBe(true);
    });

    it('title states the change and carries no sensitive detail', async () => {
      await post({ itemIds: ['agent-instructions'], confirm: true });
      expect(inserted[0].title).toMatch(/^Onboard repo:/);
    });

    it('a second confirm while one is open returns that task and creates no second', async () => {
      mockTasksFindFirst.mockResolvedValue({ id: 'task-open' });
      const res = await post({ itemIds: ['agent-instructions'], confirm: true });
      expect(res.status).toBe(409);
      expect((await res.json()).taskId).toBe('task-open');
      expect(inserted).toEqual([]);
    });

    it('nothing scaffoldable: no task, with the reasons', async () => {
      mockGather.mockResolvedValue(readinessInput({ files: ['CLAUDE.md', 'pyproject.toml'] }));
      const res = await post({ itemIds: ['agent-instructions'], confirm: true });
      expect(res.status).toBe(409);
      expect((await res.json()).skipped).toHaveLength(1);
      expect(inserted).toEqual([]);
    });

    it('a workspace with no linked repo cannot be scaffolded', async () => {
      mockWorkspacesFindFirst.mockResolvedValue(workspace({ githubRepo: null }));
      const res = await post({ itemIds: ['agent-instructions'], confirm: true });
      expect(res.status).toBe(400);
      expect(inserted).toEqual([]);
    });

    it('a repo the tree cannot be read from is a 502 and creates nothing', async () => {
      mockGather.mockRejectedValue(new Error('GitHub API error: 500'));
      const res = await post({ itemIds: ['agent-instructions'], confirm: true });
      expect(res.status).toBe(502);
      expect(inserted).toEqual([]);
    });

    it('a failed dispatch does not lose the created task', async () => {
      mockDispatch.mockRejectedValue(new Error('pusher down'));
      const res = await post({ itemIds: ['agent-instructions'], confirm: true });
      expect(res.status).toBe(201);
      expect(inserted).toHaveLength(1);
    });
  });

  describe('AC-9: the scaffold PR is never auto-merged, even under the autonomous preset', () => {
    const AUTONOMOUS = {
      preset: 'autonomous',
      riskClasses: [],
    } as any;

    it('the created task resolves to human tier whatever the workspace policy is', async () => {
      await post({ itemIds: ['agent-instructions'], confirm: true });
      const task = inserted[0];
      const policy = resolvePolicy(
        { autoMergePR: true, gitConfig: { policyConfig: AUTONOMOUS, autoMergePR: true } } as any,
        null,
        { requiresReview: task.requiresReview } as any,
        { baseRef: 'trunk' } as any,
      );
      expect(policy.tier).toBe('human');
    });
  });
});
