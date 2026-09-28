/**
 * POST /api/missions/[id]/visual-review/decisions (docs/design/visual-qa-human-review.md,
 * "Write"). Runs the real decision lib over a recording fake db, so the
 * scoping predicates are rendered through PgDialect. Illustrative ids only.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import type { HumanShotReview, VisualReviewModel } from '@buildd/shared';
import { fake, fakeDb, renderSql, type FakeCall } from '@/lib/visual-review-decisions.fake-db';
import { buildVisualReviewModel, type VisualReviewShotRow, type VisualReviewTaskInput } from '@/lib/visual-review-model';

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

let model: VisualReviewModel;
const mockLoad = mock(async (_m: any) => model);
mock.module('@/lib/visual-review-load', () => ({
  loadVisualReview: mockLoad,
  toHumanShotReview: (r: any) => ({ ...r, createdAt: String(r.createdAt), supersededAt: null }),
}));
const mockDispatch = mock(async (..._a: any[]) => {});
mock.module('@/lib/task-dispatch', () => ({ dispatchNewTask: mockDispatch }));
const mockEnsureAudit = mock(async (_p: any) => {});
mock.module('@/lib/mission-surface-audit', () => ({ ensureMissionSurfaceAudit: mockEnsureAudit, detachFixFromPendingAudit: async () => ({ action: 'none' }) }));
mock.module('@/lib/task-cancel', () => ({ applyTaskCancelSideEffects: async () => {}, applyTaskReopenSideEffects: async () => {} }));
mock.module('@/lib/mission-feed', () => ({ postMissionFeedEvent: async () => {} }));
mock.module('@/lib/pusher', () => ({ triggerEvent: async () => {}, channels: { mission: (id: string) => `mission-${id}` }, events: {} }));
mock.module('@/lib/mission-loop', () => ({ reopenCompletedMission: async () => {} }));

const { POST } = await import('./route');

const MISSION = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const SHOT_M = '33333333-3333-4333-8333-333333333333';
const SHOT_D = '44444444-4444-4444-8444-444444444444';
const AUDIT = 'audit-1';
const AT = '2026-03-10T10:00:00.000Z';

const shot = (id: string, viewport: 'mobile' | 'desktop', verdict: 'ok' | 'issue' | 'unsure'): VisualReviewShotRow => ({
  id, type: 'screenshot', workerId: 'worker-1', taskId: AUDIT, createdAt: AT, title: null,
  metadata: { qa: { runKey: 'r1', route: '/app/tasks/:id', viewport, verdict, finding: 'The tab row overflows' } },
});
const audit: VisualReviewTaskInput = { id: AUDIT, title: '[surface audit] M', status: 'completed', roleSlug: 'visual-auditor', createdAt: AT, workers: [{ id: 'worker-1', status: 'completed' }] };
const build = (verdict: 'ok' | 'issue' | 'unsure', reviews: HumanShotReview[] = []) =>
  buildVisualReviewModel({ missionId: MISSION, shots: [shot(SHOT_M, 'mobile', verdict), shot(SHOT_D, 'desktop', verdict)], tasks: [audit], reviews, now: Date.parse(AT) + 3600_000 });

let inScope: string[] = [];
let missionRow: any = { id: MISSION, teamId: 'team-a', workspaceId: WS };
function respond(c: FakeCall) {
  if (c.op === 'findFirst' && c.table === 'missions') return missionRow;
  if (c.op === 'select' && c.table === 'artifacts') return inScope.map(id => ({ id, workspaceId: WS }));
  if (c.op === 'findFirst' && c.table === 'workspaces') return { id: WS, teamId: 'team-a', name: 'ws' };
  if (c.op === 'findMany' && c.table === 'tasks') return [{ id: 'build-1', title: 'Build', taskClass: 'work', roleSlug: null, pathManifest: ['apps/web/src/app/app/(protected)/tasks/[id]/page.tsx'] }];
  if (c.op === 'insert' && c.table === 'visual_shot_reviews') return c.values.map((v: any, i: number) => ({ id: `rev-${i}`, ...v, createdAt: AT }));
  if (c.op === 'insert' && c.table === 'tasks') return [{ id: 'fix-new', ...c.values }];
  if (c.op === 'update' && c.table === 'visual_shot_reviews' && c.set.supersededAt) return [{ id: 'rev-old' }];
  return [];
}

const call = (body: unknown, id = MISSION, headers: Record<string, string> = {}) =>
  POST(new NextRequest(`http://localhost/api/missions/${id}/visual-review/decisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });

const needsFixBoth = { artifactIds: [SHOT_M, SHOT_D], decision: 'needs_fix', note: 'Tabs overflow on the phone', expected: { [SHOT_M]: 'ok', [SHOT_D]: 'ok' } };

beforeEach(() => {
  fake.reset(respond);
  inScope = [SHOT_M, SHOT_D];
  missionRow = { id: MISSION, teamId: 'team-a', workspaceId: WS };
  model = build('ok');
  for (const m of [mockGetCurrentUser, mockResolveTeamIds, mockVerifyWorkspaceAccess, mockLoad, mockDispatch, mockEnsureAudit]) m.mockClear();
  mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'reviewer@example.com', name: 'Reviewer' });
  mockResolveTeamIds.mockResolvedValue(['team-a']);
  mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-a', role: 'member' });
});

describe('POST /api/missions/[id]/visual-review/decisions: auth', () => {
  it('401s without a session, even with an API key: decisions are a person\'s', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await call(needsFixBoth, MISSION, { authorization: 'Bearer bld_x' });
    expect(res.status).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });

  it('404s a non-UUID mission id without a query', async () => {
    expect((await call(needsFixBoth, 'abc')).status).toBe(404);
    expect(fake.calls).toHaveLength(0);
  });

  it('looks the mission up by id, and 404s another team\'s mission with no write', async () => {
    mockResolveTeamIds.mockResolvedValue(['team-b']);
    expect((await call(needsFixBoth)).status).toBe(404);
    const q = renderSql(fake.calls[0].where);
    expect(q.sql).toBe('"missions"."id" = $1');
    expect(q.params).toEqual([MISSION]);
    expect(fake.calls.filter(c => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
  });

  it('404s a session that cannot reach the mission workspace', async () => {
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    expect((await call(needsFixBoth)).status).toBe(404);
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith('user-1', WS);
    expect(mockLoad).not.toHaveBeenCalled();
  });
});

describe('POST /api/missions/[id]/visual-review/decisions: validation and guards', () => {
  it('400s invalid JSON and a malformed body', async () => {
    expect((await call('{not json')).status).toBe(400);
    const res = await call({ artifactIds: [SHOT_M], decision: 'agree', expected: { [SHOT_M]: 'ok' } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('decision');
  });

  it('422s an artifact that is not an auditor shot of this mission', async () => {
    inScope = [SHOT_M];
    const res = await call(needsFixBoth);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'not_in_mission', artifactIds: [SHOT_D] });
    const scope = fake.calls.find(c => c.op === 'select' && c.table === 'artifacts')!;
    const q = renderSql(scope.where);
    expect(q.sql).toContain('"artifacts"."mission_id" = $');
    expect(q.sql).toContain('"t"."role_slug" = $');
    expect(q.params).toEqual(expect.arrayContaining([MISSION, 'visual-auditor', SHOT_M, SHOT_D]));
    expect(fake.calls.filter(c => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
  });

  it('409s stale when the agent verdict changed, with the cells and the fresh model', async () => {
    model = build('issue');
    const res = await call(needsFixBoth);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'stale', stale: true });
    expect(body.cells.map((c: any) => c.key).sort()).toEqual(['/app/tasks/:id|desktop|', '/app/tasks/:id|mobile|']);
    expect(body.model.missionId).toBe(MISSION);
  });
});

describe('POST /api/missions/[id]/visual-review/decisions: effects', () => {
  it('files exactly one [surface fix] for both viewports, with the server-built title and kind', async () => {
    const res = await call(needsFixBoth);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const inserts = fake.calls.filter(c => c.op === 'insert' && c.table === 'tasks');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toMatchObject({
      title: '[surface fix] /app/tasks/:id: Tabs overflow on the phone',
      kind: 'engineering',
      taskClass: 'work',
      missionId: MISSION,
      workspaceId: WS,
      pathManifest: ['apps/web/src/app/app/(protected)/tasks/[id]/page.tsx'],
    });
    const body = await res.json();
    expect(body.fixTaskId).toBe('fix-new');
    expect(body.reviews).toHaveLength(2);
    expect(body.reviews[0]).toMatchObject({ decision: 'needs_fix', relation: 'dispute', reviewerUserId: 'user-1', reviewerLabel: 'Reviewer' });
    expect(mockEnsureAudit.mock.calls[0][0]).toMatchObject({ origin: 'human' });
  });

  it('supersedes the active review before inserting the new one', async () => {
    const prior: HumanShotReview = {
      id: 'rev-old', artifactId: SHOT_M, auditTaskId: AUDIT, round: 1, cellKey: '/app/tasks/:id|mobile|', route: '/app/tasks/:id', viewport: 'mobile',
      agentVerdict: 'ok', decision: 'looks_right', relation: 'agree', note: null, fixTaskId: null, cancelledFixTaskId: null,
      reviewerUserId: 'user-1', reviewerLabel: 'Reviewer', createdAt: '2026-03-10T10:30:00.000Z', supersededAt: null,
    };
    model = build('ok', [prior]);
    const res = await call({ artifactIds: [SHOT_M], decision: 'looks_right', expected: { [SHOT_M]: 'ok' } });
    expect(res.status).toBe(200);
    const ops = fake.calls.filter(c => c.table === 'visual_shot_reviews').map(c => `${c.op}${c.set?.supersededAt ? ':supersede' : ''}`);
    expect(ops.slice(0, 2)).toEqual(['update:supersede', 'insert']);
    const sup = fake.calls.find(c => c.op === 'update' && c.table === 'visual_shot_reviews')!;
    const q = renderSql(sup.where);
    expect(q.sql).toContain('"visual_shot_reviews"."superseded_at" is null');
    expect(q.params).toEqual(expect.arrayContaining([SHOT_M, 'rev-old']));
  });
});
