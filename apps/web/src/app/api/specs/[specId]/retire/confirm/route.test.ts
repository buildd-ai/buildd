/**
 * POST /api/specs/[specId]/retire/confirm (Living Spec b7fc9316 R-11, R-12):
 * a dashboard session only. The rules are real-Postgres tested in
 * tests/db/spec-approval-inbox.test.ts.
 */
import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let user: { id: string } | null = { id: 'u1' };
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => user }));
mock.module('@/lib/task-token-auth', () => ({ authenticateTaskScopedCaller: async () => null }));
let calls = 0;
mock.module('@/lib/specs/retire', () => ({
  confirmSpecStatusChange: async (_c: unknown, _id: string, token: unknown) => {
    calls++;
    return token === 'tok' ? { ok: true, spec: { id: 's1', status: 'retired' } } : { ok: false, status: 409, error: 'moved', code: 'request_stale', currentVersion: 5 };
  },
}));
const { POST } = await import('./route');
const params = Promise.resolve({ specId: 's1' });
const req = (body: unknown, headers: Record<string, string> = {}) => new NextRequest('http://l/api/specs/s1/retire/confirm', { method: 'POST', body: JSON.stringify(body), headers });

describe('POST /api/specs/[specId]/retire/confirm', () => {
  it('confirms from a signed-in session', async () => {
    const res = await POST(req({ request: 'tok' }), { params });
    expect([res.status, (await res.json()).spec.status]).toEqual([200, 'retired']);
  });
  it('a stale link is a 409 with code request_stale', async () => {
    const res = await POST(req({ request: 'old' }), { params });
    expect([res.status, (await res.json()).code]).toEqual([409, 'request_stale']);
  });
  it('any bearer is a 403 before the request is read; no session is a 401', async () => {
    const before = calls;
    expect((await POST(req({ request: 'tok' }, { authorization: 'Bearer oauth-token' }), { params })).status).toBe(403);
    user = null;
    expect((await POST(req({ request: 'tok' }), { params })).status).toBe(401);
    expect(calls).toBe(before);
  });
});
