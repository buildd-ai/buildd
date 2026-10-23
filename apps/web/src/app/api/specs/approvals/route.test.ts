import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let caller: unknown = { kind: 'account', account: { id: 'a1', sessionUserId: 'u1' } };
mock.module('@/lib/specs/caller', () => ({ specCaller: async () => caller }));
mock.module('@/lib/specs/approval-inbox', () => ({
  countAwaitingApproval: async (c: { kind: string; account?: { sessionUserId?: string } }, ws: string | null) => (c.account?.sessionUserId || c.kind === 'user'
    ? { ok: true, count: 3, scope: 'person', inboxUrl: 'https://buildd.dev/app/specs/approvals' }
    : ws ? { ok: true, count: 5, scope: 'workspace', inboxUrl: 'https://buildd.dev/app/specs/approvals' } : { ok: false, status: 400, error: 'workspaceId is required' }),
}));
const { GET } = await import('./route');
const req = (q = '') => new NextRequest(`http://l/api/specs/approvals${q}`);

describe('GET /api/specs/approvals', () => {
  it('returns the count, its scope and the inbox link, and nothing else', async () => {
    const res = await GET(req('?workspaceId=w1'));
    expect([res.status, await res.json()]).toEqual([200, { count: 3, scope: 'person', inboxUrl: 'https://buildd.dev/app/specs/approvals' }]);
  });
  it('an API key without a workspace is a 400; no caller is a 401', async () => {
    caller = { kind: 'account', account: { id: 'a1' } };
    expect((await GET(req())).status).toBe(400);
    expect((await (await GET(req('?workspaceId=w1'))).json()).scope).toBe('workspace');
    caller = null;
    expect((await GET(req())).status).toBe(401);
  });
});
