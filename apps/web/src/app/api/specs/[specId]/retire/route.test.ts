import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let caller: unknown = { kind: 'user', userId: 'u1' };
const seen: unknown[] = [];
// The person-only rule itself is real-Postgres tested (tests/db/spec-retire.test.ts); here the route's mapping.
const isPerson = (c: unknown) => {
  const x = c as { kind: string; account?: { sessionUserId?: string; taskScope?: unknown } };
  return x.kind === 'user' || (!!x.account?.sessionUserId && !x.account.taskScope);
};
mock.module('@/lib/specs/caller', () => ({ specCaller: async () => caller }));
mock.module('@/lib/specs/retire', () => ({
  retireSpec: async (c: unknown, _id: string, input: { reason: unknown; supersededBy?: unknown }) => {
    seen.push(input);
    if (!isPerson(c)) return { ok: false, status: 403, error: 'a person retires' };
    if (typeof input.reason !== 'string' || input.reason.length < 10) return { ok: false, status: 400, error: 'reason is required' };
    return { ok: true, spec: { id: 's1', status: input.supersededBy ? 'superseded' : 'retired' } };
  },
  restoreSpec: async (c: unknown) => (isPerson(c) ? { ok: true, spec: { id: 's1', status: 'approved' } } : { ok: false, status: 403, error: 'a person restores' }),
}));
const { POST, DELETE } = await import('./route');
const params = Promise.resolve({ specId: 's1' });
const req = (method: string, body: unknown) => new NextRequest('http://l/api/specs/s1/retire', { method, body: JSON.stringify(body) });

describe('POST|DELETE /api/specs/[specId]/retire', () => {
  it('retires for a person and passes reason and supersededBy through', async () => {
    caller = { kind: 'user', userId: 'u1' };
    const res = await POST(req('POST', { reason: 'a duplicate import', supersededBy: 's2' }), { params });
    expect([res.status, (await res.json()).spec.status]).toEqual([200, 'superseded']);
    expect(seen.at(-1)).toEqual({ reason: 'a duplicate import', supersededBy: 's2' });
  });
  it('a person\'s own OAuth session retires too', async () => {
    caller = { kind: 'account', account: { id: 'a1', sessionUserId: 'u1' } };
    expect((await POST(req('POST', { reason: 'a duplicate import' }), { params })).status).toBe(200);
  });
  it('an agent run or API key is a 403 on both; no caller is a 401', async () => {
    for (const c of [{ kind: 'account', account: { id: 'a1', taskScope: { taskId: 't1', workspaceId: 'w1' } } }, { kind: 'account', account: { id: 'a1' } }]) {
      caller = c;
      expect((await POST(req('POST', { reason: 'a duplicate import' }), { params })).status).toBe(403);
      expect((await DELETE(req('DELETE', {}), { params })).status).toBe(403);
    }
    caller = null;
    expect((await POST(req('POST', {}), { params })).status).toBe(401);
    expect((await DELETE(req('DELETE', {}), { params })).status).toBe(401);
  });
  it('a missing reason is a 400 with the error', async () => {
    caller = { kind: 'user', userId: 'u1' };
    const res = await POST(req('POST', {}), { params });
    expect([res.status, (await res.json()).error]).toEqual([400, 'reason is required']);
  });
  it('restore returns the spec at its prior status', async () => {
    caller = { kind: 'user', userId: 'u1' };
    const res = await DELETE(req('DELETE', {}), { params });
    expect([res.status, (await res.json()).spec.status]).toEqual([200, 'approved']);
  });
});
