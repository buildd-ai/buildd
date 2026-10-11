import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let caller: unknown = { kind: 'user', userId: 'u1' };
mock.module('@/lib/specs/caller', () => ({ specCaller: async () => caller }));
mock.module('@/lib/specs/store', () => ({
  getSpec: async (_c: unknown, _id: string, o: { revision?: number }) => ({ ok: true, view: { revision: { revision: o.revision ?? 2 } } }),
  reviseSpecDraft: async () => ({ ok: false, status: 409, error: 'changed', currentVersion: 3 }),
}));
const { GET, PATCH } = await import('./route');
const params = Promise.resolve({ specId: 's1' });

describe('/api/specs/[specId]', () => {
  it('a stale revise answers 409 version_conflict with the current version', async () => {
    const res = await PATCH(new NextRequest('http://l/api/specs/s1', { method: 'PATCH', body: JSON.stringify({ expectedVersion: 1, body: 'x' }) }), { params });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'version_conflict', currentVersion: 3 });
  });
  it('GET passes revision through and refuses a malformed one; no caller is 401', async () => {
    expect((await (await GET(new NextRequest('http://l/api/specs/s1?revision=1'), { params })).json()).revision.revision).toBe(1);
    expect((await GET(new NextRequest('http://l/api/specs/s1?revision=0'), { params })).status).toBe(400);
    caller = null;
    expect((await GET(new NextRequest('http://l/api/specs/s1'), { params })).status).toBe(401);
  });
});
