/**
 * POST /api/specs/[specId]/approve/inbox (Living Spec b7fc9316 R-3, R-4,
 * AC-3): the real dashboardCaller, so a request carrying any Authorization
 * header is refused before the approval is reached, even with a signed-in
 * browser cookie beside it. The approval rules themselves are real-Postgres
 * tested in tests/db/spec-approval-inbox.test.ts.
 */
import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let user: { id: string } | null = { id: 'u1' };
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => user }));
mock.module('@/lib/task-token-auth', () => ({ authenticateTaskScopedCaller: async () => null }));
const seen: unknown[] = [];
mock.module('@/lib/specs/approval', () => ({
  approveFromInbox: async (c: unknown, _id: string, input: Record<string, unknown>) => {
    seen.push([c, input]);
    if (input.expectedVersion !== 3) return { ok: false, status: 409, error: 'stale', code: 'stale', currentVersion: 4 };
    return { ok: true, already: false, spec: { id: 's1', approvedRevision: input.revision }, revision: { revision: input.revision } };
  },
}));
const { POST } = await import('./route');
const params = Promise.resolve({ specId: 's1' });
const PIN = { revision: 2, expectedVersion: 3, contentHash: 'a'.repeat(64) };
const req = (body: unknown, headers: Record<string, string> = {}) => new NextRequest('http://l/api/specs/s1/approve/inbox', { method: 'POST', body: JSON.stringify(body), headers });

describe('POST /api/specs/[specId]/approve/inbox', () => {
  it('approves the pinned revision for a signed-in person and passes the whole pin through', async () => {
    user = { id: 'u1' };
    const res = await POST(req({ ...PIN, overrideReason: 'because it is fine' }), { params });
    expect([res.status, (await res.json()).spec.approvedRevision]).toEqual([200, 2]);
    expect(seen.at(-1)).toEqual([{ kind: 'user', userId: 'u1' }, { ...PIN, overrideReason: 'because it is fine' }]);
  });

  it('AC-3: any bearer (OAuth, API key, task token) is a 403 and the approval is never reached, cookie or not', async () => {
    user = { id: 'u1' };
    const before = seen.length;
    for (const token of ['oauth-session-token', 'bld_xxx', 'bldt_task']) {
      const res = await POST(req(PIN, { authorization: `Bearer ${token}` }), { params });
      expect(res.status).toBe(403);
    }
    expect(seen.length).toBe(before);
  });

  it('no session is a 401; a moved spec is a 409 with code stale', async () => {
    user = null;
    expect((await POST(req(PIN), { params })).status).toBe(401);
    user = { id: 'u1' };
    const res = await POST(req({ ...PIN, expectedVersion: 2 }), { params });
    expect([res.status, (await res.json()).code]).toEqual([409, 'stale']);
  });
});
