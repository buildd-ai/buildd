import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let caller: unknown = { kind: 'user', userId: 'u1' };
const seen: unknown[] = [];
mock.module('@/lib/specs/caller', () => ({ specCaller: async () => caller }));
mock.module('@/lib/specs/approval', () => ({
  approveSpecRevision: async (c: unknown, _id: string, input: { revision: unknown; expectedVersion: unknown }) => {
    seen.push([c, input]);
    if ((c as { kind: string }).kind === 'account') return { ok: false, status: 403, error: 'a person decides' };
    if (input.expectedVersion !== 3) return { ok: false, status: 409, error: 'stale', currentVersion: 3 };
    return { ok: true, spec: { id: 's1', approvedRevision: input.revision }, revision: { revision: input.revision } };
  },
  submitSpecRevision: async (c: unknown) => ((c as { kind: string }).kind === 'account'
    ? { ok: false, status: 403, error: 'a person decides' }
    : { ok: true, spec: { id: 's1', status: 'in_review' } }),
}));
const { POST: approve } = await import('./route');
const { POST: submit } = await import('../submit/route');
const params = Promise.resolve({ specId: 's1' });
const req = (path: string, body: unknown) => new NextRequest(`http://l/api/specs/s1/${path}`, { method: 'POST', body: JSON.stringify(body) });

describe('POST /api/specs/[specId]/approve and /submit', () => {
  it('approves for a person and passes revision and expectedVersion through', async () => {
    caller = { kind: 'user', userId: 'u1' };
    const res = await approve(req('approve', { revision: 2, expectedVersion: 3 }), { params });
    expect([res.status, (await res.json()).spec.approvedRevision]).toEqual([200, 2]);
    expect((seen.at(-1) as unknown[])[1]).toEqual({ revision: 2, expectedVersion: 3 });
  });
  it('a stale version is a 409 that names the current version', async () => {
    const res = await approve(req('approve', { revision: 2, expectedVersion: 1 }), { params });
    expect([res.status, (await res.json()).currentVersion]).toEqual([409, 3]);
  });
  it('an agent is refused with 403 on both, and no caller is a 401', async () => {
    caller = { kind: 'account', account: { id: 'a1', taskScope: { taskId: 't1', workspaceId: 'w1' } } };
    expect((await approve(req('approve', { revision: 2, expectedVersion: 3 }), { params })).status).toBe(403);
    expect((await submit(req('submit', { expectedVersion: 3 }), { params })).status).toBe(403);
    caller = null;
    expect((await approve(req('approve', {}), { params })).status).toBe(401);
    expect((await submit(req('submit', {}), { params })).status).toBe(401);
  });
  it('submit returns the spec for a person', async () => {
    caller = { kind: 'user', userId: 'u1' };
    const res = await submit(req('submit', { expectedVersion: 3 }), { params });
    expect((await res.json()).spec.status).toBe('in_review');
  });
});
