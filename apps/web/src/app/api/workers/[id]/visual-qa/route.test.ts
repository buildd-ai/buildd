/**
 * POST /api/workers/[id]/visual-qa: dispatches visual-qa.yml from trunk with the
 * worker's branch as capture_ref, for a worker with no authenticated gh.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const WORKER = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';

let authed: { id: string } | null;
let workspace: Record<string, unknown> | null;
let dispatched: Array<{ ref: string; inputs: Record<string, string> }>;
let workflowExists: boolean;

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => authed }));
mock.module('@buildd/core/db/schema', () => ({ workers: { id: 'workers.id' }, workspaces: { id: 'workspaces.id' } }));
mock.module('drizzle-orm', () => ({ eq: (f: unknown, v: unknown) => ({ f, v }) }));
mock.module('@/lib/quality-scout-visual-adapter', () => ({
  VISUAL_QA_WORKFLOW_FILE: 'visual-qa.yml',
  visualQaRunName: (r: string) => `Visual QA · ${r}`,
  githubVisualQaActions: (_i: number, repo: string) => ({
    repoFullName: repo,
    workflowExists: async () => workflowExists,
    harnessRef: async () => 'dev',
    dispatch: async (ref: string, inputs: Record<string, string>) => { dispatched.push({ ref, inputs }); },
    listDispatchRuns: async () => [{
      id: 99, status: 'queued', conclusion: null, headSha: 'x', headBranch: 'dev',
      displayTitle: `Visual QA · ${dispatched.at(-1)?.inputs.capture_ref}`, createdAt: new Date().toISOString(),
    }],
  }),
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: async () => ({ id: WORKER, accountId: ACCOUNT, workspaceId: 'ws-1', branch: 'buildd/abc12345-fix' }) },
      workspaces: { findFirst: async () => workspace },
    },
  },
}));

import { POST } from './route';

const req = (body: unknown = {}) =>
  new NextRequest(`http://localhost/api/workers/${WORKER}/visual-qa`, {
    method: 'POST', headers: { authorization: 'Bearer bld_runner' }, body: JSON.stringify(body),
  });
const params = (id = WORKER) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  authed = { id: ACCOUNT };
  workspace = { id: 'ws-1', githubRepo: { fullName: 'acme/web', installation: { installationId: 42 } } };
  dispatched = [];
  workflowExists = true;
});

describe('POST /api/workers/[id]/visual-qa', () => {
  it('401 without a valid key', async () => {
    authed = null;
    expect((await POST(req(), params())).status).toBe(401);
  });

  it('dispatches from trunk with the worker branch as capture_ref and judge off', async () => {
    const res = await POST(req({ routes: '/app/missions', viewport: 'mobile', theme: 'dark' }), params());
    expect(res.status).toBe(200);
    expect(dispatched).toEqual([{
      ref: 'dev',
      inputs: { capture_ref: 'buildd/abc12345-fix', judge: 'false', routes: '/app/missions', viewport: 'mobile', theme: 'dark' },
    }]);
    const json = await res.json();
    expect(json.runId).toBe(99);
    expect(json.runUrl).toBe('https://github.com/acme/web/actions/runs/99');
  });

  it('rejects an unsafe captureRef or viewport before dispatching', async () => {
    expect((await POST(req({ captureRef: 'a..b' }), params())).status).toBe(400);
    expect((await POST(req({ viewport: 'huge' }), params())).status).toBe(400);
    expect(dispatched).toEqual([]);
  });

  it('409 when the workspace has no installation or no workflow', async () => {
    workspace = { id: 'ws-1', githubRepo: null };
    expect((await POST(req(), params())).status).toBe(409);
    workspace = { id: 'ws-1', githubRepo: { fullName: 'acme/web', installation: { installationId: 42 } } };
    workflowExists = false;
    expect((await POST(req(), params())).status).toBe(409);
  });
});
