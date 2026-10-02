/**
 * POST /api/workers/[id]/cbm-injection — CBM search injection's decision.
 * The decision itself is covered in lib/cbm-injection-decision.test.ts and
 * packages/core/__tests__/cbm-injection-decision.test.ts; this pins auth,
 * ownership, facts validation and that the worker's team scopes the call.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const WORKER = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';

let authed: { id: string } | null;
let worker: { id: string; accountId: string; workspaceId: string } | null;
let workspace: { id: string; teamId: string | null } | null;
let decided: Array<{ scope: unknown; facts: unknown }>;

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => authed }));
mock.module('@buildd/core/db/schema', () => ({ workers: { id: 'workers.id' }, workspaces: { id: 'workspaces.id' } }));
mock.module('drizzle-orm', () => ({ eq: (f: unknown, v: unknown) => ({ f, v }) }));
mock.module('@buildd/core/db', () => ({
  db: { query: { workers: { findFirst: async () => worker }, workspaces: { findFirst: async () => workspace } } },
}));
mock.module('@/lib/cbm-injection-decision', () => ({
  decideCbmInjection: async (scope: unknown, facts: unknown) => {
    decided.push({ scope, facts });
    return { ok: true, action: 'inject_callers', status: 'applied', label: 'inject_callers', confidence: 0.9, latencyMs: 12, version: 'v' };
  },
}));

import { POST } from './route';

const FACTS = {
  trigger: 'grep', taskKind: null, taskCategory: 'feature', missedInManifest: false, missedAlreadyEdited: false,
  hitCount: 2, hitFiles: 1, definitionCount: 1, callerCount: 2, diffSize: 1, definitionMissed: false, symbolKind: 'Method',
};

const req = (body: unknown, apiKey: string | null = 'bld_runner') =>
  new NextRequest(`http://localhost/api/workers/${WORKER}/cbm-injection`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const params = (id = WORKER) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  authed = { id: ACCOUNT };
  worker = { id: WORKER, accountId: ACCOUNT, workspaceId: 'ws-1' };
  workspace = { id: 'ws-1', teamId: 'team-1' };
  decided = [];
});

describe('POST /api/workers/[id]/cbm-injection', () => {
  it('401 without a key', async () => {
    authed = null;
    expect((await POST(req({ facts: FACTS }, null), params())).status).toBe(401);
  });

  it('404 for a non-UUID id or another account\'s worker', async () => {
    expect((await POST(req({ facts: FACTS }), params('nope'))).status).toBe(404);
    worker = { ...worker!, accountId: 'someone-else' };
    expect((await POST(req({ facts: FACTS }), params())).status).toBe(404);
    expect(decided).toEqual([]);
  });

  it('400 on malformed JSON or facts carrying text', async () => {
    expect((await POST(req('{nope'), params())).status).toBe(400);
    expect((await POST(req({ facts: { ...FACTS, symbol: 'parseConfig' } }), params())).status).toBe(400);
    expect((await POST(req({ facts: { ...FACTS, symbolKind: 'rg -n foo' } }), params())).status).toBe(400);
    expect(decided).toEqual([]);
  });

  it('decides on the validated facts, scoped to the worker\'s team and workspace', async () => {
    const res = await POST(req({ facts: FACTS }), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, action: 'inject_callers' });
    expect(decided).toEqual([{ scope: { teamId: 'team-1', workspaceId: 'ws-1', accountId: ACCOUNT }, facts: FACTS }]);
  });
});
