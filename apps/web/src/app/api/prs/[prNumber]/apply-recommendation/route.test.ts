import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockResolveOpenWorkerForUser = mock(() => ({}) as any);
const mockMissionNotesFindMany = mock(() => Promise.resolve([] as any[]));
const mockTasksFindFirst = mock(() => Promise.resolve(null) as any);
const mockWorkspacesFindFirst = mock(() => Promise.resolve(null) as any);
const mockAnnounceTaskCreated = mock(() => Promise.resolve());
const mockAppendPrActivity = mock(() => Promise.resolve({ action: 'updated' } as any));
const mockSupersedeAncestorEscalations = mock(() => Promise.resolve());

const mockTasksValues = mock((_v: any) => {});
const mockTasksReturning = mock(() => Promise.resolve([{ id: 'apply-task-1' }]) as any);
const mockMissionNotesValues = mock((_v: any) => Promise.resolve());

const mockPerformLandingAction = mock((_i: any) => Promise.resolve({} as any));
mock.module('@/lib/landing-action-run', () => ({ performLandingAction: mockPerformLandingAction }));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/pr-resolve', () => ({ resolveOpenWorkerForUser: mockResolveOpenWorkerForUser }));
// The dispatch authority's full surface: mock.module is process-global.
const mockWakeTask = mock(async (_taskId: string, _cause: string, _opts?: unknown) => {});
mock.module('@/lib/dispatch-authority', () => ({
  announceTaskCreated: mockAnnounceTaskCreated,
  wakeTask: mockWakeTask,
  wakeTasks: mock(async () => {}),
  kickDispatch: () => {},
  enqueueTaskDispatch: async () => {},
  drainDispatchOutbox: async () => ({ claimed: 0, delivered: 0, skipped: 0, failed: 0 }),
  deliverTaskDispatch: async () => 'pusher',
  routeForCause: () => ({ event: 'task.created', legacyDefault: true, legacyUnfilteredRunnerPreference: false }),
  webhookWants: () => false,
  primaryCause: (_causes: string[], fallback: string) => fallback,
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH: 25,
  reseedDispatchTimer: async () => {},
}));
mock.module('@/lib/pr-activity-comment', () => ({ appendPrActivity: mockAppendPrActivity }));
mock.module('@/lib/escalation-supersession', () => ({ supersedeAncestorEscalations: mockSupersedeAncestorEscalations }));
// Workflow kernel (lib/workflow/seam.ts): default, the PR is legacy-owned and every case below runs unchanged.
const mockKernelDeliveryOfPr = mock(async (_p: any): Promise<any> => null);
const mockApplyThroughKernel = mock(async (_p: any): Promise<any> => null);
mock.module('@/lib/workflow/seam', () => ({ kernelDeliveryOfPr: mockKernelDeliveryOfPr, applyRecommendationThroughKernel: mockApplyThroughKernel }));

const TASKS_TABLE = { __name: 'tasks' };
const MISSION_NOTES_TABLE = { __name: 'missionNotes' };
const WORKSPACES_TABLE = { __name: 'workspaces' };

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missionNotes: { findMany: mockMissionNotesFindMany },
      tasks: { findFirst: mockTasksFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    insert: (table: any) => {
      if (table === TASKS_TABLE) {
        return {
          values: (v: any) => {
            mockTasksValues(v);
            return { onConflictDoNothing: () => ({ returning: mockTasksReturning }) };
          },
        };
      }
      return { values: (v: any) => mockMissionNotesValues(v) };
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  inArray: (a: any, b: any) => ({ type: 'inArray', a, b }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: TASKS_TABLE,
  missionNotes: MISSION_NOTES_TABLE,
  workspaces: WORKSPACES_TABLE,
}));

import { POST } from './route';

function makeRequest(prNumber = '42', body?: Record<string, unknown>) {
  const req = new NextRequest(`http://localhost/api/prs/${prNumber}/apply-recommendation`, {
    method: 'POST',
    ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
  });
  return [req, { params: Promise.resolve({ prNumber }) }] as const;
}

const openWorker = {
  id: 'w-1',
  taskId: 't-1',
  workspaceId: 'ws-1',
  branch: 'buildd/some-branch',
  prUrl: 'https://github.com/org/repo/pull/42',
  lastCommitSha: 'abc123',
  task: { id: 't-1', title: 'Fix the thing', description: 'Original description', missionId: 'mis-1', pathManifest: ['a.ts'] },
};

const escalatedNote = {
  taskId: 't-1',
  type: 'reviewer_escalated',
  title: 'PR #42 escalated: touches schema.ts',
  body: 'touches schema.ts\n\n**Recommended next step:** Guard the null-overwrite in heartbeat/route.ts.',
  status: 'open',
  createdAt: new Date('2026-09-11T07:00:00Z'),
};

// No RECOMMENDATION_MARKER — a concrete defect statement with nothing
// structured to Apply. This is the case the fix-dispatch widening covers.
const escalatedNoteNoRecommendation = {
  taskId: 't-1',
  type: 'reviewer_escalated',
  title: 'PR #42 escalated: spec conformance',
  body: 'Spec conformance: the discrepancy ledger schema changed without a generated SQL migration',
  status: 'open',
  createdAt: new Date('2026-09-11T07:00:00Z'),
};

describe('POST /api/prs/[prNumber]/apply-recommendation', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockResolveOpenWorkerForUser.mockReset();
    mockMissionNotesFindMany.mockReset();
    mockMissionNotesFindMany.mockResolvedValue([escalatedNote]);
    mockTasksFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockTasksValues.mockReset();
    mockTasksReturning.mockReset();
    mockTasksReturning.mockResolvedValue([{ id: 'apply-task-1' }]);
    mockMissionNotesValues.mockReset();
    mockAnnounceTaskCreated.mockReset();
    mockWakeTask.mockReset();
    mockAppendPrActivity.mockReset();
    mockSupersedeAncestorEscalations.mockReset();
    mockPerformLandingAction.mockReset();
    mockKernelDeliveryOfPr.mockReset();
    mockKernelDeliveryOfPr.mockResolvedValue(null);
    mockApplyThroughKernel.mockReset();
    mockApplyThroughKernel.mockResolvedValue(null);
  });

  // Task eee04322 (T23): on a kernel-owned PR, Apply is HumanResolve(apply_recommendation).
  // The kernel files the fix (trigger=human ledger row, its own dispatch_fix); the route
  // files nothing on the legacy path and only reports what the kernel did.
  describe('kernel-owned PR (T23 HumanResolve)', () => {
    const kernelOwned = { deliveryId: 'd-1', state: 'ESCALATED', stateReason: 'review_escalated', version: 7 };
    const current = { state: 'CHANGES_REQUESTED', stateReason: null, version: 9, head: 'abc123', round: 2 };
    beforeEach(() => {
      mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
      mockResolveOpenWorkerForUser.mockResolvedValue(openWorker);
      mockKernelDeliveryOfPr.mockResolvedValue(kernelOwned);
    });

    it('dispatches the fix through the kernel with the reviewer recommendation as instructions; nothing on the legacy path', async () => {
      mockApplyThroughKernel.mockResolvedValue({
        result: { result: 'applied', transitionId: 'tr-1', deliveryId: 'd-1', version: 8, decision: {} },
        current,
        attempt: { id: 'a-1', attemptNo: 1, maxAttempts: 3, taskId: 'kernel-fix-1' },
      });
      const [req, ctx] = makeRequest('42', { workspaceId: 'ws-1', version: 7 });
      const res = await POST(req, ctx);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, dispatched: true, kernel: true, taskId: 'kernel-fix-1', attempt: { attemptNo: 1 } });
      expect(mockApplyThroughKernel.mock.calls[0][0]).toEqual({
        workspaceId: 'ws-1', prNumber: 42, actor: 'human:u-1', expectedVersion: 7,
        instructions: 'Guard the null-overwrite in heartbeat/route.ts.',
      });
      // The legacy insert, announce and wake never ran: the kernel's dispatch_fix owns the task.
      expect(mockTasksValues).not.toHaveBeenCalled();
      expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
      // The escalation card closes and the decision is on the mission feed.
      expect(mockSupersedeAncestorEscalations).toHaveBeenCalledWith(expect.anything(), 't-1', 42);
      expect(mockMissionNotesValues.mock.calls[0][0]).toMatchObject({ missionId: 'mis-1', type: 'decision', authorType: 'user' });
    });

    it('corrections are the authoritative instruction', async () => {
      mockApplyThroughKernel.mockResolvedValue({
        result: { result: 'applied', transitionId: 'tr-1', deliveryId: 'd-1', version: 8, decision: {} },
        current, attempt: { id: 'a-1', attemptNo: 1, maxAttempts: 3, taskId: 'kernel-fix-1' },
      });
      const [req, ctx] = makeRequest('42', { corrections: '  Regenerate the migration instead.  ' });
      await POST(req, ctx);
      expect(mockApplyThroughKernel.mock.calls[0][0]).toMatchObject({ instructions: 'Regenerate the migration instead.', expectedVersion: undefined });
    });

    it('works without an escalation note: the kernel carries the reviewer round output itself', async () => {
      mockMissionNotesFindMany.mockResolvedValue([]);
      mockApplyThroughKernel.mockResolvedValue({
        result: { result: 'applied', transitionId: 'tr-1', deliveryId: 'd-1', version: 8, decision: {} },
        current, attempt: { id: 'a-1', attemptNo: 1, maxAttempts: 3, taskId: 'kernel-fix-1' },
      });
      const [req, ctx] = makeRequest();
      const res = await POST(req, ctx);
      expect(res.status).toBe(200);
      expect(mockApplyThroughKernel.mock.calls[0][0]).toMatchObject({ instructions: null });
    });

    it('a stale version is a 409 with the current view, and resolves nothing', async () => {
      const now = { state: 'AWAITING_REVIEW', stateReason: null, version: 11, head: 'def456', round: 3 };
      mockApplyThroughKernel.mockResolvedValue({
        result: { result: 'stale', reason: 'version_moved', current: { state: 'AWAITING_REVIEW', version: 11, head: 'def456', round: 3 } },
        current: now, attempt: null,
      });
      const [req, ctx] = makeRequest('42', { version: 7 });
      const res = await POST(req, ctx);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ stale: true, reason: 'version_moved', kernel: true, current: now });
      expect(mockTasksValues).not.toHaveBeenCalled();
      expect(mockSupersedeAncestorEscalations).not.toHaveBeenCalled();
      expect(mockMissionNotesValues).not.toHaveBeenCalled();
    });

    it('a kernel refusal is a 409 naming the reason', async () => {
      mockApplyThroughKernel.mockResolvedValue({
        result: { result: 'rejected', reason: 'no_review_at_head', current: { state: 'ESCALATED', version: 7, head: 'abc123', round: 0 } },
        current: { state: 'ESCALATED', stateReason: 'push_undeliverable', version: 7, head: 'abc123', round: 0 }, attempt: null,
      });
      const [req, ctx] = makeRequest();
      const res = await POST(req, ctx);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ reason: 'no_review_at_head', kernel: true });
      expect(mockTasksValues).not.toHaveBeenCalled();
      expect(mockSupersedeAncestorEscalations).not.toHaveBeenCalled();
    });

    it('a legacy PR never reaches the kernel door', async () => {
      mockKernelDeliveryOfPr.mockResolvedValue(null);
      const [req, ctx] = makeRequest();
      const res = await POST(req, ctx);
      expect(res.status).toBe(200);
      expect(mockApplyThroughKernel).not.toHaveBeenCalled();
      expect(mockTasksValues).toHaveBeenCalled();
    });
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 400 for a non-numeric prNumber', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    const [req, ctx] = makeRequest('not-a-number');
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
  });

  it('propagates a resolver error (e.g. PR not found)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue({ error: 'PR not found or already merged', status: 404 });
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
  });

  it('returns 422 when the PR has no recorded head commit', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue({ ...openWorker, lastCommitSha: null });
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(422);
  });

  it('returns 409 when there is no open reviewer escalation to apply', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue(openWorker);
    mockMissionNotesFindMany.mockResolvedValue([]);
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
  });

  it('dispatches off the escalation reason when the note carries no recommendation', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue(openWorker);
    mockMissionNotesFindMany.mockResolvedValue([escalatedNoteNoRecommendation]);
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, dispatched: true, taskId: 'apply-task-1' });
    expect(mockAnnounceTaskCreated).toHaveBeenCalledTimes(1);
    expect(mockWakeTask).toHaveBeenCalledWith((mockAnnounceTaskCreated.mock.calls[0] as any[])[0].id, 'task.created');
    expect(mockSupersedeAncestorEscalations).toHaveBeenCalledWith(expect.anything(), 't-1', 42);

    const inserted = mockTasksValues.mock.calls[0][0];
    expect(inserted.description).toContain(
      'Spec conformance: the discrepancy ledger schema changed without a generated SQL migration',
    );
    expect(inserted.description).toContain('## Fix the reported defect');
    expect(inserted.context.iteration).toBe(0);
    expect(inserted.context.recommendation).toBeNull();
    expect(inserted.context.instruction).toContain('schema changed without a generated SQL migration');
  });

  it('frames corrections as authoritative over a defect-only escalation (no recommendation)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue(openWorker);
    mockMissionNotesFindMany.mockResolvedValue([escalatedNoteNoRecommendation]);
    const [req, ctx] = makeRequest('42', { corrections: 'Generate the migration and stop there.' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);

    const inserted = mockTasksValues.mock.calls[0][0];
    const correctionIdx = inserted.description.indexOf('Generate the migration and stop there.');
    const reasonIdx = inserted.description.indexOf('schema changed without a generated SQL migration');
    expect(correctionIdx).toBeGreaterThan(-1);
    expect(reasonIdx).toBeGreaterThan(-1);
    expect(correctionIdx).toBeLessThan(reasonIdx);
  });

  it('dispatches a fix task carrying the recommendation verbatim and closes the escalation', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue(openWorker);
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, dispatched: true, taskId: 'apply-task-1' });
    expect(mockAnnounceTaskCreated).toHaveBeenCalledTimes(1);
    expect(mockWakeTask).toHaveBeenCalledWith((mockAnnounceTaskCreated.mock.calls[0] as any[])[0].id, 'task.created');
    expect(mockSupersedeAncestorEscalations).toHaveBeenCalledWith(expect.anything(), 't-1', 42);

    const inserted = mockTasksValues.mock.calls[0][0];
    expect(inserted.description).toContain('Guard the null-overwrite in heartbeat/route.ts.');
    expect(inserted.parentTaskId).toBe('t-1');
    expect(inserted.reviewerRetryPrNumber).toBe(42);
    expect(inserted.reviewerRetryHeadSha).toBe('abc123');
    expect(inserted.context.iteration).toBe(0);
    expect(inserted.context.baseBranch).toBe('buildd/some-branch');
    expect(inserted.creationSource).toBe('dashboard');
  });

  // role-routing §1 row 8: the apply-recommendation fix dropped the role of
  // the task it re-attempts.
  it('the fix task inherits the escalated task\'s roleSlug', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue(openWorker);
    mockTasksFindFirst.mockImplementation((opts?: any) =>
      Promise.resolve(opts?.columns?.roleSlug
        ? { backend: 'claude', roleSlug: 'builder', kind: 'engineering', complexity: null, missionPhaseIndex: null, missionPhaseLabel: null }
        : null),
    );
    const [req, ctx] = makeRequest();
    await POST(req, ctx);
    const inserted = mockTasksValues.mock.calls[0][0];
    expect(inserted.roleSlug).toBe('builder');
    expect(inserted.taskClass).toBe('attempt');
  });

  it('frames corrections as the authoritative instruction ahead of the recommendation', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue(openWorker);
    const [req, ctx] = makeRequest('42', { corrections: 'Only do point 1, skip point 2.' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);

    const inserted = mockTasksValues.mock.calls[0][0];
    const correctionIdx = inserted.description.indexOf('Only do point 1, skip point 2.');
    const recommendationIdx = inserted.description.indexOf('Guard the null-overwrite in heartbeat/route.ts.');
    expect(correctionIdx).toBeGreaterThan(-1);
    expect(recommendationIdx).toBeGreaterThan(-1);
    expect(correctionIdx).toBeLessThan(recommendationIdx);
    expect(inserted.context.corrections).toBe('Only do point 1, skip point 2.');
  });

  it('returns the existing task id on a duplicate (double-tap) dispatch', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue(openWorker);
    mockTasksReturning.mockResolvedValue([]);
    mockTasksFindFirst.mockResolvedValue({ id: 'existing-task-1' });
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, dispatched: false, taskId: 'existing-task-1' });
    expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
    expect(mockWakeTask).not.toHaveBeenCalled();
    expect(mockSupersedeAncestorEscalations).not.toHaveBeenCalled();
  });
});


describe('POST /api/prs/[prNumber]/apply-recommendation — signed landing link', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockResolveOpenWorkerForUser.mockReset();
    mockMissionNotesFindMany.mockReset();
    mockMissionNotesFindMany.mockResolvedValue([]);
    mockAnnounceTaskCreated.mockReset();
    mockWakeTask.mockReset();
    mockPerformLandingAction.mockReset();
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue(openWorker);
  });

  const body = { workspaceId: 'ws-1', token: 'signed.token', action: 'conflict' };
  const doneOk = { status: 'done', ok: true, stale: false, liveHeadSha: null, result: { action: 'conflict', summary: 'Conflict resolution dispatched.', taskId: 'c1' } };

  it('still requires a session: a bare signed link is not enough', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const [req, ctx] = makeRequest('42', body);
    expect((await POST(req, ctx)).status).toBe(401);
    expect(mockPerformLandingAction).not.toHaveBeenCalled();
  });

  it('runs the landing action for the session-resolved PR owner, not the escalation path', async () => {
    mockPerformLandingAction.mockResolvedValue(doneOk);
    const [req, ctx] = makeRequest('42', body);
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).result.summary).toBe('Conflict resolution dispatched.');
    expect(mockPerformLandingAction).toHaveBeenCalledWith({
      token: 'signed.token',
      action: 'conflict',
      workspaceId: 'ws-1',
      prNumber: 42,
      taskId: 't-1',
      workerId: 'w-1',
    });
    // No open escalation note is needed for a landing tap.
    expect(mockMissionNotesFindMany).not.toHaveBeenCalled();
    expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
    expect(mockWakeTask).not.toHaveBeenCalled();
  });

  it('rejects an expired link with 410 and a replayed one with 200 alreadyDone', async () => {
    mockPerformLandingAction.mockResolvedValueOnce({ status: 'rejected', code: 'expired', httpStatus: 410 });
    let [req, ctx] = makeRequest('42', body);
    let res = await POST(req, ctx);
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe('expired');

    mockPerformLandingAction.mockResolvedValueOnce({ status: 'already_done', result: doneOk.result });
    [req, ctx] = makeRequest('42', body);
    res = await POST(req, ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).alreadyDone).toBe(true);
  });

  it('409 while another tap is in flight; 502 when the action fails', async () => {
    mockPerformLandingAction.mockResolvedValueOnce({ status: 'in_progress' });
    let [req, ctx] = makeRequest('42', body);
    expect((await POST(req, ctx)).status).toBe(409);

    mockPerformLandingAction.mockResolvedValueOnce({ status: 'done', ok: false, stale: false, error: 'boom' });
    [req, ctx] = makeRequest('42', body);
    const res = await POST(req, ctx);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('boom');
  });

  it('404 when the PR has no owning task', async () => {
    mockResolveOpenWorkerForUser.mockResolvedValue({ ...openWorker, taskId: null, task: null });
    const [req, ctx] = makeRequest('42', body);
    expect((await POST(req, ctx)).status).toBe(404);
  });
});
