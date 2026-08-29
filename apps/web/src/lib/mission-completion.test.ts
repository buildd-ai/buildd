import { describe, it, expect, beforeEach, mock } from 'bun:test';

/**
 * The one mission-completion predicate.
 *
 * These tests are the regression suite for mission 01718005 ("M2"), which
 * completed and archived while holding two pending deliverables and with all
 * four goal criteria reading "not yet evaluated" — not failed, not overridden,
 * never asked. Two independent holes had to line up for that: the heartbeat was
 * exempt from the criteria guard, and the evaluator refused to run while pending
 * tasks remained. The second is the interesting one, and it is covered here:
 * when the work is done and no verdict exists, the predicate PULLS one.
 */

// ── Mock state ────────────────────────────────────────────────────────────────
let missionRow: any = null;
let taskRows: any[] = [];
let recentNotes: any[] = [];
let missionUpdateReturning: any[] = [{ id: 'm1', scheduleId: null }];
let releaseTaskRows: any[] = [];
let workerRow: any = null;
const updateCalls: Array<{ table: unknown; data: any }> = [];
const insertedRows: any[] = [];

const mockTriggerEvent = mock(() => Promise.resolve());
const mockUnblock = mock(() => Promise.resolve());
const mockEnsureCriteriaVerdict = mock((_id: string, _opts: any) => Promise.resolve(null) as any);
const mockFireMissionRelease = mock((..._args: any[]) => Promise.resolve());

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
  and: (...args: any[]) => ({ _op: 'and', args }),
  gte: (...args: any[]) => ({ _op: 'gte', args }),
  desc: (col: any) => ({ _op: 'desc', col }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: Symbol('missions'),
  tasks: Symbol('tasks'),
  taskSchedules: Symbol('taskSchedules'),
  missionNotes: Symbol('missionNotes'),
}));

// Uses the REAL @buildd/core/mission-helpers so isDeliverableTask's actual rules
// (taskClass, housekeeping titles, planning mode) are under test here.
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: () => Promise.resolve(missionRow) },
      tasks: { findMany: () => Promise.resolve(taskRows) },
      missionNotes: { findMany: () => Promise.resolve(recentNotes) },
      workers: { findFirst: () => Promise.resolve(workerRow) },
    },
    // db.select(...).from(tasks).where(...).orderBy(...).limit(n) — the release
    // attempt's lookup for a task/worker pair.
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: () => Promise.resolve(releaseTaskRows) }) }),
      }),
    }),
    update: (table: unknown) => ({
      set: (data: any) => {
        updateCalls.push({ table, data });
        return {
          where: () => {
            const p: any = Promise.resolve(missionUpdateReturning);
            p.returning = () => Promise.resolve(missionUpdateReturning);
            return p;
          },
        };
      },
    }),
    insert: () => ({
      values: (v: any) => { insertedRows.push(v); return Promise.resolve([]); },
    }),
  },
}));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { mission: (id: string) => `mission-${id}` },
  events: {
    MISSION_LOOP_COMPLETED: 'mission:loop_completed',
    MISSION_COMPLETION_DECISION: 'mission:completion_decision',
  },
}));

mock.module('@/lib/mission-dependency', () => ({
  checkAndUnblockDependentMissions: mockUnblock,
}));

mock.module('@/lib/mission-criteria-eval', () => ({
  ensureCriteriaVerdict: mockEnsureCriteriaVerdict,
}));

mock.module('@/lib/mission-release', () => ({
  fireMissionReleaseIfComplete: mockFireMissionRelease,
}));

import {
  canCompleteMission,
  completeMissionIfVerified,
  isCriteriaBlockCode,
  CRITERIA_BLOCK_CODES,
  AWAITING_VERIFICATION_NOTE_TITLE,
} from './mission-completion';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function activeMission(overrides: Record<string, unknown> = {}) {
  missionRow = {
    id: 'm1',
    title: 'M2 — Readiness + trigger',
    status: 'active',
    goalCriteria: null,
    goalCriteriaState: null,
    autoVerify: null,
    ...overrides,
  };
}

/** A work row. taskClass defaults to 'work' in the schema, as real rows do. */
function work(status: string, title = 'Build the thing', extra: Record<string, unknown> = {}) {
  return { id: `t-${title}-${status}`, status, title, taskClass: 'work', mode: 'execution', result: null, ...extra };
}

function housekeeping(status: string, title = 'Aggregate results: cycle 1') {
  return { id: `h-${status}`, status, title, taskClass: 'bookkeeping', mode: 'planning', result: null };
}

const PASSING_STATE = {
  evaluatedAt: '2026-08-29T12:00:00.000Z',
  evaluatedBy: 'auto',
  overall: 'pass',
  criteria: [{ index: 0, type: 'command', verdict: 'pass', evidence: '`bun test` exited 0' }],
};

function reset() {
  missionRow = null;
  taskRows = [];
  recentNotes = [];
  missionUpdateReturning = [{ id: 'm1', scheduleId: null }];
  releaseTaskRows = [{ taskId: 't-done', workspaceId: 'ws-1' }];
  workerRow = { id: 'w-done' };
  updateCalls.length = 0;
  insertedRows.length = 0;
  mockTriggerEvent.mockReset();
  mockTriggerEvent.mockImplementation(() => Promise.resolve());
  mockUnblock.mockReset();
  mockUnblock.mockImplementation(() => Promise.resolve());
  mockEnsureCriteriaVerdict.mockReset();
  mockEnsureCriteriaVerdict.mockImplementation(() => Promise.resolve(null) as any);
  mockFireMissionRelease.mockReset();
  mockFireMissionRelease.mockImplementation(() => Promise.resolve());
}

/** A real CI-retry row: taskClass 'attempt', which is NOT a deliverable. */
function attempt(status: string, title = '[CI Retry #1] Implement feature X') {
  return { id: `a-${status}`, status, title, taskClass: 'attempt', mode: 'execution', result: null };
}

/** The exact shape `dispatchCommandCriterionTask` inserts. */
function verificationTask(status: string) {
  return {
    id: `v-${status}`, status, title: 'Verify goal criterion: bun test',
    taskClass: 'bookkeeping', mode: 'execution', result: null,
  };
}

// ── canCompleteMission ────────────────────────────────────────────────────────

describe('canCompleteMission — mission state', () => {
  beforeEach(reset);

  it('refuses a mission that does not exist', async () => {
    missionRow = null;
    const d = await canCompleteMission('gone');
    expect(d.ok).toBe(false);
    expect(d.code).toBe('mission_not_found');
  });

  it('refuses a paused mission', async () => {
    activeMission({ status: 'paused' });
    const d = await canCompleteMission('m1');
    expect(d.ok).toBe(false);
    expect(d.code).toBe('mission_not_active');
  });

  it('refuses an already-completed mission by default (keeps the write idempotent)', async () => {
    activeMission({ status: 'completed' });
    const d = await canCompleteMission('m1');
    expect(d.ok).toBe(false);
    expect(d.code).toBe('mission_not_active');
  });

  it('accepts an already-completed mission for acceptCompleted callers (the release trigger)', async () => {
    activeMission({ status: 'completed' });
    const d = await canCompleteMission('m1', { acceptCompleted: true });
    expect(d.ok).toBe(true);
    expect(d.reason).toContain('already completed');
  });

  it('accepts an archived mission for acceptCompleted callers too', async () => {
    // It passed the gate when it closed; a late task finishing in it must not
    // silently skip its release.
    activeMission({ status: 'archived' });
    const d = await canCompleteMission('m1', { acceptCompleted: true });
    expect(d.ok).toBe(true);
  });
});

describe('canCompleteMission — task rows', () => {
  beforeEach(reset);

  it('M2: refuses with the pending count when deliverables are still open', async () => {
    activeMission();
    taskRows = [
      work('completed', 'PR 1'), work('completed', 'PR 2'), work('completed', 'PR 3'),
      work('completed', 'PR 4'), work('completed', 'PR 5'), work('completed', 'PR 6'),
      work('pending', 'pluggable batched evaluator'),
      work('pending', 'metric query registry'),
    ];

    const d = await canCompleteMission('m1');

    expect(d.ok).toBe(false);
    expect(d.code).toBe('pending_deliverables');
    expect(d.pendingDeliverables).toBe(2);
    expect(d.pendingByStatus).toEqual({ pending: 2 });
    // The reason names the blocker — this is the sentence the heartbeat never said.
    expect(d.reason).toContain('2 task(s) still open');
    expect(d.reason).toContain('2 pending');
  });

  it('does not spend an evaluation while deliverables are pending', async () => {
    activeMission({ goalCriteria: [{ type: 'no_open_tasks' }] });
    taskRows = [work('completed'), work('in_progress', 'still going')];

    const d = await canCompleteMission('m1');

    expect(d.code).toBe('pending_deliverables');
    expect(mockEnsureCriteriaVerdict).not.toHaveBeenCalled();
  });

  it('refuses a mission with no deliverable rows when nothing proposed completion', async () => {
    activeMission();
    taskRows = [housekeeping('completed'), housekeeping('completed', 'Mission: plan')];

    const d = await canCompleteMission('m1');
    expect(d.ok).toBe(false);
    expect(d.code).toBe('no_deliverables');
  });

  it('lets a PROPOSAL close a monitoring mission whose only rows are heartbeat cycles', async () => {
    // A watcher mission ("observe X, close when resolved") produces bookkeeping
    // planning rows and nothing else. Refusing those unconditionally left every
    // such mission unable to ever close once the heartbeat's fast path was
    // removed — the worst regression in the first cut of this change.
    activeMission();
    taskRows = [housekeeping('completed', 'Mission: watch the thing')];

    const d = await canCompleteMission('m1', { proposed: true });
    expect(d.ok).toBe(true);
  });

  it('allows completion while housekeeping rows are still pending, and reports them', async () => {
    activeMission();
    taskRows = [work('completed'), housekeeping('in_progress')];

    const d = await canCompleteMission('m1');
    expect(d.ok).toBe(true);
    expect(d.pendingDeliverables).toBe(0);
    // The release trigger uses this to hold off until every row settles.
    expect(d.pendingAllTasks).toBe(1);
  });

  it('regression: a pending CI-retry row (taskClass attempt) blocks completion', async () => {
    // The real shape. `isDeliverableTask` says an 'attempt' row is not a
    // deliverable, so counting only deliverables let a mission close with CI red
    // and a retry in flight — the exact case the originating task named.
    activeMission();
    taskRows = [work('completed', 'Implement feature X'), attempt('pending')];

    const d = await canCompleteMission('m1');
    expect(d.ok).toBe(false);
    expect(d.code).toBe('pending_deliverables');
    expect(d.pendingDeliverables).toBe(1);
  });

  it('regression: a pending CI-retry row in the legacy shape (no taskClass) also blocks', async () => {
    activeMission();
    taskRows = [
      work('completed', 'Implement feature X'),
      { id: 'r1', status: 'pending', title: '[CI Retry #1] Implement feature X', mode: 'execution', result: null },
    ];

    const d = await canCompleteMission('m1');
    expect(d.code).toBe('pending_deliverables');
  });

  it('a pending goal-criterion verification task does NOT block — it would block on itself', async () => {
    // The deadlock guard, pinned against the real inserted shape rather than a
    // fixture that is non-deliverable for three unrelated reasons.
    activeMission();
    taskRows = [work('completed'), verificationTask('in_progress')];

    const d = await canCompleteMission('m1');
    expect(d.ok).toBe(true);
    expect(d.pendingDeliverables).toBe(0);
    expect(d.pendingAllTasks).toBe(1);
  });

  it('allows completion when every deliverable was cancelled (the work was called off)', async () => {
    activeMission();
    taskRows = [work('cancelled', 'A'), work('cancelled', 'B')];

    const d = await canCompleteMission('m1');
    expect(d.ok).toBe(true);
    expect(d.deliverableStatusCounts).toEqual({ cancelled: 2 });
  });

  it('refuses — and names the tasks — when a deliverable is infra-stalled', async () => {
    activeMission();
    taskRows = [
      work('completed', 'A'),
      work('failed', 'Deploy the worker', { result: { errorType: 'infra_stalled' } }),
    ];

    const d = await canCompleteMission('m1');
    expect(d.ok).toBe(false);
    expect(d.code).toBe('infra_stalled');
    expect(d.infraStalledTitles).toEqual(['Deploy the worker']);
    expect(d.reason).toContain('Deploy the worker');
  });

  it('allows completion when deliverables are a mix of completed and (non-infra) failed', async () => {
    activeMission();
    taskRows = [work('completed', 'A'), work('failed', 'B')];

    const d = await canCompleteMission('m1');
    expect(d.ok).toBe(true);
    expect(d.deliverableStatusCounts).toEqual({ completed: 1, failed: 1 });
  });
});

describe('canCompleteMission — the goal-criteria gate', () => {
  beforeEach(reset);

  it('passes a mission with no stated criteria, and says so rather than claiming a pass', async () => {
    activeMission({ goalCriteria: [] });
    taskRows = [work('completed')];

    const d = await canCompleteMission('m1');
    expect(d.ok).toBe(true);
    expect(d.criteriaVerdict).toBe('none');
    expect(d.criteriaCount).toBe(0);
  });

  it('PULLS a verdict when the work is done and criteria are stated', async () => {
    // This is the inversion. The old evaluator skipped whenever pending tasks
    // remained, so the only moment it would have spoken was one nobody asked at.
    activeMission({ goalCriteria: [{ type: 'command', command: 'bun test' }] });
    taskRows = [work('completed')];
    mockEnsureCriteriaVerdict.mockImplementation(() => Promise.resolve(PASSING_STATE) as any);

    const d = await canCompleteMission('m1', { path: 'heartbeat' });

    expect(mockEnsureCriteriaVerdict).toHaveBeenCalledWith('m1', { trigger: 'heartbeat' });
    expect(d.ok).toBe(true);
    expect(d.criteriaVerdict).toBe('pass');
    expect(d.criteriaEvaluatedAt).toBe(PASSING_STATE.evaluatedAt);
  });

  it('M2: refuses when the evaluator produces no verdict — unevaluated is not a pass', async () => {
    activeMission({
      goalCriteria: [
        { type: 'description', description: 'Rows exist' },
        { type: 'description', description: 'No double-fire' },
      ],
    });
    taskRows = [work('completed')];
    mockEnsureCriteriaVerdict.mockImplementation(() => Promise.resolve(null) as any);

    const d = await canCompleteMission('m1');

    expect(d.ok).toBe(false);
    expect(d.code).toBe('criteria_unverified');
    expect(d.criteriaVerdict).toBe('NOT_EVALUATED');
  });

  it('refuses with the failing criteria named when the verdict is fail', async () => {
    activeMission({ goalCriteria: [{ type: 'all_prs_merged' }] });
    taskRows = [work('completed')];
    mockEnsureCriteriaVerdict.mockImplementation(() => Promise.resolve({
      evaluatedAt: '2026-08-29T12:00:00.000Z',
      evaluatedBy: 'auto',
      overall: 'fail',
      criteria: [{ index: 0, type: 'all_prs_merged', verdict: 'fail', evidence: '1 PR(s) not yet merged', label: 'PRs merged' }],
    }) as any);

    const d = await canCompleteMission('m1');
    expect(d.ok).toBe(false);
    expect(d.code).toBe('criteria_failed');
    expect(d.reason).toContain('PRs merged');
    expect(d.reason).toContain('1 PR(s) not yet merged');
  });

  it('refuses with criteria_pending while a verification run is in flight', async () => {
    activeMission({ goalCriteria: [{ type: 'command', command: 'bun test' }] });
    taskRows = [work('completed')];
    mockEnsureCriteriaVerdict.mockImplementation(() => Promise.resolve({
      evaluatedAt: '2026-08-29T12:00:00.000Z',
      evaluatedBy: 'auto',
      overall: 'UNVERIFIED',
      criteria: [{ index: 0, type: 'command', verdict: 'PENDING', evidence: 'Verification task abcd1234 dispatched: bun test', workerTaskId: 'abcd1234' }],
    }) as any);

    const d = await canCompleteMission('m1');
    expect(d.ok).toBe(false);
    expect(d.code).toBe('criteria_pending');
    expect(d.reason).toContain('in flight');
  });

  it('uses the stored verdict without evaluating when evaluateCriteria=false', async () => {
    activeMission({ goalCriteria: [{ type: 'command', command: 'bun test' }], goalCriteriaState: PASSING_STATE });
    taskRows = [work('completed')];

    const d = await canCompleteMission('m1', { evaluateCriteria: false });

    expect(mockEnsureCriteriaVerdict).not.toHaveBeenCalled();
    expect(d.ok).toBe(true);
    expect(d.criteriaVerdict).toBe('pass');
  });
});

// ── completeMissionIfVerified ─────────────────────────────────────────────────

describe('canCompleteMission — diagnosability', () => {
  beforeEach(reset);

  it('reports the stored verdict on an early refusal, never "none" when criteria exist', async () => {
    // The decision event is the diagnostic record. Reporting `criteriaVerdict:
    // 'none'` for a mission with four criteria told a reader the opposite of the
    // truth in exactly the M2 case.
    activeMission({
      goalCriteria: [{ type: 'no_open_tasks' }, { type: 'all_prs_merged' }],
      goalCriteriaState: { evaluatedAt: '2026-08-29T10:00:00.000Z', evaluatedBy: 'auto', overall: 'UNVERIFIED', criteria: [] },
    });
    taskRows = [work('completed'), work('pending', 'still going')];

    const d = await canCompleteMission('m1');

    expect(d.code).toBe('pending_deliverables');
    expect(d.criteriaCount).toBe(2);
    expect(d.criteriaVerdict).toBe('UNVERIFIED');
    expect(d.criteriaVerdict).not.toBe('none');
  });

  it('reports NOT_EVALUATED (not "none") when criteria exist but were never evaluated', async () => {
    activeMission({ goalCriteria: [{ type: 'no_open_tasks' }] });
    taskRows = [work('pending', 'still going')];

    const d = await canCompleteMission('m1');
    expect(d.criteriaVerdict).toBe('NOT_EVALUATED');
  });

  it('every criteria refusal is recognised by isCriteriaBlockCode', async () => {
    // The loop branches on this classification. A prefix match in another module
    // would silently stop matching the day a code is renamed; this pins the
    // contract against the real predicate.
    const verdicts: Array<[string, string]> = [
      ['fail', 'criteria_failed'],
      ['UNVERIFIED', 'criteria_unverified'],
    ];
    for (const [overall, expectedCode] of verdicts) {
      reset();
      activeMission({ goalCriteria: [{ type: 'no_open_tasks' }] });
      taskRows = [work('completed')];
      mockEnsureCriteriaVerdict.mockImplementation(() => Promise.resolve({
        evaluatedAt: '2026-08-29T12:00:00.000Z',
        evaluatedBy: 'auto',
        overall,
        criteria: [{ index: 0, type: 'no_open_tasks', verdict: overall === 'fail' ? 'fail' : 'UNVERIFIED' }],
      }) as any);

      const d = await canCompleteMission('m1');
      expect(d.code).toBe(expectedCode as any);
      expect(isCriteriaBlockCode(d.code)).toBe(true);
    }
  });

  it('CRITERIA_BLOCK_CODES lists exactly the criteria_* codes', () => {
    expect([...CRITERIA_BLOCK_CODES].sort()).toEqual(['criteria_failed', 'criteria_pending', 'criteria_unverified']);
  });
});

describe('completeMissionIfVerified — allowed', () => {
  beforeEach(reset);

  it('writes completion, disables the schedule, notes it, unblocks dependents', async () => {
    activeMission();
    taskRows = [work('completed')];
    missionUpdateReturning = [{ id: 'm1', scheduleId: 's1' }];

    const result = await completeMissionIfVerified('m1', { path: 'dormancy' });

    expect(result.completed).toBe(true);
    expect(updateCalls.some(c => c.data.status === 'completed')).toBe(true);
    expect(updateCalls.some(c => c.data.enabled === false)).toBe(true);
    expect(insertedRows.some(r => r.title === 'Mission completed')).toBe(true);
    expect(mockUnblock).toHaveBeenCalledWith('m1', 'completed');
    expect(mockTriggerEvent).toHaveBeenCalledWith('mission-m1', 'mission:loop_completed', expect.objectContaining({ missionId: 'm1' }));
  });

  it('asks the release trigger to reconsider once the mission closes', async () => {
    // The gate clearing IS the moment an on_mission_complete release becomes due.
    // Previously the release could only be attempted from a worker-completion
    // PATCH, so a verdict that turned green anywhere else left the mission
    // reading COMPLETE with nothing deployed and no error anywhere.
    activeMission();
    taskRows = [work('completed')];

    await completeMissionIfVerified('m1', { path: 'criteria_eval' });
    // Fire-and-forget on purpose: a GitHub round-trip must not extend the
    // worker-completion request, and a release failure must not un-complete the
    // mission. Flush the queue to observe it.
    await new Promise(r => setTimeout(r, 0));

    expect(mockFireMissionRelease).toHaveBeenCalledWith('ws-1', 'm1', 't-done', 'w-done');
  });

  it('does not attempt a release when the completion was refused', async () => {
    activeMission();
    taskRows = [work('completed'), work('pending', 'X')];

    await completeMissionIfVerified('m1', { path: 'dormancy' });
    await new Promise(r => setTimeout(r, 0));

    expect(mockFireMissionRelease).not.toHaveBeenCalled();
  });

  it('records the predicate inputs on the decision event (allowed)', async () => {
    activeMission({ goalCriteria: [{ type: 'command', command: 'bun test' }] });
    taskRows = [work('completed'), work('failed', 'B')];
    mockEnsureCriteriaVerdict.mockImplementation(() => Promise.resolve(PASSING_STATE) as any);

    await completeMissionIfVerified('m1', { path: 'heartbeat', predicate: 'task pt1 result.missionComplete=true', proposed: true });

    const call = mockTriggerEvent.mock.calls.find((c: any[]) => c[1] === 'mission:completion_decision');
    expect(call).toBeDefined();
    expect((call as any[])[2]).toMatchObject({
      path: 'heartbeat',
      allowed: true,
      code: 'ok',
      pendingDeliverables: 0,
      criteriaVerdict: 'pass',
      criteriaCount: 1,
      predicate: 'task pt1 result.missionComplete=true',
      deliverableStatusCounts: { completed: 1, failed: 1 },
    });
  });

  it('reports not-completed when another caller won the atomic active → completed race', async () => {
    activeMission();
    taskRows = [work('completed')];
    missionUpdateReturning = []; // WHERE status='active' matched nothing

    const result = await completeMissionIfVerified('m1', { path: 'dormancy' });

    expect(result.completed).toBe(false);
    expect(result.decision.code).toBe('mission_not_active');
    expect(insertedRows.some(r => r.title === 'Mission completed')).toBe(false);
  });
});

describe('completeMissionIfVerified — refused', () => {
  beforeEach(reset);

  it('M2: a heartbeat proposal with pending deliverables neither completes nor stays silent', async () => {
    activeMission();
    taskRows = [work('completed', 'PR 1'), work('pending', 'batched evaluator'), work('pending', 'metric registry')];

    const result = await completeMissionIfVerified('m1', {
      path: 'heartbeat',
      predicate: 'task pt1 result.missionComplete=true',
      proposed: true,
    });

    expect(result.completed).toBe(false);
    expect(updateCalls.some(c => c.data.status === 'completed')).toBe(false);

    const note = insertedRows.find(r => r.title === AWAITING_VERIFICATION_NOTE_TITLE);
    expect(note).toBeDefined();
    expect(note.body).toContain('2 task(s) still open');
    expect(note.body).toContain('awaiting verification');
    expect(note.type).toBe('warning');

    const call = mockTriggerEvent.mock.calls.find((c: any[]) => c[1] === 'mission:completion_decision');
    expect((call as any[])[2]).toMatchObject({ allowed: false, code: 'pending_deliverables', pendingDeliverables: 2 });
  });

  it('does not note a still-working mission when nothing proposed completion', async () => {
    activeMission();
    taskRows = [work('completed'), work('in_progress', 'still going')];

    const result = await completeMissionIfVerified('m1', { path: 'criteria_eval' });

    expect(result.completed).toBe(false);
    // One note per task completion would drown the feed; the decision event still fires.
    expect(insertedRows).toHaveLength(0);
    expect(mockTriggerEvent).toHaveBeenCalled();
  });

  it('always notes a criteria block, proposal or not — this is the question that went unasked', async () => {
    activeMission({ goalCriteria: [{ type: 'description', description: 'Rows exist' }] });
    taskRows = [work('completed')];
    mockEnsureCriteriaVerdict.mockImplementation(() => Promise.resolve({
      evaluatedAt: '2026-08-29T12:00:00.000Z',
      evaluatedBy: 'auto',
      overall: 'UNVERIFIED',
      criteria: [{ index: 0, type: 'description', verdict: 'NOT_EVALUATED', evidence: 'LLM evaluator not configured' }],
    }) as any);

    await completeMissionIfVerified('m1', { path: 'criteria_eval' });

    const note = insertedRows.find(r => r.title === AWAITING_VERIFICATION_NOTE_TITLE);
    expect(note).toBeDefined();
    expect(note.body).toContain('LLM evaluator not configured');
  });

  it('emits no decision event when nothing was decided (mission already closed)', async () => {
    activeMission({ status: 'completed' });

    await completeMissionIfVerified('m1', { path: 'criteria_eval' });

    const call = mockTriggerEvent.mock.calls.find((c: any[]) => c[1] === 'mission:completion_decision');
    expect(call).toBeUndefined();
  });

  it('dedups the block note on the decision code, not the volatile detail', async () => {
    // The reason embeds counts and task ids that change every round, so deduping
    // on the whole body produced a fresh "duplicate" note per heartbeat.
    activeMission();
    taskRows = [work('completed'), work('pending', 'X'), work('pending', 'Y')];
    recentNotes = [{ body: '[pending_deliverables] 5 task(s) still open (5 pending)\n\nolder round' }];

    await completeMissionIfVerified('m1', { path: 'heartbeat', proposed: true });

    expect(insertedRows.filter(r => r.title === AWAITING_VERIFICATION_NOTE_TITLE)).toHaveLength(0);
  });

  it('does not re-post an identical block note within the window', async () => {
    activeMission();
    taskRows = [work('completed'), work('pending', 'X')];
    // Simulate the note this call would write already existing from an earlier tick.
    const firstRun = await completeMissionIfVerified('m1', { path: 'heartbeat', proposed: true });
    expect(firstRun.completed).toBe(false);
    const firstNote = insertedRows.find(r => r.title === AWAITING_VERIFICATION_NOTE_TITLE);
    recentNotes = [{ body: firstNote.body }];
    insertedRows.length = 0;

    await completeMissionIfVerified('m1', { path: 'heartbeat', proposed: true });

    expect(insertedRows).toHaveLength(0);
  });

  it('does not note (or write) when the mission has already left the active state', async () => {
    activeMission({ status: 'archived' });

    const result = await completeMissionIfVerified('m1', { path: 'heartbeat', proposed: true });

    expect(result.completed).toBe(false);
    expect(insertedRows).toHaveLength(0);
  });
});
