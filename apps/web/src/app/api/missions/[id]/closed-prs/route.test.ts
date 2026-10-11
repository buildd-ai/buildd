import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/**
 * POST /api/missions/[id]/closed-prs: the mission card's answer to a PR that
 * closed without merging — confirm the suggested supersession, reject it
 * ("Not this"), or mark the PR abandoned with a reason.
 */

const ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TASK = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SUGGESTION = { repo: 'org/buildd', prNumber: 3366, prUrl: 'https://github.com/org/buildd/pull/3366', signal: 'sibling_task', why: 'w', score: 0.6 };

let missionRow: any = null;
let taskRow: any = null;
let currentUser: any = { id: 'u-1', email: 'owner@example.com' };
let apiAccountRow: any = null;
let teamIds = ['team-1'];

const mockRecord = mock((_p: any) => Promise.resolve({ ok: true, supersedingPrNumber: 3366 } as any));
const mockAbandon = mock((_p: any) => Promise.resolve({ ok: true } as any));
const mockDismiss = mock((_p: any) => Promise.resolve({ ok: true } as any));

mock.module('drizzle-orm', () => ({ eq: (...a: any[]) => ({ _op: 'eq', a }), and: (...a: any[]) => ({ _op: 'and', a }), desc: (a: any) => a }));
mock.module('@buildd/core/db/schema', () => ({ missions: { id: 'id' }, tasks: { id: 'id', missionId: 'missionId' }, workers: { startedAt: 's' } }));
mock.module('@buildd/core/db', () => ({
  db: { query: {
    missions: { findFirst: () => Promise.resolve(missionRow) },
    tasks: { findFirst: () => Promise.resolve(taskRow) },
  } },
}));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: () => Promise.resolve(currentUser) }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: () => Promise.resolve(apiAccountRow) }));
mock.module('@/lib/token-route-policy', () => ({ hasTokenRouteAdminAccess: () => true }));
mock.module('@/lib/team-access', () => ({ resolveAccountTeamIds: () => Promise.resolve(teamIds) }));
mock.module('@/lib/pr-supersession', () => ({
  recordPrSupersession: mockRecord,
  recordPrAbandonment: mockAbandon,
  dismissSupersessionSuggestion: mockDismiss,
}));

const { POST } = await import('./route');
const call = (body: unknown, id = ID) => POST(
  new NextRequest(`http://localhost/api/missions/${id}/closed-prs`, { method: 'POST', body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
);

beforeEach(() => {
  missionRow = { id: ID, teamId: 'team-1' };
  taskRow = {
    id: TASK, missionId: ID,
    workers: [{ id: 'w-6', prUrl: 'https://github.com/org/kb/pull/6', prNumber: 6, supersessionScan: { scannedAt: 'x', candidatesChecked: 1, suggestion: SUGGESTION } }],
  };
  currentUser = { id: 'u-1', email: 'owner@example.com' };
  apiAccountRow = null;
  teamIds = ['team-1'];
  mockRecord.mockClear();
  mockAbandon.mockClear();
  mockDismiss.mockClear();
});

describe('POST /api/missions/[id]/closed-prs', () => {
  it('401s without a session or key', async () => {
    currentUser = null;
    expect((await call({ taskId: TASK, action: 'confirm' })).status).toBe(401);
  });

  it('404s for a mission outside the caller’s teams', async () => {
    teamIds = ['other'];
    expect((await call({ taskId: TASK, action: 'confirm' })).status).toBe(404);
  });

  it('404s for a task that is not in this mission', async () => {
    taskRow = { ...taskRow, missionId: 'other' };
    expect((await call({ taskId: TASK, action: 'confirm' })).status).toBe(404);
  });

  it('confirm records the suggested PR through the verified write, with reason "confirmed by user"', async () => {
    const res = await call({ taskId: TASK, action: 'confirm' });
    expect(res.status).toBe(200);
    expect(mockRecord).toHaveBeenCalledWith({
      workerId: 'w-6', supersedingPrNumber: 3366, supersedingRepo: 'org/buildd', reason: 'confirmed by user', recordedBy: 'owner@example.com',
    });
  });

  it('confirm with no suggestion on the row is a 409, not a guess', async () => {
    taskRow.workers[0].supersessionScan = null;
    expect((await call({ taskId: TASK, action: 'confirm' })).status).toBe(409);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('surfaces the write-time refusal (e.g. target not merged)', async () => {
    mockRecord.mockImplementationOnce(() => Promise.resolve({ ok: false, error: 'not merged', status: 409 }));
    const res = await call({ taskId: TASK, action: 'confirm' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('not merged');
  });

  it('dismiss forgets the suggested candidate', async () => {
    expect((await call({ taskId: TASK, action: 'dismiss' })).status).toBe(200);
    expect(mockDismiss).toHaveBeenCalledWith({ workerId: 'w-6', candidatePrUrl: SUGGESTION.prUrl });
  });

  it('abandon requires a reason', async () => {
    expect((await call({ taskId: TASK, action: 'abandon', reason: ' ' })).status).toBe(400);
    expect(mockAbandon).not.toHaveBeenCalled();
  });

  it('abandon from a dashboard session records the reason and the person who said so', async () => {
    expect((await call({ taskId: TASK, action: 'abandon', reason: 'plan changed' })).status).toBe(200);
    expect(mockAbandon).toHaveBeenCalledWith({ workerId: 'w-6', reason: 'plan changed', recordedBy: 'owner@example.com', actor: 'human:u-1' });
  });

  it('abandon from the person\'s own OAuth session acts as that person', async () => {
    currentUser = null;
    apiAccountRow = { id: 'acct-team', name: 'team account', level: 'admin', sessionUserId: 'u-7' };
    expect((await call({ taskId: TASK, action: 'abandon', reason: 'plan changed' })).status).toBe(200);
    expect(mockAbandon).toHaveBeenCalledWith({ workerId: 'w-6', reason: 'plan changed', recordedBy: 'team account', actor: 'human:u-7' });
  });

  it('abandon from an admin API key is refused: a key is not a person', async () => {
    currentUser = null;
    apiAccountRow = { id: 'acct-svc', name: 'svc key', level: 'admin' };
    const res = await call({ taskId: TASK, action: 'abandon', reason: 'plan changed' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('Only a person');
    expect(mockAbandon).not.toHaveBeenCalled();
  });

  it('abandon from a task-scoped account is refused even if it names a session user', async () => {
    currentUser = null;
    apiAccountRow = { id: 'acct-svc', name: 'svc key', level: 'admin', sessionUserId: 'u-7', taskScope: { taskId: TASK, workspaceId: 'ws' } };
    expect((await call({ taskId: TASK, action: 'abandon', reason: 'plan changed' })).status).toBe(403);
    expect(mockAbandon).not.toHaveBeenCalled();
  });

  it('confirm and dismiss stay open to an admin API key', async () => {
    currentUser = null;
    apiAccountRow = { id: 'acct-svc', name: 'svc key', level: 'admin' };
    expect((await call({ taskId: TASK, action: 'dismiss' })).status).toBe(200);
    expect((await call({ taskId: TASK, action: 'confirm' })).status).toBe(200);
  });

  it('rejects an unknown action', async () => {
    expect((await call({ taskId: TASK, action: 'merge' })).status).toBe(400);
  });
});
