import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Mock state ──
let missionsFindFirstResult: any = null;
let tasksFindManyResult: any[] = [];
let selectResults: number[] = [];
let selectCallCount = 0;

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
  and: (...args: any[]) => ({ _op: 'and', args }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: any[]) => ({ _op: 'sql' }),
    { raw: (s: string) => s }
  ),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: Symbol('missions'),
  tasks: Symbol('tasks'),
  artifacts: Symbol('artifacts'),
  missionNotes: Symbol('missionNotes'),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: {
        findFirst: () => Promise.resolve(missionsFindFirstResult),
      },
      tasks: {
        findMany: () => Promise.resolve(tasksFindManyResult),
      },
    },
    select: () => ({
      from: () => ({
        where: () => {
          const idx = selectCallCount++;
          return Promise.resolve([{ count: selectResults[idx] ?? 0 }]);
        },
      }),
    }),
  },
}));

import { computeStateKey, evaluateHeartbeatPrepass, classifyMissionWait, type HeartbeatMissionState } from './heartbeat-prepass';

function resetAll() {
  missionsFindFirstResult = null;
  tasksFindManyResult = [];
  selectResults = [];
  selectCallCount = 0;
}

const BASE_INPUT = {
  missionId: 'm1',
  dependsOnMissionId: null as string | null,
  gateCondition: 'merged' as const,
  dependencyMetAt: null as Date | null,
  lastHeartbeatStateHash: null as string | null,
};

// ── computeStateKey ───────────────────────────────────────────────────────────

describe('computeStateKey', () => {
  it('returns a stable string key for a given state', () => {
    const state: HeartbeatMissionState = {
      completedCount: 3,
      activeCount: 1,
      failedCount: 0,
      artifactCount: 2,
      prCount: 1,
      noteCount: 0,
    };
    expect(computeStateKey(state)).toBe('c3a1f0ar2pr1n0');
  });

  it('returns different keys for different states', () => {
    const a: HeartbeatMissionState = { completedCount: 1, activeCount: 0, failedCount: 0, artifactCount: 0, prCount: 0, noteCount: 0 };
    const b: HeartbeatMissionState = { completedCount: 2, activeCount: 0, failedCount: 0, artifactCount: 0, prCount: 0, noteCount: 0 };
    expect(computeStateKey(a)).not.toBe(computeStateKey(b));
  });

  it('is a pure function — same input, same output', () => {
    const state: HeartbeatMissionState = { completedCount: 5, activeCount: 2, failedCount: 1, artifactCount: 3, prCount: 2, noteCount: 4 };
    expect(computeStateKey(state)).toBe(computeStateKey(state));
  });
});

// ── evaluateHeartbeatPrepass ──────────────────────────────────────────────────

describe('evaluateHeartbeatPrepass', () => {
  beforeEach(resetAll);

  // ── Dependency gate ──

  it('returns skip_blocked when upstream dependency is unmet', async () => {
    // isMissionBlocked queries missions for the upstream
    missionsFindFirstResult = { id: 'upstream', title: 'Upstream Mission', status: 'active' };
    tasksFindManyResult = [];
    selectResults = [0, 0]; // artifacts, notes

    const result = await evaluateHeartbeatPrepass({
      ...BASE_INPUT,
      dependsOnMissionId: 'upstream',
      dependencyMetAt: null,
    });
    expect(result.action).toBe('skip_blocked');
  });

  it('returns invoke_llm when dependency is cleared (dependencyMetAt set)', async () => {
    // dependencyMetAt set → isMissionBlocked returns false
    tasksFindManyResult = [];
    selectResults = [0, 0]; // artifacts, notes

    const result = await evaluateHeartbeatPrepass({
      ...BASE_INPUT,
      dependsOnMissionId: 'upstream',
      dependencyMetAt: new Date(),
    });
    expect(result.action).toBe('invoke_llm');
  });

  it('returns invoke_llm when no dependency configured', async () => {
    tasksFindManyResult = [];
    selectResults = [0, 0];

    const result = await evaluateHeartbeatPrepass(BASE_INPUT);
    expect(result.action).toBe('invoke_llm');
  });

  // ── All deliverables done → skip_complete ──

  it('returns skip_complete when all deliverable tasks are completed', async () => {
    tasksFindManyResult = [
      { title: 'Build feature A', mode: 'execution', status: 'completed', result: null },
      { title: 'Write tests', mode: 'execution', status: 'completed', result: null },
    ];
    selectResults = [0, 0]; // artifacts, notes

    const result = await evaluateHeartbeatPrepass(BASE_INPUT);
    expect(result.action).toBe('skip_complete');
  });

  it('returns skip_complete when all deliverables are in terminal state (mixed completed/failed)', async () => {
    tasksFindManyResult = [
      { title: 'Build feature A', mode: 'execution', status: 'completed', result: null },
      { title: 'Deploy to prod', mode: 'execution', status: 'failed', result: null },
    ];
    selectResults = [0, 0];

    const result = await evaluateHeartbeatPrepass(BASE_INPUT);
    expect(result.action).toBe('skip_complete');
  });

  it('returns skip_complete when all deliverables are terminal including cancelled (cancelled = "never happened")', async () => {
    tasksFindManyResult = [
      { title: 'Build feature A', mode: 'execution', status: 'completed', result: null },
      { title: 'Build feature A (duplicate)', mode: 'execution', status: 'cancelled', result: null },
      { title: 'Build feature A (duplicate 2)', mode: 'execution', status: 'cancelled', result: null },
    ];
    selectResults = [0, 0];

    const result = await evaluateHeartbeatPrepass(BASE_INPUT);
    expect(result.action).toBe('skip_complete');
  });

  it('does not skip_complete when cancelled tasks are the only deliverables (no real work done)', async () => {
    // All cancelled — no completed work at all → should not auto-complete
    tasksFindManyResult = [
      { title: 'Build feature A', mode: 'execution', status: 'cancelled', result: null },
    ];
    selectResults = [0, 0];

    const result = await evaluateHeartbeatPrepass(BASE_INPUT);
    // Cancelled-only → deliverables.length > 0 but no completed → should NOT skip_complete
    expect(result.action).not.toBe('skip_complete');
  });

  it('does not skip_complete when some deliverable tasks are still active', async () => {
    tasksFindManyResult = [
      { title: 'Build feature A', mode: 'execution', status: 'completed', result: null },
      { title: 'Write tests', mode: 'execution', status: 'in_progress', result: null },
    ];
    selectResults = [0, 0];

    const result = await evaluateHeartbeatPrepass(BASE_INPUT);
    expect(result.action).not.toBe('skip_complete');
  });

  it('does not skip_complete when there are no deliverable tasks', async () => {
    tasksFindManyResult = []; // no tasks at all
    selectResults = [0, 0];

    const result = await evaluateHeartbeatPrepass(BASE_INPUT);
    expect(result.action).not.toBe('skip_complete');
  });

  it('ignores planning tasks when checking skip_complete', async () => {
    tasksFindManyResult = [
      { title: 'Mission: Organizer', mode: 'planning', status: 'completed', result: null },
      { title: 'Aggregate results: cycle 1', mode: 'planning', status: 'completed', result: null },
    ];
    selectResults = [0, 0];

    // Only planning tasks → no deliverables → should NOT skip_complete
    const result = await evaluateHeartbeatPrepass(BASE_INPUT);
    expect(result.action).not.toBe('skip_complete');
  });

  // ── No state change → skip_no_change ──

  it('returns skip_no_change when state hash matches and there are deliverables and no PRs', async () => {
    tasksFindManyResult = [
      { title: 'Build feature A', mode: 'execution', status: 'in_progress', result: null },
    ];
    selectResults = [2, 0]; // 2 artifacts, 0 notes

    // Pre-compute what the state key will be
    // completedCount=0, activeCount=1, failedCount=0, artifactCount=2, prCount=0, noteCount=0
    const expectedKey = 'c0a1f0ar2pr0n0';

    const result = await evaluateHeartbeatPrepass({
      ...BASE_INPUT,
      lastHeartbeatStateHash: expectedKey,
    });
    expect(result.action).toBe('skip_no_change');
  });

  it('does not skip_no_change when state has changed', async () => {
    tasksFindManyResult = [
      { title: 'Build feature A', mode: 'execution', status: 'in_progress', result: null },
      { title: 'Write tests', mode: 'execution', status: 'completed', result: null },
    ];
    selectResults = [0, 0];

    // Last hash was for just 1 active task (no completed)
    const result = await evaluateHeartbeatPrepass({
      ...BASE_INPUT,
      lastHeartbeatStateHash: 'c0a1f0ar0pr0n0',
    });
    // State is now c1a1f0ar0pr0n0 (one completed, one active) → mismatch
    expect(result.action).toBe('invoke_llm');
  });

  it('does not skip_no_change when there are no deliverable tasks', async () => {
    tasksFindManyResult = []; // no tasks
    selectResults = [0, 0];

    const result = await evaluateHeartbeatPrepass({
      ...BASE_INPUT,
      lastHeartbeatStateHash: 'c0a0f0ar0pr0n0',
    });
    // totalDeliverables === 0 → skip_no_change does not apply
    expect(result.action).not.toBe('skip_no_change');
  });

  it('does not skip_no_change when PRs exist (PR merge status is external state)', async () => {
    tasksFindManyResult = [
      { title: 'Build feature A', mode: 'execution', status: 'completed', result: { prUrl: 'https://github.com/owner/repo/pull/1' } },
    ];
    selectResults = [0, 0];

    // All deliverables done → goes to skip_complete before reaching no-change check
    // Let's add an active task so we skip skip_complete:
    // Actually let me use a case where there's a completed task with a PR + an active task
    tasksFindManyResult = [
      { title: 'Build feature A', mode: 'execution', status: 'completed', result: { prUrl: 'https://github.com/owner/repo/pull/1' } },
      { title: 'Write tests', mode: 'execution', status: 'pending', result: null },
    ];
    selectResults = [0, 0];

    // c1a1f0ar0pr1n0 — matches the hash, but prCount > 0 → should NOT skip
    const result = await evaluateHeartbeatPrepass({
      ...BASE_INPUT,
      lastHeartbeatStateHash: 'c1a1f0ar0pr1n0',
    });
    expect(result.action).toBe('invoke_llm');
  });

  it('does not skip_no_change when lastHeartbeatStateHash is null (first run)', async () => {
    tasksFindManyResult = [
      { title: 'Build feature A', mode: 'execution', status: 'in_progress', result: null },
    ];
    selectResults = [0, 0];

    const result = await evaluateHeartbeatPrepass({
      ...BASE_INPUT,
      lastHeartbeatStateHash: null,
    });
    expect(result.action).toBe('invoke_llm');
  });

  // ── invoke_llm ──

  it('returns invoke_llm with stateKey when state has changed', async () => {
    tasksFindManyResult = [
      { title: 'Build feature A', mode: 'execution', status: 'in_progress', result: null },
    ];
    selectResults = [1, 2]; // 1 artifact, 2 notes

    const result = await evaluateHeartbeatPrepass({
      ...BASE_INPUT,
      lastHeartbeatStateHash: 'different-key',
    });
    expect(result.action).toBe('invoke_llm');
    if (result.action === 'invoke_llm') {
      expect(result.stateKey).toBe('c0a1f0ar1pr0n2');
    }
  });

  it('counts tasks with prUrl in result as PRs', async () => {
    tasksFindManyResult = [
      { title: 'Build feature A', mode: 'execution', status: 'in_progress', result: { prUrl: 'https://github.com/x/y/pull/2' } },
    ];
    selectResults = [0, 0];

    const result = await evaluateHeartbeatPrepass({
      ...BASE_INPUT,
      lastHeartbeatStateHash: 'c0a1f0ar0pr1n0', // would match IF prCount=1 and no-change
    });
    // prCount=1 → no-change check is skipped → invoke_llm
    expect(result.action).toBe('invoke_llm');
  });

  // ── Priority of checks ──

  it('checks dependency before all-done (blocked takes priority)', async () => {
    missionsFindFirstResult = { id: 'upstream', title: 'Upstream', status: 'active' };
    // Even if deliverables are all done, blocked takes priority
    tasksFindManyResult = [
      { title: 'Build feature A', mode: 'execution', status: 'completed', result: null },
    ];
    selectResults = [0, 0];

    const result = await evaluateHeartbeatPrepass({
      ...BASE_INPUT,
      dependsOnMissionId: 'upstream',
      dependencyMetAt: null,
    });
    expect(result.action).toBe('skip_blocked');
  });

  // ── The criteria gate moved downstream (one predicate) ──
  //
  // This prepass used to hold its own goal-criteria check that could only ever
  // BLOCK — it never produced a verdict. A mission with unevaluated criteria was
  // therefore refused here on every tick while nothing anywhere produced the
  // verdict that would release it. The prepass now proposes completion and
  // `completeMissionIfVerified` decides, because that path can also EVALUATE.

  it('returns skip_complete for an ordinary mission with no criteria (must not regress)', async () => {
    tasksFindManyResult = [
      { title: 'Build feature A', mode: 'execution', status: 'completed', result: null },
    ];
    selectResults = [0, 0];

    const result = await evaluateHeartbeatPrepass(BASE_INPUT);
    expect(result.action).toBe('skip_complete');
  });

  // ── Wait, don't plan (skip_waiting) ──

  it('returns skip_waiting when the only non-terminal task is paused on a provider budget wall', async () => {
    const resetsAt = new Date(Date.now() + 60 * 60 * 1000);
    tasksFindManyResult = [
      {
        title: 'Wait for token budget reset', mode: 'execution', status: 'pending', result: null,
        taskClass: 'work', context: { budgetExhausted: true }, startAt: resetsAt, loopConfig: null, loopState: null,
      },
    ];
    selectResults = [0, 0];

    const result = await evaluateHeartbeatPrepass(BASE_INPUT);
    expect(result.action).toBe('skip_waiting');
    if (result.action === 'skip_waiting') {
      expect(result.waitUntil).toEqual(resetsAt);
      expect(result.reason).toContain('budget');
    }
  });

  it('creates zero tasks worth of decision (skip_waiting, not invoke_llm) while budget-paused, even with other queued attempts', async () => {
    const resetsAt = new Date(Date.now() + 30 * 60 * 1000);
    tasksFindManyResult = [
      {
        title: 'Wait for Claude session budget reset', mode: 'execution', status: 'pending', result: null,
        taskClass: 'work', context: { budgetExhausted: true }, startAt: resetsAt, loopConfig: null, loopState: null,
      },
      {
        title: '[reviewer] PR #42', mode: 'execution', status: 'pending', result: null,
        taskClass: 'attempt', context: null, startAt: null, loopConfig: null, loopState: null,
      },
    ];
    selectResults = [0, 0];

    const result = await evaluateHeartbeatPrepass(BASE_INPUT);
    expect(result.action).toBe('skip_waiting');
  });

  it('resumes planning once the budget reset time has passed', async () => {
    const resetsAt = new Date(Date.now() - 60 * 1000); // already in the past
    tasksFindManyResult = [
      {
        title: 'Wait for token budget reset', mode: 'execution', status: 'pending', result: null,
        taskClass: 'work', context: { budgetExhausted: true }, startAt: resetsAt, loopConfig: null, loopState: null,
      },
    ];
    selectResults = [0, 0];

    const result = await evaluateHeartbeatPrepass(BASE_INPUT);
    // No longer classifiable as waiting → falls through to normal planning.
    expect(result.action).not.toBe('skip_waiting');
    expect(result.action).toBe('invoke_llm');
  });

  it('does not skip_waiting when any task is genuinely active (real work, not a wait)', async () => {
    tasksFindManyResult = [
      {
        title: 'Wait for token budget reset', mode: 'execution', status: 'pending', result: null,
        taskClass: 'work', context: { budgetExhausted: true }, startAt: new Date(Date.now() + 60_000), loopConfig: null, loopState: null,
      },
      {
        title: 'Build feature A', mode: 'execution', status: 'in_progress', result: null,
        taskClass: 'work', context: null, startAt: null, loopConfig: null, loopState: null,
      },
    ];
    selectResults = [0, 0];

    const result = await evaluateHeartbeatPrepass(BASE_INPUT);
    expect(result.action).not.toBe('skip_waiting');
  });

  it('checks skip_waiting before skip_complete (both could technically apply to an empty non-terminal set, but waiting wins when there IS a non-terminal task)', async () => {
    const resetsAt = new Date(Date.now() + 60 * 60 * 1000);
    tasksFindManyResult = [
      { title: 'Build feature A', mode: 'execution', status: 'completed', result: null, taskClass: 'work', context: null, startAt: null, loopConfig: null, loopState: null },
      {
        title: 'Wait for token budget reset', mode: 'execution', status: 'pending', result: null,
        taskClass: 'work', context: { budgetExhausted: true }, startAt: resetsAt, loopConfig: null, loopState: null,
      },
    ];
    selectResults = [0, 0];

    const result = await evaluateHeartbeatPrepass(BASE_INPUT);
    expect(result.action).toBe('skip_waiting');
  });
});

describe('classifyMissionWait', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  it('returns null when there are no non-terminal tasks', () => {
    expect(classifyMissionWait([], now)).toBeNull();
    expect(classifyMissionWait([
      { status: 'completed', mode: 'execution', taskClass: 'work', context: null, startAt: null, loopConfig: null, loopState: null },
    ], now)).toBeNull();
  });

  it('ignores the heartbeat planning task itself', () => {
    expect(classifyMissionWait([
      { status: 'in_progress', mode: 'planning', taskClass: 'bookkeeping', context: null, startAt: null, loopConfig: null, loopState: null },
    ], now)).toBeNull();
  });

  it('classifies a loop task inside its backoff as waiting', () => {
    const waitUntil = new Date(now.getTime() + 10 * 60 * 1000);
    const result = classifyMissionWait([
      {
        status: 'pending', mode: 'execution', taskClass: 'work', context: null, startAt: waitUntil,
        loopConfig: { exitCondition: { type: 'pr_checks_green' } } as any, loopState: 'condition_unmet',
      },
    ], now);
    expect(result?.waitUntil).toEqual(waitUntil);
  });

  it('treats a loop task actively running (loopState=running) as real work, not a wait', () => {
    const result = classifyMissionWait([
      {
        status: 'in_progress', mode: 'execution', taskClass: 'work', context: null, startAt: null,
        loopConfig: { exitCondition: { type: 'pr_checks_green' } } as any, loopState: 'running',
      },
    ], now);
    expect(result).toBeNull();
  });

  it('uses the earliest waitUntil across multiple waiting tasks', () => {
    const soon = new Date(now.getTime() + 5 * 60 * 1000);
    const later = new Date(now.getTime() + 60 * 60 * 1000);
    const result = classifyMissionWait([
      { status: 'pending', mode: 'execution', taskClass: 'work', context: { budgetExhausted: true }, startAt: later, loopConfig: null, loopState: null },
      {
        status: 'pending', mode: 'execution', taskClass: 'work', context: null, startAt: soon,
        loopConfig: { exitCondition: { type: 'command' } } as any, loopState: 'condition_unmet',
      },
    ], now);
    expect(result?.waitUntil).toEqual(soon);
  });
});
