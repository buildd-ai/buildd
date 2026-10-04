/**
 * DELETE /api/missions/[id]/visual-review/decisions/[reviewId]: the Undo
 * (docs/design/visual-qa-human-review.md, part 1). Runs the real decision lib
 * over a recording fake db. Illustrative ids only.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { fake, fakeDb, renderSql, type FakeCall } from '@/lib/visual-review-decisions.fake-db';
import { buildVisualReviewModel } from '@/lib/visual-review-model';

const mockGetCurrentUser = mock(async () => null as any);
const mockResolveTeamIds = mock(async (..._a: any[]) => [] as string[]);
const mockVerifyWorkspaceAccess = mock(async (..._a: any[]) => ({ teamId: 'team-a', role: 'member' }) as any);
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({
  resolveAccountTeamIds: mockResolveTeamIds,
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: async () => true,
}));
mock.module('@buildd/core/db', () => ({ db: fakeDb }));

const MISSION = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const REVIEW = '55555555-5555-4555-8555-555555555555';

const model = buildVisualReviewModel({ missionId: MISSION, shots: [], tasks: [], now: Date.parse('2026-03-10T11:00:00.000Z') });
mock.module('@/lib/visual-review-load', () => ({ loadVisualReview: async () => model, toHumanShotReview: (r: any) => r }));
// The dispatch authority's full surface: mock.module is process-global.
const mockWakeTask = mock(async (_taskId: string, _cause: string, _opts?: unknown) => {});
mock.module('@/lib/dispatch-authority', () => ({
  announceTaskCreated: async () => {},
  wakeTask: mockWakeTask,
  wakeTasks: mock(async () => {}),
  kickDispatch: () => {},
  enqueueTaskDispatch: async () => {},
  drainDispatchOutbox: async () => ({ claimed: 0, delivered: 0, skipped: 0, failed: 0 }),
  deliverTaskDispatch: async () => 'pusher',
  routeForCause: () => ({ event: 'task.created', legacyDefault: true, githubActions: true, legacyUnfilteredRunnerPreference: false }),
  webhookWants: () => false,
  primaryCause: (_causes: string[], fallback: string) => fallback,
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH: 25,
  reseedDispatchTimer: async () => {},
}));
mock.module('@/lib/mission-surface-audit', () => ({ ensureMissionSurfaceAudit: async () => {}, detachFixFromPendingAudit: async () => ({ action: 'none' }) }));
const mockCancelFx = mock(async (_t: any) => {});
mock.module('@/lib/task-cancel', () => ({ applyTaskCancelSideEffects: mockCancelFx, applyTaskReopenSideEffects: async () => {} }));
mock.module('@/lib/mission-feed', () => ({ postMissionFeedEvent: async () => {} }));
mock.module('@/lib/pusher', () => ({ triggerEvent: async () => {}, channels: { mission: (id: string) => `mission-${id}` }, events: {} }));
mock.module('@/lib/mission-loop', () => ({ reopenCompletedMission: async () => {} }));

const { DELETE } = await import('./route');

const reviewRow = {
  id: REVIEW, missionId: MISSION, workspaceId: WS, artifactId: 'a-m', auditTaskId: 'audit-1', round: 1, cellKey: '/app/x|mobile|', route: '/app/x', viewport: 'mobile',
  agentVerdict: 'ok', decision: 'needs_fix', relation: 'dispute', note: null, fixTaskId: 'fix-h', cancelledFixTaskId: null,
  reviewerUserId: 'user-1', reviewerLabel: 'Reviewer', createdAt: new Date('2026-03-10T11:00:00.000Z'), supersededAt: null,
};

let fixClaimed = false;
function respond(c: FakeCall) {
  if (c.op === 'findFirst' && c.table === 'missions') return { id: MISSION, teamId: 'team-a', workspaceId: WS };
  if (c.op === 'findFirst' && c.table === 'visual_shot_reviews') return reviewRow;
  if (c.op === 'select' && c.table === 'visual_shot_reviews') {
    return renderSql(c.where).sql.includes('"visual_shot_reviews"."created_at" =') ? [reviewRow] : [];
  }
  // The all-or-nothing check undo runs on each fix before any write.
  if (c.op === 'select' && c.table === 'tasks') return [{ id: 'fix-h', status: 'pending', claimedBy: fixClaimed ? 'acct-1' : null, started: false }];
  if (c.op === 'update' && c.table === 'tasks') return fixClaimed ? [] : [{ id: 'fix-h', workspaceId: WS }];
  if (c.op === 'findFirst' && c.table === 'tasks') return { id: 'fix-h', status: 'in_progress' };
  if (c.op === 'update' && c.table === 'visual_shot_reviews') return [{ id: REVIEW }];
  return [];
}

const call = (reviewId = REVIEW, id = MISSION) =>
  DELETE(new NextRequest(`http://localhost/api/missions/${id}/visual-review/decisions/${reviewId}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id, reviewId }),
  });

beforeEach(() => {
  fake.reset(respond);
  fixClaimed = false;
  mockCancelFx.mockClear();
  mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'reviewer@example.com', name: 'Reviewer' });
  mockResolveTeamIds.mockResolvedValue(['team-a']);
  mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-a', role: 'member' });
});

describe('DELETE /api/missions/[id]/visual-review/decisions/[reviewId]', () => {
  it('401s without a session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });

  it('404s non-UUID ids and another team\'s mission', async () => {
    expect((await call('abc')).status).toBe(404);
    expect((await call(REVIEW, 'abc')).status).toBe(404);
    mockResolveTeamIds.mockResolvedValue(['team-b']);
    expect((await call()).status).toBe(404);
    expect(fake.calls.filter(c => c.op === 'update')).toHaveLength(0);
  });

  it('undo reverses the pending fix it filed and supersedes the review', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ superseded: REVIEW, supersededIds: [REVIEW], cancelledFixTaskId: 'fix-h', reopenedFixTaskId: null, cancelledFixTaskIds: ['fix-h'], restoredIds: [] });
    const cancel = fake.calls.find(c => c.op === 'update' && c.table === 'tasks')!;
    expect(cancel.set.status).toBe('cancelled');
    const q = renderSql(cancel.where);
    expect(q.sql).toContain('"tasks"."status" = $');
    expect(q.sql).toContain('"tasks"."claimed_by" is null');
    expect(q.params).toEqual(expect.arrayContaining(['fix-h', MISSION, 'pending']));
    expect(mockCancelFx).toHaveBeenCalledTimes(1);
    // The review lookup is scoped to this mission.
    const lookup = renderSql(fake.calls.find(c => c.op === 'findFirst' && c.table === 'visual_shot_reviews')!.where);
    expect(lookup.params).toEqual(expect.arrayContaining([REVIEW, MISSION]));
  });

  it('409 fix_started once the fix was claimed, and the review stays active', async () => {
    fixClaimed = true;
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'fix_started', fixTaskId: 'fix-h' });
    expect(fake.calls.some(c => c.op === 'update')).toBe(false);
    expect(mockCancelFx).not.toHaveBeenCalled();
  });
});
