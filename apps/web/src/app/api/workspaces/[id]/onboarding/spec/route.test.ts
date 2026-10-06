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
const mockAnnounce = mock((_task: any, _ws: any) => Promise.resolve());
let inserted: any[] = [];
const mockInsert = mock((_table: any) => ({
  values: (vals: any) => {
    inserted.push(vals);
    return { returning: () => Promise.resolve([{ id: 'task-spec', ...vals }]) };
  },
}));
const mockOtherWrite = mock(() => {
  throw new Error('author_spec may only insert the one task');
});

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ verifyWorkspaceAccess: mockVerifyWorkspaceAccess }));
mock.module('@/lib/workspace-readiness-io', () => ({ gatherReadinessInput: mockGather }));
mock.module('@/lib/task-service', () => ({ resolveCreatorContext: mockResolveCreator }));
// The dispatch authority's full surface: mock.module is process-global.
const mockWakeTask = mock(async (_taskId: string, _cause: string, _opts?: unknown) => {});
mock.module('@/lib/dispatch-authority', () => ({
  announceTaskCreated: mockAnnounce,
  wakeTask: mockWakeTask,
  wakeTasks: mock(async () => {}),
  kickDispatch: () => {},
  enqueueTaskDispatch: async () => {},
  drainDispatchOutbox: async () => ({ claimed: 0, delivered: 0, skipped: 0, failed: 0 }),
  deliverTaskDispatch: async () => 'pusher',
  routeForCause: () => ({ event: 'task.created', legacyDefault: true, legacyUnfilteredRunnerPreference: false }),
  webhookWants: () => false,
  primaryCause: (_causes: string[], fallback: string) => fallback,
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH: 25,
  reseedDispatchTimer: async () => {},
}));
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

const params = Promise.resolve({ id: 'ws-1' });
const post = (body: unknown, headers?: Record<string, string>) =>
  POST(
    new NextRequest('http://localhost:3000/api/workspaces/ws-1/onboarding/spec', {
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

// A Python/uv service with no buildd layout and no specs.
const readinessInput = (over: Record<string, unknown> = {}) => ({
  files: ['pyproject.toml', 'src/ledger/posting.py', 'tests/test_posting.py'],
  truncated: false,
  manifests: {},
  deployments: [],
  branches: ['trunk'],
  gitConfig: { defaultBranch: 'trunk' },
  configStatus: 'unconfigured',
  releaseConfig: null,
  ...over,
});

const answers = (over: Record<string, unknown> = {}) => ({
  title: 'Ledger',
  description: 'Ledger records double-entry postings for small finance teams.',
  capabilities: [
    {
      name: 'post a balanced entry',
      invariants: ['the sum of debits equals the sum of credits for every stored entry'],
      accepted: { given: 'a balanced entry', when: 'it is posted', then: 'it is stored and returned with an id' },
      rejected: { given: 'an unbalanced entry', when: 'it is posted', then: 'it is rejected with HTTP 422' },
      codePaths: ['src/ledger/posting.py', 'src/ledger/missing.py'],
    },
  ],
  outOfScope: ['Currency conversion'],
  verification: ['tests/test_posting.py'],
  protectedAreas: ['src/ledger/posting.py', 'the audit log format'],
  ...over,
});

describe('POST /api/workspaces/[id]/onboarding/spec', () => {
  beforeEach(() => {
    for (const m of [
      mockGetCurrentUser, mockAuthenticateApiKey, mockVerifyWorkspaceAccess, mockWorkspacesFindFirst,
      mockTasksFindFirst, mockGather, mockResolveCreator, mockAnnounce, mockInsert, mockOtherWrite,
    ]) m.mockReset();
    inserted = [];
    mockOtherWrite.mockImplementation(() => {
      throw new Error('author_spec may only insert the one task');
    });
    mockInsert.mockImplementation((_table: any) => ({
      values: (vals: any) => {
        inserted.push(vals);
        return { returning: () => Promise.resolve([{ id: 'task-spec', ...vals }]) };
      },
    }));
    mockResolveCreator.mockResolvedValue({ createdByAccountId: 'acct-1', createdByWorkerId: null, creationSource: 'dashboard', parentTaskId: null });
    mockAnnounce.mockResolvedValue(undefined);
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
      expect((await post({ answers: answers() })).status).toBe(401);
    });

    it('404 for a session user without access, with no repo read', async () => {
      mockVerifyWorkspaceAccess.mockResolvedValue(null);
      const res = await post({ answers: answers(), confirm: true });
      expect(res.status).toBe(404);
      expect(mockGather).not.toHaveBeenCalled();
      expect(inserted).toEqual([]);
    });

    it('404 for an API key of another team', async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-9', teamId: 'team-other', level: 'admin' });
      mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });
      const res = await post({ answers: answers(), confirm: true }, { Authorization: 'Bearer bld_test' });
      expect(res.status).toBe(404);
      expect(inserted).toEqual([]);
    });

    it('an API key of the same team is accepted', async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', teamId: 'team-1', level: 'admin' });
      mockWorkspacesFindFirst.mockResolvedValueOnce({ teamId: 'team-1' }).mockResolvedValue(workspace());
      const res = await post({ answers: answers() }, { Authorization: 'Bearer bld_test' });
      expect(res.status).toBe(200);
    });
  });

  describe('input', () => {
    it('invalid JSON is a 400', async () => {
      expect((await post('{nope')).status).toBe(400);
    });

    it('missing answers is a 400 with no repo read', async () => {
      const res = await post({});
      expect(res.status).toBe(400);
      expect(mockGather).not.toHaveBeenCalled();
    });

    it('vague or incomplete answers come back as issues to re-ask, nothing created', async () => {
      const bad = answers();
      (bad.capabilities[0] as any).invariants = ['it works properly'];
      const res = await post({ answers: bad, confirm: true });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.issues.map((i: any) => i.path)).toContain('capabilities[0].invariants[0]');
      expect(mockGather).not.toHaveBeenCalled();
      expect(inserted).toEqual([]);
    });

    it('an owner that is not a GitHub handle is a 400', async () => {
      expect((await post({ answers: answers(), owner: '@bad handle' })).status).toBe(400);
    });

    it('a non-boolean dryRun is a 400', async () => {
      expect((await post({ answers: answers(), dryRun: 'yes' })).status).toBe(400);
    });

    it('a workspace with no linked repo cannot author a spec', async () => {
      mockWorkspacesFindFirst.mockResolvedValue(workspace({ githubRepo: null }));
      const res = await post({ answers: answers(), confirm: true });
      expect(res.status).toBe(400);
      expect(inserted).toEqual([]);
    });
  });

  describe('dryRun is the default and creates nothing', () => {
    it('answers alone return the rendered markdown and the target path', async () => {
      const res = await post({ answers: answers() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.dryRun).toBe(true);
      expect(body.path).toBe('docs/specs/ledger.md');
      expect(body.markdown).toContain('status: draft');
      expect(body.markdown).toContain('owner: acme');
      expect(body.task).toBeUndefined();
      expect(inserted).toEqual([]);
      expect(mockAnnounce).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
    });

    it('an explicit dryRun: true wins over confirm: true', async () => {
      const res = await post({ answers: answers(), dryRun: true, confirm: true });
      expect(res.status).toBe(200);
      expect((await res.json()).dryRun).toBe(true);
      expect(inserted).toEqual([]);
    });

    it('dryRun: false without confirm is refused, not treated as consent', async () => {
      const res = await post({ answers: answers(), dryRun: false });
      expect(res.status).toBe(400);
      expect(inserted).toEqual([]);
    });

    it('reports what was left out and hands Q8 back without putting it in the file', async () => {
      const body = await (await post({ answers: answers() })).json();
      expect(body.dropped.codePaths).toEqual(['src/ledger/missing.py']);
      expect(body.mergePolicy).toEqual({ paths: ['src/ledger/posting.py'], notes: ['the audit log format'] });
      expect(body.markdown).not.toContain('audit log format');
    });

    it('an owner in the body wins over the repo owner', async () => {
      const body = await (await post({ answers: answers(), owner: 'octocat' })).json();
      expect(body.markdown).toContain('owner: octocat');
    });
  });

  describe('the file is flat under the detected spec root', () => {
    it('uses the detected root, mirroring an existing spec there', async () => {
      mockGather.mockResolvedValue(
        readinessInput({
          files: ['pyproject.toml', 'src/ledger/posting.py', 'docs/specs/auth.md', 'docs/specs/SPEC-FORMAT.md'],
          manifests: {
            'docs/specs/auth.md': '---\ntitle: Auth\nstatus: active\nowner: x\nsummary: Auth MUST work.\ndomain: auth\n---\n# Auth\n\n## Log in\n\n### Invariants\n\n- a\n\n### Acceptance criteria\n\n- AC-1: WHEN a THEN b\n',
          },
        }),
      );
      const body = await (await post({ answers: answers() })).json();
      expect(body.path).toBe('docs/specs/ledger.md');
      expect(body.format).toBe('mirrored');
      expect(body.markdown).toContain('### Acceptance criteria');
    });

    it('honours a configured specsRoot over detection', async () => {
      mockWorkspacesFindFirst.mockResolvedValue(
        workspace({ gitConfig: { defaultBranch: 'trunk', specConformance: { specsRoot: 'contracts/' } } }),
      );
      const body = await (await post({ answers: answers() })).json();
      expect(body.path).toBe('contracts/ledger.md');
    });

    it('a spec already at the target path is a 409 and no task', async () => {
      mockGather.mockResolvedValue(readinessInput({ files: ['docs/specs/ledger.md', 'src/ledger/posting.py'] }));
      const res = await post({ answers: answers(), confirm: true });
      expect(res.status).toBe(409);
      expect(inserted).toEqual([]);
    });
  });

  describe('confirm creates exactly one pr_required builder task', () => {
    it('inserts one task, dispatches it, and reports it', async () => {
      const res = await post({ answers: answers(), confirm: true });
      expect(res.status).toBe(201);
      const body = await res.json();

      expect(inserted).toHaveLength(1);
      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockAnnounce).toHaveBeenCalledTimes(1);
      expect(mockWakeTask).toHaveBeenCalledWith((mockAnnounce.mock.calls[0] as any[])[0].id, 'task.created');
      expect(body.task).toMatchObject({ id: 'task-spec', baseBranch: 'trunk' });
      expect(body.dryRun).toBe(false);
      expect(body.markdown).toContain('status: draft');

      expect(inserted[0]).toMatchObject({
        workspaceId: 'ws-1',
        roleSlug: 'builder',
        outputRequirement: 'pr_required',
        status: 'pending',
        createdByAccountId: 'acct-1',
      });
    });

    it('is tagged human-review and bases the PR on the default branch, never headed at it', async () => {
      await post({ answers: answers(), confirm: true });
      expect(inserted[0].requiresReview).toBe(true);
      expect(inserted[0].context.baseBranch).toBe('trunk');
      expect(inserted[0].context.headBranch).toBeUndefined();
      expect(inserted[0].context.onboardingSpec).toEqual({ path: 'docs/specs/ledger.md', slug: 'ledger' });
    });

    it('hands the agent the exact file and the one-file rule', async () => {
      await post({ answers: answers(), confirm: true });
      const text: string = inserted[0].description;
      expect(text).toContain('`docs/specs/ledger.md`');
      expect(text).toContain('exactly one file');
      expect(text).toContain('status: draft');
      expect(text).toContain('Never commit or push to the default branch `trunk`');
    });

    it('title states the change', async () => {
      await post({ answers: answers(), confirm: true });
      expect(inserted[0].title).toBe('Spec: add draft spec docs/specs/ledger.md');
    });

    it('does not put Q8 in the task either', async () => {
      await post({ answers: answers(), confirm: true });
      expect(inserted[0].description).not.toContain('audit log format');
    });

    it('a second confirm for the same path while one is open returns that task', async () => {
      mockTasksFindFirst.mockResolvedValue({ id: 'task-open' });
      const res = await post({ answers: answers(), confirm: true });
      expect(res.status).toBe(409);
      expect((await res.json()).taskId).toBe('task-open');
      expect(inserted).toEqual([]);
    });

    it('a repo the tree cannot be read from is a 502 and creates nothing', async () => {
      mockGather.mockRejectedValue(new Error('GitHub API error: 500'));
      const res = await post({ answers: answers(), confirm: true });
      expect(res.status).toBe(502);
      expect(inserted).toEqual([]);
    });

    it('a failed dispatch does not lose the created task', async () => {
      mockAnnounce.mockRejectedValue(new Error('pusher down'));
      const res = await post({ answers: answers(), confirm: true });
      expect(res.status).toBe(201);
      expect(inserted).toHaveLength(1);
    });
  });
});
