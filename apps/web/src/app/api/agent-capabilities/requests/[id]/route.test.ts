import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── mocks (before importing the route) ────────────────────────────────────────

const mockUser = mock(() => Promise.resolve(null as any));
const mockTeamIds = mock((_u: string) => Promise.resolve([] as string[]));
const mockCan = mock((_c: any, _p: string, _t: string) => Promise.resolve(false));
const mockLoadGrant = mock((_id: string) => Promise.resolve(null as any));
const mockDecide = mock((_r: any, _d: any, _a: any, _o: any) => Promise.resolve(null as any));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockUser }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mockTeamIds }));
mock.module('@/lib/permissions', () => ({ can: mockCan }));
mock.module('@/lib/capability-grants-store', () => ({ loadGrant: mockLoadGrant, decideCapabilityRequest: mockDecide }));

import { POST } from './route';

// ── fixtures (illustrative) ───────────────────────────────────────────────────

const GRANT_ID = '66666666-6666-4666-8666-666666666666';
const TEAM_A = '77777777-7777-4777-8777-777777777777';
const TEAM_B = '88888888-8888-4888-8888-888888888888';
const ROW = { id: GRANT_ID, teamId: TEAM_A, status: 'pending' };

function req(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/agent-capabilities/requests/${GRANT_ID}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}
const ctx = { params: Promise.resolve({ id: GRANT_ID }) };

beforeEach(() => {
  mockUser.mockReset(); mockTeamIds.mockReset(); mockCan.mockReset(); mockLoadGrant.mockReset(); mockDecide.mockReset();
  mockUser.mockResolvedValue({ id: 'user-1' });
  mockTeamIds.mockResolvedValue([TEAM_A]);
  mockCan.mockResolvedValue(true);
  mockLoadGrant.mockResolvedValue(ROW);
  mockDecide.mockResolvedValue({ ok: true, grant: { id: GRANT_ID, status: 'granted' }, alreadyDecided: false });
});

describe('POST /api/agent-capabilities/requests/[id]', () => {
  it('a team admin approves', async () => {
    const res = await POST(req({ decision: 'approve', ttlSeconds: 600 }), ctx);
    expect(res.status).toBe(200);
    expect(mockCan.mock.calls[0]).toEqual([{ kind: 'user', userId: 'user-1' }, 'manage_connectors', TEAM_A]);
    expect(mockDecide.mock.calls[0].slice(1)).toEqual(['approve', { userId: 'user-1' }, { ttlSeconds: 600, reason: null }]);
  });

  it('a member without manage_connectors gets 403 and nothing changes', async () => {
    mockCan.mockResolvedValue(false);
    const res = await POST(req({ decision: 'approve' }), ctx);
    expect(res.status).toBe(403);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('never via an API key, an agent key or an admin key: no self-escalation', async () => {
    for (const key of ['bldt_task_token', 'bld_admin_key']) {
      const res = await POST(req({ decision: 'approve' }, { authorization: `Bearer ${key}` }), ctx);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('session_required');
    }
    expect(mockUser).not.toHaveBeenCalled();
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it("another team's request answers 404, not 403", async () => {
    mockTeamIds.mockResolvedValue([TEAM_B]);
    const res = await POST(req({ decision: 'deny' }), ctx);
    expect(res.status).toBe(404);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('unknown id is 404; bad decision or TTL is 400', async () => {
    mockLoadGrant.mockResolvedValue(null);
    expect((await POST(req({ decision: 'approve' }), ctx)).status).toBe(404);
    mockLoadGrant.mockResolvedValue(ROW);
    expect((await POST(req({ decision: 'escalate' }), ctx)).status).toBe(400);
    expect((await POST(req({ decision: 'approve', ttlSeconds: 5 }), ctx)).status).toBe(400);
  });

  it('passes through idempotent and conflicting outcomes', async () => {
    mockDecide.mockResolvedValue({ ok: true, grant: { id: GRANT_ID, status: 'granted' }, alreadyDecided: true });
    const again = await POST(req({ decision: 'approve' }), ctx);
    expect(again.status).toBe(200);
    expect((await again.json()).alreadyDecided).toBe(true);
    mockDecide.mockResolvedValue({ ok: false, status: 409, code: 'already_granted', error: 'This request is already granted.', grant: { id: GRANT_ID, status: 'granted' } });
    const conflict = await POST(req({ decision: 'deny' }), ctx);
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe('already_granted');
  });

  it('401 without a session', async () => {
    mockUser.mockResolvedValue(null);
    expect((await POST(req({ decision: 'approve' }), ctx)).status).toBe(401);
  });
});
