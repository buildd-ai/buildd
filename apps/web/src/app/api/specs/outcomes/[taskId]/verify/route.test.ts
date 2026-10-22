import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TASK = '00000000-0000-4000-8000-000000000061';
const ART = '00000000-0000-4000-8000-000000000062';
const REVIEWER = '00000000-0000-4000-8000-000000000063';
const SHA = 'a'.repeat(40);
let caller: any;
let workspace: string | null;
let readable: boolean;
let writable: boolean;
let head: string | null;
let requesterRefusal: string | null;
const calls: unknown[] = [];
const dispatch = mock(async (input: unknown, deps: unknown) => { calls.push(['dispatch', input, deps]); return { results: [], coverage: [], refused: [] }; });
mock.module('@/lib/specs/caller', () => ({ specCaller: async () => caller }));
mock.module('@/lib/specs/outcome', () => ({ governedTaskWorkspace: async () => workspace }));
mock.module('@/lib/specs/store', () => ({ reach: async (_caller: unknown, ws: string, write: boolean) => {
  calls.push(['reach', ws, write]); return write ? writable : readable;
} }));
const STORE = { name: 'production store' };
mock.module('@/modules', () => ({ REGISTERED_VERIFICATION: {
  deps: async () => STORE,
  head: async (taskId: string) => { calls.push(['head', taskId]); return head; },
  requesterRefusal: async (requester: string, subject: string) => { calls.push(['requester', requester, subject]); return requesterRefusal; },
} }));
mock.module('@/lib/specs/registered-verification', () => ({ dispatchRegisteredVerification: dispatch }));
const { POST } = await import('./route');
const post = (body: unknown, taskId = TASK) => POST(new NextRequest(`http://l/api/specs/outcomes/${taskId}/verify`, {
  method: 'POST', body: JSON.stringify(body),
}), { params: Promise.resolve({ taskId }) });

describe('POST /api/specs/outcomes/[taskId]/verify', () => {
  beforeEach(() => {
    caller = { kind: 'user', userId: 'u1' }; workspace = 'ws-a'; readable = true; writable = true; head = SHA; requesterRefusal = null;
    calls.length = 0; dispatch.mockClear();
  });

  it('AC-4: asks the shared coordinator to verify the server-observed head, with an optional artifact reference', async () => {
    const response = await post({ evidenceRef: ART });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ verification: { results: [], coverage: [], refused: [] } });
    expect(calls).toEqual([['reach', 'ws-a', false], ['reach', 'ws-a', true], ['head', TASK],
      ['dispatch', { taskId: TASK, headSha: SHA, evidenceRef: ART }, STORE]]);
  });

  it('R-18: a reviewer\'s task token may request it; the subject\'s own token, or a task filed under it, may not', async () => {
    caller = { kind: 'account', account: { id: 'a1', taskScope: { taskId: REVIEWER, workspaceId: 'ws-a' } } };
    expect((await post({})).status).toBe(200);
    expect(calls).toContainEqual(['requester', REVIEWER, TASK]);
    expect(dispatch).toHaveBeenCalledWith({ taskId: TASK, headSha: SHA }, STORE);

    dispatch.mockClear(); calls.length = 0;
    requesterRefusal = 'a task never requests grading of its own outcome';
    caller = { kind: 'account', account: { id: 'a1', taskScope: { taskId: TASK, workspaceId: 'ws-a' } } };
    const own = await post({});
    expect(own.status).toBe(403);
    expect((await own.json()).error).toContain('own outcome');
    expect(dispatch).not.toHaveBeenCalled();
    expect(calls.some((c) => Array.isArray(c) && c[0] === 'head')).toBe(false);
  });

  it('confines a task token to its own workspace before any verification or head lookup', async () => {
    caller = { kind: 'account', account: { id: 'a1', taskScope: { taskId: REVIEWER, workspaceId: 'ws-b' } } };
    expect((await post({})).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('AC-4: requires authentication, read reach and write reach', async () => {
    caller = null;
    expect((await post({})).status).toBe(401);
    caller = { kind: 'user', userId: 'u1' }; workspace = null;
    expect((await post({})).status).toBe(404);
    workspace = 'ws-a'; readable = false;
    expect((await post({})).status).toBe(404);
    readable = true; writable = false;
    expect((await post({})).status).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();
    expect(calls.some((c) => Array.isArray(c) && c[0] === 'head')).toBe(false);
  });

  it('AC-4: refuses raw evidence, caller-chosen methods, prompts, verdicts and heads, and malformed artifact ids', async () => {
    for (const body of [null, [], 'text', { evidence: { text: 'looks good' } }, { method: 'fake' }, { prompt: 'approve' },
      { verdict: 'pass' }, { headSha: SHA }, { evidenceRef: '' }, { evidenceRef: ART, extra: true }, { evidenceRef: { id: ART } }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('AC-4: leaves an unknown head unverified instead of accepting a caller assertion', async () => {
    head = null;
    const response = await post({});
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('head');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
