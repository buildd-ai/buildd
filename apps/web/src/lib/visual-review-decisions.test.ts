/**
 * Human decisions in the visual review (docs/design/visual-qa-human-review.md,
 * part 1 and "Write"). The effect table is pure; applyDecision runs against a
 * recording fake db, and every predicate that scopes a write is rendered
 * through PgDialect, because a mocked db hides WHERE clauses. Illustrative ids.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { fake, fakeDb, renderSql, type FakeCall } from './visual-review-decisions.fake-db';
import type { HumanShotReview, VisualReviewModel } from '@buildd/shared';
import { buildVisualReviewModel, type VisualReviewShotRow, type VisualReviewTaskInput } from './visual-review-model';

const render = renderSql;
type Call = FakeCall;
mock.module('@buildd/core/db', () => ({ db: fakeDb }));
// Shared state through the fake: `calls` is read after each run.
let calls: Call[] = [];
let respond: (c: Call) => any = () => [];
const sync = () => { fake.respond = (c) => respond(c); };

let model: VisualReviewModel;
const mockLoad = mock(async (_m: any) => model);
mock.module('@/lib/visual-review-load', () => ({
  loadVisualReview: mockLoad,
  toHumanShotReview: (r: any) => ({ ...r, createdAt: String(r.createdAt), supersededAt: r.supersededAt ? String(r.supersededAt) : null }),
}));
const mockDispatch = mock(async (..._a: any[]) => {});
mock.module('@/lib/task-dispatch', () => ({ dispatchNewTask: mockDispatch }));
const mockEnsureAudit = mock(async (_p: any) => {});
const mockDetach = mock(async (_p: any) => ({ action: 'none' }));
mock.module('@/lib/mission-surface-audit', () => ({ ensureMissionSurfaceAudit: mockEnsureAudit, detachFixFromPendingAudit: mockDetach }));
const mockCancelFx = mock(async (_t: any) => {});
const mockReopenFx = mock(async (_t: any, _r: string) => {});
mock.module('@/lib/task-cancel', () => ({ applyTaskCancelSideEffects: mockCancelFx, applyTaskReopenSideEffects: mockReopenFx }));
const mockFeed = mock(async (_o: any) => {});
mock.module('@/lib/mission-feed', () => ({ postMissionFeedEvent: mockFeed }));
const mockTrigger = mock(async (..._a: any[]) => {});
mock.module('@/lib/pusher', () => ({ triggerEvent: mockTrigger, channels: { mission: (id: string) => `mission-${id}` }, events: {} }));
mock.module('@/lib/mission-loop', () => ({ reopenCompletedMission: async () => {} }));
const mockChatEvent = mock(async (_i: any) => true);
mock.module('@/lib/chat/mission-events', () => ({ postVisualReviewEvent: mockChatEvent }));

const {
  parseDecisionRequest,
  planShotReviewEffect,
  planDecision,
  applyDecision,
  undoDecision,
  planUndo,
  humanFixTitle,
} = await import('./visual-review-decisions');

// ── A mission with one audit round ──────────────────────────────────────────

const MISSION = { id: 'mission-1', teamId: 'team-1', workspaceId: 'ws-1' };
const REVIEWER = { userId: 'user-1', label: 'Reviewer' };
const AUDIT = 'audit-1';
const WORKER = 'worker-1';
const AT = '2026-03-10T10:00:00.000Z';

function shot(id: string, route: string, viewport: 'mobile' | 'desktop', verdict: 'ok' | 'issue' | 'unsure', finding: string, fixTaskId?: string): VisualReviewShotRow {
  return { id, type: 'screenshot', workerId: WORKER, taskId: AUDIT, createdAt: AT, title: null, metadata: { qa: { runKey: 'r1', route, viewport, verdict, finding, ...(fixTaskId ? { fixTaskId } : {}) } } };
}
const auditTask: VisualReviewTaskInput = { id: AUDIT, title: '[surface audit] M', status: 'completed', roleSlug: 'visual-auditor', createdAt: AT, workers: [{ id: WORKER, status: 'completed' }] };

function buildModel(shots: VisualReviewShotRow[], opts: { tasks?: VisualReviewTaskInput[]; reviews?: HumanShotReview[]; roundCapOpen?: boolean } = {}) {
  return buildVisualReviewModel({ missionId: MISSION.id, shots, tasks: [auditTask, ...(opts.tasks ?? [])], reviews: opts.reviews, roundCapOpen: opts.roundCapOpen, now: Date.parse(AT) + 3600_000 });
}

const review = (over: Partial<HumanShotReview>): HumanShotReview => ({
  id: 'rev-old', artifactId: 'a-ok-m', auditTaskId: AUDIT, round: 1, cellKey: '/app/x|mobile|', route: '/app/x', viewport: 'mobile',
  agentVerdict: 'ok', decision: 'needs_fix', relation: 'dispute', note: null, fixTaskId: null, cancelledFixTaskId: null,
  reviewerUserId: 'user-1', reviewerLabel: 'Reviewer', createdAt: '2026-03-10T10:30:00.000Z', supersededAt: null, ...over,
});

// Default responder: artifacts in scope are whatever the request names; inserts echo.
let inScope: string[] = [];
let cancelReturns: Array<{ id: string }> = [{ id: 'fix-a' }];
let fixStatus = 'in_progress';
let openFixRows: Array<{ id: string }> = [];
let insertError: unknown = null;
function defaultRespond(c: Call) {
  if (c.op === 'select' && c.table === 'artifacts') {
    return inScope.map(id => ({ id, metadata: {} }));
  }
  if (c.op === 'insert' && c.table === 'visual_shot_reviews') {
    if (insertError) throw insertError;
    return (c.values as any[]).map((v, i) => ({ id: `rev-${i + 1}`, ...v, createdAt: '2026-03-10T11:00:00.000Z', supersededAt: null }));
  }
  if (c.op === 'insert' && c.table === 'tasks') return [{ id: 'fix-new', workspaceId: 'ws-1', ...c.values }];
  if (c.op === 'insert') return [{ id: 'note-1' }];
  if (c.op === 'update' && c.table === 'tasks') return cancelReturns;
  if (c.op === 'update' && c.table === 'visual_shot_reviews') return (c.set.supersededAt ? [{ id: 'rev-old' }] : []);
  if (c.op === 'findFirst' && c.table === 'tasks') return { id: 'fix-a', status: fixStatus, title: '[surface fix] /app/x: y', workspaceId: 'ws-1', missionId: MISSION.id, pathManifest: null, taskClass: 'work', context: {} };
  if (c.op === 'findFirst' && c.table === 'workspaces') return { id: 'ws-1', teamId: 'team-1', name: 'ws', repo: null };
  if (c.op === 'findMany' && c.table === 'tasks') {
    return [
      { id: 'build-1', title: 'Build the page', taskClass: 'work', roleSlug: null, pathManifest: ['apps/web/src/app/app/(protected)/x/page.tsx', 'apps/web/src/lib/x.ts'] },
      { id: 'build-2', title: 'Other page', taskClass: 'work', roleSlug: null, pathManifest: ['apps/web/src/app/app/(protected)/y/page.tsx'] },
    ];
  }
  if (c.op === 'select' && c.table === 'tasks') return openFixRows;
  return [];
}

beforeEach(() => {
  fake.reset(defaultRespond);
  calls = fake.calls;
  respond = defaultRespond;
  sync();
  inScope = [];
  cancelReturns = [{ id: 'fix-a' }];
  fixStatus = 'in_progress';
  openFixRows = [];
  insertError = null;
  for (const m of [mockLoad, mockDispatch, mockEnsureAudit, mockDetach, mockCancelFx, mockReopenFx, mockFeed, mockTrigger]) m.mockClear();
});

const req = (artifactIds: string[], decision: 'looks_right' | 'needs_fix', expected: Record<string, 'ok' | 'issue' | 'unsure'>, note?: string) =>
  ({ artifactIds, decision, expected, ...(note ? { note } : {}) });

// ── The effect table ────────────────────────────────────────────────────────

describe('planShotReviewEffect: the six cells', () => {
  const none = { linkedFix: null, hasNote: false };
  const open = (id = 'fix-a') => ({ id, status: 'pending' });
  it('ok + looks right: agree, record only', () => {
    expect(planShotReviewEffect('ok', 'looks_right', none)).toEqual({ relation: 'agree', intent: 'none' });
  });
  it('ok + needs fix: dispute, file a fix', () => {
    expect(planShotReviewEffect('ok', 'needs_fix', none)).toEqual({ relation: 'dispute', intent: 'file_fix' });
  });
  it('issue + looks right: dispute, waive the linked fix', () => {
    expect(planShotReviewEffect('issue', 'looks_right', { linkedFix: open(), hasNote: false })).toEqual({ relation: 'dispute', intent: 'waive_fix' });
    // No linked fix, or it already finished: nothing to waive.
    expect(planShotReviewEffect('issue', 'looks_right', none)).toEqual({ relation: 'dispute', intent: 'none' });
    expect(planShotReviewEffect('issue', 'looks_right', { linkedFix: { id: 'fix-a', status: 'completed' }, hasNote: false })).toEqual({ relation: 'dispute', intent: 'none' });
  });
  it('issue + needs fix: agree, the note goes to the linked fix as guidance', () => {
    expect(planShotReviewEffect('issue', 'needs_fix', { linkedFix: open(), hasNote: true })).toEqual({ relation: 'agree', intent: 'guide_fix' });
    expect(planShotReviewEffect('issue', 'needs_fix', { linkedFix: open(), hasNote: false })).toEqual({ relation: 'agree', intent: 'none' });
    // The auditor never filed one: the human's agreement files it.
    expect(planShotReviewEffect('issue', 'needs_fix', none)).toEqual({ relation: 'agree', intent: 'file_fix' });
  });
  it('needs fix on a shot whose fix already completed agrees with the old shot and files nothing', () => {
    // The re-check round is what shows whether it worked; a second fix on a pre-fix screenshot is duplicate work.
    const done = { linkedFix: { id: 'fix-a', status: 'completed' }, hasNote: true };
    expect(planShotReviewEffect('issue', 'needs_fix', done)).toEqual({ relation: 'agree', intent: 'none' });
    expect(planShotReviewEffect('ok', 'needs_fix', done)).toEqual({ relation: 'dispute', intent: 'none' });
    // A fix that failed or was cancelled solved nothing: file again.
    expect(planShotReviewEffect('issue', 'needs_fix', { linkedFix: { id: 'fix-a', status: 'failed' }, hasNote: false })).toEqual({ relation: 'agree', intent: 'file_fix' });
    expect(planShotReviewEffect('issue', 'needs_fix', { linkedFix: { id: 'fix-a', status: 'cancelled' }, hasNote: false })).toEqual({ relation: 'agree', intent: 'file_fix' });
  });
  it('unsure + looks right: waive, record only', () => {
    expect(planShotReviewEffect('unsure', 'looks_right', none)).toEqual({ relation: 'waive', intent: 'none' });
  });
  it('unsure + needs fix: dispute, file a fix as for ok', () => {
    expect(planShotReviewEffect('unsure', 'needs_fix', none)).toEqual({ relation: 'dispute', intent: 'file_fix' });
  });
});

describe('humanFixTitle', () => {
  it('is surfaceFixTitle over the recorded route and the note, else the finding, on one line', () => {
    expect(humanFixTitle('/app/tasks/:id', 'The header\n wraps', 'finding')).toBe('[surface fix] /app/tasks/:id: The header wraps');
    expect(humanFixTitle('/app/tasks/:id', '  ', 'Tabs overflow at 390')).toBe('[surface fix] /app/tasks/:id: Tabs overflow at 390');
    expect(humanFixTitle('/x', 'a'.repeat(400), '').length).toBeLessThanOrEqual(200);
  });
});

describe('parseDecisionRequest', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  it('accepts a well-formed request and dedupes ids', () => {
    const out = parseDecisionRequest({ artifactIds: [A, A, B], decision: 'needs_fix', note: 'x', expected: { [A]: 'ok', [B]: 'issue' } });
    expect(out).toEqual({ ok: true, request: { artifactIds: [A, B], decision: 'needs_fix', note: 'x', expected: { [A]: 'ok', [B]: 'issue' } } });
  });
  it('rejects every malformed shape with a message', () => {
    const bad: unknown[] = [
      null, [], {}, { artifactIds: [] },
      { artifactIds: ['not-a-uuid'], decision: 'looks_right', expected: { 'not-a-uuid': 'ok' } },
      { artifactIds: [A], decision: 'agree', expected: { [A]: 'ok' } },
      { artifactIds: [A], decision: 'looks_right', expected: {} },
      { artifactIds: [A], decision: 'looks_right', expected: { [A]: 'fine' } },
      { artifactIds: [A], decision: 'looks_right', note: 5, expected: { [A]: 'ok' } },
      { artifactIds: [A], decision: 'looks_right', note: 'x'.repeat(2001), expected: { [A]: 'ok' } },
      { artifactIds: Array.from({ length: 51 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`), decision: 'looks_right', expected: {} },
    ];
    for (const b of bad) {
      const out = parseDecisionRequest(b);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.length).toBeGreaterThan(0);
    }
  });
});

// ── Planning a request ──────────────────────────────────────────────────────

describe('planDecision', () => {
  it('two viewports of one route decided together file exactly one fix', () => {
    model = buildModel([shot('a-m', '/app/x', 'mobile', 'ok', 'fine'), shot('a-d', '/app/x', 'desktop', 'ok', 'fine')]);
    const plan = planDecision(model, req(['a-m', 'a-d'], 'needs_fix', { 'a-m': 'ok', 'a-d': 'ok' }));
    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    expect(plan.fixGroups).toHaveLength(1);
    expect(plan.fixGroups[0].route).toBe('/app/x');
    expect(plan.fixGroups[0].artifactIds.sort()).toEqual(['a-d', 'a-m']);
  });

  it('two routes in one needs-fix request file one fix per route', () => {
    model = buildModel([shot('a-m', '/app/x', 'mobile', 'ok', 'fine'), shot('b-m', '/app/y', 'mobile', 'unsure', 'hmm')]);
    const plan = planDecision(model, req(['a-m', 'b-m'], 'needs_fix', { 'a-m': 'ok', 'b-m': 'unsure' }));
    expect(plan.kind === 'ok' && plan.fixGroups.map(g => g.route).sort()).toEqual(['/app/x', '/app/y']);
  });

  it('a changed agent verdict is stale, naming the cell', () => {
    model = buildModel([shot('a-m', '/app/x', 'mobile', 'issue', 'broken')]);
    const plan = planDecision(model, req(['a-m'], 'looks_right', { 'a-m': 'unsure' }));
    expect(plan.kind).toBe('stale');
    expect(plan.kind === 'stale' && plan.cells.map(c => c.key)).toEqual(['/app/x|mobile|']);
  });

  it('a shot a newer round re-shot is stale', () => {
    const round2: VisualReviewTaskInput = { id: 'audit-2', title: '[surface audit] round 2: M', status: 'completed', roleSlug: 'visual-auditor', createdAt: AT, context: { surfaceAuditRound: 2 }, workers: [{ id: 'worker-2', status: 'completed' }] };
    const newer = { ...shot('a-m2', '/app/x', 'mobile', 'ok', 'fixed now'), workerId: 'worker-2', taskId: 'audit-2', createdAt: '2026-03-10T10:40:00.000Z' };
    model = buildModel([shot('a-m', '/app/x', 'mobile', 'issue', 'broken'), newer], { tasks: [round2] });
    const plan = planDecision(model, req(['a-m'], 'looks_right', { 'a-m': 'issue' }));
    expect(plan.kind).toBe('stale');
  });

  it('needs fix on an issue shot whose auditor fix completed files nothing', () => {
    model = buildModel([shot('a-m', '/app/x', 'mobile', 'issue', 'broken', 'fix-a')], { tasks: [{ id: 'fix-a', title: '[surface fix] /app/x: broken', status: 'completed' }] });
    const plan = planDecision(model, req(['a-m'], 'needs_fix', { 'a-m': 'issue' }, 'still broken?'));
    expect(plan.kind === 'ok' && plan.fixGroups).toEqual([]);
    expect(plan.kind === 'ok' && plan.guides).toEqual([]);
    expect(plan.kind === 'ok' && plan.shots[0]).toMatchObject({ relation: 'agree', intent: 'none' });
  });

  describe('after a fix merged', () => {
    const MERGED = '2026-03-10T10:20:00.000Z';
    const merged: VisualReviewTaskInput = { id: 'fix-a', title: '[surface fix] /app/x: broken', status: 'completed', workers: [{ id: 'wf', prUrl: 'https://example.test/pr/1', prNumber: 1, mergedAt: MERGED }] };
    const round2: VisualReviewTaskInput = { id: 'audit-2', title: '[surface audit] round 2: M', status: 'completed', roleSlug: 'visual-auditor', createdAt: AT, context: { surfaceAuditRound: 2 }, workers: [{ id: 'worker-2', status: 'completed' }] };
    const after = (verdict: 'ok' | 'issue' | 'unsure', fixTaskId?: string) =>
      ({ ...shot('a-m2', '/app/x', 'mobile', verdict, 'looks fixed', fixTaskId), workerId: 'worker-2', taskId: 'audit-2', createdAt: '2026-03-10T10:40:00.000Z' });

    it('no screenshot since the merge: any decision is stale, there is nothing to decide', () => {
      model = buildModel([shot('a-m', '/app/x', 'mobile', 'issue', 'broken', 'fix-a')], { tasks: [merged] });
      expect(model.cells[0].fixCheck?.state).toBe('awaiting_capture');
      for (const d of ['looks_right', 'needs_fix'] as const) {
        expect(planDecision(model, req(['a-m'], d, { 'a-m': 'issue' })).kind).toBe('stale');
      }
    });

    it('Still broken on the new screenshot files a new fix for the route, whatever the agent said', () => {
      for (const verdict of ['ok', 'issue', 'unsure'] as const) {
        // The re-shot may carry the merged fix id over; it still files.
        for (const carried of [undefined, 'fix-a']) {
          model = buildModel([shot('a-m', '/app/x', 'mobile', 'issue', 'broken', 'fix-a'), after(verdict, carried)], { tasks: [round2, merged] });
          expect(model.cells[0].fixCheck?.state).toBe('check');
          const plan = planDecision(model, req(['a-m2'], 'needs_fix', { 'a-m2': verdict }, 'header still overflows'));
          expect(plan.kind === 'ok' && plan.shots[0].intent).toBe('file_fix');
          expect(plan.kind === 'ok' && plan.fixGroups).toEqual([{ route: '/app/x', artifactIds: ['a-m2'], reuseFixId: null }]);
        }
      }
    });

    it('Fixed on the new screenshot records only', () => {
      model = buildModel([shot('a-m', '/app/x', 'mobile', 'issue', 'broken', 'fix-a'), after('ok', 'fix-a')], { tasks: [round2, merged] });
      const plan = planDecision(model, req(['a-m2'], 'looks_right', { 'a-m2': 'ok' }));
      expect(plan.kind === 'ok' && plan.shots[0]).toMatchObject({ relation: 'agree', intent: 'none' });
      expect(plan.kind === 'ok' && [...plan.fixGroups, ...plan.waives, ...plan.guides]).toEqual([]);
    });
  });

  it('a looks-right redecide withdraws the fix the earlier human decision filed', () => {
    model = buildModel([shot('a-m', '/app/x', 'mobile', 'ok', 'fine')], {
      reviews: [review({ id: 'rev-old', artifactId: 'a-m', fixTaskId: 'fix-h' })],
      tasks: [{ id: 'fix-h', title: '[surface fix] /app/x: y', status: 'pending' }],
    });
    const plan = planDecision(model, req(['a-m'], 'looks_right', { 'a-m': 'ok' }));
    expect(plan.kind === 'ok' && plan.waives.map(w => w.fixTaskId)).toEqual(['fix-h']);
    expect(plan.kind === 'ok' && plan.priorReviewIds).toEqual(['rev-old']);
  });

  it('a needs-fix redecide reuses the open fix the earlier decision filed', () => {
    model = buildModel([shot('a-m', '/app/x', 'mobile', 'ok', 'fine')], {
      reviews: [review({ id: 'rev-old', artifactId: 'a-m', fixTaskId: 'fix-h' })],
      tasks: [{ id: 'fix-h', title: '[surface fix] /app/x: y', status: 'pending' }],
    });
    const plan = planDecision(model, req(['a-m'], 'needs_fix', { 'a-m': 'ok' }, 'also the footer'));
    expect(plan.kind === 'ok' && plan.fixGroups[0].reuseFixId).toBe('fix-h');
  });
});

// ── Applying it ─────────────────────────────────────────────────────────────

describe('applyDecision', () => {
  it('422s an artifact outside the mission\'s auditor shots, before any write', async () => {
    model = buildModel([shot('a-m', '/app/x', 'mobile', 'ok', 'fine')]);
    inScope = [];
    const out = await applyDecision({ mission: MISSION, reviewer: REVIEWER, request: req(['a-m'], 'looks_right', { 'a-m': 'ok' }) });
    expect(out.status).toBe(422);
    expect(out.body).toEqual({ error: 'not_in_mission', artifactIds: ['a-m'] });
    expect(calls.filter(c => c.op !== 'select')).toHaveLength(0);
    // Scoped by missionVisualShotsWhere plus the ids.
    const q = render(calls[0].where);
    expect(q.sql).toContain('"artifacts"."mission_id" = $');
    expect(q.sql).toContain('"t"."role_slug" = $');
    expect(q.sql).toContain('"artifacts"."id" in');
    expect(q.params).toContain(MISSION.id);
  });

  it('needs fix on ok files one human [surface fix] for both viewports, then dispatches and plans the round', async () => {
    model = buildModel([shot('a-m', '/app/x', 'mobile', 'ok', 'Looks fine'), shot('a-d', '/app/x', 'desktop', 'ok', 'Looks fine')]);
    inScope = ['a-m', 'a-d'];
    const out = await applyDecision({ mission: MISSION, reviewer: REVIEWER, request: req(['a-m', 'a-d'], 'needs_fix', { 'a-m': 'ok', 'a-d': 'ok' }, 'The tabs overflow') });
    expect(out.status).toBe(200);
    const taskInserts = calls.filter(c => c.op === 'insert' && c.table === 'tasks');
    expect(taskInserts).toHaveLength(1);
    const fix = taskInserts[0].values;
    expect(fix.title).toBe('[surface fix] /app/x: The tabs overflow');
    expect(fix.kind).toBe('engineering');
    expect(fix.taskClass).toBe('work');
    expect(fix.missionId).toBe(MISSION.id);
    expect(fix.workspaceId).toBe('ws-1');
    // Only the builder file whose route is the fixed route.
    expect(fix.pathManifest).toEqual(['apps/web/src/app/app/(protected)/x/page.tsx']);
    expect(fix.description).toContain('a-m');
    expect(fix.description).toContain('a-d');
    expect(fix.context.surfaceFix.origin).toBe('human');
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockEnsureAudit).toHaveBeenCalledTimes(1);
    expect(mockEnsureAudit.mock.calls[0][0]).toMatchObject({ origin: 'human', missionId: MISSION.id, createdTask: { id: 'fix-new', taskClass: 'work' } });
    // The fix id goes on the review rows, never into artifacts.metadata.qa.
    expect(calls.some(c => c.table === 'artifacts' && c.op === 'update')).toBe(false);
    const link = calls.find(c => c.op === 'update' && c.table === 'visual_shot_reviews' && c.set.fixTaskId);
    expect(link?.set).toEqual({ fixTaskId: 'fix-new' });
    const body = out.body as any;
    expect(body.fixTaskId).toBe('fix-new');
    expect(body.fixTaskIds).toEqual(['fix-new']);
    expect(body.outcome).toBe('fix_filed');
    expect(body.reviews).toHaveLength(2);
    expect(body.reviews.every((r: any) => r.relation === 'dispute')).toBe(true);
    // The mission's conversation hears that the decision filed a fix.
    const ev = mockChatEvent.mock.calls.at(-1)![0];
    expect(ev).toMatchObject({ missionId: MISSION.id, moment: 'fixes_filed', fixes: 1, routes: ['/app/x'] });
  });

  it('inserts the review rows after superseding the prior active one, never in a transaction', async () => {
    model = buildModel([shot('a-m', '/app/x', 'mobile', 'ok', 'fine')], { reviews: [review({ id: 'rev-old', artifactId: 'a-m', decision: 'looks_right', relation: 'agree' })] });
    inScope = ['a-m'];
    const out = await applyDecision({ mission: MISSION, reviewer: REVIEWER, request: req(['a-m'], 'looks_right', { 'a-m': 'ok' }) });
    expect(out.status).toBe(200);
    const sup = calls.findIndex(c => c.op === 'update' && c.table === 'visual_shot_reviews' && c.set.supersededAt);
    const ins = calls.findIndex(c => c.op === 'insert' && c.table === 'visual_shot_reviews');
    expect(sup).toBeGreaterThanOrEqual(0);
    expect(ins).toBeGreaterThan(sup);
    const q = render(calls[sup].where);
    expect(q.sql).toContain('"visual_shot_reviews"."artifact_id" in');
    expect(q.sql).toContain('"visual_shot_reviews"."superseded_at" is null');
    expect(q.sql).toContain('"visual_shot_reviews"."id" in');
    expect(q.params).toEqual(expect.arrayContaining(['a-m', 'rev-old']));
    expect(calls[sup].returning).toBe(true);
    const row = calls[ins].values[0];
    expect(row).toMatchObject({ missionId: MISSION.id, workspaceId: 'ws-1', artifactId: 'a-m', auditTaskId: AUDIT, round: 1, cellKey: '/app/x|mobile|', route: '/app/x', viewport: 'mobile', agentVerdict: 'ok', decision: 'looks_right', relation: 'agree', reviewerUserId: 'user-1' });
  });

  it('stamps createdAt on the rows with the instant it superseded the prior ones, so undo can find both exactly', async () => {
    // created_at defaults to now() in microseconds; a JS Date keeps milliseconds,
    // so a server default never compares equal to the value read back.
    model = buildModel([shot('a-m', '/app/x', 'mobile', 'ok', 'fine'), shot('a-d', '/app/x', 'desktop', 'ok', 'fine')], {
      reviews: [review({ id: 'rev-old', artifactId: 'a-m', decision: 'looks_right', relation: 'agree' })],
    });
    inScope = ['a-m', 'a-d'];
    await applyDecision({ mission: MISSION, reviewer: REVIEWER, request: req(['a-m', 'a-d'], 'needs_fix', { 'a-m': 'ok', 'a-d': 'ok' }) });
    const sup = calls.find(c => c.op === 'update' && c.table === 'visual_shot_reviews' && c.set.supersededAt)!;
    const ins = calls.find(c => c.op === 'insert' && c.table === 'visual_shot_reviews')!;
    expect(sup.set.supersededAt).toBeInstanceOf(Date);
    for (const row of ins.values) {
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.createdAt.getTime()).toBe(sup.set.supersededAt.getTime());
    }
  });

  it('409s a concurrent duplicate that hits the one-active-review index, with no side effects', async () => {
    model = buildModel([shot('a-m', '/app/x', 'mobile', 'ok', 'fine')]);
    inScope = ['a-m'];
    insertError = Object.assign(new Error('duplicate key value violates unique constraint "visual_shot_reviews_one_active_per_artifact"'), { code: '23505' });
    const out = await applyDecision({ mission: MISSION, reviewer: REVIEWER, request: req(['a-m'], 'needs_fix', { 'a-m': 'ok' }) });
    expect(out.status).toBe(409);
    expect((out.body as any).error).toBe('stale');
    expect(calls.some(c => c.op === 'insert' && c.table === 'tasks')).toBe(false);
    expect(mockFeed).not.toHaveBeenCalled();
  });

  it('409s stale with the cells and a fresh model, before any write', async () => {
    model = buildModel([shot('a-m', '/app/x', 'mobile', 'issue', 'broken')]);
    inScope = ['a-m'];
    const out = await applyDecision({ mission: MISSION, reviewer: REVIEWER, request: req(['a-m'], 'looks_right', { 'a-m': 'ok' }) });
    expect(out.status).toBe(409);
    const body = out.body as any;
    expect(body).toMatchObject({ error: 'stale', stale: true });
    expect(body.cells).toHaveLength(1);
    expect(body.model.missionId).toBe(MISSION.id);
    expect(calls.filter(c => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
  });

  describe('looks right on issue: waive the auditor\'s fix', () => {
    const issueModel = () => buildModel(
      [shot('a-m', '/app/x', 'mobile', 'issue', 'broken', 'fix-a'), shot('a-d', '/app/x', 'desktop', 'issue', 'broken', 'fix-a')],
      { tasks: [{ id: 'fix-a', title: '[surface fix] /app/x: broken', status: 'pending' }] },
    );

    it('cancels it only while pending and unclaimed (atomic WHERE), and records the cancel for undo', async () => {
      model = issueModel();
      inScope = ['a-m', 'a-d'];
      const out = await applyDecision({ mission: MISSION, reviewer: REVIEWER, request: req(['a-m', 'a-d'], 'looks_right', { 'a-m': 'issue', 'a-d': 'issue' }) });
      expect(out.status).toBe(200);
      const cancels = calls.filter(c => c.op === 'update' && c.table === 'tasks');
      expect(cancels).toHaveLength(1);
      expect(cancels[0].set.status).toBe('cancelled');
      const q = render(cancels[0].where);
      expect(q.sql).toContain('"tasks"."id" = $');
      expect(q.sql).toContain('"tasks"."status" = $');
      expect(q.sql).toContain('"tasks"."claimed_by" is null');
      expect(q.sql).toContain('not exists');
      expect(q.params).toEqual(expect.arrayContaining(['fix-a', 'pending', MISSION.id]));
      expect(mockCancelFx).toHaveBeenCalledTimes(1);
      expect(mockDetach).toHaveBeenCalledWith(expect.objectContaining({ fixTaskId: 'fix-a', route: '/app/x' }));
      const body = out.body as any;
      expect(body.cancelledFixTaskId).toBe('fix-a');
      expect(body.guidanceTaskId).toBeNull();
      expect(body.outcome).toBe('fix_cancelled');
      const rec = calls.find(c => c.op === 'update' && c.table === 'visual_shot_reviews' && c.set.cancelledFixTaskId);
      expect(rec?.set).toEqual({ cancelledFixTaskId: 'fix-a' });
      // Never a second fix, and never the auditor's qa.
      expect(calls.some(c => c.op === 'insert' && c.table === 'tasks')).toBe(false);
    });

    it('waiving one viewport of a fix both viewports link leaves the fix open for the other', async () => {
      model = issueModel();
      inScope = ['a-m'];
      const out = await applyDecision({ mission: MISSION, reviewer: REVIEWER, request: req(['a-m'], 'looks_right', { 'a-m': 'issue' }) });
      expect(out.status).toBe(200);
      expect(calls.some(c => c.op === 'update' && c.table === 'tasks')).toBe(false);
      expect((out.body as any).guidanceTaskId).toBe('fix-a');
      expect((out.body as any).annotated).toEqual([{ fixTaskId: 'fix-a', reason: 'still_linked' }]);
      expect((out.body as any).outcome).toBe('fix_still_linked');
      const note = calls.find(c => c.op === 'insert' && c.table === 'mission_notes');
      expect(note?.values.body).toContain('Another screen still links this fix');
    });

    it('a fix that has started gets a guidance note instead, and the response says annotated', async () => {
      model = issueModel();
      inScope = ['a-m', 'a-d'];
      cancelReturns = [];
      fixStatus = 'in_progress';
      const out = await applyDecision({ mission: MISSION, reviewer: REVIEWER, request: req(['a-m', 'a-d'], 'looks_right', { 'a-m': 'issue', 'a-d': 'issue' }, 'This is intended') });
      // The atomic cancel was tried, and matched nothing.
      expect(calls.filter(c => c.op === 'update' && c.table === 'tasks')).toHaveLength(1);
      expect(out.status).toBe(200);
      const body = out.body as any;
      expect(body.cancelledFixTaskId).toBeNull();
      expect(body.guidanceTaskId).toBe('fix-a');
      expect(body.annotated).toEqual([{ fixTaskId: 'fix-a', reason: 'started' }]);
      expect(body.outcome).toBe('fix_started');
      const note = calls.find(c => c.op === 'insert' && c.table === 'mission_notes');
      expect(note?.values).toMatchObject({ missionId: MISSION.id, taskId: 'fix-a', type: 'guidance', authorType: 'user', status: 'open' });
      expect(note?.values.body).toContain('This is intended');
      expect(note?.values.body).toContain('already started');
      expect(mockCancelFx).not.toHaveBeenCalled();
    });
  });

  it('needs fix on issue with a note sends guidance to the linked fix, files nothing', async () => {
    model = buildModel([shot('a-m', '/app/x', 'mobile', 'issue', 'broken', 'fix-a')], { tasks: [{ id: 'fix-a', title: '[surface fix] /app/x: broken', status: 'in_progress' }] });
    inScope = ['a-m'];
    const out = await applyDecision({ mission: MISSION, reviewer: REVIEWER, request: req(['a-m'], 'needs_fix', { 'a-m': 'issue' }, 'Check the phone width too') });
    expect(out.status).toBe(200);
    expect(calls.some(c => c.op === 'insert' && c.table === 'tasks')).toBe(false);
    const note = calls.find(c => c.op === 'insert' && c.table === 'mission_notes');
    expect(note?.values).toMatchObject({ taskId: 'fix-a', type: 'guidance' });
    expect((out.body as any).guidanceTaskId).toBe('fix-a');
    expect((out.body as any).annotated).toEqual([{ fixTaskId: 'fix-a', reason: 'note' }]);
    expect((out.body as any).outcome).toBe('fix_noted');
  });

  describe('outcome: what the confirmation says, from the branch the server took', () => {
    const issueWith = (status: string, opts: { roundCapOpen?: boolean } = {}) => buildModel(
      [shot('a-m', '/app/x', 'mobile', 'issue', 'broken', 'fix-a')],
      { tasks: [{ id: 'fix-a', title: '[surface fix] /app/x: broken', status }], ...opts },
    );
    const decide = async (decision: 'looks_right' | 'needs_fix', verdict: 'ok' | 'issue' | 'unsure' = 'issue') => {
      inScope = ['a-m'];
      const out = await applyDecision({ mission: MISSION, reviewer: REVIEWER, request: req(['a-m'], decision, { 'a-m': verdict }) });
      expect(out.status).toBe(200);
      return (out.body as any).outcome;
    };

    it('needs fix on an issue whose fix is open, no note: the fix is kept', async () => {
      model = issueWith('in_progress');
      expect(await decide('needs_fix')).toBe('fix_kept');
    });

    it('the same once the last automatic round ran (round-cap note open): no re-check left', async () => {
      model = issueWith('pending', { roundCapOpen: true });
      expect(await decide('needs_fix')).toBe('fix_kept_no_recheck');
    });

    it('needs fix on an issue whose fix completed: recorded, the next screenshot re-checks it', async () => {
      model = issueWith('completed');
      expect(await decide('needs_fix')).toBe('fix_done');
      expect(calls.some(c => c.op === 'insert' && c.table === 'tasks')).toBe(false);
    });

    it('looks right on an issue with no open fix: marked not a bug', async () => {
      model = issueWith('completed');
      expect(await decide('looks_right')).toBe('not_a_bug');
    });

    it('looks right on ok or unsure: marked fine', async () => {
      model = buildModel([shot('a-m', '/app/x', 'mobile', 'unsure', 'not sure')]);
      expect(await decide('looks_right', 'unsure')).toBe('marked_fine');
    });

    it('a needs-fix redecide that reuses the open human fix: added to it', async () => {
      model = buildModel([shot('a-m', '/app/x', 'mobile', 'ok', 'fine')], {
        reviews: [review({ id: 'rev-old', artifactId: 'a-m', fixTaskId: 'fix-h' })],
        tasks: [{ id: 'fix-h', title: '[surface fix] /app/x: broken', status: 'pending' }],
      });
      expect(await decide('needs_fix', 'ok')).toBe('fix_added');
    });
  });

  it('a needs-fix note on a shot whose open fix a human filed keeps that fix on the new row', async () => {
    // Otherwise the human fix is left open with no active review linking it, and the next Needs fix files a duplicate.
    model = buildModel([shot('a-m', '/app/x', 'mobile', 'issue', 'broken')], {
      reviews: [review({ id: 'rev-old', artifactId: 'a-m', agentVerdict: 'issue', relation: 'agree', fixTaskId: 'fix-h' })],
      tasks: [{ id: 'fix-h', title: '[surface fix] /app/x: broken', status: 'pending' }],
    });
    inScope = ['a-m'];
    const out = await applyDecision({ mission: MISSION, reviewer: REVIEWER, request: req(['a-m'], 'needs_fix', { 'a-m': 'issue' }, 'the footer too') });
    expect(out.status).toBe(200);
    expect(calls.some(c => c.op === 'insert' && c.table === 'tasks')).toBe(false);
    const ins = calls.find(c => c.op === 'insert' && c.table === 'visual_shot_reviews')!;
    expect(ins.values[0].fixTaskId).toBe('fix-h');
    expect((out.body as any).annotated).toEqual([{ fixTaskId: 'fix-h', reason: 'note' }]);
  });

  it('refuses a new human round at the ceiling with 409 and writes nothing', async () => {
    const r5: VisualReviewTaskInput = { id: 'audit-5', title: '[surface audit] round 5: M', status: 'completed', roleSlug: 'visual-auditor', createdAt: '2026-03-10T10:50:00.000Z', context: { surfaceAuditRound: 5 }, workers: [{ id: 'worker-5', status: 'completed' }] };
    model = buildModel([{ ...shot('a-m', '/app/x', 'mobile', 'ok', 'fine'), workerId: 'worker-5', taskId: 'audit-5' }], { tasks: [r5] });
    inScope = ['a-m'];
    const out = await applyDecision({ mission: MISSION, reviewer: REVIEWER, request: req(['a-m'], 'needs_fix', { 'a-m': 'ok' }) });
    expect(out.status).toBe(409);
    expect((out.body as any).error).toBe('round_ceiling');
    expect((out.body as any).message).not.toMatch(/round|\d/i);
    expect(calls.filter(c => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
  });

  it('a decision on an unsure cell answers the auditor\'s open question that names the artifact', async () => {
    model = buildModel([shot('a-u', '/app/x', 'mobile', 'unsure', 'not sure')]);
    inScope = ['a-u'];
    await applyDecision({ mission: MISSION, reviewer: REVIEWER, request: req(['a-u'], 'looks_right', { 'a-u': 'unsure' }) });
    const upd = calls.find(c => c.op === 'update' && c.table === 'mission_notes' && c.set.status === 'answered');
    expect(upd).toBeDefined();
    const q = render(upd!.where);
    expect(q.sql).toContain('"mission_notes"."mission_id" = $');
    expect(q.sql).toContain('"mission_notes"."type" = $');
    expect(q.sql).toContain('"mission_notes"."status" = $');
    expect(q.sql).toContain('"mission_notes"."body" like $');
    expect(q.params).toEqual(expect.arrayContaining([MISSION.id, 'question', 'open', '%a-u%']));
  });

  it('answers the round-cap note once no surface fix is open', async () => {
    model = buildModel([shot('a-m', '/app/x', 'mobile', 'issue', 'broken', 'fix-a')], { tasks: [{ id: 'fix-a', title: '[surface fix] /app/x: broken', status: 'pending' }], roundCapOpen: true });
    inScope = ['a-m'];
    openFixRows = [];
    await applyDecision({ mission: MISSION, reviewer: REVIEWER, request: req(['a-m'], 'looks_right', { 'a-m': 'issue' }) });
    const capUpd = calls.filter(c => c.op === 'update' && c.table === 'mission_notes').find(c => render(c.where).params.includes('Visual review: issues remain after 2 audit rounds'));
    expect(capUpd?.set).toEqual({ status: 'answered' });

    fake.calls = []; calls = fake.calls;
    openFixRows = [{ id: 'fix-b' }];
    await applyDecision({ mission: MISSION, reviewer: REVIEWER, request: req(['a-m'], 'looks_right', { 'a-m': 'issue' }) });
    expect(calls.filter(c => c.op === 'update' && c.table === 'mission_notes').some(c => render(c.where).params.includes('Visual review: issues remain after 2 audit rounds'))).toBe(false);
  });

  it('writes one decision note keyed by round and fires mission:visual_review', async () => {
    model = buildModel([shot('a-m', '/app/tasks/:id', 'mobile', 'ok', 'fine'), shot('a-d', '/app/tasks/:id', 'desktop', 'ok', 'fine')]);
    inScope = ['a-m', 'a-d'];
    await applyDecision({ mission: MISSION, reviewer: REVIEWER, request: req(['a-m', 'a-d'], 'looks_right', { 'a-m': 'ok', 'a-d': 'ok' }) });
    expect(mockFeed).toHaveBeenCalledTimes(1);
    const note = mockFeed.mock.calls[0][0];
    expect(note).toMatchObject({ missionId: MISSION.id, type: 'decision', collapseKey: 'visual-review:1', actor: { kind: 'user', id: 'user-1' } });
    // The collapse merge keys a body line on the text before its first colon,
    // so the line carries no colon before the verdict.
    expect(note.body.split(':')[0]).toBe('/app/tasks/[id], phone and desktop');
    expect(mockTrigger).toHaveBeenCalledWith('mission-mission-1', 'mission:visual_review', expect.objectContaining({ missionId: MISSION.id, decision: 'looks_right' }));
  });
});

describe('planUndo: undo restores the state before the decision', () => {
  const row = (over: Record<string, unknown>) => ({ id: 'rev-2', artifactId: 'a-m', route: '/app/x', fixTaskId: null, cancelledFixTaskId: null, ...over }) as any;

  it('a two-viewport needs fix cancels the one shared fix once', () => {
    const plan = planUndo([row({ id: 'r-m', fixTaskId: 'fix-h' }), row({ id: 'r-d', artifactId: 'a-d', fixTaskId: 'fix-h' })], [], []);
    expect(plan.cancel).toEqual([{ fixTaskId: 'fix-h', route: '/app/x' }]);
    expect(plan.reopen).toEqual([]);
  });

  it('a two-route needs fix cancels the fix of every route', () => {
    const plan = planUndo([row({ id: 'r-x', fixTaskId: 'fix-x' }), row({ id: 'r-y', artifactId: 'b-m', route: '/app/y', fixTaskId: 'fix-y' })], [], []);
    expect(plan.cancel).toEqual([{ fixTaskId: 'fix-x', route: '/app/x' }, { fixTaskId: 'fix-y', route: '/app/y' }]);
  });

  it('a two-route waive reopens every fix it cancelled', () => {
    const plan = planUndo([row({ id: 'r-x', cancelledFixTaskId: 'fix-x' }), row({ id: 'r-y', artifactId: 'b-m', route: '/app/y', cancelledFixTaskId: 'fix-y' })], [], []);
    expect(plan.reopen.map(r => r.fixTaskId)).toEqual(['fix-x', 'fix-y']);
    expect(plan.cancel).toEqual([]);
  });

  it('needs fix, then needs fix with a note, then undo: the first decision comes back and its fix stays', () => {
    const first = row({ id: 'rev-1', fixTaskId: 'fix-h' });
    const plan = planUndo([row({ id: 'rev-2', fixTaskId: 'fix-h' })], [first], []);
    expect(plan.cancel).toEqual([]);
    expect(plan.restoreIds).toEqual(['rev-1']);
  });

  it('needs fix, then looks right, then undo: the fix reopens and the needs-fix review comes back with it', () => {
    const first = row({ id: 'rev-1', fixTaskId: 'fix-h' });
    const plan = planUndo([row({ id: 'rev-2', cancelledFixTaskId: 'fix-h' })], [first], []);
    expect(plan.reopen).toEqual([{ fixTaskId: 'fix-h', route: '/app/x' }]);
    expect(plan.cancel).toEqual([]);
    expect(plan.restoreIds).toEqual(['rev-1']);
  });

  it('keeps a fix another active review still points at', () => {
    const plan = planUndo([row({ id: 'rev-2', fixTaskId: 'fix-h' })], [], ['fix-h']);
    expect(plan.cancel).toEqual([]);
  });

  it('restores only rows of the decision\'s own shots', () => {
    const plan = planUndo([row({ id: 'rev-2' })], [row({ id: 'rev-1' }), row({ id: 'rev-x', artifactId: 'other' })], []);
    expect(plan.restoreIds).toEqual(['rev-1']);
  });
});

describe('undoDecision', () => {
  const T = new Date('2026-03-10T11:00:00.000Z');
  const reviewRow = (over: Record<string, unknown> = {}) => ({
    id: 'rev-1', missionId: MISSION.id, workspaceId: 'ws-1', artifactId: 'a-m', auditTaskId: AUDIT, round: 1, cellKey: '/app/x|mobile|', route: '/app/x', viewport: 'mobile',
    agentVerdict: 'ok', decision: 'needs_fix', relation: 'dispute', note: null, fixTaskId: 'fix-h', cancelledFixTaskId: null,
    reviewerUserId: 'user-1', reviewerLabel: 'Reviewer', createdAt: T, supersededAt: null, ...over,
  });
  type TaskState = { status: string; claimedBy?: string | null; started?: boolean };

  function undoRespond(opts: { review: any; siblings?: any[]; restorable?: any[]; otherRefs?: any[]; states?: Record<string, TaskState>; fixUpdate?: any[]; fixStatusAfter?: string }) {
    const states = opts.states ?? { 'fix-h': { status: opts.review?.cancelledFixTaskId ? 'cancelled' : 'pending' } };
    return (c: Call) => {
      if (c.op === 'findFirst' && c.table === 'visual_shot_reviews') return opts.review;
      if (c.op === 'select' && c.table === 'visual_shot_reviews') {
        const q = render(c.where).sql;
        if (q.includes('"visual_shot_reviews"."created_at" =')) return opts.siblings ?? [opts.review];
        if (q.includes('"visual_shot_reviews"."superseded_at" =')) return opts.restorable ?? [];
        return opts.otherRefs ?? [];
      }
      if (c.op === 'select' && c.table === 'tasks') {
        return Object.entries(states).map(([id, s]) => ({ id, status: s.status, claimedBy: s.claimedBy ?? null, started: s.started ?? false }));
      }
      if (c.op === 'update' && c.table === 'tasks') {
        if (opts.fixUpdate) return opts.fixUpdate;
        const id = render(c.where).params.find((p: unknown) => typeof p === 'string' && p.startsWith('fix-'));
        return [{ id, workspaceId: 'ws-1' }];
      }
      if (c.op === 'findFirst' && c.table === 'tasks') return { id: 'fix-h', status: opts.fixStatusAfter ?? 'in_progress', title: '[surface fix] /app/x: y', workspaceId: 'ws-1', missionId: MISSION.id, taskClass: 'work', pathManifest: null };
      if (c.op === 'findFirst' && c.table === 'workspaces') return { id: 'ws-1', teamId: 'team-1' };
      if (c.op === 'update' && c.table === 'visual_shot_reviews') {
        return c.set.supersededAt === null ? (opts.restorable ?? []).map((r: any) => ({ id: r.id })) : (opts.siblings ?? [opts.review]).map((r: any) => ({ id: r.id }));
      }
      return [];
    };
  }
  const run = () => undoDecision({ mission: MISSION, reviewer: REVIEWER, reviewId: 'rev-1' });
  const taskUpdates = () => calls.filter(c => c.op === 'update' && c.table === 'tasks');

  it('404s a review of another mission, or one already superseded', async () => {
    model = buildModel([]);
    respond = undoRespond({ review: null });
    const out = await run();
    expect(out.status).toBe(404);
    const q = render(calls[0].where);
    expect(q.sql).toContain('"visual_shot_reviews"."mission_id" = $');
    expect(q.sql).toContain('"visual_shot_reviews"."superseded_at" is null');
    expect(q.params).toEqual(expect.arrayContaining(['rev-1', MISSION.id]));
  });

  it('cancels the pending, unclaimed fix it filed, then supersedes the review', async () => {
    model = buildModel([]);
    respond = undoRespond({ review: reviewRow() });
    const out = await run();
    expect(out.status).toBe(200);
    const cancel = calls.findIndex(c => c.op === 'update' && c.table === 'tasks');
    const sup = calls.findIndex(c => c.op === 'update' && c.table === 'visual_shot_reviews');
    expect(cancel).toBeGreaterThanOrEqual(0);
    expect(sup).toBeGreaterThan(cancel);
    expect(calls[cancel].set.status).toBe('cancelled');
    expect(render(calls[cancel].where).sql).toContain('"tasks"."claimed_by" is null');
    expect(mockCancelFx).toHaveBeenCalledTimes(1);
    expect((out.body as any).cancelledFixTaskId).toBe('fix-h');
    expect((out.body as any).cancelledFixTaskIds).toEqual(['fix-h']);
    expect((out.body as any).superseded).toBe('rev-1');
  });

  it('finds the rest of the tap by its exact createdAt and the reviewer, scoped to the mission', async () => {
    model = buildModel([]);
    respond = undoRespond({ review: reviewRow() });
    await run();
    const sib = calls.find(c => c.op === 'select' && c.table === 'visual_shot_reviews' && render(c.where).sql.includes('"created_at" ='))!;
    const q = render(sib.where);
    expect(q.sql).toContain('"visual_shot_reviews"."mission_id" = $');
    expect(q.sql).toContain('"visual_shot_reviews"."superseded_at" is null');
    expect(q.sql).toContain('"visual_shot_reviews"."reviewer_user_id" = $');
    expect(q.params).toEqual(expect.arrayContaining([MISSION.id, T.toISOString(), 'user-1']));
  });

  it('undo of a two-viewport needs fix cancels the shared fix and takes back both rows', async () => {
    model = buildModel([]);
    const siblings = [reviewRow(), reviewRow({ id: 'rev-d', artifactId: 'a-d', viewport: 'desktop', cellKey: '/app/x|desktop|' })];
    respond = undoRespond({ review: reviewRow(), siblings });
    const out = await run();
    expect(out.status).toBe(200);
    expect(taskUpdates()).toHaveLength(1);
    // The other-references check excludes the whole tap, so the desktop row does not keep the fix alive.
    const refs = calls.find(c => c.op === 'select' && c.table === 'visual_shot_reviews' && render(c.where).sql.includes('"fix_task_id" in'))!;
    expect(render(refs.where).sql).toContain('"visual_shot_reviews"."id" not in');
    expect(render(refs.where).params).toEqual(expect.arrayContaining(['rev-1', 'rev-d', 'fix-h']));
    expect((out.body as any).supersededIds.sort()).toEqual(['rev-1', 'rev-d']);
  });

  it('undo of a two-route needs fix cancels every route\'s fix', async () => {
    model = buildModel([]);
    const siblings = [reviewRow({ fixTaskId: 'fix-x' }), reviewRow({ id: 'rev-y', artifactId: 'b-m', route: '/app/y', cellKey: '/app/y|mobile|', fixTaskId: 'fix-y' })];
    respond = undoRespond({ review: siblings[0], siblings, states: { 'fix-x': { status: 'pending' }, 'fix-y': { status: 'pending' } } });
    const out = await run();
    expect(out.status).toBe(200);
    expect(taskUpdates().map(c => render(c.where).params.find((p: unknown) => String(p).startsWith('fix-'))).sort()).toEqual(['fix-x', 'fix-y']);
    expect((out.body as any).cancelledFixTaskIds.sort()).toEqual(['fix-x', 'fix-y']);
    expect(mockDetach).toHaveBeenCalledTimes(2);
  });

  it('409 fix_started when any fix of the tap has started, before any write', async () => {
    model = buildModel([]);
    const siblings = [reviewRow({ fixTaskId: 'fix-x' }), reviewRow({ id: 'rev-y', artifactId: 'b-m', route: '/app/y', fixTaskId: 'fix-y' })];
    respond = undoRespond({ review: siblings[0], siblings, states: { 'fix-x': { status: 'pending' }, 'fix-y': { status: 'pending', started: true } } });
    const out = await run();
    expect(out.status).toBe(409);
    expect(out.body).toEqual({ error: 'fix_started', fixTaskId: 'fix-y' });
    expect(calls.filter(c => c.op === 'update')).toHaveLength(0);
  });

  it('409 fix_started when the fix it filed was claimed, and keeps the review', async () => {
    model = buildModel([]);
    respond = undoRespond({ review: reviewRow(), states: { 'fix-h': { status: 'pending', claimedBy: 'acct-1' } } });
    const out = await run();
    expect(out.status).toBe(409);
    expect(out.body).toEqual({ error: 'fix_started', fixTaskId: 'fix-h' });
    expect(calls.some(c => c.op === 'update')).toBe(false);
  });

  it('409 fix_started when the atomic cancel loses a race after the check', async () => {
    model = buildModel([]);
    respond = undoRespond({ review: reviewRow(), fixUpdate: [], fixStatusAfter: 'in_progress' });
    const out = await run();
    expect(out.status).toBe(409);
    expect(calls.some(c => c.op === 'update' && c.table === 'visual_shot_reviews')).toBe(false);
  });

  it('keeps a fix another active review still points at', async () => {
    model = buildModel([]);
    respond = undoRespond({ review: reviewRow(), otherRefs: [{ fixTaskId: 'fix-h' }] });
    const out = await run();
    expect(out.status).toBe(200);
    expect(taskUpdates()).toHaveLength(0);
  });

  it('needs fix, then needs fix with a note, then undo: restores the first review and keeps its fix', async () => {
    model = buildModel([]);
    const first = reviewRow({ id: 'rev-0', createdAt: new Date('2026-03-10T10:30:00.000Z'), supersededAt: T });
    respond = undoRespond({ review: reviewRow({ note: 'also the footer' }), restorable: [first] });
    const out = await run();
    expect(out.status).toBe(200);
    expect(taskUpdates()).toHaveLength(0);
    // The superseded-by-this-decision lookup: same shots, superseded at the decision's instant.
    const look = calls.find(c => c.op === 'select' && c.table === 'visual_shot_reviews' && render(c.where).sql.includes('"superseded_at" ='))!;
    const lq = render(look.where);
    expect(lq.sql).toContain('"visual_shot_reviews"."mission_id" = $');
    expect(lq.sql).toContain('"visual_shot_reviews"."artifact_id" in');
    expect(lq.params).toEqual(expect.arrayContaining([MISSION.id, 'a-m', T.toISOString()]));
    // Supersede the undone rows first, then bring the prior one back.
    const sup = calls.findIndex(c => c.op === 'update' && c.table === 'visual_shot_reviews' && c.set.supersededAt instanceof Date);
    const back = calls.findIndex(c => c.op === 'update' && c.table === 'visual_shot_reviews' && c.set.supersededAt === null);
    expect(sup).toBeGreaterThanOrEqual(0);
    expect(back).toBeGreaterThan(sup);
    const bq = render(calls[back].where);
    expect(bq.params).toEqual(expect.arrayContaining(['rev-0', T.toISOString()]));
    expect((out.body as any).restoredIds).toEqual(['rev-0']);
  });

  it('needs fix, then looks right, then undo: reopens the fix and restores the needs-fix review', async () => {
    model = buildModel([]);
    const first = reviewRow({ id: 'rev-0', supersededAt: T });
    respond = undoRespond({ review: reviewRow({ fixTaskId: null, cancelledFixTaskId: 'fix-h', decision: 'looks_right', relation: 'agree' }), restorable: [first] });
    const out = await run();
    expect(out.status).toBe(200);
    const reopen = taskUpdates();
    expect(reopen).toHaveLength(1);
    expect(reopen[0].set.status).toBe('pending');
    expect((out.body as any).reopenedFixTaskIds).toEqual(['fix-h']);
    expect((out.body as any).restoredIds).toEqual(['rev-0']);
  });

  it('reopens a fix the decision cancelled, while still cancelled and unclaimed, and re-plans its round', async () => {
    model = buildModel([]);
    respond = undoRespond({ review: reviewRow({ fixTaskId: null, cancelledFixTaskId: 'fix-h', agentVerdict: 'issue', decision: 'looks_right' }) });
    const out = await run();
    expect(out.status).toBe(200);
    const reopen = calls.find(c => c.op === 'update' && c.table === 'tasks');
    expect(reopen?.set.status).toBe('pending');
    const q = render(reopen!.where);
    expect(q.params).toEqual(expect.arrayContaining(['fix-h', 'cancelled']));
    expect(q.sql).toContain('"tasks"."claimed_by" is null');
    expect(mockReopenFx).toHaveBeenCalledTimes(1);
    expect(mockEnsureAudit).toHaveBeenCalledWith(expect.objectContaining({ origin: 'human', createdTask: expect.objectContaining({ id: 'fix-h' }) }));
    expect((out.body as any).reopenedFixTaskId).toBe('fix-h');
  });

  it('409 fix_started when the cancelled fix was changed since', async () => {
    model = buildModel([]);
    respond = undoRespond({ review: reviewRow({ fixTaskId: null, cancelledFixTaskId: 'fix-h' }), states: { 'fix-h': { status: 'in_progress', claimedBy: 'acct-1' } } });
    const out = await run();
    expect(out.status).toBe(409);
    expect(calls.some(c => c.op === 'update')).toBe(false);
  });
});
