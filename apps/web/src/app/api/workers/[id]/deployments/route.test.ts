/**
 * POST /api/workers/[id]/deployments — the Operator's deploy path. The action
 * rules are covered in lib/deployments/action.test.ts; this pins auth,
 * worker ownership and liveness, and that authority comes from the TASK's
 * role in the TASK's workspace (not the caller's key or body), end to end
 * with the credential never in a reply.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { resolveOperatorGrant } from '@/lib/operator-capability';

const WORKER = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'cf_secret_token_value_not_real_00000000000';
const CF_ACCOUNT = 'fedcba9876543210fedcba9876543210';

const SCOPE = { providers: ['cloudflare'], projects: ['model-policy'], environments: ['production'], credentialRefs: ['cloudflare-prod'] };
const BODY = { provider: 'cloudflare', project: 'model-policy', environment: 'production', credentialRef: 'cloudflare-prod', operation: 'status' };

let authed: { id: string; teamId: string; level: string } | null;
let worker: Record<string, unknown> | null;
let task: Record<string, unknown> | null;
let workspace: Record<string, unknown> | null;
/** workspaceId -> the operator's workspace override row in that workspace. */
let grantRows: Record<string, unknown>;
let grantCalls: Array<[string, string]>;
let audits: Array<Record<string, unknown>>;
let credentialReads: number;

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => authed }));
mock.module('@buildd/core/db/schema', () => ({ workers: { id: 'workers.id' }, workspaces: { id: 'workspaces.id' }, tasks: { id: 'tasks.id' } }));
mock.module('drizzle-orm', () => ({ eq: (f: unknown, v: unknown) => ({ f, v }) }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: async () => worker },
      tasks: { findFirst: async () => task },
      workspaces: { findFirst: async () => workspace },
    },
  },
}));
mock.module('@/lib/operator-capability-source', () => ({
  loadOperatorGrant: async (workspaceId: string, roleSlug: string) => {
    grantCalls.push([workspaceId, roleSlug]);
    return resolveOperatorGrant({ roleSlug, workspaceId, workspaceRow: (grantRows[workspaceId] ?? null) as never });
  },
}));
mock.module('@/lib/deployments/store', () => ({
  deploymentStore: {
    recordAudit: async (row: Record<string, unknown>) => { audits.push(row); return `audit-${audits.length}`; },
    settleAudit: async () => {},
    resolveCredential: async () => { credentialReads++; return { apiToken: TOKEN, accountId: CF_ACCOUNT }; },
  },
}));

const realFetch = globalThis.fetch;
const providerCalls: string[] = [];
globalThis.fetch = (async (url: string) => {
  providerCalls.push(String(url));
  return new Response(JSON.stringify({ success: true, result: String(url).endsWith('/deployments') ? { deployments: [] } : [] }));
}) as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; });

import { POST } from './route';

const req = (body: unknown = BODY, apiKey: string | null = 'bld_worker') =>
  new NextRequest(`http://localhost/api/workers/${WORKER}/deployments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(body),
  });
const params = (id = WORKER) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  authed = { id: ACCOUNT, teamId: 'team-1', level: 'worker' };
  worker = { id: WORKER, accountId: ACCOUNT, workspaceId: 'ws-1', taskId: 'task-1', status: 'running' };
  task = { id: 'task-1', workspaceId: 'ws-1', roleSlug: 'operator' };
  workspace = { id: 'ws-1', teamId: 'team-1' };
  grantRows = { 'ws-1': { enabled: true, metadata: { operator: { enabled: true, scope: SCOPE } } } };
  grantCalls = [];
  audits = [];
  credentialReads = 0;
  providerCalls.length = 0;
});

describe('POST /api/workers/[id]/deployments', () => {
  it('401 without a key', async () => {
    authed = null;
    expect((await POST(req(BODY, null), params())).status).toBe(401);
  });

  it('404 for a non-UUID id or another account\'s worker', async () => {
    expect((await POST(req(), params('nope'))).status).toBe(404);
    worker = { ...worker!, accountId: 'someone-else' };
    expect((await POST(req(), params())).status).toBe(404);
    expect(credentialReads).toBe(0);
  });

  it('409 for a worker that is no longer live', async () => {
    worker = { ...worker!, status: 'completed' };
    expect((await POST(req(), params())).status).toBe(409);
    expect(credentialReads).toBe(0);
  });

  it('runs an in-scope operation with a worker-level key and returns no credential', async () => {
    const res = await POST(req(), params());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(CF_ACCOUNT);
    expect(JSON.parse(text)).toMatchObject({ ok: true, auditId: 'audit-1', result: { script: 'model-policy' } });
    expect(audits[0]).toMatchObject({ principal: 'operator', roleSlug: 'operator', taskId: 'task-1', workerId: WORKER, workspaceId: 'ws-1', teamId: 'team-1' });
  });

  it('reads the grant for the task\'s own workspace and role', async () => {
    await POST(req(), params());
    expect(grantCalls).toEqual([['ws-1', 'operator']]);
  });

  it('denies a workspace that has not opted in, even when another workspace has', async () => {
    worker = { ...worker!, workspaceId: 'ws-2' };
    task = { ...task!, workspaceId: 'ws-2' };
    workspace = { id: 'ws-2', teamId: 'team-1' };
    const res = await POST(req(), params());
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe('not_enabled');
    expect(credentialReads).toBe(0);
    expect(providerCalls).toHaveLength(0);
  });

  it('denies a task under any other role, whatever key the caller holds', async () => {
    authed = { ...authed!, level: 'admin' };
    task = { ...task!, roleSlug: 'builder' };
    const res = await POST(req(), params());
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe('role_not_capable');
    expect(credentialReads).toBe(0);
  });

  it('denies a target outside the workspace scope', async () => {
    for (const change of [{ project: 'cloud-runner' }, { environment: 'staging' }, { credentialRef: 'other' }]) {
      const res = await POST(req({ ...BODY, ...change }), params());
      expect(res.status).toBe(403);
    }
    expect(credentialReads).toBe(0);
    expect(providerCalls).toHaveLength(0);
  });

  it('ignores a workspaceId in the body: authority is the task\'s', async () => {
    worker = { ...worker!, workspaceId: 'ws-2' };
    task = { ...task!, workspaceId: 'ws-2' };
    workspace = { id: 'ws-2', teamId: 'team-1' };
    const res = await POST(req({ ...BODY, workspaceId: 'ws-1' }), params());
    expect(res.status).toBe(403);
  });
});
