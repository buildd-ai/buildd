import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let caller: unknown = { kind: 'user', userId: 'u1' };
const calls: unknown[][] = [];
mock.module('@/lib/task-token-auth', () => ({ authenticateTaskScopedCaller: async () => null }));
mock.module('@/lib/artifact-link-caller', () => ({ bearerOf: () => null, linkCaller: async () => caller }));
let result: Record<string, unknown> = { ok: true, screen: { id: 'c-row' } };
mock.module('@/lib/designs/service', () => ({
  readDesignScreen: async (...a: unknown[]) => { calls.push(a); return result; },
}));
const { GET } = await import('./route');

const ID = '11111111-1111-4111-8111-111111111111';
const get = (screenId: string, qs = '') =>
  GET(new NextRequest(`http://localhost/api/artifacts/designs/${ID}/screens/${screenId}${qs}`), { params: Promise.resolve({ designId: ID, screenId }) });

describe('GET /api/artifacts/designs/[designId]/screens/[screenId]', () => {
  it('needs a caller', async () => {
    caller = null;
    expect((await get('c-row')).status).toBe(401);
    caller = { kind: 'user', userId: 'u1' };
  });

  it('reads one screen at the revision named', async () => {
    const res = await get('c-row', '?revision=2');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ screen: { id: 'c-row' } });
    expect(calls.at(-1)).toEqual([caller, ID, { screenId: 'c-row', revision: 2 }]);
  });

  it('reads the current revision when none is named, and refuses a bad one', async () => {
    await get('c-row');
    expect(calls.at(-1)).toEqual([caller, ID, { screenId: 'c-row' }]);
    const bad = await get('c-row', '?revision=x');
    expect(bad.status).toBe(400);
    expect((await bad.json()).field).toBe('revision');
  });

  it('passes a refusal through with its status and field', async () => {
    result = { ok: false, status: 404, error: 'no screen "x" in revision 2', field: 'screenId' };
    const res = await get('x', '?revision=2');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no screen "x" in revision 2', field: 'screenId' });
  });
});
