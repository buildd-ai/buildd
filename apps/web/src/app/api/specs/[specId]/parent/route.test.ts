import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let caller: unknown = { kind: 'user', userId: 'u1' };
const calls: unknown[] = [];
mock.module('@/lib/specs/caller', () => ({ specCaller: async () => caller }));
mock.module('@/lib/specs/store', () => ({
  relateSpec: async (_c: unknown, _id: string, input: { parentSpecId: unknown }) => {
    calls.push(input.parentSpecId);
    return input.parentSpecId === 'loop' ? { ok: false, status: 409, error: 'cycle' } : { ok: true, spec: { id: 's1', parentSpecId: input.parentSpecId } };
  },
}));
const { PUT } = await import('./route');
const params = Promise.resolve({ specId: 's1' });
const put = (body: unknown) => PUT(new NextRequest('http://l/api/specs/s1/parent', { method: 'PUT', body: JSON.stringify(body) }), { params });

describe('PUT /api/specs/[specId]/parent', () => {
  it('sets or clears the parent, and passes a cycle refusal through as 409', async () => {
    expect((await (await put({ parentSpecId: 'p1' })).json()).spec.parentSpecId).toBe('p1');
    expect((await (await put({ parentSpecId: null })).json()).spec.parentSpecId).toBe(null);
    expect((await put({ parentSpecId: 'loop' })).status).toBe(409);
  });
  it('requires parentSpecId to be present (null clears), and a caller', async () => {
    const before = calls.length;
    expect((await put({})).status).toBe(400);
    expect(calls.length).toBe(before);
    caller = null;
    expect((await put({ parentSpecId: null })).status).toBe(401);
  });
});
