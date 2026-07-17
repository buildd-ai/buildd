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

mock.module('@buildd/core/mission-helpers', () => ({
  isDeliverableTask(t: { title: string; mode?: string | null }): boolean {
    if (t.mode === 'planning') return false;
    if (t.title.startsWith('Aggregate results:')) return false;
    if (t.title.startsWith('Evaluate mission completion:')) return false;
    if (t.title.startsWith('Mission:')) return false;
    return true;
  },
}));

import { computeStateKey, evaluateHeartbeatPrepass, type HeartbeatMissionState } from './heartbeat-prepass';

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
});
