/**
 * POST /api/specs/[specId]/approve/confirm: the endpoint a confirm link and
 * Review all's Approve all both use, one signed request per call (Living Spec
 * b7fc9316 R-25, R-26, AC-27). The real dashboardCaller, so any
 * Authorization header is refused before the approval is reached; a stale
 * request names the head the spec is at now. The approval rules themselves are
 * real-Postgres tested in tests/db/spec-approval-confirm.test.ts.
 */
import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let user: { id: string } | null = { id: 'u1' };
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => user }));
mock.module('@/lib/task-token-auth', () => ({ authenticateTaskScopedCaller: async () => null }));
const seen: unknown[] = [];
mock.module('@/lib/specs/approval', () => ({
  confirmSpecApproval: async (c: unknown, _id: string, token: unknown) => {
    seen.push([c, token]);
    if (token === 'stale-request') return { ok: false, status: 409, error: 'The spec changed since this approval was asked for.', code: 'request_stale', currentVersion: 9, headRevision: 6 };
    return { ok: true, already: false, spec: { id: 's1', approvedRevision: 2 }, revision: { revision: 2 }, retirements: [] };
  },
}));
const { POST } = await import('./route');
const params = Promise.resolve({ specId: 's1' });
const req = (body: unknown, headers: Record<string, string> = {}) => new NextRequest('http://l/api/specs/s1/approve/confirm', { method: 'POST', body: JSON.stringify(body), headers });

describe('POST /api/specs/[specId]/approve/confirm', () => {
  it('confirms the one request it carries for a signed-in person', async () => {
    user = { id: 'u1' };
    const res = await POST(req({ request: 'r-1' }), { params });
    expect([res.status, (await res.json()).spec.approvedRevision]).toEqual([200, 2]);
    expect(seen.at(-1)).toEqual([{ kind: 'user', userId: 'u1' }, 'r-1']);
  });

  it('AC-27: any bearer (OAuth, API key, task token) is a 403 and nothing is confirmed, cookie or not', async () => {
    user = { id: 'u1' };
    const before = seen.length;
    for (const token of ['oauth-session-token', 'bld_xxx', 'bldt_task']) {
      const res = await POST(req({ request: 'r-1' }, { authorization: `Bearer ${token}` }), { params });
      expect(res.status).toBe(403);
    }
    expect(seen.length).toBe(before);
  });

  it('a stale request is a 409 that names the head the spec is at now', async () => {
    user = { id: 'u1' };
    const res = await POST(req({ request: 'stale-request' }), { params });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'request_stale', currentVersion: 9, headRevision: 6 });
  });
});
