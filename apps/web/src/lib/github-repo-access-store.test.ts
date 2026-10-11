import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';

// ── DB stub ────────────────────────────────────────────────────────────────
// Only the calls this module makes. Updates record what they set and return
// whatever `nextReturning` holds, so a test can play GitHub redelivering the
// same webhook (second UPDATE finds nothing still `failed`).

const LIVE_INST = {
  id: 'inst-db-1', installationId: 4242, accountLogin: 'acme', accountType: 'Organization', accountId: 9001,
  installedByUserId: null, repositorySelection: 'selected', suspendedAt: null,
  permissions: { pull_requests: 'write', contents: 'write' },
};
const LINKED_WS = {
  id: 'ws-1', teamId: 'team-1', repo: 'https://github.com/acme/web', githubRepoId: 'repo-1',
  githubRepo: { id: 'repo-1', fullName: 'acme/web', defaultBranch: 'main', installation: LIVE_INST },
};

let wsRow: any = LINKED_WS;
let wsList: any[] = [];
let returningQueue: Array<Array<{ id: string }>> = [];
let priorBlocks: Array<{ id: string }> = [];
let distinctWaiting: Array<{ workspaceId: string }> = [];
const updates: Array<Record<string, unknown>> = [];

function chain(result: unknown) {
  const c: any = {
    from: () => c, where: () => c, innerJoin: () => c, leftJoin: () => c,
    limit: () => c,
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej),
  };
  return c;
}

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: {
        findFirst: async () => wsRow,
        findMany: async () => wsList,
      },
      githubRepos: { findMany: async () => [] },
      githubInstallations: {
        findMany: async () => [],
        findFirst: async () => ({ accountLogin: 'Acme' }),
      },
      users: { findFirst: async () => null },
    },
    select: () => chain(priorBlocks),
    selectDistinct: () => chain(distinctWaiting),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        const p: any = Promise.resolve();
        p.returning = async () => returningQueue.shift() ?? [];
        return { where: () => p };
      },
    }),
  },
}));

mock.module('@/lib/github', () => ({
  isGitHubAppConfigured: () => true,
  generateAppJWT: () => 'jwt',
}));
mock.module('@/lib/github-installation-access', () => ({
  getInstallationOwnerTeamIds: async () => ['team-1'],
}));
const mockSync = mock(async (_i: unknown) => ({ synced: 1, linked: 0, linkedWorkspaceIds: [] }));
mock.module('@/lib/github-repo-link', () => ({ syncInstallationRepos: mockSync }));
const mockWakeTasks = mock(async (_ids: string[], _cause: string) => {});
mock.module('@/lib/dispatch-authority', () => ({ wakeTasks: mockWakeTasks }));

const fetchCalls: Array<{ url: string; method: string }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  fetchCalls.push({ url: String(url), method: init?.method ?? 'GET' });
  if (String(url).endsWith('/app')) {
    return new Response(JSON.stringify({ slug: 'buildd-test', html_url: 'https://github.com/apps/buildd-test', permissions: { pull_requests: 'write', contents: 'write' } }));
  }
  return new Response(JSON.stringify({ permissions: LIVE_INST.permissions, repository_selection: 'selected', suspended_at: null, account: { login: 'acme' } }));
}) as typeof fetch;

import {
  __resetAppIdentityCache,
  checkWorkspaceRepoConnection,
  recordRepoAccessBlock,
  resumeAfterInstallationChange,
  resumeRepoAccessBlockedTasks,
} from './github-repo-access-store';

afterAll(() => { globalThis.fetch = originalFetch; });

beforeEach(() => {
  wsRow = LINKED_WS;
  wsList = [];
  returningQueue = [];
  priorBlocks = [];
  distinctWaiting = [];
  updates.length = 0;
  fetchCalls.length = 0;
  mockWakeTasks.mockClear();
  mockSync.mockClear();
  __resetAppIdentityCache();
});

describe('resumeRepoAccessBlockedTasks', () => {
  it('re-queues waiting tasks once access is verified, waking them as a restored credential', async () => {
    returningQueue = [[{ id: 'task-1' }, { id: 'task-2' }]];
    const r = await resumeRepoAccessBlockedTasks('ws-1');
    expect(r.verified).toBe(true);
    expect(r.resumed).toEqual(['task-1', 'task-2']);
    expect(updates.at(-1)?.status).toBe('pending');
    expect(mockWakeTasks).toHaveBeenCalledWith(['task-1', 'task-2'], 'credential.restored');
  });

  it('is idempotent across repeated callbacks: the second finds nothing still failed and wakes nothing', async () => {
    returningQueue = [[{ id: 'task-1' }], []];
    await resumeRepoAccessBlockedTasks('ws-1');
    const second = await resumeRepoAccessBlockedTasks('ws-1');
    expect(second.resumed).toEqual([]);
    expect(mockWakeTasks).toHaveBeenCalledTimes(1);
  });

  it('does not resume while the installation is still suspended', async () => {
    wsRow = { ...LINKED_WS, githubRepo: { ...LINKED_WS.githubRepo, installation: { ...LIVE_INST, suspendedAt: new Date() } } };
    const r = await resumeRepoAccessBlockedTasks('ws-1');
    expect(r.verified).toBe(false);
    expect(!r.diagnosis.ok && r.diagnosis.problem.reason).toBe('installation_suspended');
    expect(updates).toHaveLength(0);
    expect(mockWakeTasks).not.toHaveBeenCalled();
  });

  it('does not resume while the PR permission is still missing', async () => {
    wsRow = { ...LINKED_WS, githubRepo: { ...LINKED_WS.githubRepo, installation: { ...LIVE_INST, permissions: { pull_requests: 'read' } } } };
    const r = await resumeRepoAccessBlockedTasks('ws-1');
    expect(r.verified).toBe(false);
    expect(mockWakeTasks).not.toHaveBeenCalled();
  });

  it('does not resume a workspace with no installation covering its repo', async () => {
    wsRow = { id: 'ws-1', teamId: 'team-1', repo: 'acme/web', githubRepoId: null, githubRepo: null };
    const r = await resumeRepoAccessBlockedTasks('ws-1');
    expect(r.verified).toBe(false);
    expect(!r.diagnosis.ok && r.diagnosis.problem.reason).toBe('installation_missing');
    expect(mockWakeTasks).not.toHaveBeenCalled();
  });
});

describe('resumeAfterInstallationChange', () => {
  it('only resumes workspaces whose repo lives on the changed installation’s account', async () => {
    distinctWaiting = [{ workspaceId: 'ws-1' }, { workspaceId: 'ws-2' }];
    wsList = [
      { id: 'ws-1', repo: null, githubRepo: { fullName: 'acme/web' } },
      { id: 'ws-2', repo: 'other-org/api', githubRepo: null },
    ];
    returningQueue = [[{ id: 'task-1' }]];
    const resumed = await resumeAfterInstallationChange(4242);
    expect(resumed).toEqual(['task-1']);
    // ws-2 was never re-judged, so exactly one guarded UPDATE ran.
    expect(updates.filter(u => u.status === 'pending')).toHaveLength(1);
  });

  it('does nothing when no task is waiting', async () => {
    expect(await resumeAfterInstallationChange(4242)).toEqual([]);
    expect(updates).toHaveLength(0);
  });
});

describe('checkWorkspaceRepoConnection', () => {
  it('re-reads the installation and mirrors repos, then resumes — and never creates a repository', async () => {
    returningQueue = [[{ id: 'task-1' }]];
    const r = await checkWorkspaceRepoConnection('ws-1');
    expect(r.refreshedInstallations).toBe(1);
    expect(mockSync).toHaveBeenCalledWith({ id: 'inst-db-1', installationId: 4242 });
    expect(r.resumed).toEqual(['task-1']);
    // Only reads went to GitHub: no POST /orgs/{org}/repos, no POST /user/repos.
    expect(fetchCalls.every(c => c.method === 'GET')).toBe(true);
    expect(fetchCalls.some(c => /\/repos$/.test(c.url))).toBe(false);
  });
});

describe('recordRepoAccessBlock', () => {
  const problem = { reason: 'repo_not_selected', operation: 'pr.create', repoFullName: 'acme/web', installation: null, missingPermissions: [], repoRow: null } as const;

  it('stamps the task and reports a first refusal as new', async () => {
    const r = await recordRepoAccessBlock({ taskId: 'task-1', workerId: 'w-1', workspaceId: 'ws-1', problem: { ...problem, missingPermissions: [] }, head: 'buildd/abc' });
    expect(r.alreadyReported).toBe(false);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toHaveProperty('context');
  });

  it('reports alreadyReported when the workspace is already waiting on the same fix', async () => {
    priorBlocks = [{ id: 'task-0' }];
    const r = await recordRepoAccessBlock({ taskId: 'task-1', workerId: 'w-1', workspaceId: 'ws-1', problem: { ...problem, missingPermissions: [] } });
    expect(r.alreadyReported).toBe(true);
  });
});
