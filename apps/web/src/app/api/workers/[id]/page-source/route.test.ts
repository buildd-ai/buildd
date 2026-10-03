/**
 * GET /api/workers/[id]/page-source — the visual auditor asks where its pages
 * come from. Resolution itself is covered in lib/visual-qa-page-source.test.ts;
 * this pins auth, ownership, and that the workspace's repo/installation/config
 * reach the resolver.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const WORKER = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';

let authed: { id: string } | null;
let worker: { id: string; accountId: string; workspaceId: string; taskId?: string | null } | null;
let workspace: Record<string, unknown> | null;
let resolverArgs: Record<string, unknown> | null;
let task: { missionId: string | null } | null;
let mission: { workingBranch: string | null; integrationBranchEnabled: boolean } | null;

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => authed }));
mock.module('@buildd/core/db/schema', () => ({ workers: { id: 'workers.id' }, workspaces: { id: 'workspaces.id' }, tasks: { id: 'tasks.id' }, missions: { id: 'missions.id' } }));
mock.module('drizzle-orm', () => ({ eq: (f: unknown, v: unknown) => ({ f, v }) }));
mock.module('@/lib/github', () => ({ githubApi: async () => ({}) }));
mock.module('@/lib/visual-qa-page-source', () => ({
  resolvePageSource: async (args: Record<string, unknown>) => {
    resolverArgs = args;
    return { pageSource: 'auto', decision: { ok: true, source: 'sandbox', baseUrl: null, reason: 'x' } };
  },
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: async () => worker },
      workspaces: { findFirst: async () => workspace },
      tasks: { findFirst: async () => task },
      missions: { findFirst: async () => mission },
    },
  },
}));

import { GET } from './route';

const req = (qs = '', apiKey: string | null = 'bld_runner') =>
  new NextRequest(`http://localhost/api/workers/${WORKER}/page-source${qs}`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
const params = (id = WORKER) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  authed = { id: ACCOUNT };
  worker = { id: WORKER, accountId: ACCOUNT, workspaceId: 'ws-1' };
  workspace = {
    id: 'ws-1',
    gitConfig: { visualQa: { pageSource: 'auto' } },
    githubRepo: { fullName: 'acme/web', installation: { installationId: 42 } },
  };
  resolverArgs = null;
  task = null;
  mission = null;
});

describe('GET /api/workers/[id]/page-source', () => {
  it('401 without a key', async () => {
    authed = null;
    expect((await GET(req('', null), params())).status).toBe(401);
  });

  it('404 for a non-UUID id or another account\'s worker', async () => {
    expect((await GET(req(), params('nope'))).status).toBe(404);
    worker = { ...worker!, accountId: 'someone-else' };
    expect((await GET(req(), params())).status).toBe(404);
  });

  it('passes the workspace repo, installation and config, plus sha/pr/wait, to the resolver', async () => {
    const res = await GET(req('?sha=abc1234&prNumber=12&waitSeconds=30'), params());
    expect(res.status).toBe(200);
    expect(resolverArgs).toMatchObject({
      repoFullName: 'acme/web',
      gitConfig: { visualQa: { pageSource: 'auto' } },
      sha: 'abc1234',
      prNumber: 12,
      waitSeconds: 30,
    });
    expect(typeof resolverArgs!.get).toBe('function');
  });

  it("passes the worker's mission integration fields and the repo default branch, for the capture ref", async () => {
    worker = { ...worker!, taskId: 'task-1' } as typeof worker;
    task = { missionId: 'mission-1' };
    mission = { workingBranch: 'mission/settings-abcd1234', integrationBranchEnabled: true };
    workspace = { ...workspace!, githubRepo: { fullName: 'acme/web', defaultBranch: 'main', installation: { installationId: 42 } } };
    await GET(req(), params());
    expect(resolverArgs).toMatchObject({ mission, repoDefaultBranch: 'main' });
  });

  it('no mission: the resolver gets mission null (trunk)', async () => {
    await GET(req(), params());
    expect(resolverArgs!.mission).toBeNull();
  });

  it('no installation: the resolver gets no GitHub reader (it reports unreadable)', async () => {
    workspace = { ...workspace!, githubRepo: null };
    await GET(req(), params());
    expect(resolverArgs!.get).toBeNull();
  });

  it('400 for a malformed prNumber', async () => {
    expect((await GET(req('?prNumber=12abc'), params())).status).toBe(400);
  });
});
