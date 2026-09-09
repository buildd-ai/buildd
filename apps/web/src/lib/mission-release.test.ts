process.env.NODE_ENV = 'test';

import { describe, it, expect, mock, beforeEach, afterAll, spyOn } from 'bun:test';

// ── Leaf mocks (behavior varies per test) ─────────────────────────────────────

const mockWorkspacesFindFirst = mock(() => Promise.resolve(null) as any);
const mockGithubReposFindFirst = mock(() => Promise.resolve(null) as any);
const mockGithubApi = mock(() => Promise.resolve(null) as any);

/**
 * Makes a specific write to `missions` reject, so a test can simulate the
 * bookkeeping failing AFTER a dispatch has already gone out. Returns true for
 * the payload that should throw.
 */
let failMissionWriteMatching: ((payload: Record<string, unknown>) => boolean) | null = null;

// db.select({ count: count() }).from(tasks).where(...) → Promise<[{count}]>
const mockSelectWhere = mock(() => Promise.resolve([{ count: 0 }]) as any);

// db.update(missions).set({...}).where(...).returning({...}) → Promise<Row[]>
// Only the two-phase CLAIM calls .returning(); commit and abandon end at
// .where(). Keeping mockReturning as the claim's own hook is what lets the
// existing dedup tests keep meaning "the claim won / lost".
const mockReturning = mock(() => Promise.resolve([]) as any);

/**
 * Every `.set({...})` payload written to `missions`, in order.
 *
 * The whole point of the two-phase fix is WHICH column a given code path writes,
 * so a db mock that swallows the payload cannot test it. These are asserted
 * directly rather than inferred from call counts.
 */
const missionWrites: Array<Record<string, unknown>> = [];
/** Every row inserted into `mission_notes`. */
const noteInserts: Array<Record<string, unknown>> = [];

// ── Module mocks (must appear before the import under test) ───────────────────

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      githubRepos: { findFirst: mockGithubReposFindFirst },
    },
    // Chainable select: db.select({...}).from(t).where(expr) → awaitable
    select: () => ({ from: () => ({ where: mockSelectWhere }) }),
    // Chainable update. `.where()` is itself awaitable (commit/abandon stop
    // there) AND carries `.returning()` (the claim continues).
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        missionWrites.push(payload);
        const shouldFail = failMissionWriteMatching?.(payload) ?? false;
        const where = (_expr?: unknown) => {
          const p: any = shouldFail
            ? Promise.reject(new Error('write failed'))
            : Promise.resolve([]);
          p.returning = mockReturning;
          return p;
        };
        return { where };
      },
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        noteInserts.push(row);
        return Promise.resolve([]);
      },
    }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  or: (...args: any[]) => ({ type: 'or', args }),
  lt: (a: any, b: any) => ({ type: 'lt', a, b }),
  isNull: (a: any) => ({ type: 'isNull', a }),
  inArray: (a: any, b: any) => ({ type: 'inArray', a, b }),
  count: () => ({ type: 'count' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: { id: 'id', releasedAt: 'released_at', releaseAttemptedAt: 'release_attempted_at' },
  missionNotes: { id: 'id', missionId: 'mission_id' },
  tasks: { missionId: 'mission_id', status: 'status' },
  workspaces: { id: 'id' },
  githubRepos: { id: 'id' },
}));

mock.module('@buildd/core/release-strategy', () => ({
  // Mirrors the real module: the trigger default lives in ONE place.
  resolveReleaseTrigger: (c: any) => c?.trigger ?? 'every_merge',
  resolveReleaseStrategy: (config: any) => {
    if (!config?.enabled) {
      return { ok: false, reason: 'not_configured', message: 'not configured' };
    }
    const kind = config.strategy ?? 'branch_merge';
    if (kind === 'branch_merge') {
      if (!config.prodBranch) {
        return { ok: false, reason: 'invalid', message: 'needs prodBranch' };
      }
      return { ok: true, strategy: { kind, prodBranch: config.prodBranch } };
    }
    if (kind === 'workflow_dispatch') {
      return {
        ok: true,
        strategy: {
          kind,
          workflowFile: config.workflowFile ?? 'release.yml',
          ref: config.ref ?? 'dev',
          inputs: config.inputs ?? {},
        },
      };
    }
    return { ok: false, reason: 'invalid', message: `unknown strategy ${kind}` };
  },
}));

mock.module('@/lib/github', () => ({
  githubApi: mockGithubApi,
}));

// The mission release path dispatches through recordAndDispatchRelease, which
// also writes the `releases` row. Stubbed here so this file stays about the
// claim/commit/abandon protocol; the recorder has its own tests.
const mockRecordAndDispatchRelease = mock(() =>
  Promise.resolve({ ok: true as const, releaseId: 'rel-1', deduped: false, headSha: 'sha-1', runId: 5 }) as any,
);
mock.module('@/lib/release/record', () => ({
  recordAndDispatchRelease: mockRecordAndDispatchRelease,
}));

mock.module('@buildd/core/release-archetype', () => ({
  detectArchetype: (w: any) =>
    w?.releaseConfig?.enabled && w?.releaseConfig?.prodBranch !== (w?.gitConfig?.defaultBranch ?? 'main')
      ? 'gated'
      : 'none',
}));

// The shared completion predicate. Mocked here so this file stays about release
// dedup + strategy dispatch; the predicate's own behaviour is covered in
// mission-completion.test.ts. Default: the mission is cleared to ship.
const mockCanCompleteMission = mock(() => Promise.resolve({
  ok: true,
  code: 'ok',
  reason: 'All 1 goal criteria pass',
  pendingDeliverables: 0,
  pendingByStatus: {},
  pendingAllTasks: 0,
  deliverableStatusCounts: { completed: 1 },
  criteriaCount: 1,
  criteriaVerdict: 'pass',
  criteriaEvaluatedAt: '2026-08-29T00:00:00.000Z',
  infraStalledTitles: [],
}) as any);

mock.module('@/lib/mission-completion', () => ({
  canCompleteMission: mockCanCompleteMission,
}));

// ── Import module under test ───────────────────────────────────────────────────

import { fireMissionReleaseIfComplete, MISSION_RELEASE_ATTEMPT_STALE_MS } from './mission-release';

// Spy on executeRelease instead of mock.module()'ing '@/lib/release-executor' —
// mock.module() replaces the module in the global registry for the whole test
// run, which poisons release-executor.test.ts (it imports the same module via
// './release-executor' and would get this mock instead of the real
// implementation). spyOn + mockRestore() properly unwinds after this file.
import * as releaseExecutorModule from './release-executor';
const mockExecuteRelease = spyOn(releaseExecutorModule, 'executeRelease');
afterAll(() => mockExecuteRelease.mockRestore());

// ── Helpers ───────────────────────────────────────────────────────────────────

const ON_MISSION_WORKSPACE = {
  releaseConfig: {
    enabled: true,
    strategy: 'branch_merge',
    prodBranch: 'main',
    trigger: 'on_mission_complete',
  },
  githubRepoId: 'repo-1',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('fireMissionReleaseIfComplete', () => {
  beforeEach(() => {
    mockWorkspacesFindFirst.mockReset();
    mockExecuteRelease.mockReset();
    mockSelectWhere.mockReset();
    mockReturning.mockReset();
    mockCanCompleteMission.mockClear();
    mockGithubReposFindFirst.mockReset();
    mockGithubApi.mockReset();
    mockRecordAndDispatchRelease.mockReset();
    mockRecordAndDispatchRelease.mockResolvedValue({
      ok: true, releaseId: 'rel-1', deduped: false, headSha: 'sha-1', runId: 5,
    } as any);
    failMissionWriteMatching = null;
    missionWrites.length = 0;
    noteInserts.length = 0;

    // Defaults: no pending tasks, claim wins, release succeeds
    mockSelectWhere.mockResolvedValue([{ count: 0 }]);
    mockReturning.mockResolvedValue([{ id: 'mission-1' }]);
    mockExecuteRelease.mockResolvedValue({ status: 'completed', message: 'done' });
    mockGithubApi.mockResolvedValue(null);
    mockGithubReposFindFirst.mockResolvedValue({
      id: 'repo-1',
      fullName: 'acme/app',
      installation: { installationId: 42 },
    });
  });

  // ── Trigger-policy gates ──────────────────────────────────────────────────

  it('skips when trigger=manual — no claim attempt, no release', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: {
        enabled: true,
        strategy: 'branch_merge',
        prodBranch: 'main',
        trigger: 'manual',
      },
      githubRepoId: 'repo-1',
    });

    await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

    expect(mockReturning).not.toHaveBeenCalled();
    expect(mockExecuteRelease).not.toHaveBeenCalled();
  });

  it('skips when trigger=every_merge — no claim attempt, no release', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: {
        enabled: true,
        strategy: 'branch_merge',
        prodBranch: 'main',
        trigger: 'every_merge',
      },
      githubRepoId: 'repo-1',
    });

    await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

    expect(mockReturning).not.toHaveBeenCalled();
    expect(mockExecuteRelease).not.toHaveBeenCalled();
  });

  it('skips when trigger absent (null config) — no release', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: null,
      githubRepoId: 'repo-1',
    });

    await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

    expect(mockExecuteRelease).not.toHaveBeenCalled();
  });

  // ── Pending-task gate ─────────────────────────────────────────────────────

  it('skips when pending tasks remain in the mission', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(ON_MISSION_WORKSPACE);
    mockSelectWhere.mockResolvedValue([{ count: 2 }]);

    await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

    expect(mockReturning).not.toHaveBeenCalled();
    expect(mockExecuteRelease).not.toHaveBeenCalled();
  });

  // ── Completion-predicate gate ─────────────────────────────────────────────

  it('does not release when the shared predicate refuses (unverified goal criteria)', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(ON_MISSION_WORKSPACE);
    mockSelectWhere.mockResolvedValue([{ count: 0 }]);
    mockCanCompleteMission.mockResolvedValueOnce({
      ok: false,
      code: 'criteria_unverified',
      reason: 'Goal criteria not verified (overall: UNVERIFIED)',
      pendingDeliverables: 0,
      pendingByStatus: {},
      pendingAllTasks: 0,
      deliverableStatusCounts: { completed: 3 },
      criteriaCount: 4,
      criteriaVerdict: 'UNVERIFIED',
      criteriaEvaluatedAt: null,
      infraStalledTitles: [],
    } as any);

    await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

    // No claim on releasedAt, so a later verified attempt can still ship.
    expect(mockReturning).not.toHaveBeenCalled();
    expect(mockExecuteRelease).not.toHaveBeenCalled();
  });

  it('accepts an already-completed mission (the gate ran when it closed)', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(ON_MISSION_WORKSPACE);
    mockSelectWhere.mockResolvedValue([{ count: 0 }]);

    await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

    expect(mockCanCompleteMission).toHaveBeenCalledWith('mission-1', {
      path: 'release_trigger',
      acceptCompleted: true,
      // A release READS a verdict; it must not dispatch verification tasks or
      // spend tokens producing one.
      evaluateCriteria: false,
    });
    expect(mockExecuteRelease).toHaveBeenCalled();
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it('fires executeRelease(isMissionRelease=true) for branch_merge when all tasks are terminal', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(ON_MISSION_WORKSPACE);
    mockSelectWhere.mockResolvedValue([{ count: 0 }]);
    mockReturning.mockResolvedValue([{ id: 'mission-1' }]); // claim won

    await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

    expect(mockExecuteRelease).toHaveBeenCalledTimes(1);
    expect(mockExecuteRelease).toHaveBeenCalledWith({
      taskId: 'task-1',
      workerId: 'worker-1',
      workspaceId: 'ws-1',
      isMissionRelease: true,
    });
  });

  // ── Dedup / concurrency ───────────────────────────────────────────────────

  it('deduplicates concurrent completions — exactly one release fires', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(ON_MISSION_WORKSPACE);
    // Both callers observe 0 pending tasks
    mockSelectWhere.mockResolvedValue([{ count: 0 }]);

    // Simulate DB atomicity: first UPDATE (releasedAt IS NULL) wins;
    // second UPDATE hits a non-null releasedAt and returns no rows.
    let claimCalls = 0;
    mockReturning.mockImplementation(() => {
      claimCalls++;
      return Promise.resolve(claimCalls === 1 ? [{ id: 'mission-1' }] : []);
    });

    await Promise.all([
      fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-a', 'worker-a'),
      fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-b', 'worker-b'),
    ]);

    expect(mockExecuteRelease).toHaveBeenCalledTimes(1);
  });

  it('does not fire release when the attempt claim is already taken', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(ON_MISSION_WORKSPACE);
    mockSelectWhere.mockResolvedValue([{ count: 0 }]);
    // Another caller already owns the attempt → no rows returned
    mockReturning.mockResolvedValue([]);

    await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

    expect(mockExecuteRelease).not.toHaveBeenCalled();
    // A lost claim must not record a failure — the winner owns the outcome.
    expect(noteInserts).toEqual([]);
  });

  // ── Two-phase claim (B1) ──────────────────────────────────────────────────
  //
  // The claim used to write `releasedAt` up front, before strategy resolution
  // and before executeRelease. Nothing in the codebase resets it, so every
  // failure path left the mission permanently marked as released with nothing
  // deployed — and every one of those paths was a console.log.

  describe('two-phase release claim', () => {
    beforeEach(() => {
      mockWorkspacesFindFirst.mockResolvedValue(ON_MISSION_WORKSPACE);
      mockSelectWhere.mockResolvedValue([{ count: 0 }]);
      mockReturning.mockResolvedValue([{ id: 'mission-1' }]); // claim won
    });

    it('claims releaseAttemptedAt, not releasedAt', async () => {
      mockExecuteRelease.mockResolvedValue({ status: 'completed', message: 'done' });

      await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

      // First write is the claim, and it must not touch releasedAt.
      expect(missionWrites[0]).toHaveProperty('releaseAttemptedAt');
      expect(missionWrites[0]).not.toHaveProperty('releasedAt');
      expect(missionWrites[0].releaseAttemptedAt).toBeInstanceOf(Date);
    });

    it('writes releasedAt only after the release reports success', async () => {
      mockExecuteRelease.mockResolvedValue({ status: 'completed', message: 'done' });

      await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

      const released = missionWrites.filter(w => 'releasedAt' in w);
      expect(released).toHaveLength(1);
      expect(released[0].releasedAt).toBeInstanceOf(Date);
      expect(noteInserts).toEqual([]);
    });

    it('a skipped release can be released again, and says why', async () => {
      // The regression. `skipped` is the DEFAULT outcome on this repo's own
      // topology: a releaseBranch workspace skips any task whose `release` flag
      // is 'inherit'. Under the one-phase claim this burned the mission's only
      // release attempt and logged one line.
      mockExecuteRelease.mockResolvedValue({
        status: 'skipped',
        message: 'feature task — code lands on dev and is promoted by the release task',
      });

      await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

      // Never marked released...
      expect(missionWrites.some(w => w.releasedAt instanceof Date)).toBe(false);
      // ...and the attempt is handed back, so the next completion retries.
      expect(missionWrites.some(w => w.releaseAttemptedAt === null)).toBe(true);
      // ...and the reason is readable from the mission feed, not just the logs.
      expect(noteInserts).toHaveLength(1);
      expect(noteInserts[0]).toMatchObject({
        missionId: 'mission-1',
        authorType: 'system',
        type: 'decision',
      });
      expect(String(noteInserts[0].body)).toContain('promoted by the release task');
      expect(String(noteInserts[0].body)).toContain('skipped');
    });

    it('an Option A′ policy refusal clears the claim WITHOUT a failure note', async () => {
      // For an opted-in mission every per-task release attempt is refused by
      // design — the mission releases through its mission PR. The note said
      // "Mission release attempt failed" on the intended path, every time
      // completion was evaluated, and a feed that cries failure on the happy
      // path stops being read.
      mockExecuteRelease.mockResolvedValue({
        status: 'skipped',
        message: 'Release: task PR targets the mission integration branch (mission/example-slug-0a1b2c3d)',
        skipReason: 'mission_integration_branch',
      });

      await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

      // The claim invariant is untouched: never released, attempt handed back.
      expect(missionWrites.some(w => w.releasedAt instanceof Date)).toBe(false);
      expect(missionWrites.some(w => w.releaseAttemptedAt === null)).toBe(true);
      // Only the note is suppressed.
      expect(noteInserts).toHaveLength(0);
    });

    it('still posts a note for a skipped release that is NOT an A′ refusal', async () => {
      // The suppression must be keyed on the discriminator, not on `skipped` —
      // otherwise it would silence the very regression the note exists for.
      mockExecuteRelease.mockResolvedValue({
        status: 'skipped',
        message: 'feature task — code lands on dev and is promoted by the release task',
      });

      await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

      expect(noteInserts).toHaveLength(1);
    });

    it('releases the claim when the strategy is not configured', async () => {
      mockWorkspacesFindFirst.mockResolvedValue({
        releaseConfig: { enabled: false, trigger: 'on_mission_complete' },
        githubRepoId: 'repo-1',
      });

      await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

      expect(mockExecuteRelease).not.toHaveBeenCalled();
      expect(missionWrites.some(w => w.releasedAt instanceof Date)).toBe(false);
      expect(missionWrites.some(w => w.releaseAttemptedAt === null)).toBe(true);
      expect(String(noteInserts[0]?.body)).toContain('not_configured');
    });

    it('releases the claim when executeRelease throws', async () => {
      mockExecuteRelease.mockRejectedValue(new Error('github 502'));

      await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

      expect(missionWrites.some(w => w.releasedAt instanceof Date)).toBe(false);
      expect(missionWrites.some(w => w.releaseAttemptedAt === null)).toBe(true);
      expect(String(noteInserts[0]?.body)).toContain('github 502');
    });

    it('records a decision note rather than terminating in a console.log', async () => {
      // Invariant 1 of docs/design/mission-delivery-arc.md: no automated release
      // decision may end in a log line alone.
      mockExecuteRelease.mockResolvedValue({ status: 'skipped', message: 'nope' });

      await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

      expect(noteInserts).toHaveLength(1);
      expect(noteInserts[0].title).toBe('Mission release attempt failed');
      expect(noteInserts[0].actorLabel).toBe('release trigger (on_mission_complete)');
    });

    it('bounds retries with a stale-attempt window rather than retrying per completion', async () => {
      // A process that dies between the two phases cannot clear its own attempt.
      // The window is what stops that becoming the same permanent stall, while
      // keeping retries to roughly one per window instead of one per task.
      expect(MISSION_RELEASE_ATTEMPT_STALE_MS).toBeGreaterThan(60_000);
      expect(MISSION_RELEASE_ATTEMPT_STALE_MS).toBeLessThanOrEqual(60 * 60 * 1000);
    });
  });

  // ── workflow_dispatch: the claim must survive a bookkeeping failure ───────
  //
  // This branch had no coverage at all, and `missions.released_at` is NULL on
  // every mission in production — so nothing here was ever exercised, by a
  // test or by a real release.

  const DISPATCH_WORKSPACE = {
    releaseConfig: {
      enabled: true,
      strategy: 'workflow_dispatch',
      workflowFile: 'release.yml',
      ref: 'dev',
      trigger: 'on_mission_complete',
    },
    githubRepoId: 'repo-1',
  };

  it('workflow_dispatch: records the release when the dispatch succeeds', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(DISPATCH_WORKSPACE);

    await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

    expect(mockRecordAndDispatchRelease).toHaveBeenCalledTimes(1);
    // A mission release used to leave `missions.releasedAt` as its ONLY trace:
    // no run id, no run url, no releases row. Nothing could verify it, attribute
    // tasks to it, or advance it from the workflow_run webhook.
    expect((mockRecordAndDispatchRelease.mock.calls[0] as any[])[0]).toMatchObject({
      workspaceId: 'ws-1',
      workflowFile: 'release.yml',
      ref: 'dev',
      triggeredBy: 'auto',
    });
    // Phase 1 claims the attempt, phase 2 commits the release.
    expect(missionWrites.some(w => 'releaseAttemptedAt' in w && w.releaseAttemptedAt instanceof Date)).toBe(true);
    expect(missionWrites.some(w => 'releasedAt' in w && w.releasedAt instanceof Date)).toBe(true);
    expect(noteInserts).toHaveLength(0);
  });

  it('workflow_dispatch: a failed dispatch abandons the claim with a decision note', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(DISPATCH_WORKSPACE);
    mockRecordAndDispatchRelease.mockResolvedValue({
      ok: false, status: 502, error: '422 workflow not found',
    } as any);

    await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

    // The claim is cleared so the next completion can retry, and the feed says why.
    expect(missionWrites.some(w => w.releaseAttemptedAt === null)).toBe(true);
    expect(missionWrites.some(w => 'releasedAt' in w)).toBe(false);
    expect(noteInserts).toHaveLength(1);
    expect(String(noteInserts[0].body)).toContain('dispatch_failed');
  });

  // THE REGRESSION. The dispatch has already gone out to GitHub; only the
  // bookkeeping failed. Reporting `dispatch_failed` here is a factual lie, and
  // clearing the claim lets the very next task completion fire a SECOND
  // release for the same mission. The claim must stay held so the only retry
  // path is the bounded 30-minute stale window.
  it('workflow_dispatch: a bookkeeping failure after a successful dispatch neither lies nor frees the claim', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(DISPATCH_WORKSPACE);
    failMissionWriteMatching = payload => 'releasedAt' in payload;

    await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

    // The dispatch happened exactly once.
    expect(mockRecordAndDispatchRelease).toHaveBeenCalledTimes(1);
    // No false failure note on the mission feed.
    expect(noteInserts).toHaveLength(0);
    // And the claim was NOT released — nothing set releaseAttemptedAt back to null.
    expect(missionWrites.some(w => w.releaseAttemptedAt === null)).toBe(false);
  });

  it('branch_merge: a bookkeeping failure after a completed release does not report execute_failed', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(ON_MISSION_WORKSPACE);
    mockExecuteRelease.mockResolvedValue({ status: 'completed', message: 'merged' });
    failMissionWriteMatching = payload => 'releasedAt' in payload;

    await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

    expect(mockExecuteRelease).toHaveBeenCalledTimes(1);
    expect(noteInserts).toHaveLength(0);
    expect(missionWrites.some(w => w.releaseAttemptedAt === null)).toBe(false);
  });

});
