import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let caller: unknown = { kind: 'user', userId: 'u1' };
// The gate and the checks themselves are real-Postgres tested (tests/db/spec-review-speed.test.ts, spec-repo-copy.test.ts); here the route's mapping.
mock.module('@/lib/specs/caller', () => ({ specCaller: async () => caller }));
mock.module('@/lib/specs/page-view', () => ({
  specRepoChecks: async (c: { userId?: string }) => (c.userId === 'approver'
    ? { ok: true, revision: 3, preflight: { state: 'not_generated', message: 'unfiled' } }
    : { ok: false, status: 403, error: 'Only someone who may approve specs here can see the repo checks on a waiting revision.' }),
}));
const { GET } = await import('./route');
const params = Promise.resolve({ specId: 's1' });
const req = () => new NextRequest('http://l/api/specs/s1/preflight');

describe('GET /api/specs/[specId]/preflight', () => {
  it('returns the checks and the revision they are for', async () => {
    caller = { kind: 'user', userId: 'approver' };
    const res = await GET(req(), { params });
    expect([res.status, await res.json()]).toEqual([200, { revision: 3, preflight: { state: 'not_generated', message: 'unfiled' } }]);
  });
  it('passes a refusal through with its status; no caller is a 401', async () => {
    caller = { kind: 'user', userId: 'member' };
    expect((await GET(req(), { params })).status).toBe(403);
    caller = null;
    expect((await GET(req(), { params })).status).toBe(401);
  });
});
