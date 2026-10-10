process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── Mock functions ──────────────────────────────────────────────────────────
const mockVerifyWebhookSignature = mock(() => Promise.resolve(true));
const mockGithubApi = mock(() => Promise.resolve(null) as any);
const mockAllCheckSuitesPassed = mock(() => Promise.resolve(true));
const mockHasCheckSuites = mock(() => Promise.resolve(false));
const mockMergePullRequest = mock(() => Promise.resolve({ merged: true, message: 'ok' }));
const mockNotifyMissionPrReady = mock(() => Promise.resolve());
const mockSyncInstallationReposById = mock(() =>
  Promise.resolve({ synced: 0, linked: 0, linkedWorkspaceIds: [] as string[] })
);
// Repo-scope helpers are mocked so tests can assert the webhook passes repo
// context down. The predicates they build are covered in repo-scope.test.ts.
const mockWorkerOwnsPr = mock((repoFullName: string, prNumber: number) => ({
  type: 'workerOwnsPr',
  repoFullName,
  prNumber,
}));
const mockWorkerOwnsPrUrl = mock((prUrl: string, prNumber: number) => ({
  type: 'workerOwnsPrUrl',
  prUrl,
  prNumber,
}));
const mockWorkspaceRepoMatches = mock((repoFullName: string) => ({
  type: 'workspaceRepoMatches',
  repoFullName,
}));
const mockAnnounceTaskCreated = mock(() => Promise.resolve());
const mockInstallationsFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockWorkspacesFindMany = mock(() => [] as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockMissionsFindFirst = mock(() => null as any);

// Track DB operations for assertions
let insertCalls: Array<{ table: any; values: any; conflict: string | null }> = [];
let deleteCalls: Array<{ table: any }> = [];
let updateCalls: Array<{ table: any; setValues: any; condition?: any }> = [];
// Captured `db.select().from(t).where(cond)` predicates, so a test can assert
// the SHAPE of a query and not just its result (see the workflow_run runId
// lookup: the danger there is the SQL it emits, not what it returns).
let selectWhereCalls: Array<{ table: any; condition: any }> = [];

// Table-keyed select results — lets tests configure `db.select().from(<table>)`
// responses (used by the knowledge-ingest enqueue path). Return null to fall
// back to the legacy `.limit()` chain used by the release-PR lookups.
let selectTableResults: (table: any) => any[] | null = () => null;
// When true, ingest-job inserts return no rows (simulated ON CONFLICT DO NOTHING).
let jobInsertConflicts = false;

// Rows the next `db.update(tasks)…returning()` yields, keyed by the status
// being written. Unset → the legacy [{ id: 'row-1' }].
let updateReturningByStatus: Record<string, any[]> = {};
const mockApplyTaskCancelSideEffects = mock(() => Promise.resolve());
const mockApplyTaskReopenSideEffects = mock(() => Promise.resolve());
const mockCancelRetryAttemptsForMergedPr = mock((_input: any) => Promise.resolve());

// ── Module mocks (must be before route import) ──────────────────────────────
// Subscriptions ledger: the builders are stood in by tagged objects so a test
// reads exactly which event the route recorded and with what arguments. The
// real builders and their dedupe keys are covered in lib/subscriptions.test.ts.
const mockRecordEvent = mock((_e: any) => Promise.resolve({ recorded: 0 }));
mock.module('@/lib/subscriptions', () => ({
  recordEvent: mockRecordEvent,
  prMergedEvent: (a: any) => ({ type: 'pr.merged', ...a }),
  prCiFailedEvent: (a: any) => ({ type: 'pr.ci_failed', ...a }),
  taskCompletedEvent: (a: any) => ({ type: 'task.completed', ...a }),
  taskFailedEvent: (a: any) => ({ type: 'task.failed', ...a }),
}));
// The chat module's "task done" post, reached lazily by its subscriber.
const mockPostTaskCompletedEvent = mock(async (_a: any) => {});
mock.module('@/lib/chat/mission-events', () => ({ postTaskCompletedEvent: mockPostTaskCompletedEvent }));
// Revert ledger: the writer is stood in; what it parses and writes is covered
// in packages/core/__tests__/pr-reverts.test.ts and lib/pr-reverts.test.ts.
const mockRecordPrReverts = mock((_a: any) => Promise.resolve(0));
mock.module('@/lib/pr-reverts', () => ({ recordPrReverts: mockRecordPrReverts }));
// Base-advance notices: what is matched and sent is covered in
// lib/base-advance-notice.test.ts; here only what the webhook hands over.
const mockRunBaseAdvanceNotice = mock((_input: any, _resolver: any) => Promise.resolve({ notified: [], debounced: [] }));
const mockChangedFilesForPr = mock((_i: number, _r: string, _n: number) => Promise.resolve(['apps/web/src/lib/foo.ts']));
const mockChangedFilesForCompare = mock((_i: number, _r: string, _b: string, _a: string) => Promise.resolve(['from/compare.ts']));
const mockIsReleaseRollupPr = mock((_repo: string, _head: string, _base: string) => Promise.resolve(false));
mock.module('@/lib/base-advance-notice-store', () => ({
  isReleaseRollupPr: mockIsReleaseRollupPr,
  runBaseAdvanceNotice: mockRunBaseAdvanceNotice,
  changedFilesForPr: mockChangedFilesForPr,
  changedFilesForCompare: mockChangedFilesForCompare,
}));
// Supersession detection: what it decides is covered in lib/pr-supersession-detect.test.ts.
const mockDetectPrSupersession = mock((_a: any) => Promise.resolve({ outcome: 'none', candidatesChecked: 0 } as any));
mock.module('@/lib/pr-supersession-detect', () => ({ detectPrSupersession: mockDetectPrSupersession }));
mock.module('@/lib/task-cancel', () => ({
  applyTaskCancelSideEffects: mockApplyTaskCancelSideEffects,
  applyTaskReopenSideEffects: mockApplyTaskReopenSideEffects,
  emitTaskUpdated: mock(() => Promise.resolve()),
}));

mock.module('@/lib/retry-attempt-cleanup', () => ({
  cancelRetryAttemptsForMergedPr: mockCancelRetryAttemptsForMergedPr,
}));

mock.module('@/lib/github', () => ({
  verifyWebhookSignature: mockVerifyWebhookSignature,
  allCheckSuitesPassed: mockAllCheckSuitesPassed,
  hasCheckSuites: mockHasCheckSuites,
  mergePullRequest: mockMergePullRequest,
  githubApi: mockGithubApi,
}));

mock.module('@/lib/mission-notifications', () => ({
  notifyMissionPrReady: mockNotifyMissionPrReady,
}));

mock.module('@/lib/github-repo-link', () => ({
  syncInstallationReposById: mockSyncInstallationReposById,
}));

// Resume of tasks waiting on GitHub access — idempotency lives in the store
// (github-repo-access-store.test.ts); here only which deliveries trigger it.
const mockResumeAfterInstallationChange = mock(async (_installationId: number) => [] as string[]);
mock.module('@/lib/github-repo-access-store', () => ({
  resumeAfterInstallationChange: mockResumeAfterInstallationChange,
}));

mock.module('@/lib/repo-scope', () => ({
  workerOwnsPr: mockWorkerOwnsPr,
  workerOwnsPrUrl: mockWorkerOwnsPrUrl,
  workspaceRepoMatches: mockWorkspaceRepoMatches,
  prUrlFor: (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`,
  GITHUB_HOST_PREFIX_RE: 'prefix-re',
  GIT_SUFFIX_RE: 'suffix-re',
}));

const mockNotify = mock((_opts: any) => {});
mock.module('@/lib/pushover', () => ({
  notifyOperator: mockNotify,
}));
// Tenant alerts go to the owning team's channel: mockNotifyTeamOf records the
// subject and event so a test reads where each one was routed.
const mockNotifyTeamOf = mock((_subject: any, _event: any, _payload: any) => {});
const mockNotifyTeam = mock(async (..._a: any[]) => {});
mock.module('@/lib/notify', () => ({
  notifyTeam: mockNotifyTeam,
  notifyTeamOf: async (subject: any, event: any, payload: any) => {
    mockNotifyTeamOf(subject, event, payload);
  },
}));

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

const mockCaptureCiJobLogEvidence = mock((_input: any) => Promise.resolve({ status: 'stored' }));
mock.module('@/lib/ci-job-log-evidence', () => ({
  captureCiJobLogEvidence: mockCaptureCiJobLogEvidence,
}));

// The red-PR sweep's due queue: a skipped CI retry that someone must come back
// to (fix in flight, head already tried) schedules a look here.
const mockScheduleCiRedLook = mock((_ref: any, _dueAtMs: number) => Promise.resolve());
mock.module('@/lib/ci-red-queue', () => ({
  CI_RED_DUE_QUEUE: 'ci-red',
  CI_RED_ESCALATED_KEY: 'ciRedEscalatedHeadSha',
  scheduleCiRedLook: mockScheduleCiRedLook,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      githubInstallations: { findFirst: mockInstallationsFindFirst },
      workspaces: {
        findFirst: mockWorkspacesFindFirst,
        findMany: mockWorkspacesFindMany,
      },
      workers: { findFirst: mockWorkersFindFirst },
      tasks: { findFirst: mockTasksFindFirst },
      missions: { findFirst: mockMissionsFindFirst },
    },
    insert: (table: any) => ({
      values: (values: any) => {
        const call = { table, values, conflict: null as string | null };
        insertCalls.push(call);
        return {
          onConflictDoUpdate: (opts: any) => {
            call.conflict = 'update';
            return Promise.resolve();
          },
          onConflictDoNothing: () => {
            call.conflict = 'nothing';
            return {
              returning: () =>
                Promise.resolve(jobInsertConflicts ? [] : [{ id: 'task-1', ...values }]),
            };
          },
          returning: () => Promise.resolve([{ id: 'new-task-1', ...values }]),
        };
      },
    }),
    delete: (table: any) => ({
      where: (condition: any) => {
        deleteCalls.push({ table });
        return Promise.resolve();
      },
    }),
    update: (table: any) => ({
      set: (values: any) => {
        const call: { table: any; setValues: any; condition?: any } = { table, setValues: values };
        updateCalls.push(call);
        if (failUpdateMatching?.(values)) {
          return {
            where: (_condition: any) => {
              const p: any = Promise.reject(new Error('update failed'));
              p.returning = () => p;
              return p;
            },
          };
        }
        return {
          where: (condition: any) => (call.condition = condition, {
            returning: () =>
              Promise.resolve(updateReturningByStatus[values?.status] ?? [{ id: 'row-1' }]),
            then: (resolve: any) => resolve(undefined),
          }),
        };
      },
    }),
    // Used by handleReleasePrCiSuccess / handleReleasePrCiFailure (via .limit)
    // and by the knowledge-ingest enqueue path (awaited directly).
    select: (_columns?: any) => ({
      from: (table: any) => ({
        where: (_cond: any) => {
          selectWhereCalls.push({ table, condition: _cond });
          const rows = selectTableResults(table);
          const settled = rows ?? [];
          // `.orderBy(...).limit(n)` is the shape of the release sha-fallback
          // lookup; a mock missing it throws instead of exercising the code.
          const terminal: any = Object.assign(Promise.resolve(settled), {
            limit: (_n: number) => Promise.resolve(settled),
            orderBy: (_o: any) => Object.assign(Promise.resolve(settled), {
              limit: (_n: number) => Promise.resolve(settled),
            }),
          });
          return terminal;
        },
      }),
    }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  desc: (field: any) => ({ field, type: 'desc' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  isNull: (field: any) => ({ field, type: 'isNull' }),
  not: (condition: any) => ({ condition, type: 'not' }),
  or: (...conditions: any[]) => ({ conditions, type: 'or' }),
  ne: (field: any, value: any) => ({ field, value, type: 'ne' }),
  sql: Object.assign((strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' }), {}),
}));

const schemaMock = {
  githubInstallations: { id: 'id', installationId: 'installationId' },
  githubRepos: { id: 'id', repoId: 'repoId', installationId: 'installationId', fullName: 'fullName' },
  tasks: {
    id: 'id', externalId: 'externalId', parentTaskId: 'parentTaskId', status: 'status',
    releaseResult: 'release_result', missionId: 'mission_id', workspaceId: 'workspace_id',
  },
  workers: { id: 'id', prNumber: 'prNumber', workspaceId: 'workspaceId', prBaseRef: 'prBaseRef', mergedAt: 'mergedAt', taskId: 'taskId' },
  workspaces: { id: 'id', repo: 'repo', githubRepoId: 'githubRepoId' },
  missions: { id: 'id', releasedAt: 'released_at' },
  // headSha and createdAt are load-bearing for the sha-fallback lookup: a column
  // missing from this stub is `undefined` in the predicate, and JSON.stringify
  // drops it — so an assertion on the WHERE clause silently stops checking the
  // field it names.
  releases: {
    id: 'id',
    workspaceId: 'workspaceId',
    state: 'state',
    runUrl: 'runUrl',
    headSha: 'headSha',
    createdAt: 'createdAt',
  },
  knowledgeIngestJobs: {
    id: 'id', workspaceId: 'workspaceId', repo: 'repo', trigger: 'trigger',
    sha: 'sha', prNumber: 'prNumber', scope: 'scope', status: 'status',
  },
};
mock.module('@buildd/core/db/schema', () => schemaMock);

// Mock release-strategy (real logic but isolated from DB)
const mockResolveReleaseStrategy = mock((config: any) => {
  if (!config || !config.enabled) return { ok: false, reason: 'not_configured', message: 'not configured' };
  const kind = config.strategy ?? 'branch_merge';
  if (kind === 'branch_merge') {
    return { ok: true, strategy: { kind, prodBranch: config.prodBranch ?? 'main' } };
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
  return { ok: false, reason: 'invalid', message: 'unknown strategy' };
});
mock.module('@buildd/core/release-strategy', () => ({
  // Mirrors the real module: the trigger default lives in ONE place.
  resolveReleaseTrigger: (c: any) => c?.trigger ?? 'every_merge',
  resolveReleaseStrategy: mockResolveReleaseStrategy,
}));

/**
 * Makes one `db.update(...).set(payload)` reject, so a test can simulate the
 * bookkeeping failing AFTER a release dispatch has already gone out.
 */
let failUpdateMatching: ((values: any) => boolean) | null = null;

// Mock mission-release helpers
const mockCountPendingTasksForMission = mock(() => Promise.resolve(0));
// Two-phase release claim. `claim` returning true means this caller owns the
// attempt and must resolve it; commit/abandon are the two resolutions. Asserting
// on WHICH one fired is how the "no poisoned mission" guarantee is tested.
const mockClaimMissionReleaseAttempt = mock(() => Promise.resolve(true));
const mockCommitMissionRelease = mock(() => Promise.resolve());
const mockAbandonMissionReleaseAttempt = mock(() => Promise.resolve());
// Passthrough, not an opaque stub: `recordDispatchedRelease` exists precisely to
// commit the release without letting a write failure masquerade as a dispatch
// failure, so the assertions that matter are still "was the release recorded"
// (commit) vs "was a failure reported" (abandon).
const mockRecordDispatchedRelease = mock((missionId: string, _what?: string) =>
  mockCommitMissionRelease(missionId as any),
);
mock.module('@/lib/mission-release', () => ({
  countPendingTasksForMission: mockCountPendingTasksForMission,
  fireMissionReleaseIfComplete: mock(() => Promise.resolve()),
  claimMissionReleaseAttempt: mockClaimMissionReleaseAttempt,
  commitMissionRelease: mockCommitMissionRelease,
  abandonMissionReleaseAttempt: mockAbandonMissionReleaseAttempt,
  recordDispatchedRelease: mockRecordDispatchedRelease,
}));

// Mission dependency gate. `dependencyMetAt` has exactly one writer, and the
// `merged` gate is cleared only by that column — so whether this fires is the
// difference between a downstream mission starting and waiting forever.
const mockCheckAndUnblockDependentMissions = mock(() => Promise.resolve([] as string[]));
mock.module('@/lib/mission-dependency', () => ({
  checkAndUnblockDependentMissions: mockCheckAndUnblockDependentMissions,
  // Full module surface, deliberately: mock.module replaces a module for the
  // whole process, and a partial stub would delete these for every other
  // importer loaded in it.
  isMissionBlocked: mock(() => Promise.resolve({ blocked: false })),
  wouldCreateCycle: mock(() => Promise.resolve(false)),
}));

// Post-completion path. The webhook used to write tasks.status directly on a
// merge, so dependents, mission completion and re-planning never ran from it.
// Its internals are covered in lib/task-dependencies.test.ts.
const mockResolveCompletedTask = mock((_taskId: string, _workspaceId: string) => Promise.resolve());
const mockCheckDependsOnResolved = mock((_taskId: string) => Promise.resolve());
mock.module('@/lib/task-dependencies', () => ({
  resolveCompletedTask: mockResolveCompletedTask,
  checkDependsOnResolved: mockCheckDependsOnResolved,
  requirePlanApprovalEnabled: () => false,
  shouldAutoApprovePlan: () => true,
}));

// Early release's stacking mechanics: un-draft any dependent stacked on this
// task's branch once it merges. The module's own tests cover the lookup and
// GitHub call; here only whether the webhook fires it, and with what task id.
const mockUndraftStackedDependents = mock((_upstreamTaskId: string) => Promise.resolve());
mock.module('@/lib/early-release-stacking', () => ({
  undraftStackedDependents: mockUndraftStackedDependents,
  findStackedReleaseForBase: mock(() => Promise.resolve(false)),
}));
const mockWakeMissionAfterResponse = mock((_id: string, _reason: string) => {});
mock.module('@/lib/mission-wake', () => ({
  wakeMission: mock(() => Promise.resolve({ woken: false, reason: 'not_found' })),
  wakeMissionAfterResponse: mockWakeMissionAfterResponse,
}));

// The shared completion predicate. The webhook release path used to check only
// "no pending tasks", so a mission whose goal criteria read `fail` could ship
// here and be refused by the completion path in the same minute. Default: clear.
const mockCanCompleteMission = mock(() => Promise.resolve({
  ok: true,
  code: 'ok',
  reason: 'All goal criteria pass',
}) as any);
const mockCompleteMissionIfVerified = mock(async (_missionId: string, _opts: any) => ({ completed: false }) as any);
mock.module('@/lib/mission-completion', () => ({
  canCompleteMission: mockCanCompleteMission,
  completeMissionIfVerified: mockCompleteMissionIfVerified,
}));

// What a held release's resolution records: the evidence write (task.terminal),
// the outcome-analytics row and the runner failure detector.
const mockPersistTaskEvidence = mock(async (..._args: unknown[]) => null);
mock.module('@/lib/task-evidence-store', () => ({ persistTaskEvidence: mockPersistTaskEvidence }));
const mockRecordTaskOutcome = mock(async (_input: any) => true);
mock.module('@buildd/core/routing-analytics', () => ({ recordTaskOutcome: mockRecordTaskOutcome }));
const mockRecordRunnerOutcome = mock(async (_outcome: string) => {});
mock.module('@buildd/core/runner-health', () => ({ recordRunnerOutcome: mockRecordRunnerOutcome }));

// Mock workflow dispatch so tests don't hit real GitHub or block on setTimeout polling
const mockDispatchWorkflowRelease = mock(() =>
  Promise.resolve({
    dispatched: true,
    workflowFile: 'release.yml',
    ref: 'dev',
    inputs: {},
    runsUrl: 'https://github.com/test-org/test-repo/actions/workflows/release.yml',
  }),
);
mock.module('@/lib/release/dispatch', () => ({
  dispatchWorkflowRelease: mockDispatchWorkflowRelease,
}));

// The webhook dispatches releases through recordAndDispatchRelease, which also
// writes the `releases` row. Kept as a passthrough over the dispatch mock so the
// existing "did we dispatch, with what" assertions keep their meaning.
const mockRecordAndDispatchRelease = mock(async (params: any) => {
  const dispatched: any = await mockDispatchWorkflowRelease(
    params.installationId,
    params.owner,
    params.name,
    { workflowFile: params.workflowFile, ref: params.ref, inputs: params.inputs },
  );
  return {
    ok: true as const,
    releaseId: 'rel-auto-1',
    deduped: false,
    headSha: 'sha-dev-head',
    runId: dispatched?.runId,
    runUrl: dispatched?.runUrl,
    runsUrl: dispatched?.runsUrl,
  };
});
mock.module('@/lib/release/record', () => ({
  recordAndDispatchRelease: mockRecordAndDispatchRelease,
}));

// Pusher — no-op in tests; triggerEvent calls should be silently skipped
const mockTriggerEvent = mock(() => Promise.resolve());
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: {
    workspace: (id: string) => `workspace-${id}`,
    task: (id: string) => `task-${id}`,
    worker: (id: string) => `worker-${id}`,
    mission: (id: string) => `mission-${id}`,
  },
  events: {
    TASK_CREATED: 'task:created',
    TASK_CLAIMED: 'task:claimed',
    TASK_COMPLETED: 'task:completed',
    TASK_FAILED: 'task:failed',
    TASK_ASSIGNED: 'task:assigned',
    WORKER_STARTED: 'worker:started',
    WORKER_PROGRESS: 'worker:progress',
    WORKER_COMPLETED: 'worker:completed',
    WORKER_FAILED: 'worker:failed',
    WORKER_COMMAND: 'worker:command',
    SCHEDULE_TRIGGERED: 'schedule:triggered',
    SCHEDULE_DEFERRED: 'schedule:deferred',
    CHILDREN_COMPLETED: 'task:children_completed',
    TASK_UNBLOCKED: 'task:unblocked',
    TASK_DEPENDENCY_FAILED: 'task:dependency_failed',
    MISSION_CYCLE_STARTED: 'mission:cycle_started',
    MISSION_LOOP_COMPLETED: 'mission:loop_completed',
    MISSION_LOOP_STALLED: 'mission:loop_stalled',
    TASK_UPDATED: 'task:updated',
    TASK_RETRY_CAP: 'task:retry_cap',
    MISSION_NOTE_POSTED: 'mission:note_posted',
    RELEASE_UPDATED: 'release:updated',
  },
}));
mock.module('@/lib/work-tracker', () => ({
  maybePostWorkTrackerNote: mock(() => Promise.resolve()),
  postWorkTrackerCompletionUpdate: mock(() => Promise.resolve()),
  postLinearCompletionComment: mock(() => Promise.resolve()),
}));

// Merge-policy + reviewer mocks (Phase 2)
const mockResolvePolicy = mock(() => ({ tier: 'auto-threshold' as const, threshold: { maxLines: 800, denyPaths: [] } }));
mock.module('@/lib/merge-policy', () => ({
  resolvePolicy: mockResolvePolicy,
}));

const mockCreateReviewerTask = mock(() => Promise.resolve({ id: 'reviewer-task-1' }));
const mockPreflightEscalationCheck = mock(() => ({ shouldEscalate: false as const }));
mock.module('@/lib/reviewer', () => ({
  createReviewerTask: mockCreateReviewerTask,
  preflightEscalationCheck: mockPreflightEscalationCheck,
}));

// The rules and the cancellation are unit-tested in lib/supersession*.test.ts;
// here the mock pins which subject event the close handler fires.
const mockReconcileSubjectEvent = mock((..._args: any[]) =>
  Promise.resolve({ cancelled: [], lostRace: [], decisions: [] }),
);
const mockCheckDispatch = mock((..._args: any[]) => Promise.resolve({ verdict: 'keep', rule: null } as any));
mock.module('@/lib/supersession', () => ({
  reconcileSubjectEvent: mockReconcileSubjectEvent,
  checkDispatch: mockCheckDispatch,
}));

// Gate ledger — captured so the merge telemetry can be asserted. The slug
// catalogue is the real one (dependency-free).
const { GATE_SLUGS: REAL_GATE_SLUGS } = await import('@buildd/core/gate-slugs');
const mockFireGateEvent = mock((_input: any) => 'gate-event-1');
mock.module('@/lib/gate-ledger', () => ({
  GATE_SLUGS: REAL_GATE_SLUGS,
  fireGateEvent: mockFireGateEvent,
  fireDeferralEvent: mock(() => {}),
  fireGateEventForWorkspaceRef: mock(() => 'gate-event-1'),
  gateCallerOrigin: () => 'system',
  gateFrictionSignature: (gate: string, reason: string) => `${gate}:${reason}`,
}));

const mockInspectPullRequestMigrations = mock(() => Promise.resolve({ safe: true as const }));
mock.module('@/lib/migration-inspector', () => ({
  inspectPullRequestMigrations: mockInspectPullRequestMigrations,
}));

const mockTryDispatchMigrationCollisionRetry = mock(() => Promise.resolve({ handled: false }));
mock.module('@/lib/migration-collision-retry', () => ({
  tryDispatchMigrationCollisionRetry: mockTryDispatchMigrationCollisionRetry,
}));

const mockTryAutoMergeWorkerPr = mock(() => Promise.resolve());
mock.module('@/lib/auto-merge', () => ({
  tryAutoMergeWorkerPr: mockTryAutoMergeWorkerPr,
}));

// Dark-check detection is fire-and-forget; no-op in route tests.
mock.module('./dark-check-detection', () => ({
  detectDarkChecksForClosedPr: mock(() => Promise.resolve()),
}));

// Release verification is fire-and-forget; no-op in route tests.
const mockVerifyReleaseDeployment = mock(() => Promise.resolve());
mock.module('@/lib/release-verification', () => ({
  verifyReleaseDeployment: mockVerifyReleaseDeployment,
}));

// recordDirectProdMerge's own repo→workspace resolution and row-insert logic
// are covered at the unit level in release-executor.test.ts; here we only
// assert the webhook wires it up with the right args.
const mockRecordDirectProdMerge = mock(() => Promise.resolve());
const mockAdvanceGatedReleaseOnPrMerge = mock(() => Promise.resolve());
mock.module('@/lib/release-executor', () => ({
  recordDirectProdMerge: mockRecordDirectProdMerge,
  advanceGatedReleaseOnPrMerge: mockAdvanceGatedReleaseOnPrMerge,
}));

// On-demand review callbacks — asserted below, stubbed here.
const mockDeliverPrReviewCallback = mock(() => Promise.resolve('fired' as const));
// Stored reviewer verdict — default "no review on file" so the existing
// agent-review deferral behaviour holds unless a test says otherwise.
const mockReadPrReviewStatus = mock(() => Promise.resolve({
  state: 'not_requested' as const,
  terminal: true,
  reviewTaskId: null,
  adoptedTaskId: null,
  verdict: null,
  confidence: null,
  summary: null,
  feedback: null,
  escalationReason: null,
  iteration: null,
  maxIterations: null,
  prState: 'open' as const,
  merged: false,
  mergeBlocked: null,
}));
// The workspace's roles, for the reviewer-role existence check.
const DEFAULT_ROLES = [
  { slug: 'reviewer', isRole: true },
  { slug: 'builder', isRole: true },
];
const mockListWorkspaceRoles = mock((_workspaceId: string, _teamId: string) => Promise.resolve(DEFAULT_ROLES as any[]));
mock.module('@/lib/pr-review-request', () => ({
  deliverPrReviewCallback: mockDeliverPrReviewCallback,
  readPrReviewStatus: mockReadPrReviewStatus,
  listWorkspaceRoles: mockListWorkspaceRoles,
}));

const mockSchedulePrScopeReconcile = mock((_input: any) => {});
mock.module('@/lib/pr-scope-reconcile-trigger', () => ({
  schedulePrScopeReconcile: mockSchedulePrScopeReconcile,
}));
// The landing function — its decisions are covered in lib/pr-landing.test.ts;
// here only the door's wiring is asserted. Mode resolution is the real rule.
const mockLandPr = mock(async (_input: any, _deps?: any): Promise<any> => ({ kind: 'waiting_ci', headSha: 'abc123' }));
mock.module('@/lib/pr-landing', () => ({
  landPr: mockLandPr,
  resolveLandingMode: (gitConfig: any) => {
    const mode = gitConfig?.landing?.mode;
    return mode === 'off' || mode === 'shadow' || mode === 'enforce' ? mode : 'shadow';
  },
}));
// Surface ordering's own decisions are covered in lib/surface-ordering.test.ts;
// here only which PR, workspace and bases the webhook hands it.
const mockRetargetSurfaceIntents = mock(async (_input: any): Promise<any> => ({ woke: [] }));
const mockSettleSurfaceIntentsOnClose = mock(async (_input: any): Promise<any> => ({ woke: [] }));
mock.module('@/lib/surface-ordering', () => ({
  retargetSurfaceIntents: mockRetargetSurfaceIntents,
  settleSurfaceIntentsOnClose: mockSettleSurfaceIntentsOnClose,
}));
const mockCarryForwardApproval = mock(async (_p: any): Promise<any> => ({ carried: false, reason: 'test' }));
mock.module('@/lib/approval-carry-forward', () => ({ carryForwardApprovalIfUnchanged: mockCarryForwardApproval }));
// Workflow kernel seam (lib/workflow/seam.ts; real-SQL suite in
// apps/web/tests/db/workflow-seam.test.ts). Defaults: no kernel delivery, so
// every legacy case below runs unchanged.
const mockOpenKernelDelivery = mock(async (_p: any): Promise<any> => ({ owned: false }));
const mockObserveHead = mock(async (_p: any): Promise<boolean> => false);
const mockObservePrState = mock(async (_p: any): Promise<boolean> => false);
const mockObserveBase = mock(async (_p: any): Promise<boolean> => false);
const mockReleaseKernelDeliveryForPr = mock(async (..._a: any[]) => undefined);
mock.module('@/lib/workflow/seam', () => ({
  openKernelDelivery: mockOpenKernelDelivery,
  observeHead: mockObserveHead,
  observePrState: mockObservePrState,
  observeBase: mockObserveBase,
  observeCiFailure: mock(async () => ({ handled: false })),
  policyFindingFor: (p: any) => ({ outcome: 'human', reason: p.reason, destructive: false }),
}));
const mockKernelDeliveryForPr = mock(async (..._a: any[]): Promise<string | null> => null);
mock.module('@/lib/workflow/authority', () => ({ releaseKernelDeliveryForPr: mockReleaseKernelDeliveryForPr, kernelDeliveryForPr: mockKernelDeliveryForPr }));

// The mission loop-on-merge and integration-PR helpers, recorded in call order
// for the missions characterization at the end of this file. Real modules are
// spread in so other importers keep every export; each stub defaults to the
// no-op answer the real helper gives when there is nothing to do.
import * as realLoopWebhook from '@/lib/loop-webhook';
import * as realMissionPr from '@/lib/mission-pr';
const missionLog: Array<[string, ...unknown[]]> = [];
let missionPrOpenResult: any = { ok: false, reason: 'work_incomplete' };
const mockEvaluateAndAdvanceLoopOnMerge = mock(async (...a: unknown[]) => { missionLog.push(['evaluateAndAdvanceLoopOnMerge', ...a]); });
const mockMaybeOpenMissionIntegrationPr = mock(async (...a: unknown[]) => { missionLog.push(['maybeOpenMissionIntegrationPr', ...a]); return missionPrOpenResult; });
const mockNoteMissionPrOpenFailure = mock(async (...a: unknown[]) => { missionLog.push(['noteMissionPrOpenFailure', ...a]); });
mock.module('@/lib/loop-webhook', () => ({ ...realLoopWebhook, evaluateAndAdvanceLoopOnMerge: mockEvaluateAndAdvanceLoopOnMerge }));
mock.module('@/lib/mission-pr', () => ({
  ...realMissionPr,
  maybeOpenMissionIntegrationPr: mockMaybeOpenMissionIntegrationPr,
  noteMissionPrOpenFailure: mockNoteMissionPrOpenFailure,
}));

// The review reactions to a PR closing, recorded in call order for the reviews
// characterization at the end of this file. The sticky activity comment keeps
// its real implementation (the tests above assert the bodies it hands GitHub);
// only the call is logged. Dead-PR shutdown is stubbed: its rules are covered
// in lib/dead-pr-shutdown.test.ts.
import * as realPrActivity from '@/lib/pr-activity-comment';
const realAppendPrActivity = realPrActivity.appendPrActivity;
const reviewLog: Array<[string, ...unknown[]]> = [];
const mockAppendPrActivity = mock(async (p: any) => {
  reviewLog.push(['appendPrActivity', p]);
  return realAppendPrActivity(p);
});
mock.module('@/lib/pr-activity-comment', () => ({ ...realPrActivity, appendPrActivity: mockAppendPrActivity }));
const mockShutdownDeadBuilddPrs = mock(async (...a: unknown[]) => { reviewLog.push(['shutdownDeadBuilddPrs', ...a]); return {} as any; });
mock.module('@/lib/dead-pr-shutdown', () => ({ shutdownDeadBuilddPrs: mockShutdownDeadBuilddPrs }));

// The CI-fix retry keeps its real implementation (the CI tests above drive it
// through the db mock); only the call is logged, for the reviewer-flows
// characterization.
import * as realCiFailureRetry from '@/lib/ci-failure-retry';
const realRetryCiFailureForPr = realCiFailureRetry.retryCiFailureForPr;
const mockRetryCiFailureForPr = mock(async (input: any) => {
  reviewLog.push(['retryCiFailureForPr', input]);
  return realRetryCiFailureForPr(input);
});
mock.module('@/lib/ci-failure-retry', () => ({ ...realCiFailureRetry, retryCiFailureForPr: mockRetryCiFailureForPr }));

// The PR fact funnel: the one writer of prLifecycleStatus / mergedAt /
// conflictDetectedAt (stampPrMergedOnAllRows delegates to it). Terminal-wins,
// the stale-SHA drop and first-seen conflict are proven on real Postgres in
// apps/web/tests/db/pr-facts.test.ts; here we assert the FACT each door hands
// over, and drive the changed-rows answer (`[]` = terminal won, nothing changed).
import * as realPrFacts from '@buildd/core/pr-facts';
type RecordedPrFactRow = { id: string; taskId: string | null; workspaceId: string | null; previousStatus: string | null };
const recordedFacts: Array<{ target: any; fact: any; opts?: any }> = [];
const DEFAULT_PR_FACT_ROWS: RecordedPrFactRow[] = [{ id: 'row-1', taskId: null, workspaceId: null, previousStatus: null }];
let recordPrFactRows: RecordedPrFactRow[] = DEFAULT_PR_FACT_ROWS;
mock.module('@buildd/core/pr-facts', () => ({
  ...realPrFacts,
  recordPrFact: async (target: unknown, fact: unknown, opts?: unknown) => {
    recordedFacts.push({ target, fact, opts });
    return recordPrFactRows;
  },
}));
beforeEach(() => {
  recordedFacts.length = 0;
  recordPrFactRows = DEFAULT_PR_FACT_ROWS;
});
const factsOfKind = (kind: string) => recordedFacts.filter((r) => r.fact.kind === kind);

// Import handler AFTER mocks
import { POST } from './route';
import { MISSION_PR_TASK_PREFIX } from '@buildd/core/mission-integration';
// Real renderer (not mocked) — the tests below assert on comment bodies the
// route hands to GitHub, so they build fixtures with the same code path.
import { renderPrActivityComment, SPINNER_PATH } from '@/lib/pr-activity-comment';

// ── Helpers ─────────────────────────────────────────────────────────────────
function createWebhookRequest(event: string, payload: any, validSig = true): NextRequest {
  mockVerifyWebhookSignature.mockReturnValue(Promise.resolve(validSig));
  return new NextRequest('http://localhost:3000/api/github/webhook', {
    method: 'POST',
    headers: {
      'x-hub-signature-256': 'sha256=test',
      'x-github-event': event,
      'x-github-delivery': 'delivery-1',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

function makeInstallation(overrides: Record<string, any> = {}) {
  return {
    id: 12345,
    account: {
      login: 'test-org',
      id: 1,
      type: 'Organization',
      avatar_url: 'https://example.com/avatar.png',
    },
    repository_selection: 'selected',
    permissions: { issues: 'read', contents: 'read' },
    ...overrides,
  };
}

function makeIssue(overrides: Record<string, any> = {}) {
  return {
    id: 999,
    number: 42,
    title: 'Test Issue',
    body: 'Issue body content',
    state: 'open',
    html_url: 'https://github.com/test-org/test-repo/issues/42',
    labels: [{ name: 'buildd' }],
    ...overrides,
  };
}

function makeCheckSuitePayload(overrides: Record<string, any> = {}) {
  return {
    action: 'completed',
    check_suite: {
      id: 1,
      head_sha: 'abc123',
      status: 'completed',
      conclusion: 'failure',
      pull_requests: [
        {
          number: 42,
          head: { sha: 'abc123', ref: 'buildd/task-1-fix-bug' },
          base: { sha: 'def456', ref: 'main' },
        },
      ],
      ...overrides.check_suite,
    },
    repository: {
      id: 100,
      full_name: 'test-org/test-repo',
      ...overrides.repository,
    },
    installation: {
      id: 5000,
      ...overrides.installation,
    },
  };
}

function resetAll() {
  mockRetargetSurfaceIntents.mockClear();
  mockSettleSurfaceIntentsOnClose.mockClear();
  mockResolveCompletedTask.mockClear();
  mockCheckDependsOnResolved.mockClear();
  mockUndraftStackedDependents.mockClear();
  mockWakeMissionAfterResponse.mockClear();
  mockVerifyWebhookSignature.mockReset();
  mockGithubApi.mockReset();
  mockAllCheckSuitesPassed.mockReset();
  mockHasCheckSuites.mockReset();
  mockMergePullRequest.mockReset();
  mockNotifyMissionPrReady.mockReset();
  mockSyncInstallationReposById.mockReset();
  mockSyncInstallationReposById.mockReturnValue(
    Promise.resolve({ synced: 0, linked: 0, linkedWorkspaceIds: [] })
  );
  mockWorkerOwnsPr.mockClear();
  mockWorkerOwnsPrUrl.mockClear();
  mockWorkspaceRepoMatches.mockClear();
  mockAnnounceTaskCreated.mockReset();
  mockWakeTask.mockClear();
  mockCaptureCiJobLogEvidence.mockClear();
  mockInstallationsFindFirst.mockReset();
  mockWorkspacesFindFirst.mockReset();
  mockWorkspacesFindMany.mockReset();
  mockWorkersFindFirst.mockReset();
  mockTasksFindFirst.mockReset();
  mockMissionsFindFirst.mockReset();
  mockResolveReleaseStrategy.mockReset();
  mockCountPendingTasksForMission.mockReset();
  mockClaimMissionReleaseAttempt.mockReset();
  mockClaimMissionReleaseAttempt.mockReturnValue(Promise.resolve(true));
  mockCommitMissionRelease.mockReset();
  failUpdateMatching = null;
  updateReturningByStatus = {};
  mockApplyTaskCancelSideEffects.mockClear();
  mockApplyTaskReopenSideEffects.mockClear();
  mockAbandonMissionReleaseAttempt.mockReset();
  mockCanCompleteMission.mockReset();
  mockCanCompleteMission.mockReturnValue(Promise.resolve({ ok: true, code: 'ok', reason: 'clear' }) as any);
  mockCheckAndUnblockDependentMissions.mockReset();
  mockCheckAndUnblockDependentMissions.mockReturnValue(Promise.resolve([]));
  mockResolvePolicy.mockReset();
  mockReadPrReviewStatus.mockReset();
  mockReadPrReviewStatus.mockReturnValue(Promise.resolve({
    state: 'not_requested', terminal: true, reviewTaskId: null, adoptedTaskId: null,
    verdict: null, confidence: null, summary: null, feedback: null, escalationReason: null,
    iteration: null, maxIterations: null, prState: 'open', merged: false, mergeBlocked: null,
  }));
  mockCreateReviewerTask.mockReset();
  mockListWorkspaceRoles.mockReset();
  mockListWorkspaceRoles.mockImplementation(() => Promise.resolve(DEFAULT_ROLES as any[]));
  mockReconcileSubjectEvent.mockClear();
  mockFireGateEvent.mockClear();
  mockScheduleCiRedLook.mockClear();
  mockPreflightEscalationCheck.mockReset();
  mockTryDispatchMigrationCollisionRetry.mockReset();
  mockTryAutoMergeWorkerPr.mockReset();
  mockLandPr.mockReset();
  mockLandPr.mockImplementation(async () => ({ kind: 'waiting_ci', headSha: 'abc123' }));
  mockCarryForwardApproval.mockClear();
  mockDispatchWorkflowRelease.mockReset();
  // mockReset() drops the implementation, so the passthrough is reinstalled.
  mockRecordAndDispatchRelease.mockReset();
  mockRecordAndDispatchRelease.mockImplementation(async (params: any) => {
    const dispatched: any = await mockDispatchWorkflowRelease(
      params.installationId,
      params.owner,
      params.name,
      { workflowFile: params.workflowFile, ref: params.ref, inputs: params.inputs },
    );
    return {
      ok: true as const,
      releaseId: 'rel-auto-1',
      deduped: false,
      headSha: 'sha-dev-head',
      runId: dispatched?.runId,
      runUrl: dispatched?.runUrl,
      runsUrl: dispatched?.runsUrl,
    };
  });
  mockTriggerEvent.mockReset();
  mockRecordDirectProdMerge.mockReset();
  mockRecordDirectProdMerge.mockReturnValue(Promise.resolve());
  mockAdvanceGatedReleaseOnPrMerge.mockReset();
  mockAdvanceGatedReleaseOnPrMerge.mockReturnValue(Promise.resolve());

  insertCalls = [];
  deleteCalls = [];
  updateCalls = [];
  selectWhereCalls = [];
  mockNotify.mockClear();
  mockNotifyTeamOf.mockClear();
  selectTableResults = () => null;
  jobInsertConflicts = false;

  // Defaults
  mockVerifyWebhookSignature.mockReturnValue(Promise.resolve(true));
  mockAnnounceTaskCreated.mockReturnValue(Promise.resolve());
  mockInstallationsFindFirst.mockReturnValue(null);
  mockWorkspacesFindFirst.mockReturnValue(null);
  mockWorkspacesFindMany.mockReturnValue([]);
  mockWorkersFindFirst.mockReturnValue(null);
  mockTasksFindFirst.mockReturnValue(null);
  mockMissionsFindFirst.mockReturnValue(null);
  mockGithubApi.mockReturnValue(Promise.resolve({ draft: false }));
  mockAllCheckSuitesPassed.mockReturnValue(Promise.resolve(true));
  mockHasCheckSuites.mockReturnValue(Promise.resolve(false));
  mockMergePullRequest.mockReturnValue(Promise.resolve({ merged: true, message: 'ok' }));
  mockNotifyMissionPrReady.mockReturnValue(Promise.resolve());
  // Default: no pending tasks (all-terminal)
  mockCountPendingTasksForMission.mockReturnValue(Promise.resolve(0));
  // Phase 2 defaults
  mockResolvePolicy.mockReturnValue({ tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: [] } });
  mockPreflightEscalationCheck.mockReturnValue({ shouldEscalate: false });
  mockTryDispatchMigrationCollisionRetry.mockReturnValue(Promise.resolve({ handled: false }));
  mockCreateReviewerTask.mockReturnValue(Promise.resolve({ id: 'reviewer-task-1' }));
  mockTryAutoMergeWorkerPr.mockReturnValue(Promise.resolve());
  mockDispatchWorkflowRelease.mockReturnValue(
    Promise.resolve({
      dispatched: true,
      workflowFile: 'release.yml',
      ref: 'dev',
      inputs: {},
      runsUrl: 'https://github.com/test-org/test-repo/actions/workflows/release.yml',
    }),
  );

  // Default: resolve based on workspace config
  mockResolveReleaseStrategy.mockImplementation((config: any) => {
    if (!config || !config.enabled) return { ok: false, reason: 'not_configured', message: 'not configured' };
    const kind = config.strategy ?? 'branch_merge';
    if (kind === 'branch_merge') return { ok: true, strategy: { kind, prodBranch: config.prodBranch ?? 'main' } };
    if (kind === 'workflow_dispatch') {
      return { ok: true, strategy: { kind, workflowFile: config.workflowFile ?? 'release.yml', ref: config.ref ?? 'dev', inputs: config.inputs ?? {} } };
    }
    return { ok: false, reason: 'invalid', message: 'unknown strategy' };
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────
describe('POST /api/github/webhook', () => {
  beforeEach(resetAll);

  // ── Signature validation ────────────────────────────────────────────────
  it('returns 401 on invalid signature', async () => {
    const req = createWebhookRequest('ping', {}, false);
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Invalid signature');
  });

  it('returns 200 for ping event', async () => {
    const req = createWebhookRequest('ping', { zen: 'hello' });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  // ── Installation events ─────────────────────────────────────────────────
  it('handles installation created - upserts the installation', async () => {
    const payload = { action: 'created', installation: makeInstallation() };
    const req = createWebhookRequest('installation', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0].values.installationId).toBe(12345);
    expect(insertCalls[0].conflict).toBe('update');
  });

  // Regression: a fresh install used to leave every matching workspace with a
  // null githubRepoId until someone clicked "Sync" in Settings — and Settings
  // only lists installations a workspace already points at, so a brand-new
  // installation was unreachable from the UI. The webhook must back-link.
  it('handles installation created - back-links workspaces for the new installation', async () => {
    mockSyncInstallationReposById.mockReturnValue(
      Promise.resolve({ synced: 3, linked: 1, linkedWorkspaceIds: ['ws-sibling-app'] })
    );
    const payload = { action: 'created', installation: makeInstallation() };
    const res = await POST(createWebhookRequest('installation', payload));

    expect(res.status).toBe(200);
    expect(mockSyncInstallationReposById).toHaveBeenCalledWith(12345);
  });

  it('still returns 200 when back-linking a new installation fails', async () => {
    mockSyncInstallationReposById.mockImplementation(() =>
      Promise.reject(new Error('GitHub API error: 503'))
    );
    const payload = { action: 'created', installation: makeInstallation() };
    const res = await POST(createWebhookRequest('installation', payload));

    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('does not back-link on installation deleted / suspend / unsuspend', async () => {
    for (const action of ['deleted', 'suspend', 'unsuspend']) {
      const res = await POST(
        createWebhookRequest('installation', { action, installation: makeInstallation() })
      );
      expect(res.status).toBe(200);
    }
    expect(mockSyncInstallationReposById).not.toHaveBeenCalled();
  });

  it('handles installation deleted', async () => {
    const payload = { action: 'deleted', installation: makeInstallation() };
    const req = createWebhookRequest('installation', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(deleteCalls.length).toBe(1);
  });

  it('handles installation suspend', async () => {
    const payload = { action: 'suspend', installation: makeInstallation() };
    const req = createWebhookRequest('installation', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].setValues.suspendedAt).toBeInstanceOf(Date);
  });

  it('handles installation unsuspend', async () => {
    const payload = { action: 'unsuspend', installation: makeInstallation() };
    const req = createWebhookRequest('installation', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].setValues.suspendedAt).toBeNull();
  });

  // ── Installation repositories ───────────────────────────────────────────
  it('handles installation_repositories added - back-links newly granted repos', async () => {
    mockSyncInstallationReposById.mockReturnValue(
      Promise.resolve({ synced: 4, linked: 1, linkedWorkspaceIds: ['ws-1'] })
    );
    const payload = {
      action: 'added',
      installation: { id: 5000 },
      repositories_added: [{ id: 400, full_name: 'maxjacu/sibling-app' }],
    };
    const res = await POST(createWebhookRequest('installation_repositories', payload));

    expect(res.status).toBe(200);
    expect(mockSyncInstallationReposById).toHaveBeenCalledWith(5000);
    expect(deleteCalls.length).toBe(0);
  });

  it('resumes waiting tasks after access-granting deliveries, every time they arrive', async () => {
    mockResumeAfterInstallationChange.mockClear();
    mockSyncInstallationReposById.mockReturnValue(Promise.resolve({ synced: 1, linked: 0, linkedWorkspaceIds: [] }));
    const added = { action: 'added', installation: { id: 5000 }, repositories_added: [{ id: 400, full_name: 'acme/web' }] };
    // GitHub may redeliver; each delivery re-verifies, the store's status
    // guard makes the second one a no-op.
    await POST(createWebhookRequest('installation_repositories', added));
    await POST(createWebhookRequest('installation_repositories', added));
    await POST(createWebhookRequest('installation', { action: 'unsuspend', installation: makeInstallation() }));
    expect(mockResumeAfterInstallationChange).toHaveBeenCalledTimes(3);
    expect(mockResumeAfterInstallationChange.mock.calls[0]?.[0]).toBe(5000);
  });

  it('records accepted permissions and resumes on new_permissions_accepted', async () => {
    mockResumeAfterInstallationChange.mockClear();
    const installation = { ...makeInstallation(), permissions: { pull_requests: 'write', contents: 'write' } };
    const res = await POST(createWebhookRequest('installation', { action: 'new_permissions_accepted', installation }));
    expect(res.status).toBe(200);
    expect(updateCalls.at(-1)?.setValues.permissions).toEqual({ pull_requests: 'write', contents: 'write' });
    expect(mockResumeAfterInstallationChange).toHaveBeenCalledTimes(1);
  });

  it('does not resume on removal or suspension', async () => {
    mockResumeAfterInstallationChange.mockClear();
    await POST(createWebhookRequest('installation_repositories', { action: 'removed', installation: { id: 5000 }, repositories_removed: [{ id: 300 }] }));
    await POST(createWebhookRequest('installation', { action: 'suspend', installation: makeInstallation() }));
    expect(mockResumeAfterInstallationChange).not.toHaveBeenCalled();
  });

  it('handles installation_repositories removed', async () => {
    const payload = {
      action: 'removed',
      installation: { id: 5000 },
      repositories_removed: [{ id: 300 }],
    };
    const req = createWebhookRequest('installation_repositories', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(deleteCalls.length).toBe(1);
    expect(mockSyncInstallationReposById).not.toHaveBeenCalled();
  });

  // ── Issues events ───────────────────────────────────────────────────────
  it('handles issues opened with buildd label - creates task', async () => {
    mockWorkspacesFindFirst.mockReturnValue(
      Promise.resolve({ id: 'ws-1', repo: 'test-org/test-repo' })
    );

    const payload = {
      action: 'opened',
      issue: makeIssue({ labels: [{ name: 'buildd' }] }),
      repository: { id: 100, full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };

    const req = createWebhookRequest('issues', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0].values.workspaceId).toBe('ws-1');
    expect(insertCalls[0].values.title).toBe('Test Issue');
    expect(insertCalls[0].values.status).toBe('pending');
    expect(insertCalls[0].values.creationSource).toBe('github');
    expect(insertCalls[0].conflict).toBe('nothing');
    expect(mockAnnounceTaskCreated).toHaveBeenCalledTimes(1);
    expect(mockWakeTask).toHaveBeenCalledWith((mockAnnounceTaskCreated.mock.calls[0] as any[])[0].id, 'task.created');
  });

  it('handles issues opened without buildd label - no task created', async () => {
    mockWorkspacesFindFirst.mockReturnValue(
      Promise.resolve({ id: 'ws-1', repo: 'test-org/test-repo' })
    );

    const payload = {
      action: 'opened',
      issue: makeIssue({ labels: [{ name: 'bug' }] }),
      repository: { id: 100, full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };

    const req = createWebhookRequest('issues', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(insertCalls.length).toBe(0);
  });

  it('handles issues closed - cancels the linked task if non-terminal', async () => {
    mockWorkspacesFindFirst.mockReturnValue(
      Promise.resolve({ id: 'ws-1', repo: 'test-org/test-repo' })
    );

    const payload = {
      action: 'closed',
      issue: makeIssue({ state: 'closed' }),
      repository: { id: 100, full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };

    const req = createWebhookRequest('issues', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(updateCalls.length).toBe(1);
    // An externally-closed issue cancels its open task (was 'completed' before the
    // work-tracker rework); the WHERE guard skips already-terminal tasks.
    expect(updateCalls[0].setValues.status).toBe('cancelled');
  });

  it('issues closed with an open linked task runs the shared cancel side effects', async () => {
    mockWorkspacesFindFirst.mockReturnValue(
      Promise.resolve({ id: 'ws-1', repo: 'test-org/test-repo' })
    );
    // The running task's row is actually changed by the guarded UPDATE.
    updateReturningByStatus.cancelled = [{ id: 'task-9', workspaceId: 'ws-1', missionId: 'm-1' }];

    const res = await POST(createWebhookRequest('issues', {
      action: 'closed',
      issue: makeIssue({ state: 'closed' }),
      repository: { id: 100, full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    }));

    expect(res.status).toBe(200);
    // abort + path-claim release + resolveCompletedTask + TASK_UPDATED all live
    // in the helper (see lib/task-cancel.test.ts).
    expect(mockApplyTaskCancelSideEffects).toHaveBeenCalledTimes(1);
    expect(mockApplyTaskCancelSideEffects).toHaveBeenCalledWith(
      { id: 'task-9', workspaceId: 'ws-1', missionId: 'm-1' },
    );
  });

  it('issues closed when the task is already terminal (buildd post-merge close) is a no-op', async () => {
    mockWorkspacesFindFirst.mockReturnValue(
      Promise.resolve({ id: 'ws-1', repo: 'test-org/test-repo' })
    );
    updateReturningByStatus.cancelled = []; // guard skipped the terminal row

    const res = await POST(createWebhookRequest('issues', {
      action: 'closed',
      issue: makeIssue({ state: 'closed' }),
      repository: { id: 100, full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    }));

    expect(res.status).toBe(200);
    expect(mockApplyTaskCancelSideEffects).not.toHaveBeenCalled();
  });

  it('issues reopened runs the reopen side effects for each resurrected task', async () => {
    mockWorkspacesFindFirst.mockReturnValue(
      Promise.resolve({ id: 'ws-1', repo: 'test-org/test-repo' })
    );
    updateReturningByStatus.pending = [{ id: 'task-9', workspaceId: 'ws-1', missionId: 'm-1' }];

    await POST(createWebhookRequest('issues', {
      action: 'reopened',
      issue: makeIssue({ state: 'open' }),
      repository: { id: 100, full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    }));

    expect(updateCalls[0].setValues).toMatchObject({ status: 'pending', claimedBy: null });
    expect(mockApplyTaskReopenSideEffects).toHaveBeenCalledWith(
      { id: 'task-9', workspaceId: 'ws-1', missionId: 'm-1' },
      expect.any(String),
    );
  });

  it('issues reopened with nothing to resurrect runs no side effects', async () => {
    mockWorkspacesFindFirst.mockReturnValue(
      Promise.resolve({ id: 'ws-1', repo: 'test-org/test-repo' })
    );
    updateReturningByStatus.pending = [];

    await POST(createWebhookRequest('issues', {
      action: 'reopened',
      issue: makeIssue({ state: 'open' }),
      repository: { id: 100, full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    }));

    expect(mockApplyTaskReopenSideEffects).not.toHaveBeenCalled();
  });

  it('handles issues reopened - updates task to pending', async () => {
    mockWorkspacesFindFirst.mockReturnValue(
      Promise.resolve({ id: 'ws-1', repo: 'test-org/test-repo' })
    );

    const payload = {
      action: 'reopened',
      issue: makeIssue({ state: 'open' }),
      repository: { id: 100, full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };

    const req = createWebhookRequest('issues', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].setValues.status).toBe('pending');
  });

  it('ignores issues event without installation', async () => {
    const payload = {
      action: 'opened',
      issue: makeIssue(),
      repository: { id: 100, full_name: 'test-org/test-repo' },
    };

    const req = createWebhookRequest('issues', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(insertCalls.length).toBe(0);
    expect(mockWorkspacesFindFirst).not.toHaveBeenCalled();
  });

  it('handles issues opened with ai label - creates task', async () => {
    mockWorkspacesFindFirst.mockReturnValue(
      Promise.resolve({ id: 'ws-1', repo: 'test-org/test-repo' })
    );

    const payload = {
      action: 'opened',
      issue: makeIssue({ labels: [{ name: 'ai' }] }),
      repository: { id: 100, full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };

    const req = createWebhookRequest('issues', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(insertCalls.length).toBe(1);
  });

  it('ignores issues when no workspace is linked', async () => {
    mockWorkspacesFindFirst.mockReturnValue(Promise.resolve(null));

    const payload = {
      action: 'opened',
      issue: makeIssue(),
      repository: { id: 100, full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };

    const req = createWebhookRequest('issues', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(insertCalls.length).toBe(0);
  });

  // ── Error handling ──────────────────────────────────────────────────────
  it('returns 500 when handler throws', async () => {
    mockWorkspacesFindFirst.mockImplementation(() => {
      throw new Error('Database connection failed');
    });

    const payload = {
      action: 'opened',
      issue: makeIssue(),
      repository: { id: 100, full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };

    const req = createWebhookRequest('issues', payload);
    const res = await POST(req);

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Webhook processing failed');
  });

  it('returns 200 for unhandled event types', async () => {
    const req = createWebhookRequest('push', { ref: 'refs/heads/main' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  // ── Check suite handling ────────────────────────────────────────────────
  describe('check_suite handling', () => {
    // Helpers for the CI-failure → retry-task path.
    function withFailedWorkerPr(opts: {
      taskCtx?: Record<string, unknown>; gitConfig?: Record<string, unknown>; missionId?: string | null; status?: string;
      foreignCommit?: boolean; taskResult?: Record<string, unknown>; title?: string;
      /** GitHub's view of the PR: open (default), merged, or closed unmerged. */
      prState?: 'open' | 'merged' | 'closed';
      /** Fix-attempt rows already filed against the PR (the in-flight + budget read). */
      fixAttempts?: any[];
    } = {}) {
      if (opts.fixAttempts) {
        // Only the first tasks select is the fix-attempt read; the release-PR
        // lookup that runs after it reads tasks too and must see nothing.
        let rows: any[] | null = opts.fixAttempts;
        selectTableResults = (table: any) => {
          if (table !== schemaMock.tasks) return null;
          const out = rows;
          rows = null;
          return out;
        };
      }
      mockWorkersFindFirst.mockReturnValue({
        id: 'w1', branch: 'buildd/abc12345-fix', prNumber: 42,
        task: {
          id: 't1', title: opts.title ?? 'Fix the thing', description: 'orig desc',
          workspaceId: 'ws1', missionId: opts.missionId !== undefined ? opts.missionId : 'm1',
          context: opts.taskCtx ?? {},
          result: opts.taskResult ?? null,
          status: opts.status ?? 'in_progress',
        },
      });
      mockWorkspacesFindFirst.mockReturnValue({ id: 'ws1', gitConfig: opts.gitConfig ?? {} });
      // Dispatch different responses for different GitHub API endpoints:
      //   /commits/... → commit authorship (default: buildd worker; foreignCommit=true → human)
      //   everything else (PR draft check, CI runs) → { draft: false }
      mockGithubApi.mockImplementation((_installationId: number, url: string) => {
        if (typeof url === 'string' && url.includes('/commits/')) {
          if (opts.foreignCommit) {
            return Promise.resolve({
              author: { login: 'maxjacu' },
              commit: { author: { email: 'maxjacu@users.noreply.github.com', name: 'Max Jacubowsky' } },
            });
          }
          return Promise.resolve({
            author: { login: 'buildd-ai[bot]' },
            commit: { author: { email: '258464409+buildd-ai[bot]@users.noreply.github.com', name: 'buildd-ai[bot]' } },
          });
        }
        const prState = opts.prState ?? 'open';
        return Promise.resolve({
          draft: false,
          state: prState === 'open' ? 'open' : 'closed',
          merged: prState === 'merged',
        });
      });
    }

    /** n automatic CI retries already filed for PR #42: the budget is counted from these rows. */
    const spentCiRows = (n: number) => Array.from({ length: n }, (_, i) => ({
      id: `spent-${i}`, status: 'completed', creationSource: 'webhook', ciRetryPrNumber: 42, context: {}, createdAt: `2026-01-01T0${i}:00:00Z`,
    }));

    it('skips CI retry when no buildd worker owns the PR', async () => {
      // Default worker mock is null → nothing to retry
      const req = createWebhookRequest('check_suite', makeCheckSuitePayload());
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
      expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
    });

    it('creates and dispatches a CI fix task when CI fails on a worker PR', async () => {
      withFailedWorkerPr();

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(1);
      const inserted = insertCalls[0].values;
      expect(inserted.title).toBe('[builder · after CI #1] Fix the thing');
      expect(inserted.parentTaskId).toBe('t1');
      expect(inserted.missionId).toBe('m1');
      expect(inserted.ciRetryPrNumber).toBe(42);
      expect(inserted.ciRetryHeadSha).toBe('abc123');
      expect((inserted.context as any).iteration).toBe(1);
      expect((inserted.context as any).baseBranch).toBe('buildd/abc12345-fix');
      expect(insertCalls[0].conflict).toBe('nothing');
      expect(mockAnnounceTaskCreated).toHaveBeenCalledTimes(1);
      expect(mockWakeTask.mock.calls).toEqual([['task-1', 'ci.retry']]);
    });

    // byo-evidence-storage AC-3: the failed job's log is captured as evidence
    // for the new retry task, after the retry has been dispatched.
    it('captures ci_job_log evidence for the retry task after dispatching it', async () => {
      withFailedWorkerPr();
      const order: string[] = [];
      mockAnnounceTaskCreated.mockImplementation(() => { order.push('dispatch'); return Promise.resolve(); });
      mockCaptureCiJobLogEvidence.mockImplementationOnce(() => { order.push('evidence'); return Promise.resolve({ status: 'stored' }); });

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(mockCaptureCiJobLogEvidence).toHaveBeenCalledTimes(1);
      const arg = mockCaptureCiJobLogEvidence.mock.calls[0][0];
      expect(arg.retryTaskId).toBe('task-1'); // the id the insert mock returns
      expect(arg.parentTaskId).toBe('t1');
      expect(arg.workerId).toBe('w1');
      expect(arg.workspaceId).toBe('ws1');
      expect(arg.prNumber).toBe(42);
      expect(order).toEqual(['dispatch', 'evidence']);
    });

    // Regression: the CI fix attempt copied only the phase, so a Codex task's
    // fix ran on Claude and a role-routed task lost its role and routing kind.
    it('the CI fix attempt keeps the original task\'s backend, role, kind and phase', async () => {
      withFailedWorkerPr();
      // Answer only the attempt-identity read (the one that asks for roleSlug);
      // every other task read keeps the default.
      mockTasksFindFirst.mockImplementation((opts?: any) =>
        opts?.columns?.roleSlug
          ? {
              backend: 'codex', roleSlug: 'builder', kind: 'engineering', complexity: 'normal',
              missionPhaseIndex: 1, missionPhaseLabel: 'Build',
            }
          : null,
      );

      await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(insertCalls.length).toBe(1);
      expect(insertCalls[0].values).toMatchObject({
        backend: 'codex',
        roleSlug: 'builder',
        kind: 'engineering',
        complexity: 'normal',
        missionPhaseIndex: 1,
        missionPhaseLabel: 'Build',
      });
    });

    it('posts a sticky buildd activity comment when it picks up the CI failure', async () => {
      withFailedWorkerPr();

      await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      const commentCall = (mockGithubApi.mock.calls as any[]).find(
        (c) => c[1] === '/repos/test-org/test-repo/issues/42/comments' && c[2]?.method === 'POST',
      );
      expect(commentCall).toBeDefined();
      const body = JSON.parse(commentCall[2].body).body as string;
      expect(body).toContain('<!-- buildd-activity -->');
      // Queued, not "fixing": the retry task has no worker until the claim.
      expect(body).toContain('CI fix 1 of 3 queued');
      expect(body).toContain('waiting for a worker');
      expect(body).toContain('/app/tasks/');
    });

    it('dedupes structurally — skips dispatch when this workspace/PR/SHA already has a retry', async () => {
      withFailedWorkerPr();
      jobInsertConflicts = true;

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(1);
      expect(insertCalls[0].conflict).toBe('nothing');
      expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
    });

    it('dedupes a rebase storm — a second failure on a DIFFERENT head SHA for the same PR does not fan out while the first retry is still unclaimed', async () => {
      // A force-rebasing bot (renovate) can fire several check_suite failures for
      // the same PR within minutes, each carrying a distinct head_sha — the exact
      // (workspace, PR, headSha) unique index does not fire because the SHA really
      // did change. `tasks_one_pending_ci_retry_per_pr_unique` (schema.ts) is the
      // guard for this case: it blocks a second PENDING webhook CI retry for the
      // same PR regardless of SHA, until the first one is claimed. This test
      // exercises the app's handling of that conflict via the same
      // `jobInsertConflicts` mock idiom the exact-SHA test above uses — the mocked
      // DB enforces no schema, so the index shape itself is pinned by
      // packages/core/__tests__/ci-retry-pending-dedup-index.test.ts.
      withFailedWorkerPr();
      jobInsertConflicts = true;

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload({
        check_suite: { head_sha: 'def456', pull_requests: [{ number: 42, head: { sha: 'def456', ref: 'buildd/task-1-fix-bug' }, base: { sha: 'def456', ref: 'main' } }] },
      })));

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(1);
      const attempted = insertCalls[0].values;
      expect(attempted.ciRetryPrNumber).toBe(42); // the key the pending-retry index dedupes on
      expect(attempted.ciRetryHeadSha).toBe('def456'); // genuinely a new SHA, not a literal duplicate delivery
      expect(insertCalls[0].conflict).toBe('nothing');
      expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
    });

    it('skips CI retry for draft PRs', async () => {
      withFailedWorkerPr();
      mockGithubApi.mockReturnValue(Promise.resolve({ draft: true }));

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
      expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
    });

    it('fails the task and notifies the mission when retries are exhausted', async () => {
      // three CI retries already filed → buildCIRetryTask returns null
      withFailedWorkerPr({ fixAttempts: spentCiRows(3), gitConfig: { maxCiRetries: 3 } });

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
      expect(updateCalls.some(c => (c.setValues as any).status === 'failed')).toBe(true);
      expect(mockNotifyMissionPrReady).toHaveBeenCalledTimes(1);
    });

    it('preserves the agent handoff recommendation when it fails the exhausted task', async () => {
      // Home's blocked card leads with result.nextSuggestion — overwriting the
      // whole result object on exhaustion would destroy the only advice the
      // human gets, at exactly the moment they inherit the PR.
      withFailedWorkerPr({
        fixAttempts: spentCiRows(3),
        gitConfig: { maxCiRetries: 3 },
        taskResult: { summary: 'Fixed lint, tests still red', nextSuggestion: 'Backfill migration 0071 by hand, then re-run CI.' },
      });

      await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      const failUpdate = updateCalls.find(c => (c.setValues as any).status === 'failed');
      expect(failUpdate).toBeDefined();
      const result = (failUpdate!.setValues as any).result;
      expect(result.nextSuggestion).toBe('Backfill migration 0071 by hand, then re-run CI.');
      expect(result.summary).toContain('CI retry stopped');
    });

    it('tells the PR a human is needed once CI retries are exhausted', async () => {
      withFailedWorkerPr({ fixAttempts: spentCiRows(3), gitConfig: { maxCiRetries: 3 } });

      await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      const commentCall = (mockGithubApi.mock.calls as any[]).find(
        (c) => c[1] === '/repos/test-org/test-repo/issues/42/comments' && c[2]?.method === 'POST',
      );
      expect(commentCall).toBeDefined();
      expect(JSON.parse(commentCall[2].body).body).toContain('CI still failing · needs a human');
    });

    it('does not retry when maxCiRetries is 0 (disabled)', async () => {
      withFailedWorkerPr({ gitConfig: { maxCiRetries: 0 } });

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
      expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
      // exhausted/disabled path marks the task failed
      expect(updateCalls.some(c => (c.setValues as any).status === 'failed')).toBe(true);
    });

    // ── Commit author never decides the budget (allocation is consumption) ──

    it('a non-worker SHA spends an attempt like any other, and records no foreign-push marker', async () => {
      withFailedWorkerPr({ foreignCommit: true });

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(1);
      const inserted = insertCalls[0].values;
      expect(inserted.parentTaskId).toBe('t1');
      expect(inserted.ciRetryPrNumber).toBe(42);
      expect((inserted.context as any).iteration).toBe(1);
      expect((inserted.context as any).foreign_head_sha).toBeUndefined();
      expect((inserted.context as any).foreignCommitAuthor).toBeUndefined();
      // The author is not even read.
      expect((mockGithubApi.mock.calls as any[]).some((c) => typeof c[1] === 'string' && /\/commits\/[^/]+$/.test(c[1]))).toBe(false);
      expect(mockAnnounceTaskCreated).toHaveBeenCalledTimes(1);
      expect(mockWakeTask).toHaveBeenCalledTimes(1);
    });

    it('a worker-authored SHA spends an attempt the same way', async () => {
      withFailedWorkerPr();

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(1);
      expect((insertCalls[0].values.context as any).iteration).toBe(1);
      expect((insertCalls[0].values.context as any).foreign_head_sha).toBeUndefined();
    });

    it('the cap bounds dispatches whoever pushed: a non-worker push after a spent budget escalates', async () => {
      withFailedWorkerPr({ foreignCommit: true, fixAttempts: spentCiRows(3), gitConfig: { maxCiRetries: 3 } });

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
      expect(updateCalls.some(c => (c.setValues as any).status === 'failed')).toBe(true);
    });

    it('the disabled-retries message names the workspace switch, not who pushed', async () => {
      withFailedWorkerPr({ gitConfig: { maxCiRetries: 0 }, foreignCommit: true });

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      const failUpdate = updateCalls.find(c => (c.setValues as any).status === 'failed');
      expect(failUpdate).toBeDefined();
      const summary = (failUpdate!.setValues as any).result?.summary ?? '';
      expect(summary).toContain('CI retries are disabled');
      expect(summary).not.toContain('non-worker');
    });

    it('ignores non-completed check_suite actions', async () => {
      const payload = makeCheckSuitePayload();
      payload.action = 'requested';

      const req = createWebhookRequest('check_suite', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
    });

    it('ignores check_suite without installation', async () => {
      const payload = makeCheckSuitePayload();
      delete (payload as any).installation;

      const req = createWebhookRequest('check_suite', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
    });

    it('ignores check_suite with non-failure conclusion', async () => {
      const payload = makeCheckSuitePayload({
        check_suite: { conclusion: 'neutral' },
      });

      const req = createWebhookRequest('check_suite', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
    });

    // A worker calls complete_task right after it pushes, so by the time CI
    // reports, the PR's root task and the review-fix attempt that pushed are
    // both 'completed'. That PR is open and red: it still gets the retry.
    it('a completed review-fix attempt whose push goes red gets exactly one CI retry', async () => {
      withFailedWorkerPr({
        status: 'completed',
        title: '[builder · after review #1] Fix the thing',
        fixAttempts: [
          { id: 'rf1', status: 'completed', creationSource: 'webhook', ciRetryPrNumber: null, context: {}, createdAt: '2026-01-01T00:00:00Z' },
        ],
      });

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(1);
      const inserted = insertCalls[0].values;
      expect(inserted.title).toBe('[builder · after CI #1] Fix the thing');
      expect(inserted.ciRetryPrNumber).toBe(42);
      // Counts against the budget: an agent-authored push burns attempt 1.
      expect((inserted.context as any).iteration).toBe(1);
      expect((inserted.context as any).maxIterations).toBe(3);
      expect(mockAnnounceTaskCreated).toHaveBeenCalledTimes(1);
      expect(mockWakeTask).toHaveBeenCalledTimes(1);
      expect(updateCalls.some(c => c.table === schemaMock.tasks && (c.setValues as any).status === 'failed')).toBe(false);
    });

    it('counts the budget from the CI retries already filed, not the completed owner\'s context', async () => {
      // The owner context claims a spent budget; it is ignored. The three filed CI retries count,
      // including the old row an earlier rule marked foreign (allocation is consumption).
      withFailedWorkerPr({
        status: 'completed',
        taskCtx: { iteration: 9 },
        fixAttempts: [
          { id: 'c1', status: 'completed', creationSource: 'webhook', ciRetryPrNumber: 42, context: { iteration: 1 }, createdAt: '2026-01-01T00:00:00Z' },
          { id: 'c2', status: 'completed', creationSource: 'webhook', ciRetryPrNumber: 42, context: { iteration: 2 }, createdAt: '2026-01-01T01:00:00Z' },
          { id: 'c3', status: 'completed', creationSource: 'webhook', ciRetryPrNumber: 42, context: { foreign_head_sha: true }, createdAt: '2026-01-01T02:00:00Z' },
          // A drift diagnosis never burns the budget.
          { id: 'd1', status: 'completed', creationSource: 'webhook', outputRequirement: 'artifact_required', ciRetryPrNumber: 42, context: {}, createdAt: '2026-01-01T03:00:00Z' },
        ],
        gitConfig: { maxCiRetries: 5 },
      });

      await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(insertCalls.length).toBe(1);
      expect((insertCalls[0].values.context as any).iteration).toBe(4);
    });

    it('a completed owner whose PR already used the whole budget escalates instead of retrying', async () => {
      withFailedWorkerPr({
        status: 'completed',
        gitConfig: { maxCiRetries: 2 },
        fixAttempts: [
          { id: 'c1', status: 'completed', creationSource: 'webhook', ciRetryPrNumber: 42, context: {}, createdAt: '2026-01-01T00:00:00Z' },
          { id: 'c2', status: 'failed', creationSource: 'webhook', ciRetryPrNumber: 42, context: {}, createdAt: '2026-01-01T01:00:00Z' },
        ],
      });

      await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(insertCalls.length).toBe(0);
      expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
      expect(updateCalls.some(c => c.table === schemaMock.tasks && (c.setValues as any).status === 'failed')).toBe(true);
    });

    for (const live of ['pending', 'in_progress'] as const) {
      it(`does not stack a second CI retry while one is ${live}`, async () => {
        withFailedWorkerPr({
          status: 'completed',
          fixAttempts: [
            { id: 'c1', status: live, creationSource: 'webhook', ciRetryPrNumber: 42, context: { iteration: 1 }, createdAt: '2026-01-01T00:00:00Z' },
          ],
        });

        const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload({ check_suite: { head_sha: 'newsha1' } })));

        expect(res.status).toBe(200);
        expect(insertCalls.length).toBe(0);
        expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
        expect(mockWakeTask).not.toHaveBeenCalled();
        expect(updateCalls.some(c => c.table === schemaMock.tasks && (c.setValues as any).status === 'failed')).toBe(false);
      });
    }

    it('does not stack a CI retry on a review fix that is still running', async () => {
      withFailedWorkerPr({
        status: 'completed',
        fixAttempts: [
          { id: 'rf1', status: 'in_progress', creationSource: 'webhook', ciRetryPrNumber: null, context: {}, createdAt: '2026-01-01T00:00:00Z' },
        ],
      });

      await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(insertCalls.length).toBe(0);
      expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
    });

    for (const prState of ['merged', 'closed'] as const) {
      it(`does not retry when the PR is already ${prState}`, async () => {
        withFailedWorkerPr({ status: 'completed', prState });

        const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

        expect(res.status).toBe(200);
        expect(insertCalls.length).toBe(0);
        expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
        expect(mockWakeTask).not.toHaveBeenCalled();
        expect(updateCalls.some(c => c.table === schemaMock.tasks && (c.setValues as any).status === 'failed')).toBe(false);
      });
    }

    // AC-5: failed/cancelled tasks must not spawn retry children
    it('skips retry for failed task (AC-5)', async () => {
      withFailedWorkerPr({ status: 'failed', missionId: null });

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
    });

    it('skips retry for cancelled task (AC-5)', async () => {
      withFailedWorkerPr({ status: 'cancelled', missionId: null });

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
    });

    // Every "no CI retry" return writes a ledger row with a stable reason code,
    // so a red PR nobody is fixing can be explained instead of reconstructed.
    describe('ci_retry_skipped ledger', () => {
      const skipEvents = () =>
        (mockFireGateEvent.mock.calls as any[])
          .map(c => c[0])
          .filter(e => e.gate === REAL_GATE_SLUGS.CI_RETRY_SKIPPED);

      async function fail(payloadOverrides: Record<string, any> = {}) {
        const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload(payloadOverrides)));
        expect(res.status).toBe(200);
      }

      it('dispatching a retry writes no skip row', async () => {
        withFailedWorkerPr();
        await fail();
        expect(mockAnnounceTaskCreated).toHaveBeenCalledTimes(1);
        expect(mockWakeTask).toHaveBeenCalledTimes(1);
        expect(skipEvents()).toEqual([]);
      });

      it('a dispatched retry schedules a sweep look, so a fix that never pushes is noticed', async () => {
        withFailedWorkerPr();
        await fail();
        expect(mockScheduleCiRedLook).toHaveBeenCalledTimes(1);
        expect(mockScheduleCiRedLook.mock.calls[0][0]).toEqual({ workspaceId: 'ws1', prNumber: 42 });
      });

      it('draft PR → draft', async () => {
        withFailedWorkerPr();
        mockGithubApi.mockReturnValue(Promise.resolve({ draft: true }));
        await fail();
        const [e] = skipEvents();
        expect(e.detail.skipReason).toBe('draft');
        expect(e.outcome).toBe('rejected');
        expect(e.detail).toMatchObject({ prNumber: 42, headSha: 'abc123', repo: 'test-org/test-repo' });
        expect(e.workspaceId).toBe('ws1');
        expect(e.taskId).toBe('t1');
        expect(e.surface).toBe('webhook:check_suite');
      });

      for (const prState of ['merged', 'closed'] as const) {
        it(`${prState} PR → pr_${prState}`, async () => {
          withFailedWorkerPr({ status: 'completed', prState });
          await fail();
          expect(skipEvents().map(e => e.detail.skipReason)).toEqual([`pr_${prState}`]);
        });
      }

      it('terminal PR lifecycle → pr_terminal', async () => {
        withFailedWorkerPr();
        const w = mockWorkersFindFirst();
        mockWorkersFindFirst.mockReturnValue({ ...w, prLifecycleStatus: 'merged' });
        await fail();
        expect(skipEvents().map(e => e.detail.skipReason)).toEqual(['pr_terminal']);
      });

      for (const status of ['failed', 'cancelled'] as const) {
        it(`${status} owner → owner_stopped`, async () => {
          withFailedWorkerPr({ status, missionId: null });
          await fail();
          const [e] = skipEvents();
          expect(e.detail.skipReason).toBe('owner_stopped');
          expect(e.detail.ownerStatus).toBe(status);
        });
      }

      it('fix in flight → fix_in_flight, deferred, names the attempt, and schedules a sweep look', async () => {
        withFailedWorkerPr({
          status: 'completed',
          fixAttempts: [
            { id: 'rf1', status: 'in_progress', creationSource: 'webhook', ciRetryPrNumber: null, context: {}, createdAt: '2026-01-01T00:00:00Z' },
          ],
        });
        await fail();
        const [e] = skipEvents();
        expect(e.detail.skipReason).toBe('fix_in_flight');
        expect(e.outcome).toBe('deferred');
        expect(e.detail.inFlightTaskId).toBe('rf1');
        expect(mockScheduleCiRedLook).toHaveBeenCalledTimes(1);
        expect(mockScheduleCiRedLook.mock.calls[0][0]).toEqual({ workspaceId: 'ws1', prNumber: 42 });
      });

      it('a fix in flight elsewhere in the retry family (a sibling on a sibling PR) → fix_in_flight, names it, files nothing', async () => {
        withFailedWorkerPr({ status: 'completed', fixAttempts: [] });
        mockCheckDispatch.mockResolvedValueOnce({
          verdict: 'skip_dispatch', rule: 'open_retry_supersedes_duplicate', blockers: ['sibling-fix'],
        });
        await fail();
        expect(insertCalls.length).toBe(0);
        const [e] = skipEvents();
        expect(e.detail.skipReason).toBe('fix_in_flight');
        expect(e.detail.inFlightTaskId).toBe('sibling-fix');
      });

      it('a CI retry already filed for this exact head → head_already_retried, before fetching logs', async () => {
        withFailedWorkerPr({
          status: 'completed',
          fixAttempts: [
            { id: 'c1', status: 'completed', creationSource: 'webhook', ciRetryPrNumber: 42, ciRetryHeadSha: 'abc123', context: {}, createdAt: '2026-01-01T00:00:00Z' },
          ],
        });
        await fail();
        expect(insertCalls.length).toBe(0);
        const [e] = skipEvents();
        expect(e.detail.skipReason).toBe('head_already_retried');
        expect(e.detail.priorAttemptTaskId).toBe('c1');
        const runsCalls = (mockGithubApi.mock.calls as any[]).filter(c => String(c[1]).includes('/actions/runs'));
        expect(runsCalls).toEqual([]);
        expect(mockScheduleCiRedLook).toHaveBeenCalledTimes(1);
      });

      it('retry budget used up → retries_exhausted', async () => {
        withFailedWorkerPr({ fixAttempts: spentCiRows(3), gitConfig: { maxCiRetries: 3 } });
        await fail();
        const [e] = skipEvents();
        expect(e.detail.skipReason).toBe('retries_exhausted');
        expect(e.detail.attemptsUsed).toBe(3);
      });

      it('retries disabled → retries_disabled', async () => {
        withFailedWorkerPr({ gitConfig: { maxCiRetries: 0 } });
        await fail();
        expect(skipEvents().map(e => e.detail.skipReason)).toEqual(['retries_disabled']);
      });

      it('the insert conflicts (same PR/head retried concurrently) → duplicate', async () => {
        withFailedWorkerPr();
        jobInsertConflicts = true;
        await fail();
        expect(skipEvents().map(e => e.detail.skipReason)).toEqual(['duplicate']);
      });

      it('reason text is stable per code so the ledger coalesces repeats', async () => {
        withFailedWorkerPr();
        mockGithubApi.mockReturnValue(Promise.resolve({ draft: true }));
        await fail();
        await fail({ check_suite: { head_sha: 'other' } });
        const reasons = skipEvents().map(e => e.reason);
        expect(reasons.length).toBe(2);
        expect(reasons[0]).toBe(reasons[1]);
        expect(reasons[0]).not.toContain('42');
      });
    });

    // AC-4: a late check_suite.failure webhook must not overwrite a merged PR's lifecycle status
    it('does not stamp ci_failed when worker prLifecycleStatus is already merged (AC-4)', async () => {
      // Simulate a late failure webhook arriving after the PR was merged.
      // The first findFirst (ci_failed write loop) returns merged worker.
      // The second findFirst (handleCheckSuiteFailure) also returns the same worker
      // with a completed task so no retry is spawned.
      mockWorkersFindFirst.mockReturnValue({
        id: 'w-merged',
        workspaceId: 'ws1',
        taskId: 't-merged',
        prNumber: 42,
        prLifecycleStatus: 'merged',
        branch: 'buildd/merged-fix',
        task: {
          id: 't-merged', title: 'Merged fix', description: 'Fixed',
          workspaceId: 'ws1', missionId: null,
          context: {},
          status: 'completed',
        },
      });

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      // The door hands the CI fact over; terminal-wins is the funnel's WHERE
      // (tests/db/pr-facts.test.ts). The real rule agrees it cannot apply here.
      const ci = factsOfKind('ci');
      expect(ci.map((r) => r.fact.status)).toEqual(['ci_failed']);
      expect(realPrFacts.prFactApplies(ci[0]!.fact, { prLifecycleStatus: 'merged', mergedAt: null })).toBe(false);
      const ciFailedWrite = updateCalls.find((c) => (c.setValues as any).prLifecycleStatus === 'ci_failed');
      expect(ciFailedWrite).toBeUndefined();
    });

    it('does not stamp ci_failed over an unresolvable lifecycle (TERMINAL_PR_LIFECYCLE)', async () => {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w-unres',
        workspaceId: 'ws1',
        taskId: 't-unres',
        prNumber: 42,
        prLifecycleStatus: 'unresolvable',
        branch: 'buildd/unres',
        task: {
          id: 't-unres', title: 'Unresolvable', description: 'x',
          workspaceId: 'ws1', missionId: null,
          context: {},
          status: 'completed',
        },
      });

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      const ci = factsOfKind('ci');
      expect(ci.map((r) => r.fact.status)).toEqual(['ci_failed']);
      expect(realPrFacts.prFactApplies(ci[0]!.fact, { prLifecycleStatus: 'unresolvable', mergedAt: null })).toBe(false);
      const ciFailedWrite = updateCalls.find((c) => (c.setValues as any).prLifecycleStatus === 'ci_failed');
      expect(ciFailedWrite).toBeUndefined();
    });
  });

  // ── unowned-PR adoption + schema-drift classification ───────────────────────
  describe('check_suite — unowned PR adoption', () => {
    // A release PR (or any PR buildd did not open) has no worker record. The
    // first two workers.findFirst calls are the ci_failed-marking loop in
    // handleCheckSuiteEvent and handleCheckSuiteFailure's own initial lookup —
    // both miss. resolveOrAdoptPrOwner's findPrOwningWorker is the third miss,
    // then the fourth call is the re-fetch after adoption inserts the rows.
    function withAdoptablePr(opts: { foreignCommit?: boolean; isFork?: boolean; user?: { login: string; type: string } } = {}) {
      mockWorkersFindFirst
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce({
          id: 'adopted-w1',
          branch: 'release/v1.2.3',
          prNumber: 42,
          task: {
            id: 'adopted-t1',
            title: 'PR #42: Release v1.2.3',
            description: 'Release notes',
            workspaceId: 'ws1',
            missionId: null,
            context: { adoptedPr: { prNumber: 42 } },
            result: null,
            status: 'completed',
          },
        });
      mockWorkspacesFindFirst.mockReturnValue({ id: 'ws1', gitConfig: {} });
      mockGithubApi.mockImplementation((_installationId: number, url: string) => {
        if (typeof url === 'string' && url.includes('/commits/')) {
          if (opts.foreignCommit) {
            return Promise.resolve({
              author: { login: 'release-bot' },
              commit: { author: { email: 'release-bot@users.noreply.github.com', name: 'release-bot' } },
            });
          }
          return Promise.resolve({
            author: { login: 'buildd-ai[bot]' },
            commit: { author: { email: '258464409+buildd-ai[bot]@users.noreply.github.com', name: 'buildd-ai[bot]' } },
          });
        }
        if (typeof url === 'string' && url.includes('/pulls/42')) {
          return Promise.resolve({
            number: 42,
            title: 'Release v1.2.3',
            body: 'Release notes',
            html_url: 'https://github.com/test-org/test-repo/pull/42',
            head: opts.isFork
              ? { sha: 'abc123', ref: 'release/v1.2.3', repo: { full_name: 'someone-else/test-repo' } }
              : { sha: 'abc123', ref: 'release/v1.2.3' },
            base: { sha: 'def456', ref: 'main' },
            draft: false,
            user: opts.user ?? { login: 'maintainer', type: 'User' },
          });
        }
        return Promise.resolve({ draft: false });
      });
    }

    it('adopts an unowned PR once and dispatches a normal CI retry (indistinguishable from a worker PR)', async () => {
      withAdoptablePr();

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      // 2 adoption inserts (task, worker) + 1 CI retry task insert.
      expect(insertCalls.length).toBe(3);
      const retryInsert = insertCalls[2].values;
      expect(retryInsert.title).toBe('[builder · after CI #1] PR #42: Release v1.2.3');
      expect(retryInsert.parentTaskId).toBe('adopted-t1');
      expect(mockAnnounceTaskCreated).toHaveBeenCalledTimes(1);
      expect(mockWakeTask).toHaveBeenCalledTimes(1);
    });

    it('does not adopt twice — a second failure on the same (already-adopted) PR just retries normally', async () => {
      // No adoption branch is entered at all: every workers.findFirst call
      // (both the ci_failed-marking loop and handleCheckSuiteFailure) already
      // finds the previously-adopted worker/task.
      mockWorkersFindFirst.mockReturnValue({
        id: 'adopted-w1',
        branch: 'release/v1.2.3',
        prNumber: 42,
        task: {
          id: 'adopted-t1',
          title: 'PR #42: Release v1.2.3',
          description: 'Release notes',
          workspaceId: 'ws1',
          missionId: null,
          context: { adoptedPr: { prNumber: 42 } },
          result: null,
          status: 'completed',
        },
      });
      // A prior CI failure already filed one retry attempt: the budget is counted from that row.
      let rows: any[] | null = [{ id: 'prior-ci', status: 'completed', creationSource: 'webhook', ciRetryPrNumber: 42, context: {}, createdAt: '2026-01-01T00:00:00Z' }];
      selectTableResults = (table: any) => {
        if (table !== schemaMock.tasks) return null;
        const out = rows;
        rows = null;
        return out;
      };
      mockWorkspacesFindFirst.mockReturnValue({ id: 'ws1', gitConfig: {} });
      mockGithubApi.mockImplementation((_installationId: number, url: string) => {
        if (typeof url === 'string' && url.includes('/commits/')) {
          return Promise.resolve({
            author: { login: 'buildd-ai[bot]' },
            commit: { author: { email: '258464409+buildd-ai[bot]@users.noreply.github.com', name: 'buildd-ai[bot]' } },
          });
        }
        return Promise.resolve({ draft: false });
      });

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      // Only the retry task insert — no adoption task/worker rows created again.
      expect(insertCalls.length).toBe(1);
      expect(insertCalls[0].values.title).toBe('[builder · after CI #2] PR #42: Release v1.2.3');
      expect(mockAnnounceTaskCreated).toHaveBeenCalledTimes(1);
      expect(mockWakeTask).toHaveBeenCalledTimes(1);
    });

    it('does not adopt a fork PR', async () => {
      withAdoptablePr({ isFork: true });

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
      expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
    });

    // Renovate/Dependabot own their branch: one commit from buildd and the bot
    // stops rebasing it ("Edited/Blocked"). No adoption, no task, no push.
    it.each([
      ['renovate[bot]'],
      ['dependabot[bot]'],
    ])('does not adopt a %s PR with failing CI — no task, no push, gate recorded', async (login) => {
      withAdoptablePr({ user: { login, type: 'Bot' } });

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
      expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
      const pushes = mockGithubApi.mock.calls.filter(
        ([, , init]: any[]) => init?.method && init.method !== 'GET',
      );
      expect(pushes).toEqual([]);
      const gate = mockFireGateEvent.mock.calls.map(([e]: any[]) => e)
        .find((e: any) => e.gate === 'dependency_bot_pr');
      expect(gate).toMatchObject({ outcome: 'rejected', detail: { prNumber: 42, author: login, stage: 'adoption' } });
    });

    it('still adopts a PR from a bot that is not a dependency bot (buildd-ai[bot] release PR)', async () => {
      withAdoptablePr({ user: { login: 'buildd-ai[bot]', type: 'Bot' } });

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(3);
      expect(mockAnnounceTaskCreated).toHaveBeenCalledTimes(1);
      expect(mockWakeTask).toHaveBeenCalledTimes(1);
    });

    it('records the PR author type on adoption', async () => {
      withAdoptablePr();

      await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(insertCalls[0].values.context.adoptedPr).toMatchObject({ author: 'maintainer', authorType: 'User' });
    });

    it('no CI fix for a dependency-bot PR that an explicit review already adopted', async () => {
      mockWorkersFindFirst.mockReturnValue({
        id: 'adopted-w1',
        branch: 'renovate/postcss-8.x-lockfile',
        prNumber: 42,
        task: {
          id: 'adopted-t1',
          title: 'PR #42: chore(deps): update dependency postcss',
          description: null,
          workspaceId: 'ws1',
          missionId: null,
          context: { adoptedPr: { prNumber: 42, author: 'renovate[bot]', authorType: 'Bot' } },
          result: null,
          status: 'completed',
        },
      });
      mockWorkspacesFindFirst.mockReturnValue({ id: 'ws1', gitConfig: {} });
      mockGithubApi.mockImplementation(() => Promise.resolve({ draft: false }));

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
      expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
      const gate = mockFireGateEvent.mock.calls.map(([e]: any[]) => e)
        .find((e: any) => e.gate === 'dependency_bot_pr');
      expect(gate).toMatchObject({ outcome: 'rejected', taskId: 'adopted-t1', detail: { stage: 'ci_fix' } });
    });

    it('does not adopt a PR outside a managed workspace', async () => {
      mockWorkersFindFirst.mockReturnValue(null);
      mockWorkspacesFindFirst.mockReturnValue(null);

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
      expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
    });
  });

  describe('check_suite — schema drift is diagnose-only', () => {
    function withDriftFailure() {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w1', branch: 'buildd/abc12345-fix', prNumber: 42,
        task: {
          id: 't1', title: 'Fix the thing', description: 'orig desc',
          workspaceId: 'ws1', missionId: 'm1', context: {}, result: null, status: 'in_progress',
        },
      });
      mockWorkspacesFindFirst.mockReturnValue({ id: 'ws1', gitConfig: {} });
      mockGithubApi.mockImplementation((_installationId: number, url: string) => {
        if (typeof url === 'string' && url.includes('/commits/')) {
          return Promise.resolve({
            author: { login: 'buildd-ai[bot]' },
            commit: { author: { email: '258464409+buildd-ai[bot]@users.noreply.github.com', name: 'buildd-ai[bot]' } },
          });
        }
        if (typeof url === 'string' && url.includes('/actions/runs?')) {
          return Promise.resolve({
            workflow_runs: [{ id: 999, html_url: 'https://github.com/test-org/test-repo/actions/runs/999' }],
          });
        }
        if (typeof url === 'string' && url.includes('/actions/runs/999/jobs')) {
          return Promise.resolve({
            jobs: [{ id: 111, name: 'Schema Drift / check-prod', conclusion: 'failure', steps: [] }],
          });
        }
        return Promise.resolve({ draft: false });
      });
    }

    it('dispatches a diagnose-and-report task, never a fix task, for a drift-class failure', async () => {
      withDriftFailure();

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(1);
      const inserted = insertCalls[0].values;
      expect(inserted.title).toContain('[CI Diagnose]');
      expect(inserted.title).not.toContain('[CI Retry');
      expect(inserted.outputRequirement).toBe('artifact_required');
      expect(inserted.parentTaskId).toBe('t1');
      expect(mockAnnounceTaskCreated).toHaveBeenCalledTimes(1);
      expect(mockWakeTask).toHaveBeenCalledTimes(1);
    });

    // role-routing §1 row 8: the diagnose insert dropped the owner's role.
    it('the drift diagnose task inherits the owner task\'s roleSlug', async () => {
      withDriftFailure();
      mockTasksFindFirst.mockImplementation((opts?: any) =>
        opts?.columns?.roleSlug
          ? { backend: 'claude', roleSlug: 'builder', kind: 'engineering', complexity: null, missionPhaseIndex: null, missionPhaseLabel: null }
          : null,
      );

      await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(insertCalls.length).toBe(1);
      expect(insertCalls[0].values.title).toContain('[CI Diagnose]');
      expect(insertCalls[0].values.roleSlug).toBe('builder');
    });

    it('is diagnose-only even for a just-adopted (unowned) PR', async () => {
      mockWorkersFindFirst
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce({
          id: 'adopted-w1',
          branch: 'release/v1.2.3',
          prNumber: 42,
          task: {
            id: 'adopted-t1', title: 'PR #42: Release v1.2.3', description: null,
            workspaceId: 'ws1', missionId: null,
            context: { adoptedPr: { prNumber: 42 } }, result: null, status: 'completed',
          },
        });
      mockWorkspacesFindFirst.mockReturnValue({ id: 'ws1', gitConfig: {} });
      mockGithubApi.mockImplementation((_installationId: number, url: string) => {
        if (typeof url === 'string' && url.includes('/commits/')) {
          return Promise.resolve({
            author: { login: 'buildd-ai[bot]' },
            commit: { author: { email: '258464409+buildd-ai[bot]@users.noreply.github.com', name: 'buildd-ai[bot]' } },
          });
        }
        if (typeof url === 'string' && url.includes('/pulls/42')) {
          return Promise.resolve({
            number: 42, title: 'Release v1.2.3', body: 'notes',
            html_url: 'https://github.com/test-org/test-repo/pull/42',
            head: { sha: 'abc123', ref: 'release/v1.2.3' },
            base: { sha: 'def456', ref: 'main' },
            draft: false,
          });
        }
        if (typeof url === 'string' && url.includes('/actions/runs?')) {
          return Promise.resolve({
            workflow_runs: [{ id: 999, html_url: 'https://github.com/test-org/test-repo/actions/runs/999' }],
          });
        }
        if (typeof url === 'string' && url.includes('/actions/runs/999/jobs')) {
          return Promise.resolve({
            jobs: [{ id: 111, name: 'Schema Drift / check-prod', conclusion: 'failure', steps: [] }],
          });
        }
        return Promise.resolve({ draft: false });
      });

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      // 2 adoption inserts (task, worker) + 1 diagnose task insert. No fix task.
      expect(insertCalls.length).toBe(3);
      const diagnoseInsert = insertCalls[2].values;
      expect(diagnoseInsert.title).toContain('[CI Diagnose]');
      expect(diagnoseInsert.outputRequirement).toBe('artifact_required');
      // role-routing §1 row 7 (open decision 8): the adopted placeholder is
      // bookkeeping and carries no role — it is never work a role picks up.
      const adoptedInsert = insertCalls[0].values;
      expect(adoptedInsert.context.adoptedPr.prNumber).toBe(42);
      expect(adoptedInsert.taskClass).toBe('bookkeeping');
      expect(adoptedInsert.roleSlug).toBeUndefined();
    });
  });

  // ── policy tier gating (check_suite success path) ──────────────────────────
  describe('check_suite — policy tier gating', () => {
    function withSuccessWorkerPr(opts: {
      taskRequiresReview?: boolean;
      mission?: { id: string; requiresReview: boolean; mergePolicy?: any } | null;
    } = {}) {
      const requiresHuman = opts.taskRequiresReview || opts.mission?.requiresReview;
      // requiresReview is now folded into the policy chain — drive the mock accordingly
      mockResolvePolicy.mockReturnValue(
        requiresHuman
          ? { tier: 'human' as const }
          : { tier: 'auto-threshold' as const, threshold: { maxLines: 800, denyPaths: [] } },
      );
      mockWorkspacesFindMany.mockReturnValue([{ id: 'ws1', gitConfig: {} }]);
      mockWorkersFindFirst.mockReturnValue({ id: 'w1', taskId: 't1', prNumber: 42 });
      mockAllCheckSuitesPassed.mockReturnValue(Promise.resolve(true));
      mockTasksFindFirst.mockReturnValue({
        id: 't1',
        requiresReview: opts.taskRequiresReview ?? false,
        missionId: opts.mission?.id ?? 'm1',
        title: 'Fix bug',
        mission: opts.mission ?? null,
      });
    }

    it('resolves the merge policy from the payload base ref, not a stale stored one', async () => {
      // This is a gate that decides whether auto-merge fires, and a retargeted
      // PR leaves `workers.prBaseRef` stale in the one direction that matters:
      // a stale `mission/*` value makes Option A′'s rule drop the tier to
      // auto-threshold, so the PR can merge into trunk with the human gate
      // removed. The payload is authoritative and race-free.
      withSuccessWorkerPr();
      mockWorkersFindFirst.mockReturnValue({
        id: 'w1', taskId: 't1', prNumber: 42,
        prBaseRef: 'mission/example-slug-0a1b2c3d', // stale: the PR was retargeted to trunk
      });

      await POST(createWebhookRequest('check_suite', makeCheckSuitePayload({
        check_suite: { conclusion: 'success' },
      })));

      const opts = (mockResolvePolicy.mock.calls[0] as any[])[3];
      expect(opts.baseRef).toBe('main');
    });

    it('falls back to the stored base ref when the payload carries none', async () => {
      withSuccessWorkerPr();
      mockWorkersFindFirst.mockReturnValue({
        id: 'w1', taskId: 't1', prNumber: 42, prBaseRef: 'dev',
      });

      await POST(createWebhookRequest('check_suite', makeCheckSuitePayload({
        check_suite: {
          conclusion: 'success',
          pull_requests: [{ number: 42, head: { sha: 'abc123', ref: 'buildd/task-1-fix-bug' } }],
        },
      })));

      const opts = (mockResolvePolicy.mock.calls[0] as any[])[3];
      expect(opts.baseRef).toBe('dev');
    });

    it('holds PR and notifies when resolvePolicy returns tier=human', async () => {
      withSuccessWorkerPr();
      mockResolvePolicy.mockReturnValueOnce({ tier: 'human' });
      mockNotifyMissionPrReady.mockReturnValue(Promise.resolve({ notified: true }));

      const res = await POST(
        createWebhookRequest('check_suite', makeCheckSuitePayload({ check_suite: { conclusion: 'success' } }))
      );

      expect(res.status).toBe(200);
      expect(mockTryAutoMergeWorkerPr).not.toHaveBeenCalled();
      expect(mockNotifyMissionPrReady).toHaveBeenCalledTimes(1);
      const notifyArgs = (mockNotifyMissionPrReady.mock.calls[0] as any[])[1];
      expect(notifyArgs.reason).toBe('awaiting_review');
    });

    it('skips merge without notification when resolvePolicy returns tier=agent-review', async () => {
      withSuccessWorkerPr();
      mockResolvePolicy.mockReturnValueOnce({
        tier: 'agent-review',
        agentReview: { reviewerRole: 'reviewer' },
      });

      const res = await POST(
        createWebhookRequest('check_suite', makeCheckSuitePayload({ check_suite: { conclusion: 'success' } }))
      );

      expect(res.status).toBe(200);
      expect(mockTryAutoMergeWorkerPr).not.toHaveBeenCalled();
      expect(mockNotifyMissionPrReady).not.toHaveBeenCalled();
    });

    it('retries the merge on CI-green when an unconsumed approve is on file for tier=agent-review', async () => {
      // The reviewer's own merge-on-approve is bounded to quarantined branches,
      // so an approved PR based on trunk can sit unconsumed forever with
      // nothing retrying it. The CI-green webhook is that retry.
      withSuccessWorkerPr();
      mockResolvePolicy.mockReturnValue({
        tier: 'agent-review',
        agentReview: { reviewerRole: 'reviewer', maxConfidenceThreshold: 0.6 },
      });
      mockReadPrReviewStatus.mockResolvedValue({
        state: 'approved', terminal: true, reviewTaskId: 't-review', adoptedTaskId: 't1',
        verdict: 'approve', confidence: 0.96, summary: 'clean', feedback: null, escalationReason: null,
        iteration: 0, maxIterations: 3, prState: 'open', merged: false, mergeBlocked: null,
      } as any);

      const res = await POST(
        createWebhookRequest('check_suite', makeCheckSuitePayload({ check_suite: { conclusion: 'success' } }))
      );

      expect(res.status).toBe(200);
      expect(mockTryAutoMergeWorkerPr).toHaveBeenCalledTimes(1);
      const callArgs = (mockTryAutoMergeWorkerPr.mock.calls[0] as any[])[0];
      expect(callArgs.prNumber).toBe(42);
      expect(callArgs).not.toHaveProperty('bound');
    });

    it('does not re-attempt the merge on CI-green when the unconsumed approve is below threshold', async () => {
      withSuccessWorkerPr();
      mockResolvePolicy.mockReturnValue({
        tier: 'agent-review',
        agentReview: { reviewerRole: 'reviewer', maxConfidenceThreshold: 0.8 },
      });
      mockReadPrReviewStatus.mockResolvedValue({
        state: 'approved', terminal: true, reviewTaskId: 't-review', adoptedTaskId: 't1',
        verdict: 'approve', confidence: 0.5, summary: 'clean', feedback: null, escalationReason: null,
        iteration: 0, maxIterations: 3, prState: 'open', merged: false, mergeBlocked: null,
      } as any);

      const res = await POST(
        createWebhookRequest('check_suite', makeCheckSuitePayload({ check_suite: { conclusion: 'success' } }))
      );

      expect(res.status).toBe(200);
      expect(mockTryAutoMergeWorkerPr).not.toHaveBeenCalled();
    });

    it('is a no-op on CI-green when the approve was already consumed (PR already merged)', async () => {
      withSuccessWorkerPr();
      mockResolvePolicy.mockReturnValue({
        tier: 'agent-review',
        agentReview: { reviewerRole: 'reviewer', maxConfidenceThreshold: 0.6 },
      });
      mockReadPrReviewStatus.mockResolvedValue({
        state: 'approved', terminal: true, reviewTaskId: 't-review', adoptedTaskId: 't1',
        verdict: 'approve', confidence: 0.96, summary: 'clean', feedback: null, escalationReason: null,
        iteration: 0, maxIterations: 3, prState: 'merged', merged: true, mergeBlocked: null,
      } as any);

      const res = await POST(
        createWebhookRequest('check_suite', makeCheckSuitePayload({ check_suite: { conclusion: 'success' } }))
      );

      expect(res.status).toBe(200);
      expect(mockTryAutoMergeWorkerPr).not.toHaveBeenCalled();
    });

    it('calls tryAutoMergeWorkerPr with policy when resolvePolicy returns tier=auto-threshold', async () => {
      withSuccessWorkerPr();
      // default mockResolvePolicy returns auto-threshold

      const res = await POST(
        createWebhookRequest('check_suite', makeCheckSuitePayload({ check_suite: { conclusion: 'success' } }))
      );

      expect(res.status).toBe(200);
      expect(mockTryAutoMergeWorkerPr).toHaveBeenCalledTimes(1);
      const callArgs = (mockTryAutoMergeWorkerPr.mock.calls[0] as any[])[0];
      expect(callArgs).toHaveProperty('policy');
      expect(callArgs).not.toHaveProperty('gitConfig');
    });

    describe('landing function (gitConfig.landing.mode)', () => {
      const approved = {
        state: 'approved', terminal: true, reviewTaskId: 't-review', adoptedTaskId: 't1',
        verdict: 'approve', confidence: 0.96, summary: 'clean', feedback: null, escalationReason: null,
        iteration: 0, maxIterations: 3, prState: 'open', merged: false, mergeBlocked: null,
      } as any;
      const green = (sha = 'abc123') => createWebhookRequest('check_suite', makeCheckSuitePayload({
        check_suite: {
          conclusion: 'success',
          head_sha: sha,
          pull_requests: [{ number: 42, head: { sha, ref: 'buildd/task-1-fix-bug' }, base: { sha: 'def456', ref: 'dev' } }],
        },
      }));
      const enforce = (tier: 'auto-threshold' | 'agent-review') => {
        withSuccessWorkerPr();
        mockWorkspacesFindMany.mockReturnValue([{ id: 'ws1', gitConfig: { landing: { mode: 'enforce' } }, releaseConfig: null }]);
        mockResolvePolicy.mockReturnValue(
          tier === 'agent-review'
            ? { tier, agentReview: { reviewerRole: 'reviewer', maxConfidenceThreshold: 0.6 } }
            : { tier, threshold: { maxLines: 800, denyPaths: [] } },
        );
        mockReadPrReviewStatus.mockResolvedValue(approved);
      };

      it.each(['auto-threshold', 'agent-review'] as const)('enforce, %s: one landPr call on the event SHA, no legacy merge, no ad-hoc carry-forward', async (tier) => {
        enforce(tier);
        mockLandPr.mockImplementation(async () => ({ kind: 'merged', sha: 'abc123' }));

        const res = await POST(green());

        expect(res.status).toBe(200);
        expect(mockLandPr).toHaveBeenCalledTimes(1);
        expect(mockLandPr.mock.calls[0]![0]).toMatchObject({
          workspaceId: 'ws1', installationId: 5000, repoFullName: 'test-org/test-repo', prNumber: 42,
          eventHeadSha: 'abc123', door: 'check_suite', actor: { kind: 'system' }, mode: 'enforce',
          policy: { tier }, owner: { taskId: 't1', workerId: 'w1' },
        });
        expect(mockTryAutoMergeWorkerPr).not.toHaveBeenCalled();
        expect(mockCarryForwardApproval).not.toHaveBeenCalled();
      });

      it('enforce: a green on the pending-marker SHA hands that SHA to landPr, which lands it', async () => {
        enforce('agent-review');
        mockLandPr.mockImplementation(async (input: any) =>
          input.eventHeadSha === 'marker-sha' ? { kind: 'merged', sha: 'marker-sha' } : { kind: 'waiting_ci', headSha: 'marker-sha' });

        await POST(green('marker-sha'));

        expect(mockLandPr).toHaveBeenCalledTimes(1);
        expect(mockLandPr.mock.calls[0]![0].eventHeadSha).toBe('marker-sha');
        expect(await mockLandPr.mock.results[0]!.value).toEqual({ kind: 'merged', sha: 'marker-sha' });
      });

      it('enforce: a green on a stale SHA goes to landPr as-is and nothing else acts on it', async () => {
        enforce('auto-threshold');
        mockLandPr.mockImplementation(async () => ({ kind: 'waiting_ci', headSha: 'live-head' }));

        await POST(green('stale-sha'));

        expect(mockLandPr.mock.calls[0]![0].eventHeadSha).toBe('stale-sha');
        expect(mockTryAutoMergeWorkerPr).not.toHaveBeenCalled();
        expect(mockMergePullRequest).not.toHaveBeenCalled();
      });

      it('replay: approval, base-merge push in the same minute, then green → the webhook lands the pushed head', async () => {
        // The approve door refreshed the branch and left a marker on `pushed-head`;
        // the green that follows is the event that lands it.
        enforce('agent-review');
        mockLandPr.mockImplementation(async (input: any) => ({ kind: 'merged', sha: input.eventHeadSha }));

        await POST(green('pushed-head'));

        expect(mockLandPr).toHaveBeenCalledTimes(1);
        expect(mockLandPr.mock.calls[0]![0]).toMatchObject({ door: 'check_suite', eventHeadSha: 'pushed-head', mode: 'enforce' });
        expect(mockTryAutoMergeWorkerPr).not.toHaveBeenCalled();
      });

      it('shadow (the default): landPr observes, then the legacy path still merges', async () => {
        withSuccessWorkerPr();

        await POST(green());

        expect(mockLandPr).toHaveBeenCalledTimes(1);
        expect(mockLandPr.mock.calls[0]![0].mode).toBe('shadow');
        expect(mockTryAutoMergeWorkerPr).toHaveBeenCalledTimes(1);
      });

      it('off: legacy path only', async () => {
        withSuccessWorkerPr();
        mockWorkspacesFindMany.mockReturnValue([{ id: 'ws1', gitConfig: { landing: { mode: 'off' } } }]);

        await POST(green());

        expect(mockLandPr).not.toHaveBeenCalled();
        expect(mockTryAutoMergeWorkerPr).toHaveBeenCalledTimes(1);
      });

      it('human tier never reaches landPr from the webhook (the tier is the human queue)', async () => {
        withSuccessWorkerPr({ taskRequiresReview: true });
        mockWorkspacesFindMany.mockReturnValue([{ id: 'ws1', gitConfig: { landing: { mode: 'enforce' } } }]);

        await POST(green());

        expect(mockLandPr).not.toHaveBeenCalled();
        expect(mockTryAutoMergeWorkerPr).not.toHaveBeenCalled();
      });
    });

    it('passes task and mission context to resolvePolicy', async () => {
      withSuccessWorkerPr({
        taskRequiresReview: false,
        mission: { id: 'm1', requiresReview: false },
      });

      await POST(
        createWebhookRequest('check_suite', makeCheckSuitePayload({ check_suite: { conclusion: 'success' } }))
      );

      expect(mockResolvePolicy).toHaveBeenCalledTimes(1);
      const [wsArg, missionArg, taskArg] = (mockResolvePolicy.mock.calls[0] as any[]);
      expect(wsArg).toHaveProperty('gitConfig');
      expect(missionArg).toHaveProperty('requiresReview');
      expect(taskArg).toHaveProperty('requiresReview');
    });
  });

  // ── Pull request auto-merge (no-CI repos) ────────────────────────────────
  describe('pull_request auto-merge for repos without CI', () => {
    function makePullRequestPayload(overrides: Record<string, any> = {}) {
      return {
        action: 'opened',
        pull_request: {
          number: 7,
          merged: false,
          draft: false,
          head: { ref: 'buildd/abc12345-fix', sha: 'sha-7' },
          html_url: 'https://github.com/test-org/test-repo/pull/7',
          ...overrides.pull_request,
        },
        repository: { full_name: 'test-org/test-repo', ...overrides.repository },
        installation: { id: 5000, ...overrides.installation },
        ...overrides.top,
      };
    }

    function withAutoMergeWorkspaceAndWorker(gitConfig: Record<string, any> = { autoMergePR: true }) {
      mockWorkspacesFindMany.mockReturnValue([{ id: 'ws1', gitConfig }]);
      mockWorkersFindFirst.mockReturnValue({ id: 'w1', taskId: 't1', prNumber: 7 });
      // PR files fetch (safety rails) — empty diff passes the line budget
      mockGithubApi.mockReturnValue(Promise.resolve([]));
    }

    // Regression: worker lookups used to match on prNumber alone. PR numbers are
    // unique per repo, not globally — buildd-ai/buildd#146 and maxjacu/sibling-app#146
    // both exist, so merging one silently stamped mergedAt onto the other's
    // worker. 25 of 70 colliding worker rows in production were wrong.
    it('scopes the merge-stamp worker lookup to the event repo', async () => {
      mockWorkersFindFirst.mockReturnValue({ id: 'w1', taskId: 't1', workspaceId: 'ws1', task: null });
      const payload = makePullRequestPayload({
        top: { action: 'closed' },
        pull_request: {
          number: 146,
          merged: true,
          html_url: 'https://github.com/maxjacu/sibling-app/pull/146',
        },
        repository: { full_name: 'maxjacu/sibling-app' },
      });

      const res = await POST(createWebhookRequest('pull_request', payload));

      expect(res.status).toBe(200);
      expect(mockWorkerOwnsPr).toHaveBeenCalledWith('maxjacu/sibling-app', 146);
      // Never a bare prNumber lookup — that is the collision.
      expect(mockWorkerOwnsPr.mock.calls.every((c) => typeof c[0] === 'string' && c[0].includes('/'))).toBe(true);
    });

    it('scopes the PR-lifecycle worker lookup to the event repo', async () => {
      mockWorkersFindFirst.mockReturnValue({ id: 'w1', taskId: 't1', workspaceId: 'ws1', branch: 'b' });
      const payload = makePullRequestPayload({
        top: { action: 'synchronize' },
        pull_request: { number: 146, html_url: 'https://github.com/maxjacu/sibling-app/pull/146' },
        repository: { full_name: 'maxjacu/sibling-app' },
      });

      const res = await POST(createWebhookRequest('pull_request', payload));

      expect(res.status).toBe(200);
      expect(mockWorkerOwnsPr).toHaveBeenCalledWith('maxjacu/sibling-app', 146);
    });

    // Regression: workspace lookups used `eq(workspaces.repo, full_name)`, which
    // misses every workspace storing a clone URL — 11 of 12 in production.
    it('matches workspaces by normalized repo, not exact string equality', async () => {
      const payload = makePullRequestPayload({
        repository: { full_name: 'maxjacu/sibling-app' },
      });

      await POST(createWebhookRequest('pull_request', payload));

      expect(mockWorkspaceRepoMatches).toHaveBeenCalledWith('maxjacu/sibling-app');
    });

    it('auto-merges a newly-opened PR when the repo has no CI', async () => {
      withAutoMergeWorkspaceAndWorker();
      mockHasCheckSuites.mockReturnValue(Promise.resolve(false));

      const res = await POST(createWebhookRequest('pull_request', makePullRequestPayload()));

      expect(res.status).toBe(200);
      expect(mockTryAutoMergeWorkerPr).toHaveBeenCalledTimes(1);
    });

    it('defers to check_suite when the repo has CI', async () => {
      withAutoMergeWorkspaceAndWorker();
      mockHasCheckSuites.mockReturnValue(Promise.resolve(true));

      const res = await POST(createWebhookRequest('pull_request', makePullRequestPayload()));

      expect(res.status).toBe(200);
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it('does not auto-merge draft PRs', async () => {
      withAutoMergeWorkspaceAndWorker();
      mockHasCheckSuites.mockReturnValue(Promise.resolve(false));

      const payload = makePullRequestPayload({ pull_request: { draft: true } });
      const res = await POST(createWebhookRequest('pull_request', payload));

      expect(res.status).toBe(200);
      expect(mockHasCheckSuites).not.toHaveBeenCalled();
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it('does nothing when policy tier is human', async () => {
      mockResolvePolicy.mockReturnValue({ tier: 'human' as const });
      withAutoMergeWorkspaceAndWorker({ mergePolicy: { tier: 'human' } });
      mockHasCheckSuites.mockReturnValue(Promise.resolve(false));

      const res = await POST(createWebhookRequest('pull_request', makePullRequestPayload()));

      expect(res.status).toBe(200);
      expect(mockTryAutoMergeWorkerPr).not.toHaveBeenCalled();
    });

    it('auto-merges when policy tier is auto-threshold', async () => {
      mockResolvePolicy.mockReturnValue({ tier: 'auto-threshold' as const, threshold: { maxLines: 800, denyPaths: [] } });
      withAutoMergeWorkspaceAndWorker({ mergePolicy: { tier: 'auto-threshold' } });
      mockHasCheckSuites.mockReturnValue(Promise.resolve(false));

      const res = await POST(createWebhookRequest('pull_request', makePullRequestPayload()));

      expect(res.status).toBe(200);
      expect(mockTryAutoMergeWorkerPr).toHaveBeenCalledTimes(1);
    });

    it('does nothing for agent-review tier (reviewer handles merge after approve)', async () => {
      mockResolvePolicy.mockReturnValue({ tier: 'agent-review' as const, agentReview: { reviewerRole: 'reviewer' } });
      withAutoMergeWorkspaceAndWorker({ mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } } });
      mockHasCheckSuites.mockReturnValue(Promise.resolve(false));

      const res = await POST(createWebhookRequest('pull_request', makePullRequestPayload()));

      expect(res.status).toBe(200);
      expect(mockTryAutoMergeWorkerPr).not.toHaveBeenCalled();
    });

    it('completes task — branch_merge workspace: Path A handles release, Path B does NOT dispatch', async () => {
      const payload = {
        action: 'closed',
        pull_request: {
          number: 7,
          merged: true,
          draft: false,
          head: { ref: 'buildd/t1-fix', sha: 'sha-7' },
          html_url: 'https://github.com/test-org/test-repo/pull/7',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      mockWorkersFindFirst.mockReturnValue({
        id: 'w1',
        task: {
          id: 't1',
          status: 'pending',
          workspaceId: 'ws1',
          release: 'true',
          title: 'Fix bug',
          missionId: null,
        },
      });
      mockWorkspacesFindFirst.mockReturnValue({
        id: 'ws1',
        releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main' },
        gitConfig: { defaultBranch: 'dev' },
      });
      mockGithubApi.mockReturnValue(Promise.resolve({}));

      const res = await POST(createWebhookRequest('pull_request', payload));

      expect(res.status).toBe(200);
      expect(updateCalls.some((c) => (c.setValues as any).status === 'completed')).toBe(true);
      // Path B must NOT dispatch for branch_merge — Path A is authoritative
      expect(mockDispatchWorkflowRelease).not.toHaveBeenCalled();
    });

    // Slice C (workflow-state-kernel.md §14): a kernel-owned PR's merge work is the kernel's
    // post-merge effects (stamp_pr_rows, emit_pr_merged, finalize_mission_pr), run from T17.
    // The webhook records the fact and does none of that work inline.
    it('a kernel-owned merge: the fact goes to the kernel; the task is not flipped and nothing is stamped here', async () => {
      mockObservePrState.mockImplementationOnce(async () => true);
      mockWorkersFindFirst.mockReturnValue({
        id: 'w1',
        workspaceId: 'ws1',
        taskId: 't1',
        task: { id: 't1', status: 'pending', workspaceId: 'ws1', release: 'true', title: 'Fix bug', missionId: null },
      });
      mockWorkspacesFindFirst.mockReturnValue({ id: 'ws1', releaseConfig: null, gitConfig: { defaultBranch: 'dev' } });
      mockGithubApi.mockReturnValue(Promise.resolve({}));
      const before = updateCalls.length;

      const res = await POST(createWebhookRequest('pull_request', {
        action: 'closed',
        pull_request: { number: 7, merged: true, draft: false, head: { ref: 'buildd/t1-fix', sha: 'sha-7' }, html_url: 'https://github.com/test-org/test-repo/pull/7', merged_at: '2026-10-06T00:00:00Z' },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      }));

      expect(res.status).toBe(200);
      expect(mockObservePrState).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws1', repoFullName: 'test-org/test-repo', prNumber: 7, source: 'webhook:closed' }));
      expect(updateCalls.slice(before).some((c) => (c.setValues as any).status === 'completed')).toBe(false);
      expect(mockDispatchWorkflowRelease).not.toHaveBeenCalled();
    });

    it('workflow_dispatch + trigger=every_merge: dispatches configured workflow file', async () => {
      const payload = {
        action: 'closed',
        pull_request: {
          number: 8,
          merged: true,
          draft: false,
          head: { ref: 'buildd/t2-feat', sha: 'sha-8' },
          html_url: 'https://github.com/test-org/test-repo/pull/8',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      mockWorkersFindFirst.mockReturnValue({
        id: 'w2',
        task: { id: 't2', status: 'pending', workspaceId: 'ws2', release: 'inherit', title: 'Feature', missionId: null },
      });
      mockWorkspacesFindFirst.mockReturnValue({
        id: 'ws2',
        releaseConfig: {
          enabled: true,
          strategy: 'workflow_dispatch',
          workflowFile: 'ship.yml',
          ref: 'dev',
          trigger: 'every_merge',
        },
        gitConfig: { defaultBranch: 'dev' },
      });
      mockGithubApi.mockReturnValue(Promise.resolve({}));

      const res = await POST(createWebhookRequest('pull_request', payload));

      expect(res.status).toBe(200);
      expect(mockDispatchWorkflowRelease).toHaveBeenCalledTimes(1);
      expect((mockDispatchWorkflowRelease.mock.calls[0] as any[])[3]).toMatchObject({ workflowFile: 'ship.yml' });

      // The point of routing through recordAndDispatchRelease: this dispatch
      // leaves a `releases` row. It used to write only tasks.releaseResult, so
      // a gated + workflow_dispatch workspace had no release history at all.
      expect(mockRecordAndDispatchRelease).toHaveBeenCalledTimes(1);
      expect((mockRecordAndDispatchRelease.mock.calls[0] as any[])[0]).toMatchObject({
        workspaceId: 'ws2',
        triggeredBy: 'auto',
        workflowFile: 'ship.yml',
        ref: 'dev',
        // This fixture declares no prodBranch, so the range is measured against
        // the default branch and detectArchetype resolves to `none`. Recording
        // it truthfully is the point — the workspace has releases enabled with
        // no production branch, and the row now says so.
        prodBranch: 'dev',
        archetype: 'none',
      });
    });

    it('every_merge: links the task to the release row it created', async () => {
      const payload = {
        action: 'closed',
        pull_request: {
          number: 81,
          merged: true,
          draft: false,
          head: { ref: 'buildd/t81-feat', sha: 'sha-81' },
          html_url: 'https://github.com/test-org/test-repo/pull/81',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      mockWorkersFindFirst.mockReturnValue({
        id: 'w81',
        task: { id: 't81', status: 'pending', workspaceId: 'ws2', release: 'inherit', title: 'Feature', missionId: null },
      });
      mockWorkspacesFindFirst.mockReturnValue({
        id: 'ws2',
        releaseConfig: {
          enabled: true,
          strategy: 'workflow_dispatch',
          workflowFile: 'ship.yml',
          ref: 'dev',
          prodBranch: 'main',
          trigger: 'every_merge',
        },
        gitConfig: { defaultBranch: 'dev' },
      });
      mockGithubApi.mockReturnValue(Promise.resolve({}));

      await POST(createWebhookRequest('pull_request', payload));

      // With a prodBranch distinct from the default branch this is a gated
      // workspace — the shape that could never produce a release row before.
      expect((mockRecordAndDispatchRelease.mock.calls[0] as any[])[0]).toMatchObject({
        archetype: 'gated',
        prodBranch: 'main',
        triggeredBy: 'auto',
      });

      const annotated = updateCalls.find(
        c => c.table === schemaMock.tasks && (c.setValues as any).releaseResult,
      );
      expect(annotated).toBeDefined();
      // Without this the task knows it triggered a release and the release does
      // not know which task triggered it.
      expect((annotated!.setValues as any).releaseResult.releaseId).toBe('rel-auto-1');
    });

    it('workflow_dispatch + trigger=manual: does not dispatch', async () => {
      const payload = {
        action: 'closed',
        pull_request: {
          number: 9,
          merged: true,
          draft: false,
          head: { ref: 'buildd/t3-feat', sha: 'sha-9' },
          html_url: 'https://github.com/test-org/test-repo/pull/9',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      mockWorkersFindFirst.mockReturnValue({
        id: 'w3',
        task: { id: 't3', status: 'pending', workspaceId: 'ws3', release: 'inherit', title: 'Feature', missionId: null },
      });
      mockWorkspacesFindFirst.mockReturnValue({
        id: 'ws3',
        releaseConfig: {
          enabled: true,
          strategy: 'workflow_dispatch',
          workflowFile: 'release.yml',
          ref: 'dev',
          trigger: 'manual',
        },
      });
      mockGithubApi.mockReturnValue(Promise.resolve({}));

      const res = await POST(createWebhookRequest('pull_request', payload));

      expect(res.status).toBe(200);
      expect(mockDispatchWorkflowRelease).not.toHaveBeenCalled();
    });

    it('workflow_dispatch + on_mission_complete: dispatches once when mission is all-terminal', async () => {
      const payload = {
        action: 'closed',
        pull_request: {
          number: 10,
          merged: true,
          draft: false,
          head: { ref: 'buildd/t4-feat', sha: 'sha-10' },
          html_url: 'https://github.com/test-org/test-repo/pull/10',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      mockWorkersFindFirst.mockReturnValue({
        id: 'w4',
        task: { id: 't4', status: 'pending', workspaceId: 'ws4', release: 'inherit', title: 'Feature', missionId: 'mission-1' },
      });
      mockWorkspacesFindFirst.mockReturnValue({
        id: 'ws4',
        releaseConfig: {
          enabled: true,
          strategy: 'workflow_dispatch',
          workflowFile: 'release.yml',
          ref: 'dev',
          trigger: 'on_mission_complete',
        },
      });
      // All tasks in the mission are terminal (pending=0)
      mockCountPendingTasksForMission.mockReturnValue(Promise.resolve(0));
      mockGithubApi.mockReturnValue(Promise.resolve({}));

      const res = await POST(createWebhookRequest('pull_request', payload));

      expect(res.status).toBe(200);
      expect(mockDispatchWorkflowRelease).toHaveBeenCalledTimes(1);
      // Phase 2 on success: the mission is marked released only now.
      expect(mockCommitMissionRelease).toHaveBeenCalledWith('mission-1');
      expect(mockAbandonMissionReleaseAttempt).not.toHaveBeenCalled();
    });

    it('workflow_dispatch + on_mission_complete: refuses when the shared completion predicate refuses', async () => {
      // B3. This path used to dispatch on "no pending tasks" alone, so a mission
      // whose goal criteria read `fail` shipped here while the completion path
      // refused it — same mission, same minute, two answers.
      const payload = {
        action: 'closed',
        pull_request: {
          number: 20,
          merged: true,
          draft: false,
          head: { ref: 'buildd/t20-feat', sha: 'sha-20' },
          html_url: 'https://github.com/test-org/test-repo/pull/20',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      mockWorkersFindFirst.mockReturnValue({
        id: 'w20',
        task: { id: 't20', status: 'pending', workspaceId: 'ws4', release: 'inherit', title: 'Feature', missionId: 'mission-1' },
      });
      mockWorkspacesFindFirst.mockReturnValue({
        id: 'ws4',
        releaseConfig: {
          enabled: true,
          strategy: 'workflow_dispatch',
          workflowFile: 'release.yml',
          ref: 'dev',
          trigger: 'on_mission_complete',
        },
      });
      mockCountPendingTasksForMission.mockReturnValue(Promise.resolve(0));
      mockCanCompleteMission.mockReturnValue(Promise.resolve({
        ok: false,
        code: 'criteria_failed',
        reason: 'goal criterion 1 reads fail',
      }) as any);
      mockGithubApi.mockReturnValue(Promise.resolve({}));

      const res = await POST(createWebhookRequest('pull_request', payload));

      expect(res.status).toBe(200);
      expect(mockDispatchWorkflowRelease).not.toHaveBeenCalled();
      // A refusal must not consume the claim either.
      expect(mockClaimMissionReleaseAttempt).not.toHaveBeenCalled();
      expect(mockCommitMissionRelease).not.toHaveBeenCalled();
    });

    it('workflow_dispatch + on_mission_complete: uses the same gate options as every other completion path', async () => {
      const payload = {
        action: 'closed',
        pull_request: {
          number: 21,
          merged: true,
          draft: false,
          head: { ref: 'buildd/t21-feat', sha: 'sha-21' },
          html_url: 'https://github.com/test-org/test-repo/pull/21',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      mockWorkersFindFirst.mockReturnValue({
        id: 'w21',
        task: { id: 't21', status: 'pending', workspaceId: 'ws4', release: 'inherit', title: 'Feature', missionId: 'mission-1' },
      });
      mockWorkspacesFindFirst.mockReturnValue({
        id: 'ws4',
        releaseConfig: {
          enabled: true,
          strategy: 'workflow_dispatch',
          workflowFile: 'release.yml',
          ref: 'dev',
          trigger: 'on_mission_complete',
        },
      });
      mockCountPendingTasksForMission.mockReturnValue(Promise.resolve(0));
      mockGithubApi.mockReturnValue(Promise.resolve({}));

      await POST(createWebhookRequest('pull_request', payload));

      // `evaluateCriteria: false` — a release READS a verdict, it must not
      // dispatch verification tasks or spend tokens producing one.
      expect(mockCanCompleteMission).toHaveBeenCalledWith('mission-1', {
        path: 'release_trigger',
        acceptCompleted: true,
        evaluateCriteria: false,
      });
    });

    it('workflow_dispatch + on_mission_complete: hands back the claim when dispatch fails', async () => {
      // B1. The claim used to be `releasedAt` itself, taken before the dispatch,
      // so a throw here left the mission permanently marked released with
      // nothing deployed and only a console.error to show for it.
      const payload = {
        action: 'closed',
        pull_request: {
          number: 22,
          merged: true,
          draft: false,
          head: { ref: 'buildd/t22-feat', sha: 'sha-22' },
          html_url: 'https://github.com/test-org/test-repo/pull/22',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      mockWorkersFindFirst.mockReturnValue({
        id: 'w22',
        task: { id: 't22', status: 'pending', workspaceId: 'ws4', release: 'inherit', title: 'Feature', missionId: 'mission-1' },
      });
      mockWorkspacesFindFirst.mockReturnValue({
        id: 'ws4',
        releaseConfig: {
          enabled: true,
          strategy: 'workflow_dispatch',
          workflowFile: 'release.yml',
          ref: 'dev',
          trigger: 'on_mission_complete',
        },
      });
      mockCountPendingTasksForMission.mockReturnValue(Promise.resolve(0));
      mockRecordAndDispatchRelease.mockImplementation(
        () => Promise.resolve({ ok: false, status: 502, error: 'github 502' }) as any,
      );
      mockGithubApi.mockReturnValue(Promise.resolve({}));

      const res = await POST(createWebhookRequest('pull_request', payload));

      expect(res.status).toBe(200);
      expect(mockCommitMissionRelease).not.toHaveBeenCalled();
      expect(mockAbandonMissionReleaseAttempt).toHaveBeenCalledTimes(1);
      const [missionId, code, reason] = mockAbandonMissionReleaseAttempt.mock.calls[0] as any[];
      expect(missionId).toBe('mission-1');
      expect(code).toBe('dispatch_failed');
      expect(String(reason)).toContain('github 502');
    });

    // THE REGRESSION. The dispatch already reached GitHub; only the follow-up
    // `tasks.releaseResult` write failed. The old code had that write inside the
    // dispatch try, so it reported `dispatch_failed` — a release that HAD gone
    // out was recorded as a failure, the claim was handed back, and the next
    // merge in the same mission dispatched a second release.
    it('workflow_dispatch + on_mission_complete: a bookkeeping failure after a successful dispatch still records the release', async () => {
      const payload = {
        action: 'closed',
        pull_request: {
          number: 23,
          merged: true,
          draft: false,
          head: { ref: 'buildd/t23-feat', sha: 'sha-23' },
          html_url: 'https://github.com/test-org/test-repo/pull/23',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      mockWorkersFindFirst.mockReturnValue({
        id: 'w23',
        task: { id: 't23', status: 'pending', workspaceId: 'ws4', release: 'inherit', title: 'Feature', missionId: 'mission-1' },
      });
      mockWorkspacesFindFirst.mockReturnValue({
        id: 'ws4',
        releaseConfig: {
          enabled: true,
          strategy: 'workflow_dispatch',
          workflowFile: 'release.yml',
          ref: 'dev',
          trigger: 'on_mission_complete',
        },
      });
      mockCountPendingTasksForMission.mockReturnValue(Promise.resolve(0));
      mockRecordAndDispatchRelease.mockImplementation(
        () => Promise.resolve({ ok: true, releaseId: 'rel-auto-1', deduped: false, headSha: 's', runId: 99, runUrl: 'https://x/99' }) as any,
      );
      mockGithubApi.mockReturnValue(Promise.resolve({}));
      // The task annotation fails; the dispatch did not.
      failUpdateMatching = values => 'releaseResult' in values;

      const res = await POST(createWebhookRequest('pull_request', payload));

      expect(res.status).toBe(200);
      // The release is recorded, because it happened.
      expect(mockCommitMissionRelease).toHaveBeenCalledWith('mission-1');
      // And no false dispatch failure is reported.
      expect(mockAbandonMissionReleaseAttempt).not.toHaveBeenCalled();
    });

    it('workflow_dispatch + on_mission_complete: does NOT dispatch when tasks are still pending', async () => {
      const payload = {
        action: 'closed',
        pull_request: {
          number: 11,
          merged: true,
          draft: false,
          head: { ref: 'buildd/t5-feat', sha: 'sha-11' },
          html_url: 'https://github.com/test-org/test-repo/pull/11',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      mockWorkersFindFirst.mockReturnValue({
        id: 'w5',
        task: { id: 't5', status: 'pending', workspaceId: 'ws5', release: 'inherit', title: 'Feature', missionId: 'mission-2' },
      });
      mockWorkspacesFindFirst.mockReturnValue({
        id: 'ws5',
        releaseConfig: {
          enabled: true,
          strategy: 'workflow_dispatch',
          workflowFile: 'release.yml',
          ref: 'dev',
          trigger: 'on_mission_complete',
        },
      });
      // Still 2 tasks pending in the mission
      mockCountPendingTasksForMission.mockReturnValue(Promise.resolve(2));
      mockGithubApi.mockReturnValue(Promise.resolve({}));

      const res = await POST(createWebhookRequest('pull_request', payload));

      expect(res.status).toBe(200);
      expect(mockDispatchWorkflowRelease).not.toHaveBeenCalled();
    });

    it('calls tryAutoMergeWorkerPr with resolved policy (which handles safety-rail checks internally)', async () => {
      // The safety-rail logic (line budget, deny paths, notifyMissionPrReady on block)
      // lives in auto-merge.ts. At the webhook level, we verify that tryAutoMergeWorkerPr
      // is invoked with the resolved policy. The detailed safety-rail tests live in auto-merge.test.ts.
      mockResolvePolicy.mockReturnValue({ tier: 'auto-threshold' as const, threshold: { maxLines: 800, denyPaths: ['.github/workflows/'] } });
      mockWorkspacesFindMany.mockReturnValue([{ id: 'ws1', gitConfig: { mergePolicy: { tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: ['.github/workflows/'] } } } }]);
      mockWorkersFindFirst.mockReturnValue({ id: 'w1', taskId: 't1', prNumber: 7 });
      mockHasCheckSuites.mockReturnValue(Promise.resolve(false));

      const res = await POST(createWebhookRequest('pull_request', makePullRequestPayload()));

      expect(res.status).toBe(200);
      expect(mockTryAutoMergeWorkerPr).toHaveBeenCalledTimes(1);
      expect(mockTryAutoMergeWorkerPr.mock.calls[0][0]).toMatchObject({
        policy: { tier: 'auto-threshold', threshold: { denyPaths: ['.github/workflows/'] } },
      });
    });

    it('sets worker.mergedAt when PR merges (dependsOn gate prerequisite)', async () => {
      resetAll();
      const payload = {
        action: 'closed',
        pull_request: {
          number: 55,
          merged: true,
          draft: false,
          head: { ref: 'buildd/abc12345-fix', sha: 'sha-55' },
          html_url: 'https://github.com/test-org/test-repo/pull/55',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      mockWorkersFindFirst.mockReturnValue({
        id: 'worker-merge-test',
        task: {
          id: 'task-merge-test',
          status: 'in_progress',
          workspaceId: 'ws1',
          release: 'false',
          missionId: null,
        },
      });

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      // worker.mergedAt must be set — this is what the dependsOn gate checks.
      // No merged_at in this payload, so the receipt instant stands in.
      const merged = factsOfKind('merged');
      expect(merged).toHaveLength(1);
      expect(merged[0]!.target).toEqual({ prUrl: 'https://github.com/test-org/test-repo/pull/55', prNumber: 55 });
      expect(merged[0]!.fact.mergedAt).toBeInstanceOf(Date);
    });

    it('sets worker.mergedAt even when task was already completed', async () => {
      resetAll();
      const payload = {
        action: 'closed',
        pull_request: {
          number: 56,
          merged: true,
          draft: false,
          head: { ref: 'buildd/abc12345-fix', sha: 'sha-56' },
          html_url: 'https://github.com/test-org/test-repo/pull/56',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      // Task already completed (worker called complete_task before PR merged)
      mockWorkersFindFirst.mockReturnValue({
        id: 'worker-already-done',
        task: {
          id: 'task-already-done',
          status: 'completed',
          workspaceId: 'ws1',
          release: 'false',
          missionId: null,
        },
      });

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      // mergedAt must still be set even though task was already 'completed'
      expect(factsOfKind('merged')).toHaveLength(1);
    });

    it('stamps mergedAt on EVERY worker row carrying the PR, not just the findFirst one', async () => {
      // A CI-retry attempt pushes to its parent's branch and adopts the PR
      // number, so two rows carry one PR. Stamping only the row findFirst
      // returned left the other reading as an open PR, and Home kept a
      // "Merge PR #N" card after the merge.
      resetAll();
      const payload = {
        action: 'closed',
        pull_request: {
          number: 57,
          merged: true,
          draft: false,
          head: { ref: 'buildd/abc12345-fix', sha: 'sha-57' },
          html_url: 'https://github.com/test-org/test-repo/pull/57',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };
      mockWorkersFindFirst.mockReturnValue({
        id: 'worker-pr-owner',
        prUrl: 'https://github.com/test-org/test-repo/pull/57',
        prNumber: 57,
        task: { id: 'task-pr-owner', status: 'completed', workspaceId: 'ws1', release: 'false', missionId: null },
      });

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      // Targeted at the PR's identity (url + number), never at the single
      // worker id findFirst returned. "Only rows still unmerged" is the
      // funnel's own WHERE (proven in tests/db/pr-facts.test.ts).
      const merged = factsOfKind('merged');
      expect(merged).toHaveLength(1);
      expect(merged[0]!.target).toEqual({ prUrl: 'https://github.com/test-org/test-repo/pull/57', prNumber: 57 });
      expect(merged[0]!.target).not.toHaveProperty('workerId');
    });

    it('enqueues a knowledge diff ingest job per bound workspace on merged PR', async () => {
      // Bind repo → two workspaces via github_repos.fullName → workspaces.githubRepoId
      selectTableResults = (table: any) => {
        if (table === schemaMock.githubRepos) return [{ id: 'repo-uuid-1' }];
        if (table === schemaMock.workspaces) return [{ id: 'ws-a' }, { id: 'ws-b' }];
        return null;
      };

      const payload = {
        action: 'closed',
        pull_request: {
          number: 77,
          merged: true,
          draft: false,
          merge_commit_sha: 'merge-sha-77',
          head: { ref: 'feature/anything', sha: 'head-sha-77' },
          html_url: 'https://github.com/test-org/test-repo/pull/77',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      const jobInserts = insertCalls.filter(c => c.table === schemaMock.knowledgeIngestJobs);
      expect(jobInserts.length).toBe(2);
      expect(jobInserts[0].values).toMatchObject({
        workspaceId: 'ws-a',
        repo: 'test-org/test-repo',
        trigger: 'pr_merged',
        sha: 'merge-sha-77',
        prNumber: 77,
        scope: 'diff',
        status: 'queued',
      });
      expect(jobInserts[1].values.workspaceId).toBe('ws-b');
      // Idempotent enqueue — must go through ON CONFLICT DO NOTHING
      expect(jobInserts.every(c => c.conflict === 'nothing')).toBe(true);
    });

    it('enqueues ingest jobs even for non-worker PRs (any merged PR on a bound repo)', async () => {
      selectTableResults = (table: any) => {
        if (table === schemaMock.githubRepos) return [{ id: 'repo-uuid-1' }];
        if (table === schemaMock.workspaces) return [{ id: 'ws-a' }];
        return null;
      };
      // No worker owns this PR and branch doesn't match buildd/ pattern
      mockWorkersFindFirst.mockReturnValue(null);

      const payload = {
        action: 'closed',
        pull_request: {
          number: 88,
          merged: true,
          draft: false,
          merge_commit_sha: 'merge-sha-88',
          head: { ref: 'human/manual-fix', sha: 'head-sha-88' },
          html_url: 'https://github.com/test-org/test-repo/pull/88',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      const jobInserts = insertCalls.filter(c => c.table === schemaMock.knowledgeIngestJobs);
      expect(jobInserts.length).toBe(1);
    });

    it('does not enqueue an ingest job when the repo is not bound to any workspace', async () => {
      // Default selectTableResults → githubRepos select returns null → legacy
      // chain; configure explicitly to return empty for repos.
      selectTableResults = (table: any) => {
        if (table === schemaMock.githubRepos) return [];
        return null;
      };

      const payload = {
        action: 'closed',
        pull_request: {
          number: 78,
          merged: true,
          draft: false,
          merge_commit_sha: 'merge-sha-78',
          head: { ref: 'feature/x', sha: 'head-sha-78' },
          html_url: 'https://github.com/unbound-org/unbound-repo/pull/78',
        },
        repository: { full_name: 'unbound-org/unbound-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      const jobInserts = insertCalls.filter(c => c.table === schemaMock.knowledgeIngestJobs);
      expect(jobInserts.length).toBe(0);
    });

    it('returns 200 even when ingest enqueue throws (best-effort)', async () => {
      selectTableResults = (table: any) => {
        if (table === schemaMock.githubRepos) throw new Error('db exploded');
        return null;
      };

      const payload = {
        action: 'closed',
        pull_request: {
          number: 79,
          merged: true,
          draft: false,
          merge_commit_sha: 'merge-sha-79',
          head: { ref: 'feature/y', sha: 'head-sha-79' },
          html_url: 'https://github.com/test-org/test-repo/pull/79',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    });

    it('duplicate delivery: conflict on unique index yields no new job and still 200', async () => {
      selectTableResults = (table: any) => {
        if (table === schemaMock.githubRepos) return [{ id: 'repo-uuid-1' }];
        if (table === schemaMock.workspaces) return [{ id: 'ws-a' }];
        return null;
      };
      jobInsertConflicts = true; // second delivery — partial unique index fires

      const payload = {
        action: 'closed',
        pull_request: {
          number: 80,
          merged: true,
          draft: false,
          merge_commit_sha: 'merge-sha-80',
          head: { ref: 'feature/z', sha: 'head-sha-80' },
          html_url: 'https://github.com/test-org/test-repo/pull/80',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      // Insert attempted (idempotency handled by Postgres), but no row returned
      const jobInserts = insertCalls.filter(c => c.table === schemaMock.knowledgeIngestJobs);
      expect(jobInserts.length).toBe(1);
      expect(jobInserts[0].conflict).toBe('nothing');
    });

    it('falls back to head SHA when merge_commit_sha is absent', async () => {
      selectTableResults = (table: any) => {
        if (table === schemaMock.githubRepos) return [{ id: 'repo-uuid-1' }];
        if (table === schemaMock.workspaces) return [{ id: 'ws-a' }];
        return null;
      };

      const payload = {
        action: 'closed',
        pull_request: {
          number: 81,
          merged: true,
          draft: false,
          head: { ref: 'feature/no-merge-sha', sha: 'head-sha-81' },
          html_url: 'https://github.com/test-org/test-repo/pull/81',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      const jobInserts = insertCalls.filter(c => c.table === schemaMock.knowledgeIngestJobs);
      expect(jobInserts.length).toBe(1);
      expect(jobInserts[0].values.sha).toBe('head-sha-81');
    });

    it('records a direct-prod-merge release for any merged PR, independent of worker ownership', async () => {
      // No worker owns this PR — this is the release PR / hotfix shape:
      // scripts/release.sh opens it via `gh`, and CI or a human merges it.
      mockWorkersFindFirst.mockReturnValue(null);

      const payload = {
        action: 'closed',
        pull_request: {
          number: 90,
          merged: true,
          draft: false,
          merge_commit_sha: 'merge-sha-90',
          head: { ref: 'dev', sha: 'head-sha-90' },
          base: { ref: 'main', sha: 'base-sha-90' },
          html_url: 'https://github.com/test-org/test-repo/pull/90',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      expect(mockRecordDirectProdMerge).toHaveBeenCalledTimes(1);
      expect(mockRecordDirectProdMerge.mock.calls[0]?.[0]).toMatchObject({
        repoFullName: 'test-org/test-repo',
        installationId: 5000,
        baseRef: 'main',
        headSha: 'merge-sha-90',
        previousSha: 'base-sha-90',
      });
    });

    it('advances a gated release row when the release PR itself merges, matched by pre-merge head sha', async () => {
      mockWorkersFindFirst.mockReturnValue(null);

      const payload = {
        action: 'closed',
        pull_request: {
          number: 92,
          title: 'Release v1.2.3',
          merged: true,
          draft: false,
          merge_commit_sha: 'merge-sha-92',
          head: { ref: 'dev', sha: 'head-sha-92' },
          base: { ref: 'main', sha: 'base-sha-92' },
          html_url: 'https://github.com/test-org/test-repo/pull/92',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      expect(mockAdvanceGatedReleaseOnPrMerge).toHaveBeenCalledTimes(1);
      expect(mockAdvanceGatedReleaseOnPrMerge.mock.calls[0]?.[0]).toMatchObject({
        repoFullName: 'test-org/test-repo',
        baseRef: 'main',
        // The pre-merge branch tip: the executor checks it CONTAINS the sha
        // the row recorded at dispatch time.
        prHeadSha: 'head-sha-92',
        // What the executor needs to record the shipped identity, the version,
        // and an external row for a merge no dispatched row matches.
        installationId: 5000,
        mergeCommitSha: 'merge-sha-92',
        baseSha: 'base-sha-92',
        prTitle: 'Release v1.2.3',
        prNumber: 92,
      });
    });

    it('does not record a direct-prod-merge release for a closed-unmerged PR', async () => {
      const payload = {
        action: 'closed',
        pull_request: {
          number: 91,
          merged: false,
          draft: false,
          head: { ref: 'dev', sha: 'head-sha-91' },
          base: { ref: 'main', sha: 'base-sha-91' },
          html_url: 'https://github.com/test-org/test-repo/pull/91',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      expect(mockRecordDirectProdMerge).not.toHaveBeenCalled();
      expect(mockAdvanceGatedReleaseOnPrMerge).not.toHaveBeenCalled();
    });

    it('calls tryAutoMergeWorkerPr regardless of drizzle/lockfile noise in diff', async () => {
      // Noise-exclusion logic (drizzle meta + lockfile) lives in auto-merge.ts.
      // The webhook's job is to invoke tryAutoMergeWorkerPr with the gitConfig so
      // the library can apply the budget after exclusions. Verified in auto-merge.test.ts.
      mockWorkspacesFindMany.mockReturnValue([{ id: 'ws1', gitConfig: { autoMergePR: true, autoMergeMaxLines: 10 } }]);
      mockWorkersFindFirst.mockReturnValue({ id: 'w1', taskId: 't1', prNumber: 7 });
      mockHasCheckSuites.mockReturnValue(Promise.resolve(false));

      const res = await POST(createWebhookRequest('pull_request', makePullRequestPayload()));

      expect(res.status).toBe(200);
      expect(mockTryAutoMergeWorkerPr).toHaveBeenCalledTimes(1);
    });
  });

  // ── PR lifecycle status tracking ─────────────────────────────────────────
  describe('PR lifecycle status', () => {
    it('sets prLifecycleStatus=pr_open when PR is opened and worker exists', async () => {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w-open',
        workspaceId: 'ws1',
        taskId: 'task-open',
        prNumber: 42,
      });
      // Also return no CI for the no-CI auto-merge path (workspace lookup)
      mockWorkspacesFindMany.mockReturnValue([]);

      const payload = {
        action: 'opened',
        pull_request: {
          number: 42,
          merged: false,
          draft: false,
          head: { ref: 'buildd/abc-fix', sha: 'sha-42' },
          html_url: 'https://github.com/test-org/test-repo/pull/42',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      expect(recordedFacts).toEqual([
        { target: { workerId: 'w-open' }, fact: { kind: 'open', reopened: false }, opts: { bookkeeping: { prIsDraft: false } } },
      ]);
    });

    it.each([
      ['converted_to_draft', true],
      ['ready_for_review', false],
    ] as const)('records prIsDraft on %s', async (action, draft) => {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w-draft',
        workspaceId: 'ws1',
        taskId: 'task-draft',
        prNumber: 43,
      });
      mockWorkspacesFindMany.mockReturnValue([]);

      const payload = {
        action,
        pull_request: {
          number: 43,
          merged: false,
          draft,
          head: { ref: 'buildd/abc-draft', sha: 'sha-43' },
          html_url: 'https://github.com/test-org/test-repo/pull/43',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      const open = factsOfKind('open');
      expect(open).toHaveLength(1);
      expect(open[0]!.target).toEqual({ workerId: 'w-draft' });
      expect(open[0]!.opts).toEqual({ bookkeeping: { prIsDraft: draft } });
    });

    it('sets prLifecycleStatus=merged (and mergedAt) when PR is merged', async () => {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w-merged',
        workspaceId: 'ws1',
        taskId: 'task-merged',
        prNumber: 55,
        task: {
          id: 'task-merged',
          status: 'in_progress',
          workspaceId: 'ws1',
          release: 'false',
          missionId: null,
        },
      });

      const payload = {
        action: 'closed',
        pull_request: {
          number: 55,
          merged: true,
          draft: false,
          head: { ref: 'buildd/abc-fix', sha: 'sha-55' },
          html_url: 'https://github.com/test-org/test-repo/pull/55',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      const merged = factsOfKind('merged');
      expect(merged).toHaveLength(1);
      expect(merged[0]!.fact.mergedAt).toBeInstanceOf(Date);
    });

    it('sets prLifecycleStatus=closed when PR is closed without merge', async () => {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w-closed',
        workspaceId: 'ws1',
        taskId: 'task-closed',
        prNumber: 60,
        task: {
          id: 'task-closed',
          status: 'in_progress',
          workspaceId: 'ws1',
          release: 'false',
          missionId: null,
        },
      });

      const payload = {
        action: 'closed',
        pull_request: {
          number: 60,
          merged: false,
          draft: false,
          head: { ref: 'buildd/abc-fix', sha: 'sha-60' },
          html_url: 'https://github.com/test-org/test-repo/pull/60',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      expect(factsOfKind('closed')).toHaveLength(1);
      // mergedAt must NOT be set on an abandoned PR
      expect(factsOfKind('merged')).toHaveLength(0);
      // The task must NOT be auto-completed on a non-merged close
      const taskUpdate = updateCalls.find((c) => (c.setValues as any).status === 'completed');
      expect(taskUpdate).toBeUndefined();
    });

    it('looks for where a closed-unmerged PR\'s work landed (detection, not a recorded edge)', async () => {
      mockDetectPrSupersession.mockClear();
      mockWorkersFindFirst.mockReturnValue({
        id: 'w-closed-2', workspaceId: 'ws1', taskId: 'task-closed-2', prNumber: 61,
        task: { id: 'task-closed-2', status: 'completed', workspaceId: 'ws1', release: 'false', missionId: null },
      });
      const res = await POST(createWebhookRequest('pull_request', {
        action: 'closed',
        pull_request: { number: 61, merged: false, draft: false, head: { ref: 'buildd/x', sha: 'sha-61' }, html_url: 'https://github.com/test-org/test-repo/pull/61' },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      }));
      expect(res.status).toBe(200);
      expect(mockDetectPrSupersession).toHaveBeenCalledWith({ workerId: 'w-closed-2', via: 'webhook' });
    });

    it('resolves the sticky activity comment when the PR merges', async () => {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w-merged',
        workspaceId: 'ws1',
        taskId: 'task-merged',
        prNumber: 55,
        task: {
          id: 'task-merged',
          status: 'in_progress',
          workspaceId: 'ws1',
          release: 'false',
          missionId: null,
        },
      });
      // Sticky comment left mid-flight: "Review passed", still spinning.
      const stickyBody = renderPrActivityComment([{ kind: 'review_approved', at: '2026-08-29T14:03:00.000Z' }]);
      mockGithubApi.mockImplementation((_installationId: number, url: string) => {
        if (url.includes('/issues/55/comments')) return Promise.resolve([{ id: 77, body: stickyBody }]);
        return Promise.resolve({});
      });

      const payload = {
        action: 'closed',
        pull_request: {
          number: 55,
          merged: true,
          draft: false,
          head: { ref: 'buildd/abc-fix', sha: 'sha-55' },
          base: { ref: 'dev' },
          html_url: 'https://github.com/test-org/test-repo/pull/55',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      const patch = (mockGithubApi.mock.calls as any[]).find(
        (c) => c[1] === '/repos/test-org/test-repo/issues/comments/77' && c[2]?.method === 'PATCH',
      );
      expect(patch).toBeDefined();
      const body = JSON.parse(patch[2].body).body as string;
      expect(body).toContain('**Merged**');
      expect(body).not.toContain(SPINNER_PATH);
    });

    it('marks the sticky activity comment closed when the PR is abandoned', async () => {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w-closed',
        workspaceId: 'ws1',
        taskId: 'task-closed',
        prNumber: 60,
        task: {
          id: 'task-closed',
          status: 'in_progress',
          workspaceId: 'ws1',
          release: 'false',
          missionId: null,
        },
      });
      const stickyBody = renderPrActivityComment([{ kind: 'ci_fixing', at: '2026-08-29T14:03:00.000Z' }]);
      mockGithubApi.mockImplementation((_installationId: number, url: string) => {
        if (url.includes('/issues/60/comments')) return Promise.resolve([{ id: 88, body: stickyBody }]);
        return Promise.resolve({});
      });

      const payload = {
        action: 'closed',
        pull_request: {
          number: 60,
          merged: false,
          draft: false,
          head: { ref: 'buildd/abc-fix', sha: 'sha-60' },
          base: { ref: 'dev' },
          html_url: 'https://github.com/test-org/test-repo/pull/60',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      await POST(createWebhookRequest('pull_request', payload));

      const patch = (mockGithubApi.mock.calls as any[]).find(
        (c) => c[1] === '/repos/test-org/test-repo/issues/comments/88' && c[2]?.method === 'PATCH',
      );
      expect(patch).toBeDefined();
      const body = JSON.parse(patch[2].body).body as string;
      expect(body).toContain('**Closed without merging**');
      expect(body).not.toContain(SPINNER_PATH);
    });

    it('does not post an activity comment on a merged PR buildd never touched', async () => {
      mockWorkersFindFirst.mockReturnValue(null);
      mockGithubApi.mockImplementation((_installationId: number, url: string) => {
        if (url.includes('/comments')) return Promise.resolve([{ id: 1, body: 'a human comment' }]);
        return Promise.resolve({});
      });

      const payload = {
        action: 'closed',
        pull_request: {
          number: 61,
          merged: true,
          draft: false,
          head: { ref: 'human/branch', sha: 'sha-61' },
          base: { ref: 'dev' },
          html_url: 'https://github.com/test-org/test-repo/pull/61',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      await POST(createWebhookRequest('pull_request', payload));

      const post = (mockGithubApi.mock.calls as any[]).find(
        (c) => c[1] === '/repos/test-org/test-repo/issues/61/comments' && c[2]?.method === 'POST',
      );
      expect(post).toBeUndefined();
    });

    it('delivers a pending review callback when the PR merges', async () => {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w-cb',
        workspaceId: 'ws1',
        taskId: 'task-cb',
        prNumber: 70,
        task: { id: 'task-cb', status: 'completed', workspaceId: 'ws1', release: 'false', missionId: null },
      });
      mockDeliverPrReviewCallback.mockClear();

      const payload = {
        action: 'closed',
        pull_request: {
          number: 70,
          merged: true,
          draft: false,
          head: { ref: 'fix/thing', sha: 'sha-70' },
          base: { ref: 'dev' },
          html_url: 'https://github.com/test-org/test-repo/pull/70',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);
      expect(mockDeliverPrReviewCallback).toHaveBeenCalledTimes(1);
      expect(mockDeliverPrReviewCallback.mock.calls[0][0]).toMatchObject({
        workspaceId: 'ws1',
        prNumber: 70,
        repoFullName: 'test-org/test-repo',
      });
    });

    it('delivers the callback on a close without merge too — nothing will land', async () => {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w-cb2',
        workspaceId: 'ws1',
        taskId: 'task-cb2',
        prNumber: 71,
        task: { id: 'task-cb2', status: 'completed', workspaceId: 'ws1', release: 'false', missionId: null },
      });
      mockDeliverPrReviewCallback.mockClear();

      await POST(createWebhookRequest('pull_request', {
        action: 'closed',
        pull_request: {
          number: 71,
          merged: false,
          draft: false,
          head: { ref: 'fix/thing', sha: 'sha-71' },
          base: { ref: 'dev' },
          html_url: 'https://github.com/test-org/test-repo/pull/71',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      }));

      expect(mockDeliverPrReviewCallback).toHaveBeenCalledTimes(1);
    });

    it('sets prLifecycleStatus=ci_running on check_suite requested', async () => {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w-ci',
        workspaceId: 'ws1',
        taskId: 'task-ci',
        prNumber: 42,
      });

      const payload = {
        action: 'requested',
        check_suite: {
          id: 1,
          head_sha: 'sha-ci',
          status: 'queued',
          conclusion: null,
          pull_requests: [{ number: 42, head: { sha: 'sha-ci', ref: 'buildd/fix' }, base: { sha: 'base', ref: 'dev' } }],
        },
        repository: { id: 100, full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('check_suite', payload));
      expect(res.status).toBe(200);

      expect(recordedFacts).toEqual([
        { target: { workerId: 'w-ci' }, fact: { kind: 'ci', status: 'ci_running', headSha: 'sha-ci', currentHeadSha: 'sha-ci' }, opts: undefined },
      ]);
    });

    it('sets prLifecycleStatus=ci_failed on check_suite completed failure', async () => {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w-ci-fail',
        workspaceId: 'ws1',
        taskId: 'task-ci-fail',
        prNumber: 42,
        task: { id: 'task-ci-fail', status: 'in_progress', workspaceId: 'ws1', missionId: null, title: 'Fix bug' },
      });
      mockWorkspacesFindFirst.mockReturnValue({ id: 'ws1', gitConfig: {} });
      // CI logs fetch
      mockGithubApi.mockReturnValue(Promise.resolve({ workflow_runs: [] }));

      const payload = makeCheckSuitePayload({ check_suite: { conclusion: 'failure' } });
      const res = await POST(createWebhookRequest('check_suite', payload));
      expect(res.status).toBe(200);

      const failed = factsOfKind('ci');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toEqual({
        target: { workerId: 'w-ci-fail' },
        fact: { kind: 'ci', status: 'ci_failed', headSha: 'abc123', currentHeadSha: 'abc123' },
        opts: undefined,
      });
    });

    it('hands a mergeable=false open-state event to the funnel as a conflict fact', async () => {
      mockWorkersFindFirst.mockReturnValue({ id: 'w-conf', workspaceId: 'ws1', taskId: 'task-conf', prNumber: 44 });
      mockWorkspacesFindMany.mockReturnValue([]);

      const res = await POST(createWebhookRequest('pull_request', {
        action: 'synchronize',
        pull_request: {
          number: 44, merged: false, draft: false, mergeable: false,
          head: { ref: 'buildd/abc-conf', sha: 'sha-44' },
          html_url: 'https://github.com/test-org/test-repo/pull/44',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      }));
      expect(res.status).toBe(200);
      expect(recordedFacts).toEqual([
        { target: { workerId: 'w-conf' }, fact: { kind: 'conflict' }, opts: { bookkeeping: { prIsDraft: false } } },
      ]);
    });

    it('a reopened event is the only open fact that may lift a close (reopened: true)', async () => {
      mockWorkersFindFirst.mockReturnValue({ id: 'w-reopen', workspaceId: 'ws1', taskId: 'task-reopen', prNumber: 45 });
      mockWorkspacesFindMany.mockReturnValue([]);

      await POST(createWebhookRequest('pull_request', {
        action: 'reopened',
        pull_request: {
          number: 45, merged: false, draft: false,
          head: { ref: 'buildd/abc-reopen', sha: 'sha-45' },
          html_url: 'https://github.com/test-org/test-repo/pull/45',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      }));
      expect(factsOfKind('open').map((r) => r.fact)).toEqual([{ kind: 'open', reopened: true }]);
    });

    // ── §16 S6: arrival order never matters — terminal wins in the funnel ──
    describe('late and out-of-order facts (spec §16 S6)', () => {
      it.each(['synchronize', 'opened'] as const)(
        'a late %s after the merge hands {kind:open} to the funnel, which changes nothing',
        async (action) => {
          // The PR already merged; the row still matches the open-state lookup.
          mockWorkersFindFirst.mockReturnValue({ id: 'w-late', workspaceId: 'ws1', taskId: 'task-late', prNumber: 46 });
          mockWorkspacesFindMany.mockReturnValue([]);
          recordPrFactRows = []; // terminal wins: merged is final

          const res = await POST(createWebhookRequest('pull_request', {
            action,
            pull_request: {
              number: 46, merged: false, draft: false,
              head: { ref: 'buildd/abc-late', sha: 'sha-46-late' },
              html_url: 'https://github.com/test-org/test-repo/pull/46',
            },
            repository: { full_name: 'test-org/test-repo' },
            installation: { id: 5000 },
          }));
          expect(res.status).toBe(200);
          // The door does not decide terminal-wins itself: it hands over a plain
          // open fact (never reopened) and the funnel's WHERE refuses it.
          expect(recordedFacts).toEqual([
            { target: { workerId: 'w-late' }, fact: { kind: 'open', reopened: false }, opts: { bookkeeping: { prIsDraft: false } } },
          ]);
          expect(realPrFacts.prFactApplies(recordedFacts[0]!.fact, { prLifecycleStatus: 'merged', mergedAt: new Date() })).toBe(false);
          // No status/merge write slipped past the funnel.
          expect(updateCalls.find((c) => 'prLifecycleStatus' in (c.setValues ?? {}) || 'mergedAt' in (c.setValues ?? {}))).toBeUndefined();
        },
      );

      it('a late check_suite failure after the merge fires no progress side effects when the funnel changes nothing', async () => {
        mockWorkersFindFirst.mockReturnValue({
          id: 'w-late-ci', workspaceId: 'ws1', taskId: 'task-late-ci', prNumber: 42, prLifecycleStatus: 'merged',
          task: { id: 'task-late-ci', status: 'completed', workspaceId: 'ws1', missionId: null, title: 'Fix', context: {} },
        });
        mockWorkspacesFindFirst.mockReturnValue({ id: 'ws1', gitConfig: {} });
        mockGithubApi.mockReturnValue(Promise.resolve({ workflow_runs: [] }));
        recordPrFactRows = [];

        const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));
        expect(res.status).toBe(200);
        expect(factsOfKind('ci').map((r) => r.fact.status)).toEqual(['ci_failed']);
        const progress = (mockTriggerEvent.mock.calls as any[]).filter(
          (c) => c[1] === 'worker:progress' && c[2]?.taskId === 'task-late-ci',
        );
        expect(progress).toHaveLength(0);
      });

      it('a late check_suite requested after the merge fires no WORKER_PROGRESS when the funnel changes nothing', async () => {
        mockWorkersFindFirst.mockReturnValue({ id: 'w-late-run', workspaceId: 'ws1', taskId: 'task-late-run', prNumber: 42 });
        recordPrFactRows = [];

        const res = await POST(createWebhookRequest('check_suite', {
          action: 'requested',
          check_suite: {
            id: 1, head_sha: 'sha-run', status: 'queued', conclusion: null,
            pull_requests: [{ number: 42, head: { sha: 'sha-run', ref: 'buildd/fix' }, base: { sha: 'base', ref: 'dev' } }],
          },
          repository: { id: 100, full_name: 'test-org/test-repo' },
          installation: { id: 5000 },
        }));
        expect(res.status).toBe(200);
        expect(factsOfKind('ci').map((r) => r.fact.status)).toEqual(['ci_running']);
        expect((mockTriggerEvent.mock.calls as any[]).filter((c) => c[1] === 'worker:progress')).toHaveLength(0);
      });

      it('a check_suite failure for an old head passes both SHAs so the funnel drops it', async () => {
        mockWorkersFindFirst.mockReturnValue({
          id: 'w-old-head', workspaceId: 'ws1', taskId: 'task-old-head', prNumber: 42, prLifecycleStatus: 'ci_running',
          task: { id: 'task-old-head', status: 'in_progress', workspaceId: 'ws1', missionId: null, title: 'Fix', context: {} },
        });
        mockWorkspacesFindFirst.mockReturnValue({ id: 'ws1', gitConfig: {} });
        mockGithubApi.mockReturnValue(Promise.resolve({ workflow_runs: [] }));
        recordPrFactRows = []; // stale SHA: dropped

        const payload = makeCheckSuitePayload({
          check_suite: {
            head_sha: 'old-head-sha',
            pull_requests: [{ number: 42, head: { sha: 'new-head-sha', ref: 'buildd/task-1-fix-bug' }, base: { sha: 'def456', ref: 'main' } }],
          },
        });
        const res = await POST(createWebhookRequest('check_suite', payload));
        expect(res.status).toBe(200);

        const ci = factsOfKind('ci');
        expect(ci).toHaveLength(1);
        expect(ci[0]!.fact).toEqual({ kind: 'ci', status: 'ci_failed', headSha: 'old-head-sha', currentHeadSha: 'new-head-sha' });
        // The real funnel's own rule agrees this fact is stale for a live row.
        expect(realPrFacts.prFactApplies(ci[0]!.fact, { prLifecycleStatus: 'ci_running', mergedAt: null })).toBe(false);
        // Nothing changed, so no progress refresh for the stale suite.
        expect((mockTriggerEvent.mock.calls as any[]).filter(
          (c) => c[1] === 'worker:progress' && c[2]?.taskId === 'task-old-head',
        )).toHaveLength(0);
      });

      it('closed-unmerged targets every row carrying the PR ({prUrl, prNumber}), not the findFirst row', async () => {
        mockWorkersFindFirst.mockReturnValue({
          id: 'w-closed-any', workspaceId: 'ws1', taskId: 'task-closed-any', prNumber: 62,
          task: { id: 'task-closed-any', status: 'completed', workspaceId: 'ws1', release: 'false', missionId: null },
        });

        await POST(createWebhookRequest('pull_request', {
          action: 'closed',
          pull_request: {
            number: 62, merged: false, draft: false,
            head: { ref: 'buildd/x', sha: 'sha-62' }, base: { ref: 'dev' },
            html_url: 'https://github.com/test-org/test-repo/pull/62',
          },
          repository: { full_name: 'test-org/test-repo' },
          installation: { id: 5000 },
        }));

        expect(factsOfKind('closed')).toEqual([
          { target: { prUrl: 'https://github.com/test-org/test-repo/pull/62', prNumber: 62 }, fact: { kind: 'closed' }, opts: undefined },
        ]);
      });

      it("closed-merged stamps GitHub's merged_at, not the receipt instant", async () => {
        mockWorkersFindFirst.mockReturnValue({
          id: 'w-gh-clock', workspaceId: 'ws1', taskId: 'task-gh-clock', prNumber: 63,
          task: { id: 'task-gh-clock', status: 'completed', workspaceId: 'ws1', release: 'false', missionId: null },
        });

        await POST(createWebhookRequest('pull_request', {
          action: 'closed',
          pull_request: {
            number: 63, merged: true, merged_at: '2026-09-01T12:34:56Z', draft: false,
            head: { ref: 'buildd/x', sha: 'sha-63' }, base: { ref: 'dev' },
            html_url: 'https://github.com/test-org/test-repo/pull/63',
          },
          repository: { full_name: 'test-org/test-repo' },
          installation: { id: 5000 },
        }));

        const merged = factsOfKind('merged');
        expect(merged).toHaveLength(1);
        expect(merged[0]!.target).toEqual({ prUrl: 'https://github.com/test-org/test-repo/pull/63', prNumber: 63 });
        expect(merged[0]!.fact.mergedAt).toBe('2026-09-01T12:34:56Z');
      });
    });
  });

  // ── Reviewer invocation (Phase 2) ──────────────────────────────────────────
  describe('pull_request reviewer dispatch (agent-review policy)', () => {
    function makePROpenedPayload(overrides: Record<string, any> = {}) {
      return {
        action: 'opened',
        pull_request: {
          number: 42,
          merged: false,
          draft: false,
          head: { ref: 'buildd/abc12345-feat', sha: 'sha-42' },
          html_url: 'https://github.com/test-org/test-repo/pull/42',
          ...overrides.pull_request,
        },
        repository: { full_name: 'test-org/test-repo', ...overrides.repository },
        installation: { id: 5000, ...overrides.installation },
      };
    }

    function withAgentReviewWorkspaceAndWorker() {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w1',
        workspaceId: 'ws1',
        taskId: 'task-1',
        branch: 'buildd/abc12345-feat',
        prNumber: 42,
      });
      mockWorkspacesFindFirst.mockReturnValue({
        id: 'ws1',
        gitConfig: { mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } } },
      });
      mockTasksFindFirst.mockReturnValue({
        id: 'task-1',
        title: 'Add feature X',
        description: 'Build feature X',
        backend: 'codex',
        missionId: 'mission-1',
        pathManifest: ['apps/web/src/lib/feature-x.ts'],
        context: { iteration: 0, maxIterations: 3 },
      });
      mockMissionsFindFirst.mockReturnValue({ mergePolicy: null });
      mockResolvePolicy.mockReturnValue({
        tier: 'agent-review',
        agentReview: { reviewerRole: 'reviewer', escalateToPaths: [], maxConfidenceThreshold: 0.6 },
      });
      // PR files fetch — normal files (no schema)
      mockGithubApi.mockReturnValue(Promise.resolve([
        { filename: 'apps/web/src/lib/feature-x.ts', additions: 50, deletions: 5, status: 'added' },
      ]));
    }

    it('creates reviewer task on PR open with agent-review policy', async () => {
      withAgentReviewWorkspaceAndWorker();
      mockPreflightEscalationCheck.mockReturnValue({ shouldEscalate: false });

      const res = await POST(createWebhookRequest('pull_request', makePROpenedPayload()));

      expect(res.status).toBe(200);
      expect(mockCreateReviewerTask).toHaveBeenCalledTimes(1);
      expect(mockCreateReviewerTask.mock.calls[0][0]).toMatchObject({
        prNumber: 42,
        reviewerRole: 'reviewer',
        originalTaskId: 'task-1',
        originalTask: { backend: 'codex' },
      });
      // Auto-merge must NOT be called when reviewer is dispatched
      expect(mockTryAutoMergeWorkerPr).not.toHaveBeenCalled();
    });

    it('workflow kernel: a PR the kernel takes at its first-review point dispatches no legacy reviewer', async () => {
      withAgentReviewWorkspaceAndWorker();
      mockPreflightEscalationCheck.mockReturnValue({ shouldEscalate: false });
      mockOpenKernelDelivery.mockResolvedValueOnce({ owned: true, deliveryId: 'delivery-42' });

      const res = await POST(createWebhookRequest('pull_request', makePROpenedPayload()));

      expect(res.status).toBe(200);
      expect(mockOpenKernelDelivery).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: 'ws1', ownerTaskId: 'task-1', repoFullName: 'test-org/test-repo', prNumber: 42, installationId: 5000,
      }));
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
      // Held: the no-CI auto-merge path must not run either.
      expect(mockTryAutoMergeWorkerPr).not.toHaveBeenCalled();
    });

    it('workflow kernel: a pre-flight human escalation is imported as policy evidence, with no legacy note or release', async () => {
      withAgentReviewWorkspaceAndWorker();
      mockOpenKernelDelivery.mockClear();
      mockReleaseKernelDeliveryForPr.mockClear();
      mockOpenKernelDelivery.mockResolvedValueOnce({ owned: true, deliveryId: 'delivery-42' });
      mockPreflightEscalationCheck.mockReturnValue({ shouldEscalate: true, reason: 'touches schema' });

      await POST(createWebhookRequest('pull_request', makePROpenedPayload()));

      expect(mockOpenKernelDelivery).toHaveBeenCalledWith(expect.objectContaining({
        prNumber: 42,
        policy: { outcome: 'human', reason: 'touches schema', destructive: false },
      }));
      expect(mockReleaseKernelDeliveryForPr).not.toHaveBeenCalled();
    });

    it('legacy authority: a pre-flight human escalation the kernel does not take releases any kernel delivery', async () => {
      withAgentReviewWorkspaceAndWorker();
      mockOpenKernelDelivery.mockClear();
      mockReleaseKernelDeliveryForPr.mockClear();
      mockPreflightEscalationCheck.mockReturnValue({ shouldEscalate: true, reason: 'touches schema' });

      await POST(createWebhookRequest('pull_request', makePROpenedPayload()));

      expect(mockReleaseKernelDeliveryForPr).toHaveBeenCalledWith('ws1', 'test-org/test-repo', 42, expect.stringContaining('pre-flight'));
    });

    it('announces on the PR that a review is queued — not Reviewing until claimed', async () => {
      withAgentReviewWorkspaceAndWorker();
      mockPreflightEscalationCheck.mockReturnValue({ shouldEscalate: false });

      await POST(createWebhookRequest('pull_request', makePROpenedPayload()));

      const commentCall = (mockGithubApi.mock.calls as any[]).find(
        (c) => c[1] === '/repos/test-org/test-repo/issues/42/comments' && c[2]?.method === 'POST',
      );
      expect(commentCall).toBeDefined();
      const body = JSON.parse(commentCall[2].body).body as string;
      expect(body).toContain('<!-- buildd-activity -->');
      expect(body).toContain('**Review queued**');
      expect(body).not.toContain('**Reviewing**');
      // Role slugs are internal vocabulary; the PR reader doesn't need them.
      expect(body).not.toContain('reviewer role');
    });

    it('skips reviewer task and escalates when pre-flight detects schema file', async () => {
      withAgentReviewWorkspaceAndWorker();
      mockGithubApi.mockReturnValue(Promise.resolve([
        { filename: 'packages/core/db/schema.ts', additions: 10, deletions: 2, status: 'modified' },
      ]));
      mockPreflightEscalationCheck.mockReturnValue({
        shouldEscalate: true,
        reason: 'PR touches schema migration file: packages/core/db/schema.ts',
      });

      const res = await POST(createWebhookRequest('pull_request', makePROpenedPayload()));

      expect(res.status).toBe(200);
      // No reviewer task created — pre-flight escalated
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
      // Auto-merge also not called
      expect(mockTryAutoMergeWorkerPr).not.toHaveBeenCalled();
      // Mission notification fired
      expect(mockNotifyMissionPrReady).toHaveBeenCalledTimes(1);
    });

    it('dispatches a migration-collision renumber task instead of escalating to a human', async () => {
      withAgentReviewWorkspaceAndWorker();
      const collision = { file: '0093_safe.sql', otherFile: '0093_other.sql', otherPrNumber: 41 };
      mockInspectPullRequestMigrations.mockReturnValue(Promise.resolve({
        safe: false,
        operationClass: 'CONTRACT',
        reason: 'migration number collision: 0093_safe.sql conflicts with open PR #41 migration 0093_other.sql',
        collision,
      }));
      mockTryDispatchMigrationCollisionRetry.mockReturnValue(Promise.resolve({ handled: true }));

      const res = await POST(createWebhookRequest('pull_request', makePROpenedPayload()));

      expect(res.status).toBe(200);
      expect(mockTryDispatchMigrationCollisionRetry).toHaveBeenCalledTimes(1);
      expect(mockTryDispatchMigrationCollisionRetry.mock.calls[0][0]).toMatchObject({
        collision,
        workerId: 'w1',
        taskId: 'task-1',
        prNumber: 42,
      });
      // Handled by the renumber dispatch — no reviewer task, no human escalation.
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
      expect(mockPreflightEscalationCheck).not.toHaveBeenCalled();
      expect(mockNotifyMissionPrReady).not.toHaveBeenCalled();
      expect(mockTryAutoMergeWorkerPr).not.toHaveBeenCalled();
    });

    it('falls back to normal escalation when the collision retry is not handled (e.g. cap exhausted)', async () => {
      withAgentReviewWorkspaceAndWorker();
      const collision = { file: '0093_safe.sql', otherFile: '0093_other.sql', otherPrNumber: 41 };
      mockInspectPullRequestMigrations.mockReturnValue(Promise.resolve({
        safe: false,
        operationClass: 'CONTRACT',
        reason: 'migration number collision: 0093_safe.sql conflicts with open PR #41 migration 0093_other.sql',
        collision,
      }));
      mockTryDispatchMigrationCollisionRetry.mockReturnValue(Promise.resolve({ handled: false }));
      mockPreflightEscalationCheck.mockReturnValue({
        shouldEscalate: true,
        reason: 'migration number collision: 0093_safe.sql conflicts with open PR #41 migration 0093_other.sql',
      });

      const res = await POST(createWebhookRequest('pull_request', makePROpenedPayload()));

      expect(res.status).toBe(200);
      expect(mockTryDispatchMigrationCollisionRetry).toHaveBeenCalledTimes(1);
      // Not handled — falls through to the normal human-escalation path.
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
      expect(mockNotifyMissionPrReady).toHaveBeenCalledTimes(1);
    });

    it('falls through to normal auto-merge path when policy is auto-threshold', async () => {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w1',
        workspaceId: 'ws1',
        taskId: 'task-1',
        branch: 'buildd/abc12345-feat',
        prNumber: 42,
      });
      mockWorkspacesFindFirst.mockReturnValue({
        id: 'ws1',
        gitConfig: { autoMergePR: true },
      });
      mockTasksFindFirst.mockReturnValue({
        id: 'task-1',
        title: 'Fix bug',
        description: null,
        missionId: null,
        mission: null,
      });
      mockResolvePolicy.mockReturnValue({ tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: [] } });
      mockWorkspacesFindMany.mockReturnValue([{ id: 'ws1', gitConfig: { autoMergePR: true } }]);
      mockHasCheckSuites.mockReturnValue(Promise.resolve(false));
      mockGithubApi.mockReturnValue(Promise.resolve([]));

      const res = await POST(createWebhookRequest('pull_request', makePROpenedPayload()));

      expect(res.status).toBe(200);
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
    });

    it('does not dispatch reviewer when PR has no worker', async () => {
      // Worker not found
      mockWorkersFindFirst.mockReturnValue(null);
      mockWorkspacesFindMany.mockReturnValue([]);

      const res = await POST(createWebhookRequest('pull_request', makePROpenedPayload()));

      expect(res.status).toBe(200);
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
    });

    // N10: create_pr's auto-review got there first. Its reviewer was already
    // dispatched and announced — a second dispatch sends a second runner.
    it('does not dispatch or announce a reviewer another producer already filed', async () => {
      withAgentReviewWorkspaceAndWorker();
      mockCreateReviewerTask.mockReturnValue(Promise.resolve({ id: 'reviewer-other', deduplicated: true } as any));

      await POST(createWebhookRequest('pull_request', makePROpenedPayload()));

      expect(mockCreateReviewerTask).toHaveBeenCalledTimes(1);
      expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
      // Still handled: the PR is under review, so no auto-merge.
      expect(mockTryAutoMergeWorkerPr).not.toHaveBeenCalled();
    });

    // The payload already carries the base; without it the reviewer context
    // makes one extra PR read per full review to learn it.
    it('passes the PR base ref from the payload to the reviewer', async () => {
      withAgentReviewWorkspaceAndWorker();

      await POST(createWebhookRequest('pull_request', makePROpenedPayload({
        pull_request: { base: { ref: 'dev' } },
      })));

      expect(mockCreateReviewerTask).toHaveBeenCalledTimes(1);
      expect(mockCreateReviewerTask.mock.calls[0][0]).toMatchObject({ baseRef: 'dev' });
    });

    // V11: the policy names a role; the workspace may not have it. A reviewer
    // task routed to a nonexistent role is claimable by no runner.
    it('routes the review to a role the workspace has when the policy role does not exist', async () => {
      withAgentReviewWorkspaceAndWorker();
      mockListWorkspaceRoles.mockImplementation(() => Promise.resolve([
        { slug: 'builder', isRole: true },
        { slug: 'researcher', isRole: true },
      ]));

      await POST(createWebhookRequest('pull_request', makePROpenedPayload()));

      expect(mockCreateReviewerTask).toHaveBeenCalledTimes(1);
      expect(mockCreateReviewerTask.mock.calls[0][0]).toMatchObject({ reviewerRole: 'builder' });
    });

    it('files no reviewer and does not auto-merge when the workspace has no roles at all', async () => {
      withAgentReviewWorkspaceAndWorker();
      mockListWorkspaceRoles.mockImplementation(() => Promise.resolve([]));

      const res = await POST(createWebhookRequest('pull_request', makePROpenedPayload()));

      expect(res.status).toBe(200);
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
      expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
      // The PR still needs review — holding it is the safe side.
      expect(mockTryAutoMergeWorkerPr).not.toHaveBeenCalled();
    });
  });

  // The other half of the reviewer-loop-never-closes fix: `maybeDispatchReviewer`
  // above only ever fires on `opened`, so a fix pushed after a request-changes
  // verdict was never re-reviewed. `maybeReDispatchReviewer` closes that gap on
  // `synchronize`.
  describe('pull_request re-review dispatch on synchronize (agent-review policy)', () => {
    const OLD_SHA = 'a'.repeat(40);
    const NEW_SHA = 'b'.repeat(40);

    function makeSynchronizePayload(overrides: Record<string, any> = {}) {
      return {
        action: 'synchronize',
        pull_request: {
          number: 42,
          merged: false,
          draft: false,
          head: { ref: 'buildd/abc12345-feat', sha: NEW_SHA },
          html_url: 'https://github.com/test-org/test-repo/pull/42',
          base: { ref: 'dev' },
          ...overrides.pull_request,
        },
        repository: { full_name: 'test-org/test-repo', ...overrides.repository },
        installation: { id: 5000, ...overrides.installation },
      };
    }

    function withAgentReviewWorkspaceAndWorker() {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w1',
        workspaceId: 'ws1',
        taskId: 'task-1',
        branch: 'buildd/abc12345-feat',
        prNumber: 42,
      });
      mockWorkspacesFindFirst.mockReturnValue({
        id: 'ws1',
        gitConfig: { mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } } },
      });
      mockTasksFindFirst.mockReturnValue({
        id: 'task-1',
        title: 'Add feature X',
        description: 'Build feature X',
        backend: 'codex',
        missionId: null,
        pathManifest: ['apps/web/src/lib/feature-x.ts'],
        context: { iteration: 1, maxIterations: 3 },
      });
      mockResolvePolicy.mockReturnValue({
        tier: 'agent-review',
        agentReview: { reviewerRole: 'reviewer', escalateToPaths: [], maxConfidenceThreshold: 0.6 },
      });
      mockGithubApi.mockReturnValue(Promise.resolve([]));
    }

    function withChangesRequestedVerdict(reviewHeadSha = OLD_SHA) {
      mockReadPrReviewStatus.mockResolvedValue({
        state: 'changes_requested', terminal: true, reviewTaskId: 'review-1', adoptedTaskId: 'task-1',
        verdict: 'request-changes', confidence: 0.9, summary: 'needs work', feedback: 'fix the null check',
        escalationReason: null, iteration: 1, maxIterations: 3, reviewHeadSha,
        prState: 'open', merged: false, mergeBlocked: null,
      } as any);
    }

    it('schedules a PR-scope reconcile pinned to the pushed head', async () => {
      withAgentReviewWorkspaceAndWorker();
      withChangesRequestedVerdict();
      mockSchedulePrScopeReconcile.mockClear();

      await POST(createWebhookRequest('pull_request', makeSynchronizePayload()));

      expect(mockSchedulePrScopeReconcile).toHaveBeenCalledTimes(1);
      expect(mockSchedulePrScopeReconcile.mock.calls[0][0]).toEqual({
        workspaceId: 'ws1',
        installationId: 5000,
        repoFullName: 'test-org/test-repo',
        prNumber: 42,
        expectedHeadSha: NEW_SHA,
      });
    });

    it('workflow kernel: a push to a kernel-owned PR is a HeadObserved fact; the legacy re-dispatch and carry-forward do not run', async () => {
      withAgentReviewWorkspaceAndWorker();
      withChangesRequestedVerdict();
      mockObserveHead.mockResolvedValueOnce(true);
      mockCarryForwardApproval.mockClear();

      await POST(createWebhookRequest('pull_request', makeSynchronizePayload()));

      expect(mockObserveHead).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: 'ws1', repoFullName: 'test-org/test-repo', prNumber: 42, installationId: 5000, hintedHeadSha: NEW_SHA,
      }));
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
      expect(mockCarryForwardApproval).not.toHaveBeenCalled();
    });

    it('workflow kernel: a push to a DRAFT kernel-owned PR is still a HeadObserved fact (ddcbe113); legacy still skips drafts', async () => {
      withAgentReviewWorkspaceAndWorker();
      withChangesRequestedVerdict();
      mockObserveHead.mockClear();
      mockObserveHead.mockResolvedValueOnce(true);

      await POST(createWebhookRequest('pull_request', makeSynchronizePayload({ pull_request: { draft: true } })));

      expect(mockObserveHead).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 42, hintedHeadSha: NEW_SHA }));
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();

      // A legacy (not kernel-owned) draft keeps its old behaviour: no re-dispatch.
      mockObserveHead.mockResolvedValueOnce(false);
      await POST(createWebhookRequest('pull_request', makeSynchronizePayload({ pull_request: { draft: true } })));
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
    });

    it('workflow kernel: when ownership cannot be read, the push takes the legacy path (behaviour before the kernel)', async () => {
      withAgentReviewWorkspaceAndWorker();
      withChangesRequestedVerdict();
      mockObserveHead.mockRejectedValueOnce(new Error('db down'));

      await POST(createWebhookRequest('pull_request', makeSynchronizePayload()));

      expect(mockCreateReviewerTask).toHaveBeenCalledTimes(1);
    });

    it('re-dispatches exactly one reviewer when a push follows a request-changes verdict', async () => {
      withAgentReviewWorkspaceAndWorker();
      withChangesRequestedVerdict();

      const res = await POST(createWebhookRequest('pull_request', makeSynchronizePayload()));

      expect(res.status).toBe(200);
      expect(mockCreateReviewerTask).toHaveBeenCalledTimes(1);
      expect(mockCreateReviewerTask.mock.calls[0][0]).toMatchObject({
        prNumber: 42,
        headSha: NEW_SHA,
        reviewerRole: 'reviewer',
        originalTaskId: 'task-1',
        // baseRef must reach buildDeltaReviewerContext, or it falls back to
        // the weaker pulls/files bound, which misattributes base-history
        // churn (like an already-merged migration) to this PR — see PR #2907.
        baseRef: 'dev',
        priorVerdict: { headSha: OLD_SHA, verdict: 'request-changes' },
      });
      expect(mockAnnounceTaskCreated).toHaveBeenCalledTimes(1);
      expect(mockWakeTask).toHaveBeenCalledWith((mockAnnounceTaskCreated.mock.calls[0] as any[])[0].id, 'task.created');
    });

    it('re-dispatches after an escalated verdict too', async () => {
      withAgentReviewWorkspaceAndWorker();
      mockReadPrReviewStatus.mockResolvedValue({
        state: 'escalated', terminal: true, reviewTaskId: 'review-1', adoptedTaskId: 'task-1',
        verdict: 'escalate', confidence: 0.5, summary: 'unclear', feedback: null,
        escalationReason: 'touches auth boundary', iteration: 1, maxIterations: 3, reviewHeadSha: OLD_SHA,
        prState: 'open', merged: false, mergeBlocked: null,
      } as any);

      const res = await POST(createWebhookRequest('pull_request', makeSynchronizePayload()));

      expect(res.status).toBe(200);
      expect(mockCreateReviewerTask).toHaveBeenCalledTimes(1);
      expect(mockCreateReviewerTask.mock.calls[0][0]).toMatchObject({
        priorVerdict: { headSha: OLD_SHA, verdict: 'escalate' },
      });
    });

    it('does not stack a second reviewer while one is already in flight (single-flight)', async () => {
      withAgentReviewWorkspaceAndWorker();
      mockReadPrReviewStatus.mockResolvedValue({
        state: 'reviewing', terminal: false, reviewTaskId: 'review-1', adoptedTaskId: 'task-1',
        verdict: null, confidence: null, summary: null, feedback: null, escalationReason: null,
        iteration: 1, maxIterations: 3, reviewHeadSha: OLD_SHA,
        prState: 'open', merged: false, mergeBlocked: null,
      } as any);

      const res = await POST(createWebhookRequest('pull_request', makeSynchronizePayload()));

      expect(res.status).toBe(200);
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
    });

    it('does not re-dispatch on an approved verdict — the gate handles a stale approval, not this path', async () => {
      withAgentReviewWorkspaceAndWorker();
      mockReadPrReviewStatus.mockResolvedValue({
        state: 'approved', terminal: true, reviewTaskId: 'review-1', adoptedTaskId: 'task-1',
        verdict: 'approve', confidence: 0.9, summary: 'lgtm', feedback: null, escalationReason: null,
        iteration: 0, maxIterations: 3, reviewHeadSha: OLD_SHA,
        prState: 'open', merged: false, mergeBlocked: null,
      } as any);

      const res = await POST(createWebhookRequest('pull_request', makeSynchronizePayload()));

      expect(res.status).toBe(200);
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
    });

    it('does not re-dispatch when the head has not actually moved past the verdict (duplicate delivery)', async () => {
      withAgentReviewWorkspaceAndWorker();
      withChangesRequestedVerdict(NEW_SHA);

      const res = await POST(createWebhookRequest('pull_request', makeSynchronizePayload()));

      expect(res.status).toBe(200);
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
    });

    it('does not re-dispatch outside agent-review tier', async () => {
      withAgentReviewWorkspaceAndWorker();
      withChangesRequestedVerdict();
      mockResolvePolicy.mockReturnValue({ tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: [] } });

      const res = await POST(createWebhookRequest('pull_request', makeSynchronizePayload()));

      expect(res.status).toBe(200);
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
    });

    it('re-dispatches to a role the workspace has when the policy role does not exist', async () => {
      withAgentReviewWorkspaceAndWorker();
      withChangesRequestedVerdict();
      mockListWorkspaceRoles.mockImplementation(() => Promise.resolve([{ slug: 'builder', isRole: true }]));

      await POST(createWebhookRequest('pull_request', makeSynchronizePayload()));

      expect(mockCreateReviewerTask).toHaveBeenCalledTimes(1);
      expect(mockCreateReviewerTask.mock.calls[0][0]).toMatchObject({ reviewerRole: 'builder' });
    });

    it('does not re-dispatch when the workspace has no roles', async () => {
      withAgentReviewWorkspaceAndWorker();
      withChangesRequestedVerdict();
      mockListWorkspaceRoles.mockImplementation(() => Promise.resolve([]));

      await POST(createWebhookRequest('pull_request', makeSynchronizePayload()));

      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
    });

    it('does not re-dispatch when no review was ever requested for this PR', async () => {
      withAgentReviewWorkspaceAndWorker();
      // Default mock: state 'not_requested'.

      const res = await POST(createWebhookRequest('pull_request', makeSynchronizePayload()));

      expect(res.status).toBe(200);
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
    });
  });
});

// ── Inbound work-tracker: issues → tasks (spec §3) ───────────────────────────
describe('inbound issues → tasks', () => {
  beforeEach(resetAll);

  function issuePayload(action: string, overrides: Record<string, any> = {}) {
    return {
      action,
      issue: {
        id: 555,
        number: 7,
        title: 'Fix the thing',
        body: 'details',
        state: action === 'closed' ? 'closed' : 'open',
        html_url: 'https://github.com/acme/widgets/issues/7',
        labels: overrides.labels ?? [{ name: 'buildd' }],
      },
      repository: { id: 1, full_name: 'acme/widgets' },
      installation: { id: 12345 },
    };
  }

  it('creates a work-tracker-linked task when a github-tracked issue is labeled', async () => {
    mockWorkspacesFindFirst.mockReturnValue({
      id: 'ws1', repo: 'acme/widgets', workTrackerConfig: { provider: 'github' },
    });
    const res = await POST(createWebhookRequest('issues', issuePayload('labeled')));
    expect(res.status).toBe(200);

    const taskInsert = insertCalls.find((c) => c.table === schemaMock.tasks);
    expect(taskInsert).toBeDefined();
    expect(taskInsert!.values.externalId).toBe('issue-555');
    // github tracker → linked so the outbound completion loop can fire on merge
    expect(taskInsert!.values.externalIssueUrl).toBe('https://github.com/acme/widgets/issues/7');
  });

  it('is idempotent — no insert when a task already exists for the issue', async () => {
    mockWorkspacesFindFirst.mockReturnValue({
      id: 'ws1', repo: 'acme/widgets', workTrackerConfig: { provider: 'github' },
    });
    mockTasksFindFirst.mockReturnValue({ id: 'existing' });
    const res = await POST(createWebhookRequest('issues', issuePayload('labeled')));
    expect(res.status).toBe(200);
    expect(insertCalls.find((c) => c.table === schemaMock.tasks)).toBeUndefined();
  });

  it('does not create a task when the trigger label is absent', async () => {
    mockWorkspacesFindFirst.mockReturnValue({
      id: 'ws1', repo: 'acme/widgets', workTrackerConfig: { provider: 'github' },
    });
    const res = await POST(createWebhookRequest('issues', issuePayload('labeled', { labels: [{ name: 'bug' }] })));
    expect(res.status).toBe(200);
    expect(insertCalls.find((c) => c.table === schemaMock.tasks)).toBeUndefined();
  });

  it('honors a custom inbound label from config', async () => {
    mockWorkspacesFindFirst.mockReturnValue({
      id: 'ws1', repo: 'acme/widgets', workTrackerConfig: { provider: 'github', inboundLabel: 'agent' },
    });
    // default 'buildd' label should NOT trigger when a custom label is configured
    const res = await POST(createWebhookRequest('issues', issuePayload('labeled', { labels: [{ name: 'buildd' }] })));
    expect(res.status).toBe(200);
    expect(insertCalls.find((c) => c.table === schemaMock.tasks)).toBeUndefined();
  });

  it('cancels a linked task when its issue is closed', async () => {
    mockWorkspacesFindFirst.mockReturnValue({
      id: 'ws1', repo: 'acme/widgets', workTrackerConfig: { provider: 'github' },
    });
    const res = await POST(createWebhookRequest('issues', issuePayload('closed')));
    expect(res.status).toBe(200);
    const cancel = updateCalls.find((c) => (c.setValues as any).status === 'cancelled' && c.table === schemaMock.tasks);
    expect(cancel).toBeDefined();
  });
});

// ── workflow_run → releases state advancement ────────────────────────────────
describe('workflow_run → releases state advancement', () => {
  beforeEach(resetAll);

  const RUN_URL = 'https://github.com/test-org/test-repo/actions/runs/9999';

  function makeWorkflowRunPayload(conclusion: string | null, overrides: Record<string, any> = {}) {
    return {
      action: 'completed',
      workflow_run: {
        id: 9999,
        name: 'Release',
        status: 'completed',
        conclusion,
        html_url: RUN_URL,
        head_branch: 'dev',
        head_sha: 'sha-dev-head',
        event: 'workflow_dispatch',
        path: '.github/workflows/release.yml',
        repository: { full_name: 'test-org/test-repo' },
        ...overrides.workflow_run,
      },
      installation: { id: 5000 },
    };
  }

  it('advances release to deploying when workflow conclusion=success', async () => {
    selectTableResults = (t) =>
      t === schemaMock.releases
        ? [{ id: 'release-1', workspaceId: 'ws-release', state: 'dispatched' }]
        : null;

    const res = await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('success')));
    expect(res.status).toBe(200);

    const releaseUpdate = updateCalls.find(
      (c) => c.table === schemaMock.releases && (c.setValues as any).state === 'deploying',
    );
    expect(releaseUpdate).toBeDefined();

    const pusherCall = mockTriggerEvent.mock.calls.find(
      ([, event, data]: any[]) => event === 'release:updated' && data?.state === 'deploying',
    );
    expect(pusherCall).toBeDefined();
    expect(pusherCall[0]).toBe('workspace-ws-release');
  });

  it('advances release to failed when workflow conclusion=failure', async () => {
    selectTableResults = (t) =>
      t === schemaMock.releases
        ? [{ id: 'release-2', workspaceId: 'ws-release', state: 'dispatched' }]
        : null;

    const res = await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('failure')));
    expect(res.status).toBe(200);

    const releaseUpdate = updateCalls.find(
      (c) => c.table === schemaMock.releases && (c.setValues as any).state === 'failed',
    );
    expect(releaseUpdate).toBeDefined();

    const pusherCall = mockTriggerEvent.mock.calls.find(
      ([, event, data]: any[]) => event === 'release:updated' && data?.state === 'failed',
    );
    expect(pusherCall).toBeDefined();
  });

  it('no-ops when no release row matches the run_url', async () => {
    selectTableResults = () => null;

    const res = await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('success')));
    expect(res.status).toBe(200);

    const releaseUpdate = updateCalls.find((c) => c.table === schemaMock.releases);
    expect(releaseUpdate).toBeUndefined();
  });

  // This used to assert that `cancelled` left the row untouched. That WAS the
  // behaviour, and it was the bug: only `success` and `failure` were mapped, so
  // a cancelled / timed_out / startup_failure run left its release row in
  // `dispatched` forever — a state no sweeper covered, which also blocked every
  // future non-forced release of that commit.
  it.each(['cancelled', 'timed_out', 'startup_failure', 'skipped'])(
    'marks the release failed when the run concluded %s',
    async (conclusion) => {
      selectTableResults = (t) =>
        t === schemaMock.releases
          ? [{ id: 'release-3', workspaceId: 'ws-release', state: 'dispatched' }]
          : null;

      const res = await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload(conclusion)));
      expect(res.status).toBe(200);

      const releaseUpdate = updateCalls.find(
        (c) => c.table === schemaMock.releases && (c.setValues as any).state === 'failed',
      );
      expect(releaseUpdate).toBeDefined();
      expect(String((releaseUpdate!.setValues as any).failureReason)).toContain(conclusion);
    },
  );

  it('leaves the row alone when the run is not really concluded (action_required)', async () => {
    selectTableResults = (t) =>
      t === schemaMock.releases
        ? [{ id: 'release-3b', workspaceId: 'ws-release', state: 'dispatched' }]
        : null;

    const res = await POST(
      createWebhookRequest('workflow_run', makeWorkflowRunPayload('action_required')),
    );
    expect(res.status).toBe(200);

    // A later event carries the real verdict; recording a failure now would be
    // wrong and terminal.
    const releaseUpdate = updateCalls.find((c) => c.table === schemaMock.releases);
    expect(releaseUpdate).toBeUndefined();
  });

  // ── resolution by head sha ────────────────────────────────────────────────
  //
  // `run_url` alone was a single point of failure. dispatchWorkflowRelease
  // polls ~15s for the run and, when it has not surfaced, stores no url at all
  // — nothing can ever match that row again. It could also store the WRONG url:
  // before 3cb9ea16 the readback could return a run from weeks earlier, whose
  // workflow_run event had long since fired. Production has one row stranded
  // exactly that way.
  it('falls back to the head sha when no row carries this run url, and backfills the url', async () => {
    let releasesQuery = 0;
    selectTableResults = (t) => {
      if (t !== schemaMock.releases) return null;
      releasesQuery++;
      // First query is by run_url and misses; second is the sha fallback.
      return releasesQuery === 1
        ? []
        : [{ id: 'release-stranded', workspaceId: 'ws-release', state: 'dispatched', runUrl: null }];
    };
    mockWorkspacesFindFirst.mockReturnValue({
      id: 'ws-release',
      releaseConfig: { enabled: true, strategy: 'workflow_dispatch', workflowFile: 'release.yml' },
      githubRepo: { fullName: 'test-org/test-repo' },
    });

    const res = await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('success')));
    expect(res.status).toBe(200);

    const releaseUpdate = updateCalls.find(
      (c) => c.table === schemaMock.releases && (c.setValues as any).state === 'deploying',
    );
    expect(releaseUpdate).toBeDefined();
    // The url we should have had at dispatch time.
    expect((releaseUpdate!.setValues as any).runUrl).toBe(RUN_URL);
  });

  // ── R1: only the configured release workflow run may use the sha fallback ─
  //
  // Every workflow in the repo that runs on the release's head sha — CI
  // Auto-Fix, Sync-dev, Build & Test — used to match the fallback. A sibling
  // run's `skipped` recorded a shipped release as failed, and the real Release
  // success that arrived later hit the terminal-state early return and was
  // dropped. A sibling's `success` could equally advance a row before the
  // release had finished.
  describe('sha fallback is restricted to the configured release workflow', () => {
    const RELEASE_WS = {
      id: 'ws-release',
      releaseConfig: { enabled: true, strategy: 'workflow_dispatch', workflowFile: 'release.yml', ref: 'dev' },
      githubRepo: { fullName: 'test-org/test-repo' },
    };

    function releasesByUrlThenSha(byUrl: any[], bySha: any[]) {
      let n = 0;
      selectTableResults = (t) => {
        if (t !== schemaMock.releases) return null;
        n++;
        return n === 1 ? byUrl : bySha;
      };
    }

    it('(a) a sibling workflow skipped on the same sha leaves a row with a recorded run url unchanged', async () => {
      // The row carries its real run url R; the sibling arrives as R2.
      releasesByUrlThenSha([], [{ id: 'rel-a', workspaceId: 'ws-release', state: 'dispatched', runUrl: RUN_URL }]);
      mockWorkspacesFindFirst.mockReturnValue(RELEASE_WS);

      const res = await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('skipped', {
        workflow_run: {
          id: 10001,
          name: 'CI Auto-Fix',
          html_url: 'https://github.com/test-org/test-repo/actions/runs/10001',
          event: 'workflow_run',
          path: '.github/workflows/ci-autofix.yml',
        },
      })));
      expect(res.status).toBe(200);
      expect(updateCalls.find((c) => c.table === schemaMock.releases)).toBeUndefined();
    });

    it('(a2) even a workflow_dispatch run cannot claim a row that already has a run url', async () => {
      releasesByUrlThenSha([], [{ id: 'rel-a2', workspaceId: 'ws-release', state: 'dispatched', runUrl: RUN_URL }]);
      mockWorkspacesFindFirst.mockReturnValue(RELEASE_WS);

      await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('skipped', {
        workflow_run: { id: 10002, html_url: 'https://github.com/test-org/test-repo/actions/runs/10002' },
      })));
      expect(updateCalls.find((c) => c.table === schemaMock.releases)).toBeUndefined();

      // And the predicate itself excludes rows that carry a url.
      const fallback = selectWhereCalls.filter((c) => c.table === schemaMock.releases).at(-1);
      expect(JSON.stringify(fallback?.condition)).toContain('"type":"isNull"');
      expect(JSON.stringify(fallback?.condition)).toContain('runUrl');
    });

    it('(b) a Build & Test push-event success on the same sha leaves the row unchanged', async () => {
      releasesByUrlThenSha([], [{ id: 'rel-b', workspaceId: 'ws-release', state: 'dispatched', runUrl: null }]);
      mockWorkspacesFindFirst.mockReturnValue(RELEASE_WS);

      await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('success', {
        workflow_run: {
          id: 10003,
          name: 'Build & Test',
          html_url: 'https://github.com/test-org/test-repo/actions/runs/10003',
          event: 'push',
          path: '.github/workflows/build.yml',
        },
      })));
      expect(updateCalls.find((c) => c.table === schemaMock.releases)).toBeUndefined();
    });

    it('(b2) a workflow_dispatch run of a different workflow file leaves the row unchanged', async () => {
      releasesByUrlThenSha([], [{ id: 'rel-b2', workspaceId: 'ws-release', state: 'dispatched', runUrl: null }]);
      mockWorkspacesFindFirst.mockReturnValue(RELEASE_WS);

      await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('success', {
        workflow_run: { id: 10004, path: '.github/workflows/pre-release.yml' },
      })));
      expect(updateCalls.find((c) => c.table === schemaMock.releases)).toBeUndefined();
    });

    it('(c) the run matched by its recorded url still advances the row', async () => {
      releasesByUrlThenSha([{ id: 'rel-c', workspaceId: 'ws-release', state: 'dispatched', runUrl: RUN_URL }], []);

      await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('success')));
      const upd = updateCalls.find((c) => c.table === schemaMock.releases);
      expect((upd?.setValues as any)?.state).toBe('deploying');
    });

    it('(d) a null-url row matches the release workflow_dispatch run and backfills its url', async () => {
      releasesByUrlThenSha([], [{ id: 'rel-d', workspaceId: 'ws-release', state: 'dispatched', runUrl: null, archetype: 'gated' }]);
      mockWorkspacesFindFirst.mockReturnValue(RELEASE_WS);

      await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('success')));
      const upd = updateCalls.find((c) => c.table === schemaMock.releases);
      expect((upd?.setValues as any)?.state).toBe('pending_external');
      expect((upd?.setValues as any)?.runUrl).toBe(RUN_URL);
    });

    it('(e) the same sha from a different repository is a no-op', async () => {
      releasesByUrlThenSha([], [{ id: 'rel-e', workspaceId: 'ws-release', state: 'dispatched', runUrl: null }]);
      mockWorkspacesFindFirst.mockReturnValue(RELEASE_WS);

      await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('success', {
        workflow_run: { repository: { full_name: 'someone-else/fork' } },
      })));
      expect(updateCalls.find((c) => c.table === schemaMock.releases)).toBeUndefined();
    });

    it('(e2) a workspace with no configured workflow file cannot be matched by sha', async () => {
      releasesByUrlThenSha([], [{ id: 'rel-e2', workspaceId: 'ws-release', state: 'dispatched', runUrl: null }]);
      mockWorkspacesFindFirst.mockReturnValue({ ...RELEASE_WS, releaseConfig: { enabled: true } });

      await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('success')));
      expect(updateCalls.find((c) => c.table === schemaMock.releases)).toBeUndefined();
    });

    it('(f) a url-matched skipped release run still fails the row', async () => {
      releasesByUrlThenSha([{ id: 'rel-f', workspaceId: 'ws-release', state: 'dispatched', runUrl: RUN_URL }], []);

      await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('skipped')));
      const upd = updateCalls.find((c) => c.table === schemaMock.releases);
      expect((upd?.setValues as any)?.state).toBe('failed');
    });

    it('does not run the sha query at all for a non-dispatch run (hot path)', async () => {
      releasesByUrlThenSha([], []);
      await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('success', {
        workflow_run: { event: 'pull_request', path: '.github/workflows/build.yml' },
      })));
      expect(selectWhereCalls.filter((c) => c.table === schemaMock.releases)).toHaveLength(1);
    });
  });

  it('scopes the sha fallback to in-flight rows, by sha', async () => {
    // The mock ignores WHERE clauses, so the predicate is the only proof the
    // fallback cannot resurrect a terminal release or match another commit.
    let releasesQuery = 0;
    selectTableResults = (t) => {
      if (t !== schemaMock.releases) return null;
      releasesQuery++;
      return releasesQuery === 1 ? [] : [];
    };

    await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('success')));

    const fallback = selectWhereCalls.filter(c => c.table === schemaMock.releases).at(-1);
    const flat = JSON.stringify(fallback?.condition);
    expect(flat).toContain('sha-dev-head');
    expect(flat).toContain('headSha');
    expect(flat).toContain('dispatched');
    expect(flat).toContain('deploying');
  });

  it('does not overwrite a run url that is already recorded', async () => {
    let releasesQuery = 0;
    selectTableResults = (t) => {
      if (t !== schemaMock.releases) return null;
      releasesQuery++;
      return releasesQuery === 1
        ? [{ id: 'release-5', workspaceId: 'ws-release', state: 'dispatched', runUrl: RUN_URL }]
        : [];
    };

    await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('success')));

    const releaseUpdate = updateCalls.find(
      (c) => c.table === schemaMock.releases && (c.setValues as any).state === 'deploying',
    );
    expect(releaseUpdate).toBeDefined();
    expect((releaseUpdate!.setValues as any).runUrl).toBeUndefined();
  });

  it('does not regress a release already in healthy state', async () => {
    selectTableResults = (t) =>
      t === schemaMock.releases
        ? [{ id: 'release-4', workspaceId: 'ws-release', state: 'healthy' }]
        : null;

    const res = await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('failure')));
    expect(res.status).toBe(200);

    const releaseUpdate = updateCalls.find((c) => c.table === schemaMock.releases);
    expect(releaseUpdate).toBeUndefined();
  });

  // ── contradictory second delivery for the identical run ──────────────────
  //
  // GitHub can send two `workflow_run.completed` events for the same run with
  // different conclusions — observed live for a release job that calls out to
  // a reusable workflow via `uses:`. The first (success) legitimately advances
  // dispatched → deploying; a second, disagreeing delivery for the SAME run
  // must not be trusted verbatim, since 'deploying' isn't a terminal state a
  // regression guard already covers.

  it('ignores a conflicting second delivery for an already-resolved run when the live run is still success', async () => {
    selectTableResults = (t) =>
      t === schemaMock.releases
        ? [{ id: 'release-6', workspaceId: 'ws-release', state: 'deploying', runUrl: RUN_URL }]
        : null;
    mockGithubApi.mockReturnValue(Promise.resolve({ conclusion: 'success' }));

    const res = await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('skipped')));
    expect(res.status).toBe(200);

    const releaseUpdate = updateCalls.find((c) => c.table === schemaMock.releases);
    expect(releaseUpdate).toBeUndefined();

    const liveCheck = (mockGithubApi.mock.calls as any[]).find(([, url]) =>
      String(url).includes('/actions/runs/9999'),
    );
    expect(liveCheck).toBeDefined();
  });

  it('ignores a conflicting second delivery when the live refetch is unavailable', async () => {
    selectTableResults = (t) =>
      t === schemaMock.releases
        ? [{ id: 'release-6b', workspaceId: 'ws-release', state: 'deploying', runUrl: RUN_URL }]
        : null;
    mockGithubApi.mockImplementation(() => Promise.reject(new Error('GitHub API error: 500')));

    const res = await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('skipped')));
    expect(res.status).toBe(200);

    const releaseUpdate = updateCalls.find((c) => c.table === schemaMock.releases);
    expect(releaseUpdate).toBeUndefined();
  });

  it('still marks the release failed when the live refetch confirms the run actually failed', async () => {
    selectTableResults = (t) =>
      t === schemaMock.releases
        ? [{ id: 'release-7', workspaceId: 'ws-release', state: 'deploying', runUrl: RUN_URL }]
        : null;
    mockGithubApi.mockReturnValue(Promise.resolve({ conclusion: 'failure' }));

    const res = await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('skipped')));
    expect(res.status).toBe(200);

    const releaseUpdate = updateCalls.find(
      (c) => c.table === schemaMock.releases && (c.setValues as any).state === 'failed',
    );
    expect(releaseUpdate).toBeDefined();
  });

  it('does not need a live check when the row is still dispatched (first-ever delivery for this run)', async () => {
    selectTableResults = (t) =>
      t === schemaMock.releases
        ? [{ id: 'release-8', workspaceId: 'ws-release', state: 'dispatched', runUrl: RUN_URL }]
        : null;

    const res = await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('failure')));
    expect(res.status).toBe(200);

    // No live refetch — the row hasn't been resolved by a prior delivery yet,
    // so the payload's own conclusion is trusted as it always was.
    const liveCheck = (mockGithubApi.mock.calls as any[]).find(([, url]) =>
      String(url).includes('/actions/runs/9999'),
    );
    expect(liveCheck).toBeUndefined();

    const releaseUpdate = updateCalls.find(
      (c) => c.table === schemaMock.releases && (c.setValues as any).state === 'failed',
    );
    expect(releaseUpdate).toBeDefined();
  });

  // ── gated archetype: a successful dispatch only opened the release PR ────
  //
  // See apps/web/src/lib/release-executor.ts's advanceGatedReleaseOnPrMerge —
  // the release PR merging into prodBranch is the real deploy signal for a
  // gated workspace, not the workflow_dispatch run succeeding.

  it('does not mark a gated release deploying on dispatch success — moves to pending_external instead', async () => {
    selectTableResults = (t) =>
      t === schemaMock.releases
        ? [{ id: 'release-gated-1', workspaceId: 'ws-release', state: 'dispatched', archetype: 'gated' }]
        : null;

    const res = await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('success')));
    expect(res.status).toBe(200);

    const releaseUpdate = updateCalls.find((c) => c.table === schemaMock.releases);
    expect(releaseUpdate).toBeDefined();
    expect((releaseUpdate!.setValues as any).state).toBe('pending_external');
    expect((releaseUpdate!.setValues as any).deployedAt).toBeUndefined();

    const pusherCall = mockTriggerEvent.mock.calls.find(
      ([, event, data]: any[]) => event === 'release:updated' && data?.state === 'pending_external',
    );
    expect(pusherCall).toBeDefined();
  });

  it('a late dispatch success never moves a gated row the release-PR merge already advanced back to pending_external', async () => {
    selectTableResults = (t) =>
      t === schemaMock.releases
        ? [{ id: 'release-gated-2', workspaceId: 'ws-release', state: 'deploying', archetype: 'gated', runUrl: RUN_URL }]
        : null;

    const res = await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('success')));
    expect(res.status).toBe(200);
    expect(updateCalls.find((c) => c.table === schemaMock.releases)).toBeUndefined();
  });

  it('a late dispatch failure never overwrites a gated row the release-PR merge already advanced', async () => {
    // The merge is the gated deploy signal; once it moved the row to
    // `deploying`, no later conclusion of the dispatch run describes it.
    selectTableResults = (t) =>
      t === schemaMock.releases
        ? [{ id: 'release-gated-4', workspaceId: 'ws-release', state: 'deploying', archetype: 'gated', runUrl: RUN_URL }]
        : null;
    // Even when GitHub's live view of the dispatch run agrees it failed.
    mockGithubApi.mockReturnValue(Promise.resolve({ conclusion: 'failure' }));

    const res = await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('failure')));
    expect(res.status).toBe(200);
    expect(updateCalls.find((c) => c.table === schemaMock.releases)).toBeUndefined();
  });

  it('still marks a non-gated (continuous) release deploying on dispatch success — unaffected', async () => {
    selectTableResults = (t) =>
      t === schemaMock.releases
        ? [{ id: 'release-cont-1', workspaceId: 'ws-release', state: 'dispatched', archetype: 'continuous' }]
        : null;

    const res = await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('success')));
    expect(res.status).toBe(200);

    const releaseUpdate = updateCalls.find((c) => c.table === schemaMock.releases);
    expect(releaseUpdate).toBeDefined();
    expect((releaseUpdate!.setValues as any).state).toBe('deploying');
    expect((releaseUpdate!.setValues as any).deployedAt).toBeDefined();
  });

  it('still marks a gated release failed on dispatch failure — unaffected', async () => {
    selectTableResults = (t) =>
      t === schemaMock.releases
        ? [{ id: 'release-gated-3', workspaceId: 'ws-release', state: 'dispatched', archetype: 'gated' }]
        : null;

    const res = await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('failure')));
    expect(res.status).toBe(200);

    const releaseUpdate = updateCalls.find((c) => c.table === schemaMock.releases);
    expect(releaseUpdate).toBeDefined();
    expect((releaseUpdate!.setValues as any).state).toBe('failed');
  });

  // ── the runId lookup ──────────────────────────────────────────────────────
  //
  // This lookup runs on EVERY completed workflow_run — every CI workflow on
  // every push, not just release runs — so its SQL is on a hot path shared
  // with the whole repo's CI volume.

  it('still fails the release task on a non-failure, non-success conclusion', async () => {
    // Guard against "optimising" this handler by filtering conclusions before
    // the task lookup: buildWorkflowRunOutcome treats anything other than
    // success as failed, so a CANCELLED or TIMED_OUT release run must still
    // mark the task failed and alert. Only the releases-row advancement is
    // restricted to success/failure.
    selectTableResults = (t) =>
      t === schemaMock.tasks
        ? [{ id: 'task-rel-1', releaseResult: { status: 'pending_ci', message: '' }, missionId: null, workspaceId: 'ws-release' }]
        : null;

    const res = await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('cancelled')));
    expect(res.status).toBe(200);

    const taskUpdate = updateCalls.find((c) => c.table === schemaMock.tasks);
    expect(taskUpdate).toBeDefined();
    expect((taskUpdate!.setValues as any).releaseResult.status).toBe('failed');
    // A release failure is the owning team's alert, routed by the task, never
    // the operator's own phone.
    expect(mockNotifyTeamOf).toHaveBeenCalledTimes(1);
    const [subject, event, payload] = mockNotifyTeamOf.mock.calls[0] as any[];
    expect(subject).toEqual({ taskId: 'task-rel-1' });
    expect(event).toBe('needsAttention');
    expect(payload.title).toContain('Release workflow failed');
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('matches runId as text and skips rows with no release_result', async () => {
    selectTableResults = () => null;
    await POST(createWebhookRequest('workflow_run', makeWorkflowRunPayload('success')));

    const lookup = selectWhereCalls.find((c) => c.table === schemaMock.tasks);
    expect(lookup, 'no select against tasks was captured').toBeDefined();
    const raw = (lookup!.condition.strings as string[]).join('?');

    // No ::bigint cast. The cast is evaluated per row during the scan, so a
    // single task whose release_result->>'runId' is not numeric raises 22P02
    // and every workflow_run delivery 500s — which GitHub then retries.
    expect(raw).not.toContain('::bigint');

    // IS NOT NULL is what lets the planner use the partial index
    // tasks_release_run_id_idx (indexed WHERE release_result IS NOT NULL);
    // without it the predicate cannot be proven to exclude NULL rows.
    expect(raw).toContain('IS NOT NULL');

    // Compared as text, so the parameter must be the id stringified.
    expect(lookup!.condition.values).toContain('9999');
  });
});


// ── pull_request_review (B14) ────────────────────────────────────────────────
//
// The event was absent from the switch entirely, so a maintainer clicking
// Approve in GitHub's UI produced no state in buildd: nothing in the mission
// feed, and no answer to "who cleared this?". The handler is deliberately
// record-only — see its docstring for why merge behaviour is untouched.

describe('POST /api/github/webhook — pull_request_review', () => {
  beforeEach(resetAll);

  function reviewPayload(state: string, overrides: Record<string, any> = {}) {
    return {
      action: 'submitted',
      review: {
        state,
        body: 'Looks right to me.',
        user: { login: 'a-maintainer' },
        ...overrides,
      },
      pull_request: { number: 42, html_url: 'https://github.com/test-org/test-repo/pull/42' },
      repository: { full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };
  }

  function workerOnMission() {
    mockWorkersFindFirst.mockReturnValue({
      id: 'w-42',
      taskId: 't-42',
      task: { id: 't-42', title: 'Add pagination', missionId: 'mission-9' },
    });
  }

  it('records an approval as a reviewer_approved mission note', async () => {
    workerOnMission();

    const res = await POST(createWebhookRequest('pull_request_review', reviewPayload('approved')));

    expect(res.status).toBe(200);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].values).toMatchObject({
      missionId: 'mission-9',
      taskId: 't-42',
      workerId: 'w-42',
      // A person acting in GitHub, not a worker inside a task.
      authorType: 'user',
      type: 'reviewer_approved',
      body: 'Looks right to me.',
    });
    expect(insertCalls[0].values.title).toContain('#42');
    expect(insertCalls[0].values.actorLabel).toContain('a-maintainer');
  });

  it('records changes_requested distinctly from an approval', async () => {
    workerOnMission();

    await POST(createWebhookRequest('pull_request_review', reviewPayload('changes_requested')));

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].values.type).toBe('reviewer_request_changes');
  });

  it('ignores a bare comment — a remark is not a verdict', async () => {
    workerOnMission();

    const res = await POST(createWebhookRequest('pull_request_review', reviewPayload('commented')));

    expect(res.status).toBe(200);
    expect(insertCalls).toHaveLength(0);
  });

  it('ignores non-submitted actions', async () => {
    workerOnMission();

    const payload = { ...reviewPayload('approved'), action: 'dismissed' };
    await POST(createWebhookRequest('pull_request_review', payload));

    expect(insertCalls).toHaveLength(0);
  });

  it('does nothing when the PR does not belong to a mission task', async () => {
    mockWorkersFindFirst.mockReturnValue({
      id: 'w-42',
      taskId: 't-42',
      task: { id: 't-42', title: 'Standalone', missionId: null },
    });

    const res = await POST(createWebhookRequest('pull_request_review', reviewPayload('approved')));

    expect(res.status).toBe(200);
    expect(insertCalls).toHaveLength(0);
  });

  it('does not merge, complete a task, or clear a review gate', async () => {
    // The safety property. Whether a GitHub approval should satisfy buildd's
    // `agent-review` gate is an open policy question; deciding it as a side
    // effect here would silently change when things merge.
    workerOnMission();

    await POST(createWebhookRequest('pull_request_review', reviewPayload('approved')));

    expect(mockTryAutoMergeWorkerPr).not.toHaveBeenCalled();
    expect(updateCalls.filter(c => c.setValues?.status === 'completed')).toHaveLength(0);
  });

  it('survives a malformed payload without throwing', async () => {
    const res = await POST(createWebhookRequest('pull_request_review', { action: 'submitted' }));

    expect(res.status).toBe(200);
    expect(insertCalls).toHaveLength(0);
  });
});

// ── prBaseRef sync on pull_request events (Option A' — mission integration
// branches) ─────────────────────────────────────────────────────────────────
// The load-bearing case is `edited` + changes.base — a RETARGET. No other branch
// in handlePullRequestEvent handles that action, so without this sync a PR moved
// between trunk and a mission integration branch would keep resolving its merge
// policy against a stale base and either lose or keep a human gate wrongly.
describe('pull_request → workers.prBaseRef sync', () => {
  beforeEach(resetAll);

  function makeRetargetPayload(overrides: Record<string, any> = {}) {
    return {
      action: 'edited',
      changes: { base: { ref: { from: 'dev' } } },
      pull_request: {
        number: 9,
        merged: false,
        draft: false,
        head: { ref: 'buildd/abc12345-fix', sha: 'sha-9', repo: { full_name: 'test-org/test-repo' } },
        base: { ref: 'mission/example-slug-0a1b2c3d' },
        html_url: 'https://github.com/test-org/test-repo/pull/9',
      },
      installation: { id: 12345 },
      repository: { full_name: 'test-org/test-repo' },
      ...overrides,
    };
  }

  it('records the new base ref when a PR is retargeted', async () => {
    await POST(createWebhookRequest('pull_request', makeRetargetPayload()));

    const baseRefWrites = updateCalls.filter(c => 'prBaseRef' in (c.setValues ?? {}));
    expect(baseRefWrites.length).toBe(1);
    expect(baseRefWrites[0].setValues.prBaseRef).toBe('mission/example-slug-0a1b2c3d');
  });

  it('records the base ref on PR open too, not just retarget', async () => {
    await POST(createWebhookRequest('pull_request', makeRetargetPayload({
      action: 'opened',
      changes: undefined,
    })));

    const baseRefWrites = updateCalls.filter(c => 'prBaseRef' in (c.setValues ?? {}) && !('prUrl' in (c.setValues ?? {})));
    expect(baseRefWrites.length).toBe(1);
    expect(baseRefWrites[0].setValues.prBaseRef).toBe('mission/example-slug-0a1b2c3d');
  });

  it('registers an externally opened PR on the matching worker before processing it', async () => {
    await POST(createWebhookRequest('pull_request', makeRetargetPayload({ action: 'opened', changes: undefined })));
    const adopted = updateCalls.find(c => c.setValues?.prUrl);
    expect(adopted?.setValues).toMatchObject({ prNumber: 9, prBaseRef: 'mission/example-slug-0a1b2c3d' });
    expect(adopted?.condition).toBeDefined();
    // The open state is a fact for the funnel, on exactly the rows the CAS bound.
    expect(adopted?.setValues).not.toHaveProperty('prLifecycleStatus');
    expect(recordedFacts).toContainEqual({ target: { workerIds: ['row-1'] }, fact: { kind: 'open' }, opts: undefined });
  });

  it.each(['test-org/fork', null])('does not adopt a PR from a fork or deleted head repo (%s)', async headRepo => {
    const payload = makeRetargetPayload({ action: 'opened', changes: undefined });
    await POST(createWebhookRequest('pull_request', {
      ...payload,
      pull_request: { ...payload.pull_request, head: {
        ...payload.pull_request.head, repo: headRepo ? { full_name: headRepo } : null,
      } },
    }));
    expect(updateCalls.find(c => c.setValues?.prUrl)).toBeUndefined();
  });

  // Change intents recorded at create_pr carry the base the PR had then. A
  // retarget must move them, or surface ordering on the new base cannot see
  // this PR and the old base's lane keeps waiting on it.
  it('moves the PR\'s change intents to the new base on a retarget', async () => {
    mockWorkersFindFirst.mockReturnValue({ id: 'w-9', workspaceId: 'ws-9', taskId: 't-9', prBaseRef: 'dev', task: null });
    await POST(createWebhookRequest('pull_request', makeRetargetPayload()));

    expect(mockRetargetSurfaceIntents).toHaveBeenCalledTimes(1);
    expect(mockRetargetSurfaceIntents.mock.calls[0][0]).toEqual({
      workspaceId: 'ws-9', prNumber: 9, fromBase: 'dev', toBase: 'mission/example-slug-0a1b2c3d',
    });
  });

  it('moves intents even when the worker row already had the new base (no prBaseRef write)', async () => {
    mockWorkersFindFirst.mockReturnValue({ id: 'w-9', workspaceId: 'ws-9', taskId: 't-9', prBaseRef: 'mission/example-slug-0a1b2c3d', task: null });
    await POST(createWebhookRequest('pull_request', makeRetargetPayload()));
    expect(mockRetargetSurfaceIntents).toHaveBeenCalledTimes(1);
  });

  it('does not touch intents on an edit that did not change the base (title/body edit)', async () => {
    mockWorkersFindFirst.mockReturnValue({ id: 'w-9', workspaceId: 'ws-9', taskId: 't-9', prBaseRef: 'dev', task: null });
    await POST(createWebhookRequest('pull_request', makeRetargetPayload({ changes: { title: { from: 'old' } } })));
    expect(mockRetargetSurfaceIntents).not.toHaveBeenCalled();
  });

  it('does not touch intents on a non-edited action', async () => {
    mockWorkersFindFirst.mockReturnValue({ id: 'w-9', workspaceId: 'ws-9', taskId: 't-9', prBaseRef: 'dev', task: null });
    await POST(createWebhookRequest('pull_request', makeRetargetPayload({ action: 'synchronize' })));
    expect(mockRetargetSurfaceIntents).not.toHaveBeenCalled();
  });

  it('does not touch intents when no buildd worker owns the PR (no workspace to scope to)', async () => {
    mockWorkersFindFirst.mockReturnValue(null);
    await POST(createWebhookRequest('pull_request', makeRetargetPayload()));
    expect(mockRetargetSurfaceIntents).not.toHaveBeenCalled();
  });

  // 24e1cfad: the kernel's base-change fact. A retarget changes the diff an approval reviewed.
  it('hands a retarget to the workflow kernel (T29 base fact from a live read)', async () => {
    mockObserveBase.mockClear();
    mockWorkersFindFirst.mockReturnValue({ id: 'w-9', workspaceId: 'ws-9', taskId: 't-9', prBaseRef: 'dev', task: null });
    await POST(createWebhookRequest('pull_request', makeRetargetPayload()));
    expect(mockObserveBase).toHaveBeenCalledTimes(1);
    expect(mockObserveBase.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws-9', repoFullName: 'test-org/test-repo', prNumber: 9, installationId: 12345, hintedFromBase: 'dev', source: 'webhook:edited',
    });
  });

  it('does not hand a title/body edit to the kernel', async () => {
    mockObserveBase.mockClear();
    mockWorkersFindFirst.mockReturnValue({ id: 'w-9', workspaceId: 'ws-9', taskId: 't-9', prBaseRef: 'dev', task: null });
    await POST(createWebhookRequest('pull_request', makeRetargetPayload({ changes: { title: { from: 'old' } } })));
    expect(mockObserveBase).not.toHaveBeenCalled();
  });

  it('a failed intent retarget never fails the webhook', async () => {
    mockWorkersFindFirst.mockReturnValue({ id: 'w-9', workspaceId: 'ws-9', taskId: 't-9', prBaseRef: 'dev', task: null });
    mockRetargetSurfaceIntents.mockImplementationOnce(async () => { throw new Error('boom'); });
    const res = await POST(createWebhookRequest('pull_request', makeRetargetPayload()));
    expect(res.status).toBe(200);
  });

  it('writes nothing when the payload carries no base ref', async () => {
    const payload = makeRetargetPayload();
    delete (payload.pull_request as any).base;
    await POST(createWebhookRequest('pull_request', payload));

    const baseRefWrites = updateCalls.filter(c => 'prBaseRef' in (c.setValues ?? {}));
    expect(baseRefWrites.length).toBe(0);
  });
});

// ── P2b: a task PR retargeted OFF its mission's integration branch has lost
// its review gate — a loud event (mission note + notification), not absorbed.
describe('pull_request retarget off the mission integration branch (P2b)', () => {
  beforeEach(resetAll);

  const INTEGRATION_BRANCH = 'mission/example-slug-0a1b2c3d';

  function retargetOffPayload(overrides: Record<string, any> = {}) {
    return {
      action: 'edited',
      changes: { base: { ref: { from: INTEGRATION_BRANCH } } },
      pull_request: {
        number: 9,
        merged: false,
        draft: false,
        head: { ref: 'buildd/abc12345-fix', sha: 'sha-9' },
        base: { ref: 'dev' },
        html_url: 'https://github.com/test-org/test-repo/pull/9',
      },
      installation: { id: 12345 },
      repository: { full_name: 'test-org/test-repo' },
      ...overrides,
    };
  }

  function taskWorker(overrides: Record<string, any> = {}) {
    return {
      id: 'w-1', workspaceId: 'ws-1', taskId: 't-1', prBaseRef: INTEGRATION_BRANCH,
      task: { id: 't-1', title: 'Do thing', taskClass: 'work', missionId: 'mission-1', context: null },
      ...overrides,
    };
  }

  function optedInMission(overrides: Record<string, any> = {}) {
    mockMissionsFindFirst.mockReturnValue({
      workingBranch: INTEGRATION_BRANCH, integrationBranchEnabled: true, ...overrides,
    });
  }

  it('reports loudly when a task PR is retargeted off the integration branch', async () => {
    mockWorkersFindFirst.mockReturnValue(taskWorker());
    optedInMission();

    await POST(createWebhookRequest('pull_request', retargetOffPayload()));

    const noteInserts = insertCalls.filter(c => c.values?.type === 'warning');
    expect(noteInserts.length).toBe(1);
    expect(noteInserts[0].values.missionId).toBe('mission-1');
    expect(noteInserts[0].values.body).toContain(INTEGRATION_BRANCH);
    expect(noteInserts[0].values.body).toContain('dev');
    expect(mockNotifyMissionPrReady).toHaveBeenCalledTimes(1);
    expect((mockNotifyMissionPrReady.mock.calls[0] as any[])[1].reason).toBe('base_retargeted');
  });

  it('does not report when the retarget is not off the integration branch (moving ONTO it)', async () => {
    // The complementary case already covered by the plain prBaseRef-sync
    // suite — asserted here too so this describe is self-contained about
    // what does NOT fire.
    mockWorkersFindFirst.mockReturnValue(taskWorker({ prBaseRef: 'dev' }));
    optedInMission();

    await POST(createWebhookRequest('pull_request', retargetOffPayload({
      changes: { base: { ref: { from: 'dev' } } },
      pull_request: { ...retargetOffPayload().pull_request, base: { ref: INTEGRATION_BRANCH } },
    })));

    expect(insertCalls.filter(c => c.values?.type === 'warning').length).toBe(0);
    expect(mockNotifyMissionPrReady).not.toHaveBeenCalled();
  });

  it('does not report for the mission PR itself', async () => {
    mockWorkersFindFirst.mockReturnValue(taskWorker({
      task: { id: 't-own', title: `${MISSION_PR_TASK_PREFIX}Checkout arc`, taskClass: 'bookkeeping', missionId: 'mission-1', context: null },
    }));
    optedInMission();

    await POST(createWebhookRequest('pull_request', retargetOffPayload()));

    expect(insertCalls.filter(c => c.values?.type === 'warning').length).toBe(0);
    expect(mockNotifyMissionPrReady).not.toHaveBeenCalled();
  });

  it('does not report for a stacked-plan phase — its base was never the integration branch', async () => {
    const predecessorId = '9f8e7d6c-1111-2222-3333-444444444444';
    const predecessorBranch = `buildd/${predecessorId.slice(0, 8)}-earlier-thing`;
    mockWorkersFindFirst.mockReturnValue(taskWorker({
      prBaseRef: predecessorBranch,
      task: {
        id: 't-2',
        title: 'Second phase',
        taskClass: 'work',
        missionId: 'mission-1',
        context: { baseBranch: predecessorBranch },
        dependsOn: [predecessorId],
      },
    }));
    optedInMission();

    await POST(createWebhookRequest('pull_request', retargetOffPayload({
      changes: { base: { ref: { from: predecessorBranch } } },
      pull_request: { ...retargetOffPayload().pull_request, base: { ref: 'dev' } },
    })));

    expect(insertCalls.filter(c => c.values?.type === 'warning').length).toBe(0);
    expect(mockNotifyMissionPrReady).not.toHaveBeenCalled();
  });

  it('does not report when the mission has no integration base', async () => {
    mockWorkersFindFirst.mockReturnValue(taskWorker());
    optedInMission({ integrationBranchEnabled: false });

    await POST(createWebhookRequest('pull_request', retargetOffPayload()));

    expect(insertCalls.filter(c => c.values?.type === 'warning').length).toBe(0);
    expect(mockNotifyMissionPrReady).not.toHaveBeenCalled();
  });

  it('does not report for a task with no mission', async () => {
    mockWorkersFindFirst.mockReturnValue(taskWorker({
      task: { id: 't-1', title: 'Do thing', taskClass: 'work', missionId: null, context: null },
    }));

    await POST(createWebhookRequest('pull_request', retargetOffPayload()));

    expect(insertCalls.filter(c => c.values?.type === 'warning').length).toBe(0);
    expect(mockNotifyMissionPrReady).not.toHaveBeenCalled();
  });

  // ── The webhook's form of "refused" ────────────────────────────────────
  //
  // A webhook cannot 400 at anyone, so enforcement here is putting the base
  // back. Reporting is what is left when it cannot — which is the production
  // shape, where the integration branch was deleted and there is nothing to
  // restore to.
  it('restores the base to the integration branch instead of only reporting', async () => {
    mockWorkersFindFirst.mockReturnValue(taskWorker());
    optedInMission();

    await POST(createWebhookRequest('pull_request', retargetOffPayload()));

    const patchCall = (mockGithubApi.mock.calls as any[]).find(
      c => c[1] === '/repos/test-org/test-repo/pulls/9' && c[2]?.method === 'PATCH',
    );
    expect(patchCall).toBeDefined();
    expect(JSON.parse(patchCall[2].body)).toEqual({ base: INTEGRATION_BRANCH });
    // Still announced — a silent repair hides that something opened a mission
    // task PR on trunk in the first place.
    const noteInserts = insertCalls.filter(c => c.values?.type === 'warning');
    expect(noteInserts.length).toBe(1);
    expect(noteInserts[0].values.body).toContain('retargeted it back');
    // Put straight back: the intents never left the integration branch's lane.
    expect(mockRetargetSurfaceIntents).not.toHaveBeenCalled();
  });

  it('when the base cannot be restored, the intents follow the PR to trunk', async () => {
    mockWorkersFindFirst.mockReturnValue(taskWorker());
    optedInMission();
    mockGithubApi.mockImplementation((_id: number, _path: string, init?: any) => {
      if (init?.method === 'PATCH') return Promise.reject(new Error('422 Unprocessable Entity'));
      return Promise.resolve({});
    });

    await POST(createWebhookRequest('pull_request', retargetOffPayload()));

    expect(mockRetargetSurfaceIntents).toHaveBeenCalledTimes(1);
    expect(mockRetargetSurfaceIntents.mock.calls[0][0]).toEqual({
      workspaceId: 'ws-1', prNumber: 9, fromBase: INTEGRATION_BRANCH, toBase: 'dev',
    });
  });

  it('falls back to the lost-gate report when the base cannot be restored', async () => {
    mockWorkersFindFirst.mockReturnValue(taskWorker());
    optedInMission();
    mockGithubApi.mockImplementation((_id: number, path: string, init?: any) => {
      if (init?.method === 'PATCH') return Promise.reject(new Error('422 Unprocessable Entity'));
      return Promise.resolve({});
    });

    await POST(createWebhookRequest('pull_request', retargetOffPayload()));

    const noteInserts = insertCalls.filter(c => c.values?.type === 'warning');
    expect(noteInserts.length).toBe(1);
    expect(noteInserts[0].values.body).toContain('could not restore');
    expect(noteInserts[0].values.body).toContain('lost its mission review');
  });

  // The shape that let two task PRs reach trunk: they were NEVER on the
  // integration branch, so a detector keyed on "moved off a known-good base"
  // saw nothing. What matters is where the PR points now.
  it('acts on a PR that was never recorded on the integration branch (prBaseRef null)', async () => {
    mockWorkersFindFirst.mockReturnValue(taskWorker({ prBaseRef: null }));
    optedInMission();

    await POST(createWebhookRequest('pull_request', retargetOffPayload({
      action: 'opened',
      changes: undefined,
    })));

    const patchCall = (mockGithubApi.mock.calls as any[]).find(
      c => c[1] === '/repos/test-org/test-repo/pulls/9' && c[2]?.method === 'PATCH',
    );
    expect(patchCall).toBeDefined();
    expect(insertCalls.filter(c => c.values?.type === 'warning').length).toBe(1);
  });

  it('does not touch a PR whose head IS the integration branch — head cannot equal base', async () => {
    mockWorkersFindFirst.mockReturnValue(taskWorker({ prBaseRef: null }));
    optedInMission();

    await POST(createWebhookRequest('pull_request', retargetOffPayload({
      pull_request: {
        ...retargetOffPayload().pull_request,
        head: { ref: INTEGRATION_BRANCH, sha: 'sha-9' },
      },
    })));

    const patchCall = (mockGithubApi.mock.calls as any[]).find(
      c => c[1] === '/repos/test-org/test-repo/pulls/9' && c[2]?.method === 'PATCH',
    );
    expect(patchCall).toBeUndefined();
    // Still reported: that shape is its own violation.
    expect(insertCalls.filter(c => c.values?.type === 'warning').length).toBe(1);
  });

  it('does not act on a PR that has already merged', async () => {
    mockWorkersFindFirst.mockReturnValue(taskWorker());
    optedInMission();

    await POST(createWebhookRequest('pull_request', retargetOffPayload({
      action: 'closed',
      pull_request: { ...retargetOffPayload().pull_request, merged: true },
    })));

    expect(insertCalls.filter(c => c.values?.type === 'warning').length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Merging the mission PR on GitHub must fire the same post-merge effects as
// merging it from the dashboard.
//
// The post-merge block was gated on `worker.task.status !== 'completed'`. The
// bookkeeping task that owns a mission PR is created ALREADY completed — nothing
// should ever claim it — so when the mission PR itself merged, the whole block
// was skipped: no `merged` dependency signal, no Path-B release trigger. A
// downstream mission with gateCondition 'merged' then waited forever, but only
// when the human clicked Merge on GitHub rather than in buildd (the dashboard
// merge route fires the signal itself, which is why this was easy to miss).
// ─────────────────────────────────────────────────────────────────────────────
describe('pull_request merged — effects that belong to the merge, not the transition', () => {
  beforeEach(resetAll);

  function mergedPrPayload(overrides: Record<string, any> = {}) {
    return {
      action: 'closed',
      pull_request: {
        number: 77,
        merged: true,
        draft: false,
        head: { ref: 'mission/example-slug-0a1b2c3d', sha: 'sha-77' },
        base: { ref: 'main' },
        html_url: 'https://github.com/test-org/test-repo/pull/77',
        ...overrides.pull_request,
      },
      repository: { full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };
  }

  /**
   * The worker row that owns a mission integration PR: a bookkeeping task that
   * was `completed` the moment it was created, and a PR nobody has merged yet.
   */
  function missionPrWorker(overrides: Record<string, any> = {}) {
    return {
      id: 'w-mission-pr',
      workspaceId: 'ws1',
      taskId: 't-mission-pr',
      prNumber: 77,
      mergedAt: null,
      task: {
        id: 't-mission-pr',
        status: 'completed',
        taskClass: 'bookkeeping',
        workspaceId: 'ws1',
        release: 'false',
        title: 'Ship mission: Example',
        missionId: 'm1',
      },
      ...overrides,
    };
  }

  it('fires the merged dependency signal when the merged PR belongs to an already-completed task', async () => {
    mockWorkersFindFirst.mockReturnValue(missionPrWorker());

    const res = await POST(createWebhookRequest('pull_request', mergedPrPayload()));

    expect(res.status).toBe(200);
    expect(mockCheckAndUnblockDependentMissions).toHaveBeenCalledWith('m1', 'merged');
  });

  it('still does not rewrite tasks.status for a task that was already completed', async () => {
    mockWorkersFindFirst.mockReturnValue(missionPrWorker());

    await POST(createWebhookRequest('pull_request', mergedPrPayload()));

    // The status write is the one thing that genuinely belongs to the
    // transition. Re-stamping it would churn updatedAt on every redelivery.
    expect(updateCalls.some(c => (c.setValues as any).status === 'completed')).toBe(false);
  });

  it('fires the Path-B release trigger when the mission PR merges', async () => {
    mockWorkersFindFirst.mockReturnValue(
      missionPrWorker({ task: { ...missionPrWorker().task, release: 'true' } }),
    );
    mockWorkspacesFindFirst.mockReturnValue({
      id: 'ws1',
      releaseConfig: {
        enabled: true,
        strategy: 'workflow_dispatch',
        workflowFile: 'ship.yml',
        ref: 'dev',
        trigger: 'every_merge',
      },
      gitConfig: { defaultBranch: 'dev' },
    });
    mockGithubApi.mockReturnValue(Promise.resolve({}));

    await POST(createWebhookRequest('pull_request', mergedPrPayload()));

    expect(mockDispatchWorkflowRelease).toHaveBeenCalledTimes(1);
  });

  it('branch_merge still refuses Path B for an already-completed task (Path A is authoritative)', async () => {
    mockWorkersFindFirst.mockReturnValue(
      missionPrWorker({ task: { ...missionPrWorker().task, release: 'true' } }),
    );
    mockWorkspacesFindFirst.mockReturnValue({
      id: 'ws1',
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main' },
      gitConfig: { defaultBranch: 'dev' },
    });
    mockGithubApi.mockReturnValue(Promise.resolve({}));

    await POST(createWebhookRequest('pull_request', mergedPrPayload()));

    // The invariant the status guard used to enforce by accident, now explicit.
    expect(mockDispatchWorkflowRelease).not.toHaveBeenCalled();
  });

  it('a redelivered merge does not fire the release trigger a second time', async () => {
    // GitHub redelivers. `workers.mergedAt` already set means this merge was
    // processed before, and the effects that belong to it have already run.
    mockWorkersFindFirst.mockReturnValue(
      missionPrWorker({
        mergedAt: new Date('2026-01-01T00:00:00Z'),
        task: { ...missionPrWorker().task, release: 'true' },
      }),
    );
    mockWorkspacesFindFirst.mockReturnValue({
      id: 'ws1',
      releaseConfig: {
        enabled: true,
        strategy: 'workflow_dispatch',
        workflowFile: 'ship.yml',
        ref: 'dev',
        trigger: 'every_merge',
      },
      gitConfig: { defaultBranch: 'dev' },
    });
    mockGithubApi.mockReturnValue(Promise.resolve({}));

    await POST(createWebhookRequest('pull_request', mergedPrPayload()));

    expect(mockDispatchWorkflowRelease).not.toHaveBeenCalled();
  });

  it('a task PR merging still fires the dependency signal on the normal transition', async () => {
    // Regression guard for the split: the non-completed path must keep both the
    // status write and the merge effects.
    mockWorkersFindFirst.mockReturnValue({
      id: 'w-task',
      workspaceId: 'ws1',
      taskId: 't-task',
      mergedAt: null,
      task: {
        id: 't-task',
        status: 'in_progress',
        taskClass: 'work',
        workspaceId: 'ws1',
        release: 'false',
        title: 'Do the work',
        missionId: 'm2',
      },
    });

    await POST(createWebhookRequest('pull_request', mergedPrPayload({
      pull_request: { head: { ref: 'buildd/abc12345-fix', sha: 'sha-77' } },
    })));

    expect(updateCalls.some(c => (c.setValues as any).status === 'completed')).toBe(true);
    expect(mockCheckAndUnblockDependentMissions).toHaveBeenCalledWith('m2', 'merged');
  });

  // Early release's stacking mechanics (docs/design/early-release.md): once
  // this task's PR merges, any dependent that was released `start_stacked`
  // against its branch needs its own PR un-drafted. GitHub's own
  // retarget-on-branch-delete moves the base later — nothing else to trigger.
  it('un-drafts early-release stacked dependents once the upstream merges', async () => {
    mockWorkersFindFirst.mockReturnValue(taskPrWorker());

    await POST(createWebhookRequest('pull_request', taskPrPayload()));

    expect(mockUndraftStackedDependents).toHaveBeenCalledWith('t-task');
  });

  it('does not un-draft dependents when the PR closed without merging', async () => {
    mockWorkersFindFirst.mockReturnValue(taskPrWorker());

    await POST(createWebhookRequest('pull_request', mergedPrPayload({
      pull_request: { merged: false, head: { ref: 'buildd/abc12345-fix', sha: 'sha-77' } },
    })));

    expect(mockUndraftStackedDependents).not.toHaveBeenCalled();
  });

  // ── Merge completes the task through resolveCompletedTask (S1) ───────────
  it('routes a merge-completed task through resolveCompletedTask', async () => {
    mockWorkersFindFirst.mockReturnValue(taskPrWorker({ task: { ...taskPrWorker().task, missionId: 'm2' } }));

    await POST(createWebhookRequest('pull_request', taskPrPayload()));

    expect(mockResolveCompletedTask).toHaveBeenCalledTimes(1);
    expect(mockResolveCompletedTask).toHaveBeenCalledWith('t-task', 'ws1');
    // It already re-plans through the event loop: no separate wake.
    expect(mockWakeMissionAfterResponse).not.toHaveBeenCalled();
  });

  it('wakes the mission with pr_merged when the merge completes an attempt task (whose completion does not re-plan)', async () => {
    mockWorkersFindFirst.mockReturnValue(taskPrWorker({ task: { ...taskPrWorker().task, taskClass: 'attempt', missionId: 'm2' } }));

    await POST(createWebhookRequest('pull_request', taskPrPayload()));

    expect(mockResolveCompletedTask).toHaveBeenCalledWith('t-task', 'ws1');
    expect(mockWakeMissionAfterResponse).toHaveBeenCalledTimes(1);
    expect(mockWakeMissionAfterResponse).toHaveBeenCalledWith('m2', 'pr_merged');
  });

  it('does not resolve the task when the worker path completed it first (row guard lost)', async () => {
    mockWorkersFindFirst.mockReturnValue(taskPrWorker());
    updateReturningByStatus = { completed: [] };

    await POST(createWebhookRequest('pull_request', taskPrPayload()));

    const statusWrite = updateCalls.find(c => (c.setValues as any).status === 'completed');
    expect(statusWrite).toBeDefined();
    // The write is guarded on the row still being non-completed.
    expect(JSON.stringify(statusWrite!.condition)).toContain('"type":"ne"');
    expect(mockResolveCompletedTask).not.toHaveBeenCalled();
  });

  it('leaves a loop task waiting on this merge to the loop path, which resolves it itself', async () => {
    mockWorkersFindFirst.mockReturnValue(taskPrWorker({ task: { ...taskPrWorker().task, loopState: 'condition_unmet' } }));

    await POST(createWebhookRequest('pull_request', taskPrPayload()));

    expect(mockResolveCompletedTask).not.toHaveBeenCalled();
  });

  it('does not re-resolve an already-completed task, but wakes its mission with pr_merged', async () => {
    mockWorkersFindFirst.mockReturnValue(taskPrWorker({ task: { ...taskPrWorker().task, status: 'completed', missionId: 'm3' } }));

    await POST(createWebhookRequest('pull_request', taskPrPayload()));

    expect(mockResolveCompletedTask).not.toHaveBeenCalled();
    expect(mockWakeMissionAfterResponse).toHaveBeenCalledTimes(1);
    expect(mockWakeMissionAfterResponse).toHaveBeenCalledWith('m3', 'pr_merged');
  });

  it('a redelivered merge of an already-completed task wakes nothing', async () => {
    mockWorkersFindFirst.mockReturnValue(taskPrWorker({
      mergedAt: new Date('2026-01-01T00:00:00Z'),
      task: { ...taskPrWorker().task, status: 'completed', missionId: 'm3' },
    }));

    await POST(createWebhookRequest('pull_request', taskPrPayload()));

    expect(mockWakeMissionAfterResponse).not.toHaveBeenCalled();
    expect(mockResolveCompletedTask).not.toHaveBeenCalled();
  });

  it('routes a branch-matched merge (no owning worker) through resolveCompletedTask', async () => {
    mockWorkersFindFirst.mockReturnValue(null);
    mockTasksFindFirst.mockReturnValue({ id: 'abc12345-task', status: 'in_progress', workspaceId: 'ws9', missionId: null });

    await POST(createWebhookRequest('pull_request', taskPrPayload()));

    expect(mockResolveCompletedTask).toHaveBeenCalledWith('abc12345-task', 'ws9');
  });

  it('does not resolve a branch-matched task another path completed first', async () => {
    mockWorkersFindFirst.mockReturnValue(null);
    mockTasksFindFirst.mockReturnValue({ id: 'abc12345-task', status: 'in_progress', workspaceId: 'ws9', missionId: null });
    updateReturningByStatus = { completed: [] };

    await POST(createWebhookRequest('pull_request', taskPrPayload()));

    expect(mockResolveCompletedTask).not.toHaveBeenCalled();
  });

  // ── V8 / V14: a merge on GitHub versus the review ────────────────────────
  function taskPrWorker(overrides: Record<string, any> = {}) {
    return {
      id: 'w-task',
      workspaceId: 'ws1',
      taskId: 't-task',
      mergedAt: null,
      task: {
        id: 't-task',
        status: 'in_progress',
        taskClass: 'work',
        workspaceId: 'ws1',
        release: 'false',
        title: 'Do the work',
        missionId: null,
      },
      ...overrides,
    };
  }
  const taskPrPayload = () => mergedPrPayload({
    pull_request: { head: { ref: 'buildd/abc12345-fix', sha: 'sha-77' } },
  });
  function reviewStatus(over: Record<string, any>) {
    return {
      state: 'not_requested', terminal: true, reviewTaskId: null, adoptedTaskId: 't-task',
      verdict: null, confidence: null, summary: null, feedback: null, escalationReason: null,
      iteration: 0, maxIterations: 3, reviewHeadSha: null, reviewEquivalentHeadShas: [],
      prState: 'merged', merged: true, mergeBlocked: null,
      ...over,
    } as any;
  }
  const mergeTelemetry = () =>
    mockFireGateEvent.mock.calls
      .map(c => c[0])
      .filter((e: any) => e?.detail?.event === 'merged_over_verdict' || e?.detail?.event === 'merged_unreviewed');

  it('fires a merged supersession event when the PR merges on GitHub', async () => {
    mockWorkersFindFirst.mockReturnValue(taskPrWorker());

    await POST(createWebhookRequest('pull_request', taskPrPayload()));

    expect(mockReconcileSubjectEvent).toHaveBeenCalledTimes(1);
    expect(mockReconcileSubjectEvent.mock.calls[0][0]).toMatchObject({
      kind: 'merged',
      workspaceId: 'ws1',
      originalTaskId: 't-task',
      prNumber: 77,
      pr: { installationId: 5000, repoFullName: 'test-org/test-repo' },
    });
  });

  it('fires a closed event — not a merged one — on a PR closed without merging', async () => {
    mockWorkersFindFirst.mockReturnValue(taskPrWorker());

    await POST(createWebhookRequest('pull_request', mergedPrPayload({
      pull_request: { merged: false, head: { ref: 'buildd/abc12345-fix', sha: 'sha-77' } },
    })));

    expect(mockReconcileSubjectEvent).toHaveBeenCalledTimes(1);
    expect(mockReconcileSubjectEvent.mock.calls[0][0]).toMatchObject({ kind: 'closed', prNumber: 77 });
  });

  it('records merged_over_verdict when the PR merges over a request-changes verdict', async () => {
    mockWorkersFindFirst.mockReturnValue(taskPrWorker());
    mockReadPrReviewStatus.mockResolvedValue(reviewStatus({
      state: 'changes_requested', verdict: 'request-changes', reviewTaskId: 'review-9', reviewHeadSha: 'sha-77',
    }));

    await POST(createWebhookRequest('pull_request', taskPrPayload()));

    const events = mergeTelemetry();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      gate: 'review_verdict',
      outcome: 'bypassed',
      workspaceId: 'ws1',
      detail: { event: 'merged_over_verdict', prNumber: 77, reviewState: 'changes_requested', reviewTaskId: 'review-9' },
    });
  });

  it('records merged_unreviewed when the PR merges while its review is still running', async () => {
    mockWorkersFindFirst.mockReturnValue(taskPrWorker());
    mockReadPrReviewStatus.mockResolvedValue(reviewStatus({ state: 'reviewing', reviewTaskId: 'review-9' }));

    await POST(createWebhookRequest('pull_request', taskPrPayload()));

    const events = mergeTelemetry();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'warned', detail: { event: 'merged_unreviewed' } });
    // The verdict is read before the reviewer is superseded — cancelling it
    // first would erase the state being measured.
    expect(mockReadPrReviewStatus.mock.invocationCallOrder[0])
      .toBeLessThan(mockReconcileSubjectEvent.mock.invocationCallOrder[0]);
  });

  it('records nothing for a PR no review was requested for', async () => {
    mockWorkersFindFirst.mockReturnValue(taskPrWorker());

    await POST(createWebhookRequest('pull_request', taskPrPayload()));

    expect(mergeTelemetry()).toHaveLength(0);
  });

  it('a redelivered merge records no second telemetry event', async () => {
    mockWorkersFindFirst.mockReturnValue(taskPrWorker({ mergedAt: new Date('2026-01-01T00:00:00Z') }));
    mockReadPrReviewStatus.mockResolvedValue(reviewStatus({
      state: 'changes_requested', verdict: 'request-changes', reviewHeadSha: 'sha-77',
    }));

    await POST(createWebhookRequest('pull_request', taskPrPayload()));

    expect(mergeTelemetry()).toHaveLength(0);
  });
});

describe('release PR CI success pins the live head', () => {
  beforeEach(() => {
    resetAll();
    selectTableResults = (table) => table === schemaMock.tasks
      ? [{ id: 'release-task', workspaceId: 'ws-release', context: { releasePrPending: true, releasePrNumber: 42 } }]
      : null;
  });

  const deliverSuccess = () => POST(createWebhookRequest('check_suite',
    makeCheckSuitePayload({ check_suite: { conclusion: 'success', head_sha: 'a'.repeat(40) } })));

  it('ignores delayed success for A when live B has a rejecting review', async () => {
    mockGithubApi.mockResolvedValue({ head: { sha: 'b'.repeat(40) } });
    mockReadPrReviewStatus.mockResolvedValue({
      state: 'changes_requested', terminal: true, reviewHeadSha: 'b'.repeat(40),
      verdict: 'request-changes', reviewTaskId: 'review-B',
    } as any);
    await deliverSuccess();
    expect(mockMergePullRequest).not.toHaveBeenCalled();
    expect(updateCalls.filter(c => c.table === schemaMock.tasks)).toHaveLength(0);
  });

  it('does not merge when the live head cannot be read', async () => {
    mockGithubApi.mockRejectedValue(new Error('GitHub unavailable'));
    await deliverSuccess();
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('passes the checked SHA as the expected merge head', async () => {
    mockGithubApi.mockResolvedValue({ head: { sha: 'a'.repeat(40) } });
    await deliverSuccess();
    expect(mockMergePullRequest).toHaveBeenCalledWith(5000, 'test-org/test-repo', 42, 'merge', 'a'.repeat(40));
    expect(updateCalls.some(c => c.setValues.status === 'completed')).toBe(true);
  });
});

// A release the worker PATCH held for CI has had no outcome event yet; the
// release PR's CI settles it here, and this is where its one task.completed
// or task.failed is emitted (the PATCH emits neither while held).
describe('held release: the release PR\'s CI emits the task\'s terminal event', () => {
  const HEAD = 'a'.repeat(40);
  // What the worker PATCH would have recorded, kept on the task while held.
  const HELD = { accountId: 'acct-1', actualModel: 'model-x', totalCostUsd: '1.5', totalTurns: 7, durationMs: 1000, wasRetried: false, exitCause: null, workerId: 'w-rel' };
  beforeEach(() => {
    resetAll();
    mockRecordEvent.mockClear();
    mockNotifyTeam.mockClear();
    mockPostTaskCompletedEvent.mockClear();
    selectTableResults = (table) => {
      if (table === schemaMock.tasks) {
        return [{ id: 'release-task', title: 'Ship it', workspaceId: 'ws-release', context: { releasePrPending: true, releasePrNumber: 42, releasePrUrl: 'https://example.test/pr/42' } }];
      }
      if (table === schemaMock.workers) return [{ id: 'w-rel' }];
      return null;
    };
    mockTasksFindFirst.mockResolvedValue({
      id: 'release-task', title: 'Ship it', workspaceId: 'ws-release', missionId: 'mission-1',
      context: { releasePrPending: true, releasePrNumber: 42, heldReleaseOutcome: HELD },
      workspace: { name: 'W', teamId: 'team-1', dataClass: null },
    });
    mockPersistTaskEvidence.mockClear();
    mockRecordTaskOutcome.mockClear();
    mockRecordRunnerOutcome.mockClear();
    mockCompleteMissionIfVerified.mockClear();
  });

  const ledger = () => mockRecordEvent.mock.calls.map(c => c[0]).filter((e: any) => e.type?.startsWith('task.'));
  const pushes = () => mockNotifyTeam.mock.calls.map(c => c.slice(0, 3));
  const deliverSuccess = () => POST(createWebhookRequest('check_suite',
    makeCheckSuitePayload({ check_suite: { conclusion: 'success', head_sha: HEAD } })));

  it('resolved green: task.completed for the task\'s worker, the done push and the chat post', async () => {
    mockGithubApi.mockResolvedValue({ head: { sha: HEAD } });
    mockAllCheckSuitesPassed.mockResolvedValue(true);
    mockMergePullRequest.mockResolvedValue({ merged: true });
    await deliverSuccess();
    await new Promise(r => setTimeout(r, 0));
    expect(updateCalls.some(c => c.setValues.status === 'completed')).toBe(true);
    expect(ledger()).toEqual([{ type: 'task.completed', taskId: 'release-task', workerId: 'w-rel', title: 'Ship it', workspaceId: 'ws-release' }]);
    expect(pushes()).toEqual([['team-1', 'taskCompleted', {
      title: 'Task done', message: 'Ship it\nW', url: 'https://buildd.dev/app/tasks/release-task', urlTitle: 'View task', priority: -1,
    }]]);
    expect(mockPostTaskCompletedEvent).toHaveBeenCalledWith({ taskId: 'release-task' });
  });

  it('resolved green but the merge is rejected: task.failed naming the release merge', async () => {
    mockGithubApi.mockResolvedValue({ head: { sha: HEAD } });
    mockAllCheckSuitesPassed.mockResolvedValue(true);
    mockMergePullRequest.mockResolvedValue({ merged: false, message: 'Base branch was modified' });
    await deliverSuccess();
    expect(ledger()).toEqual([{
      type: 'task.failed', taskId: 'release-task', workerId: 'w-rel', title: 'Ship it', workspaceId: 'ws-release',
      reason: 'Release merge failed: Base branch was modified',
    }]);
    expect(pushes()).toEqual([['team-1', 'taskFailed', {
      title: 'Task failed', message: 'Ship it\nW\nRelease merge failed: Base branch was modified',
      url: 'https://buildd.dev/app/tasks/release-task', urlTitle: 'View task', priority: 0,
    }]]);
    expect(mockPostTaskCompletedEvent).not.toHaveBeenCalled();
  });

  it('resolved red: task.failed naming the release CI; no done push, no chat post', async () => {
    await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));
    await new Promise(r => setTimeout(r, 0));
    expect(updateCalls.some(c => c.setValues.status === 'failed')).toBe(true);
    expect(ledger()).toEqual([{
      type: 'task.failed', taskId: 'release-task', workerId: 'w-rel', title: 'Ship it', workspaceId: 'ws-release',
      reason: 'Release CI failed: CI failed on PR #42',
    }]);
    expect(pushes()).toEqual([['team-1', 'taskFailed', {
      title: 'Task failed', message: 'Ship it\nW\nRelease CI failed: CI failed on PR #42',
      url: 'https://buildd.dev/app/tasks/release-task', urlTitle: 'View task', priority: 0,
    }]]);
    expect(mockPostTaskCompletedEvent).not.toHaveBeenCalled();
  });

  it('resolved red in a sensitive workspace: no title in the ledger, the redacted push with the fixed label', async () => {
    mockTasksFindFirst.mockResolvedValue({
      id: 'release-task', title: 'Ship it', workspaceId: 'ws-release',
      workspace: { name: 'W', teamId: 'team-1', dataClass: 'sensitive' },
    });
    await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));
    expect(ledger()).toEqual([{
      type: 'task.failed', taskId: 'release-task', workerId: 'w-rel', title: null, workspaceId: 'ws-release', reason: 'Release CI failed',
    }]);
    expect((pushes()[0]![2] as any).message).toBe('Task failed (content redacted)\nRelease CI failed');
  });

  // The held task's analytics row, mission completion attempt and evidence
  // record wait for this resolution and then follow its status, once each.
  const outcomeRows = () => mockRecordTaskOutcome.mock.calls.map(c => c[0]);
  const missionVerdicts = () => mockCompleteMissionIfVerified.mock.calls.map(c => [c[0], c[1]]);
  const evidenceWrites = () => mockPersistTaskEvidence.mock.calls;

  it('held then resolved success: outcome completed, the mission hears completed, one evidence write', async () => {
    mockGithubApi.mockResolvedValue({ head: { sha: HEAD } });
    mockAllCheckSuitesPassed.mockResolvedValue(true);
    mockMergePullRequest.mockResolvedValue({ merged: true });
    await deliverSuccess();
    expect(outcomeRows()).toEqual([{ ...HELD, taskId: 'release-task', outcome: 'completed' }]);
    expect(mockRecordRunnerOutcome.mock.calls).toEqual([['completed']]);
    expect(missionVerdicts()).toEqual([['mission-1', { path: 'criteria_eval', predicate: 'task release-task reached completed' }]]);
    expect(evidenceWrites()).toEqual([['release-task', 'w-rel', { isSensitive: false }]]);
  });

  it('held then resolved failure (CI red): outcome failed, the mission hears failed, one evidence write', async () => {
    await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));
    expect(outcomeRows()).toEqual([{ ...HELD, taskId: 'release-task', outcome: 'failed' }]);
    expect(mockRecordRunnerOutcome.mock.calls).toEqual([['failed']]);
    expect(missionVerdicts()).toEqual([['mission-1', { path: 'criteria_eval', predicate: 'task release-task reached failed' }]]);
    expect(evidenceWrites()).toEqual([['release-task', 'w-rel', { isSensitive: false }]]);
  });

  it('held then resolved failure (merge rejected): outcome failed, the mission hears failed, one evidence write', async () => {
    mockGithubApi.mockResolvedValue({ head: { sha: HEAD } });
    mockAllCheckSuitesPassed.mockResolvedValue(true);
    mockMergePullRequest.mockResolvedValue({ merged: false, message: 'Base branch was modified' });
    await deliverSuccess();
    expect(outcomeRows()).toEqual([{ ...HELD, taskId: 'release-task', outcome: 'failed' }]);
    expect(mockRecordRunnerOutcome.mock.calls).toEqual([['failed']]);
    expect(missionVerdicts()).toEqual([['mission-1', { path: 'criteria_eval', predicate: 'task release-task reached failed' }]]);
    expect(evidenceWrites()).toEqual([['release-task', 'w-rel', { isSensitive: false }]]);
  });

  it('a held task with no kept analytics row (held before this shipped): a bare outcome row, the rest still runs', async () => {
    mockTasksFindFirst.mockResolvedValue({
      id: 'release-task', title: 'Ship it', workspaceId: 'ws-release', missionId: 'mission-1',
      context: { releasePrPending: true, releasePrNumber: 42 },
      workspace: { name: 'W', teamId: 'team-1', dataClass: null },
    });
    await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));
    // The outcome is still the release's, with what the row can tell.
    expect(outcomeRows()).toEqual([{ taskId: 'release-task', outcome: 'failed', workerId: 'w-rel' }]);
    expect(mockRecordRunnerOutcome.mock.calls).toEqual([['failed']]);
    expect(missionVerdicts()).toHaveLength(1);
    expect(evidenceWrites()).toHaveLength(1);
  });
});

describe('subscriptions ledger: the webhook records the right event', () => {
  beforeEach(() => { resetAll(); mockRecordEvent.mockClear(); });

  const recorded = () => mockRecordEvent.mock.calls.map(c => c[0]);

  it('a merged PR records pr.merged for its repo and number, even with no buildd worker', async () => {
    const res = await POST(createWebhookRequest('pull_request', {
      action: 'closed',
      pull_request: {
        number: 77, merged: true, draft: false,
        head: { ref: 'feature/x', sha: 'sha-77' }, base: { ref: 'main' },
        html_url: 'https://github.com/test-org/test-repo/pull/77',
      },
      repository: { full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    }));
    expect(res.status).toBe(200);
    expect(recorded()).toContainEqual({
      type: 'pr.merged', repoFullName: 'test-org/test-repo', prNumber: 77,
      url: 'https://github.com/test-org/test-repo/pull/77',
    });
  });

  it('a merge that auto-completes the task also records task.completed for that task', async () => {
    mockWorkersFindFirst.mockReturnValue({
      id: 'w1', workspaceId: 'ws1', taskId: 't1', prNumber: 77, mergedAt: null,
      task: { id: 't1', status: 'in_progress', workspaceId: 'ws1', release: 'false', title: 'T', missionId: null },
    });
    await POST(createWebhookRequest('pull_request', {
      action: 'closed',
      pull_request: {
        number: 77, merged: true, draft: false,
        head: { ref: 'buildd/abc-x', sha: 'sha-77' }, base: { ref: 'main' },
        html_url: 'https://github.com/test-org/test-repo/pull/77',
      },
      repository: { full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    }));
    expect(recorded()).toContainEqual({ type: 'task.completed', taskId: 't1', workerId: 'w1', workspaceId: 'ws1' });
  });

  describe('stacked PRs on one task', () => {
    const mergePayload = (n: number, head = `buildd/abc-x${n}`) => createWebhookRequest('pull_request', {
      action: 'closed',
      pull_request: {
        number: n, merged: true, draft: false,
        head: { ref: head, sha: `sha-${n}` }, base: { ref: 'main' },
        html_url: `https://github.com/test-org/test-repo/pull/${n}`,
      },
      repository: { full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    });
    const worker = (n: number, extra: any = {}) => ({
      id: 'w1', workspaceId: 'ws1', taskId: 't1', prNumber: n, mergedAt: null,
      task: { id: 't1', status: 'in_progress', workspaceId: 'ws1', release: 'false', title: 'T', missionId: null },
      ...extra,
    });
    const row = (n: number, extra: any = {}) => ({
      prUrl: `https://github.com/test-org/test-repo/pull/${n}`, prNumber: n, mergedAt: null, prLifecycleStatus: 'pr_open', ...extra,
    });
    const flippedToCompleted = () => updateCalls.some((c) => (c.setValues as any).status === 'completed');

    it('first merge keeps the task in progress while another PR is open', async () => {
      mockWorkersFindFirst.mockReturnValue(worker(1));
      selectTableResults = (t: any) => (t === schemaMock.workers ? [row(1), row(2)] : null);
      await POST(mergePayload(1));
      expect(flippedToCompleted()).toBe(false);
      expect(recorded().filter((e: any) => e.type === 'task.completed')).toEqual([]);
      expect(mockResolveCompletedTask).not.toHaveBeenCalled();
    });

    it('last merge completes the task and wakes dependents', async () => {
      mockWorkersFindFirst.mockReturnValue(worker(2));
      selectTableResults = (t: any) => (t === schemaMock.workers ? [row(1, { mergedAt: new Date(), prLifecycleStatus: 'merged' }), row(2)] : null);
      await POST(mergePayload(2));
      expect(flippedToCompleted()).toBe(true);
      expect(mockResolveCompletedTask).toHaveBeenCalledWith('t1', 'ws1');
    });

    it('a sibling PR closed unmerged (superseded) does not hold the task open', async () => {
      mockWorkersFindFirst.mockReturnValue(worker(2));
      selectTableResults = (t: any) => (t === schemaMock.workers ? [row(1, { prLifecycleStatus: 'closed' }), row(2)] : null);
      await POST(mergePayload(2));
      expect(mockResolveCompletedTask).toHaveBeenCalledWith('t1', 'ws1');
    });

    it('a redelivered first merge, after the sibling landed, does not complete the task twice', async () => {
      mockWorkersFindFirst.mockReturnValue(worker(1, {
        mergedAt: new Date(),
        task: { id: 't1', status: 'completed', workspaceId: 'ws1', release: 'false', title: 'T', missionId: null },
      }));
      selectTableResults = (t: any) => (t === schemaMock.workers ? [row(1, { mergedAt: new Date() }), row(2, { mergedAt: new Date() })] : null);
      await POST(mergePayload(1));
      expect(flippedToCompleted()).toBe(false);
      expect(mockResolveCompletedTask).not.toHaveBeenCalled();
    });

    it('branch-match fallback: a merged PR no worker row owns does not complete a task with another PR open', async () => {
      mockWorkersFindFirst.mockReturnValue(undefined);
      mockTasksFindFirst.mockReturnValue({ id: 'abc12345-0000', status: 'in_progress', workspaceId: 'ws1', missionId: null });
      selectTableResults = (t: any) => (t === schemaMock.workers ? [row(2)] : null);
      await POST(mergePayload(1, 'buildd/abc12345-x1'));
      expect(flippedToCompleted()).toBe(false);
      expect(mockResolveCompletedTask).not.toHaveBeenCalled();
    });
  });

  it('a closed-unmerged PR records nothing', async () => {
    await POST(createWebhookRequest('pull_request', {
      action: 'closed',
      pull_request: {
        number: 77, merged: false, draft: false,
        head: { ref: 'feature/x', sha: 'sha-77' }, base: { ref: 'main' },
        html_url: 'https://github.com/test-org/test-repo/pull/77',
      },
      repository: { full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    }));
    expect(recorded().filter((e: any) => e.type === 'pr.merged')).toEqual([]);
  });

  it('a failed check suite records pr.ci_failed per PR with the head SHA', async () => {
    const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));
    expect(res.status).toBe(200);
    expect(recorded()).toContainEqual({ type: 'pr.ci_failed', repoFullName: 'test-org/test-repo', prNumber: 42, headSha: 'abc123' });
  });

  it('a green check suite records no CI failure', async () => {
    await POST(createWebhookRequest('check_suite', makeCheckSuitePayload({ check_suite: { conclusion: 'success' } })));
    expect(recorded().filter((e: any) => e.type === 'pr.ci_failed')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Revert ledger: what blocks a candidate memory's promotion. A merged PR's
// title and body, and commit messages on the repo's default branch (from a
// push, or the push-triggered CI run's head commit), are handed to the writer.
// ─────────────────────────────────────────────────────────────────────────────
describe('revert ledger: merged PRs and default-branch commits are recorded', () => {
  beforeEach(() => { mockRecordPrReverts.mockClear(); });

  it('a merged PR hands its title and body to the writer, as itself', async () => {
    await POST(createWebhookRequest('pull_request', {
      action: 'closed',
      pull_request: {
        number: 130, merged: true, draft: false, title: 'Revert "feat: thing"', body: 'Reverts test-org/test-repo#123',
        head: { ref: 'revert-123', sha: 'sha-130' }, base: { ref: 'dev' },
        html_url: 'https://github.com/test-org/test-repo/pull/130', merge_commit_sha: 'm130',
      },
      repository: { full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    }));
    expect(mockRecordPrReverts).toHaveBeenCalledWith({
      repoFullName: 'test-org/test-repo',
      revertedBy: 'pr#130',
      revertingPrNumber: 130,
      text: 'Revert "feat: thing"\nReverts test-org/test-repo#123',
    });
  });

  it('a PR closed without merging records nothing', async () => {
    await POST(createWebhookRequest('pull_request', {
      action: 'closed',
      pull_request: {
        number: 131, merged: false, title: 'Revert #123', body: null,
        head: { ref: 'x', sha: 'sha-131' }, base: { ref: 'dev' }, html_url: 'https://github.com/test-org/test-repo/pull/131',
      },
      repository: { full_name: 'test-org/test-repo' },
    }));
    expect(mockRecordPrReverts).not.toHaveBeenCalled();
  });

  it('a push to the default branch hands each commit message over, as that commit', async () => {
    const res = await POST(createWebhookRequest('push', {
      ref: 'refs/heads/dev',
      repository: { full_name: 'test-org/test-repo', default_branch: 'dev' },
      commits: [
        { id: 'c1', message: 'Revert "fix: x"\n\nThis reverts commit abcdef1.' },
        { id: 'c2', message: 'chore: bump' },
      ],
    }));
    expect(res.status).toBe(200);
    expect(mockRecordPrReverts.mock.calls.map(c => c[0])).toEqual([
      { repoFullName: 'test-org/test-repo', revertedBy: 'c1', text: 'Revert "fix: x"\n\nThis reverts commit abcdef1.' },
      { repoFullName: 'test-org/test-repo', revertedBy: 'c2', text: 'chore: bump' },
    ]);
  });

  describe('base-advance notice trigger', () => {
    // The trigger runs off the response path (after(), or inline when there is
    // no request scope); let it settle.
    const settle = () => new Promise(r => setTimeout(r, 5));
    beforeEach(() => {
      mockRunBaseAdvanceNotice.mockClear();
      mockChangedFilesForPr.mockClear();
      mockChangedFilesForCompare.mockClear();
    });

    it('a merged PR hands its base, files and author branch over', async () => {
      await POST(createWebhookRequest('pull_request', {
        action: 'closed',
        pull_request: {
          number: 501, merged: true, title: 'feat: foo', body: null, merge_commit_sha: 'm501',
          head: { ref: 'buildd/aaaa1111-foo', sha: 'h501' }, base: { ref: 'dev' },
          html_url: 'https://github.com/test-org/test-repo/pull/501',
        },
        installation: { id: 7 },
        repository: { full_name: 'test-org/test-repo', default_branch: 'dev' },
      }));
      await settle();
      expect(mockChangedFilesForPr).toHaveBeenCalledWith(7, 'test-org/test-repo', 501);
      expect(mockRunBaseAdvanceNotice).toHaveBeenCalledTimes(1);
      const [input, resolver] = mockRunBaseAdvanceNotice.mock.calls[0];
      expect(input).toMatchObject({
        repoFullName: 'test-org/test-repo', baseRef: 'dev', source: 'pull_request',
        files: ['apps/web/src/lib/foo.ts'],
        change: { prNumber: 501, title: 'feat: foo', sha: 'm501', authorBranch: 'buildd/aaaa1111-foo' },
      });
      expect(typeof resolver.taskPrBase).toBe('function');
    });

    it('a PR closed without merging triggers nothing', async () => {
      await POST(createWebhookRequest('pull_request', {
        action: 'closed',
        pull_request: {
          number: 502, merged: false, title: 'x', body: null,
          head: { ref: 'buildd/bbbb2222-x', sha: 'h502' }, base: { ref: 'dev' },
          html_url: 'https://github.com/test-org/test-repo/pull/502',
        },
        installation: { id: 7 },
        repository: { full_name: 'test-org/test-repo' },
      }));
      await settle();
      expect(mockRunBaseAdvanceNotice).not.toHaveBeenCalled();
    });

    it('a push to a mission integration branch carries the payload files and the PR it names', async () => {
      await POST(createWebhookRequest('push', {
        ref: 'refs/heads/mission/foo-12345678', before: 'b0', after: 'a1', size: 1,
        repository: { full_name: 'test-org/test-repo', default_branch: 'dev' },
        installation: { id: 7 },
        commits: [{ id: 'c1', message: 'feat: foo (#77)', added: ['a.ts'], modified: ['b.ts'], removed: [] }],
      }));
      await settle();
      expect(mockChangedFilesForCompare).not.toHaveBeenCalled();
      expect(mockRunBaseAdvanceNotice).toHaveBeenCalledTimes(1);
      expect(mockRunBaseAdvanceNotice.mock.calls[0][0]).toMatchObject({
        baseRef: 'mission/foo-12345678', source: 'push', files: ['a.ts', 'b.ts'],
        change: { sha: 'a1', prNumber: 77, authorPrNumbers: [77] },
      });
    });

    it('a truncated push payload falls back to a compare', async () => {
      await POST(createWebhookRequest('push', {
        ref: 'refs/heads/dev', before: 'b0', after: 'a1', size: 40,
        repository: { full_name: 'test-org/test-repo', default_branch: 'dev' },
        installation: { id: 7 },
        commits: [{ id: 'c1', message: 'chore: x', modified: ['b.ts'] }],
      }));
      await settle();
      expect(mockChangedFilesForCompare).toHaveBeenCalledWith(7, 'test-org/test-repo', 'b0', 'a1');
      expect(mockRunBaseAdvanceNotice.mock.calls[0][0].files).toEqual(['from/compare.ts']);
    });

    it('a push to a worker head branch, or a branch deletion, triggers nothing', async () => {
      await POST(createWebhookRequest('push', {
        ref: 'refs/heads/buildd/aaaa1111-foo', after: 'a1',
        repository: { full_name: 'test-org/test-repo', default_branch: 'dev' },
        commits: [{ id: 'c1', message: 'wip', modified: ['b.ts'] }],
      }));
      await POST(createWebhookRequest('push', {
        ref: 'refs/heads/dev', deleted: true, after: '0000000',
        repository: { full_name: 'test-org/test-repo', default_branch: 'dev' },
        commits: [],
      }));
      await settle();
      expect(mockRunBaseAdvanceNotice).not.toHaveBeenCalled();
    });

    it('a release PR merge does not trigger base-advance notice (no cross-branch notifications)', async () => {
      mockIsReleaseRollupPr.mockResolvedValueOnce(true);
      await POST(createWebhookRequest('pull_request', {
        action: 'closed',
        pull_request: {
          number: 4241, merged: true, title: 'Release v1.0.0', body: null, merge_commit_sha: 'm4241',
          head: { ref: 'dev', sha: 'h4241' }, base: { ref: 'main' },
          html_url: 'https://github.com/test-org/test-repo/pull/4241',
        },
        installation: { id: 7 },
        repository: { full_name: 'test-org/test-repo', default_branch: 'dev' },
      }));
      await settle();
      expect(mockRunBaseAdvanceNotice).not.toHaveBeenCalled();
      expect(mockChangedFilesForPr).not.toHaveBeenCalled();
    });

    it('an ordinary merge still notifies when the release check is false', async () => {
      mockIsReleaseRollupPr.mockResolvedValueOnce(false);
      await POST(createWebhookRequest('pull_request', {
        action: 'closed',
        pull_request: {
          number: 4242, merged: true, title: 'feat: x', body: null, merge_commit_sha: 'm4242',
          head: { ref: 'feature/x', sha: 'h4242' }, base: { ref: 'dev' },
          html_url: 'https://github.com/test-org/test-repo/pull/4242',
        },
        installation: { id: 7 },
        repository: { full_name: 'test-org/test-repo', default_branch: 'dev' },
      }));
      await settle();
      expect(mockRunBaseAdvanceNotice).toHaveBeenCalledTimes(1);
    });
  });

  describe('push → docs ingest', () => {
    beforeEach(() => {
      insertCalls = [];
      selectTableResults = () => null;
    });
    const bindOneWorkspace = () => {
      selectTableResults = (table: any) => {
        if (table === schemaMock.githubRepos) return [{ id: 'repo-uuid-1' }];
        if (table === schemaMock.workspaces) return [{ id: 'ws-kb' }];
        return null;
      };
    };
    const push = (over: Record<string, unknown> = {}) => createWebhookRequest('push', {
      ref: 'refs/heads/main',
      after: 'sha-after-1',
      repository: { full_name: 'test-org/test-repo', default_branch: 'main' },
      head_commit: { message: 'docs: update strategy' },
      commits: [{ id: 'c1', message: 'docs: update strategy', added: ['docs/new.md'], modified: ['docs/strategy.md', 'src/app.ts'], removed: ['docs/old.md'] }],
      ...over,
    });
    const jobInserts = () => insertCalls.filter(c => c.table === schemaMock.knowledgeIngestJobs);

    it('a push to the default branch enqueues a diff job seeded with the docs paths', async () => {
      bindOneWorkspace();
      const res = await POST(push());
      expect(res.status).toBe(200);
      expect(jobInserts()).toHaveLength(1);
      expect(jobInserts()[0].values).toMatchObject({
        workspaceId: 'ws-kb',
        repo: 'test-org/test-repo',
        trigger: 'push',
        sha: 'sha-after-1',
        scope: 'diff',
        status: 'queued',
      });
      expect([...jobInserts()[0].values.changedFiles].sort()).toEqual(['docs/new.md', 'docs/old.md', 'docs/strategy.md']);
      expect(jobInserts()[0].conflict).toBe('nothing');
    });

    it('a push that touches no docs enqueues nothing', async () => {
      bindOneWorkspace();
      await POST(push({ commits: [{ id: 'c1', message: 'fix: x', modified: ['src/app.ts'] }] }));
      expect(jobInserts()).toHaveLength(0);
    });

    it('a push to another branch enqueues nothing', async () => {
      bindOneWorkspace();
      await POST(push({ ref: 'refs/heads/feature' }));
      expect(jobInserts()).toHaveLength(0);
    });

    it('a PR merge commit is left to the merged-PR path', async () => {
      bindOneWorkspace();
      await POST(push({ head_commit: { message: 'docs: update strategy (#123)' } }));
      await POST(push({ head_commit: { message: 'Merge pull request #124 from x/y' } }));
      expect(jobInserts()).toHaveLength(0);
    });

    it('a repo bound to no workspace enqueues nothing', async () => {
      selectTableResults = () => null;
      await POST(push());
      expect(jobInserts()).toHaveLength(0);
    });

    it('returns 200 when the enqueue throws (best-effort)', async () => {
      selectTableResults = () => { throw new Error('db down'); };
      const res = await POST(push());
      expect(res.status).toBe(200);
    });
  });

  it('a push to another branch records nothing', async () => {
    await POST(createWebhookRequest('push', {
      ref: 'refs/heads/feature',
      repository: { full_name: 'test-org/test-repo', default_branch: 'dev' },
      commits: [{ id: 'c1', message: 'This reverts commit abcdef1.' }],
    }));
    expect(mockRecordPrReverts).not.toHaveBeenCalled();
  });

  it("a push-triggered CI run on the default branch hands over its head commit", async () => {
    await POST(createWebhookRequest('workflow_run', {
      action: 'completed',
      workflow_run: {
        id: 424242, name: 'Build & Test', status: 'completed', conclusion: 'success',
        html_url: 'https://github.com/test-org/test-repo/actions/runs/424242',
        head_branch: 'dev', head_sha: 'c9', event: 'push', path: '.github/workflows/build.yml',
        head_commit: { id: 'c9', message: 'This reverts commit abcdef1.' },
        repository: { full_name: 'test-org/test-repo' },
      },
      repository: { full_name: 'test-org/test-repo', default_branch: 'dev' },
    }));
    expect(mockRecordPrReverts).toHaveBeenCalledWith({ repoFullName: 'test-org/test-repo', revertedBy: 'c9', text: 'This reverts commit abcdef1.' });
  });

  it('a CI run not triggered by a push (or off the default branch) records nothing', async () => {
    for (const run of [{ event: 'pull_request', head_branch: 'dev' }, { event: 'push', head_branch: 'feature' }]) {
      await POST(createWebhookRequest('workflow_run', {
        action: 'completed',
        workflow_run: {
          id: 424243, name: 'Build & Test', status: 'completed', conclusion: 'success',
          html_url: 'https://github.com/test-org/test-repo/actions/runs/424243', head_sha: 'c9', path: '.github/workflows/build.yml',
          head_commit: { id: 'c9', message: 'This reverts commit abcdef1.' },
          repository: { full_name: 'test-org/test-repo' }, ...run,
        },
        repository: { full_name: 'test-org/test-repo', default_branch: 'dev' },
      }));
    }
    expect(mockRecordPrReverts).not.toHaveBeenCalled();
  });
});

// ── Characterization: what the webhook does for releases ─────────────────────
// Pins, with arguments, the release effects the event switch runs today: the
// prod-merge record and gated-release advance on every merged delivery, the
// Path-B dispatch on a task PR's first merged delivery only, and the
// workflow_run read-back. The releases module moves behind emit(); this block
// must stay green across that move.
describe('webhook → releases (characterization)', () => {
  beforeEach(() => {
    resetAll();
    mockRecordDirectProdMerge.mockClear();
    mockAdvanceGatedReleaseOnPrMerge.mockClear();
    mockRecordAndDispatchRelease.mockClear();
    mockDispatchWorkflowRelease.mockClear();
    mockClaimMissionReleaseAttempt.mockClear();
    mockRecordDispatchedRelease.mockClear();
    mockAbandonMissionReleaseAttempt.mockClear();
    mockCountPendingTasksForMission.mockClear();
    mockNotifyTeamOf.mockClear();
    mockRecordPrReverts.mockClear();
  });

  function mergedPr(overrides: Record<string, any> = {}) {
    return {
      action: 'closed',
      pull_request: {
        number: 81,
        merged: true,
        draft: false,
        title: 'Release v1.2.0',
        body: null,
        head: { ref: 'dev', sha: 'sha-head-81' },
        base: { ref: 'main', sha: 'sha-base-81' },
        merge_commit_sha: 'sha-merge-81',
        html_url: 'https://github.com/test-org/test-repo/pull/81',
        ...overrides.pull_request,
      },
      repository: { full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
      ...(overrides.root ?? {}),
    };
  }

  function taskWorker(task: Record<string, any> = {}, worker: Record<string, any> = {}) {
    return {
      id: 'w-81', workspaceId: 'ws1', taskId: 't-81', prNumber: 81, mergedAt: null,
      task: {
        id: 't-81', status: 'completed', taskClass: 'work', workspaceId: 'ws1',
        release: 'true', title: 'Ship it', missionId: null, loopState: null, ...task,
      },
      ...worker,
    };
  }

  const dispatchWorkspace = (trigger: string) => ({
    id: 'ws1',
    name: 'test-repo',
    releaseConfig: { enabled: true, strategy: 'workflow_dispatch', workflowFile: 'ship.yml', ref: 'dev', trigger },
    gitConfig: { defaultBranch: 'dev' },
  });

  it('a merged PR records the prod merge and advances a gated release, with these args', async () => {
    mockWorkersFindFirst.mockReturnValue(null);
    const res = await POST(createWebhookRequest('pull_request', mergedPr()));
    expect(res.status).toBe(200);
    expect(mockRecordDirectProdMerge).toHaveBeenCalledTimes(1);
    expect(mockRecordDirectProdMerge.mock.calls[0]?.[0]).toEqual({
      repoFullName: 'test-org/test-repo', installationId: 5000, baseRef: 'main',
      headSha: 'sha-merge-81', previousSha: 'sha-base-81',
    });
    expect(mockAdvanceGatedReleaseOnPrMerge).toHaveBeenCalledTimes(1);
    expect(mockAdvanceGatedReleaseOnPrMerge.mock.calls[0]?.[0]).toEqual({
      repoFullName: 'test-org/test-repo', baseRef: 'main', prHeadSha: 'sha-head-81', installationId: 5000,
      mergeCommitSha: 'sha-merge-81', baseSha: 'sha-base-81', prTitle: 'Release v1.2.0', prNumber: 81,
    });
  });

  it('a redelivered merge records again (the record is idempotent, not the guard)', async () => {
    mockWorkersFindFirst.mockReturnValue(taskWorker({ release: 'false' }, { mergedAt: new Date() }));
    await POST(createWebhookRequest('pull_request', mergedPr()));
    expect(mockRecordDirectProdMerge).toHaveBeenCalledTimes(1);
    expect(mockAdvanceGatedReleaseOnPrMerge).toHaveBeenCalledTimes(1);
  });

  it('a missing merge commit reads as undefined / null', async () => {
    mockWorkersFindFirst.mockReturnValue(null);
    await POST(createWebhookRequest('pull_request', mergedPr({ pull_request: { merge_commit_sha: null } })));
    expect((mockRecordDirectProdMerge.mock.calls[0]?.[0] as any).headSha).toBeUndefined();
    expect((mockAdvanceGatedReleaseOnPrMerge.mock.calls[0]?.[0] as any).mergeCommitSha).toBeNull();
  });

  it('a PR closed unmerged, or a merge with no installation, records nothing', async () => {
    mockWorkersFindFirst.mockReturnValue(null);
    await POST(createWebhookRequest('pull_request', mergedPr({ pull_request: { merged: false } })));
    await POST(createWebhookRequest('pull_request', mergedPr({ root: { installation: undefined } })));
    expect(mockRecordDirectProdMerge).not.toHaveBeenCalled();
    expect(mockAdvanceGatedReleaseOnPrMerge).not.toHaveBeenCalled();
  });

  it('Path B every_merge: a task PR first merge dispatches the release and annotates the task', async () => {
    mockWorkersFindFirst.mockReturnValue(taskWorker());
    mockWorkspacesFindFirst.mockReturnValue(dispatchWorkspace('every_merge'));
    mockGithubApi.mockReturnValue(Promise.resolve({}));
    await POST(createWebhookRequest('pull_request', mergedPr({ pull_request: { base: { ref: 'dev', sha: 'sha-base-81' } } })));
    expect(mockRecordAndDispatchRelease).toHaveBeenCalledTimes(1);
    expect(mockRecordAndDispatchRelease.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: 'ws1', installationId: 5000, owner: 'test-org', name: 'test-repo',
      repoFullName: 'test-org/test-repo', workflowFile: 'ship.yml', ref: 'dev', prodBranch: 'dev',
      inputs: { force: 'false' }, triggeredBy: 'auto',
    });
    const annotate = updateCalls.find(c => c.table === schemaMock.tasks && (c.setValues as any).releaseResult);
    expect((annotate!.setValues as any).releaseResult).toMatchObject({ status: 'pending_ci', releaseId: 'rel-auto-1' });
  });

  it('Path B: a redelivered merge dispatches nothing', async () => {
    mockWorkersFindFirst.mockReturnValue(taskWorker({}, { mergedAt: new Date() }));
    mockWorkspacesFindFirst.mockReturnValue(dispatchWorkspace('every_merge'));
    await POST(createWebhookRequest('pull_request', mergedPr()));
    expect(mockRecordAndDispatchRelease).not.toHaveBeenCalled();
  });

  it('Path B: release=false and trigger=manual dispatch nothing', async () => {
    mockWorkersFindFirst.mockReturnValue(taskWorker({ release: 'false' }));
    mockWorkspacesFindFirst.mockReturnValue(dispatchWorkspace('every_merge'));
    await POST(createWebhookRequest('pull_request', mergedPr()));
    mockWorkersFindFirst.mockReturnValue(taskWorker());
    mockWorkspacesFindFirst.mockReturnValue(dispatchWorkspace('manual'));
    await POST(createWebhookRequest('pull_request', mergedPr()));
    expect(mockRecordAndDispatchRelease).not.toHaveBeenCalled();
  });

  it('Path B on_mission_complete: claims, dispatches, then records the dispatched release', async () => {
    mockWorkersFindFirst.mockReturnValue(taskWorker({ missionId: 'm-81' }));
    mockWorkspacesFindFirst.mockReturnValue(dispatchWorkspace('on_mission_complete'));
    mockMissionsFindFirst.mockReturnValue({ workingBranch: null, integrationBranchEnabled: false } as any);
    mockGithubApi.mockReturnValue(Promise.resolve({}));
    await POST(createWebhookRequest('pull_request', mergedPr()));
    expect(mockCountPendingTasksForMission).toHaveBeenCalledWith('m-81');
    expect(mockClaimMissionReleaseAttempt).toHaveBeenCalledWith('m-81');
    expect(mockRecordAndDispatchRelease).toHaveBeenCalledTimes(1);
    expect(mockRecordDispatchedRelease).toHaveBeenCalledWith('m-81', 'ship.yml@dev');
    expect(mockAbandonMissionReleaseAttempt).not.toHaveBeenCalled();
  });

  it('workflow_run: the revert ledger first, then the release row, then the task record and a failure alert', async () => {
    selectTableResults = (t) => {
      if (t === schemaMock.releases) return [{ id: 'release-81', workspaceId: 'ws1', state: 'dispatched', runUrl: 'https://github.com/test-org/test-repo/actions/runs/8181' }];
      if (t === schemaMock.tasks) return [{ id: 't-81', releaseResult: { status: 'pending_ci', message: 'dispatched', runId: 8181 }, missionId: null, workspaceId: 'ws1' }];
      return null;
    };
    const res = await POST(createWebhookRequest('workflow_run', {
      action: 'completed',
      workflow_run: {
        id: 8181, name: 'Release', status: 'completed', conclusion: 'failure',
        html_url: 'https://github.com/test-org/test-repo/actions/runs/8181',
        head_branch: 'dev', head_sha: 'sha-dev', event: 'push', path: '.github/workflows/release.yml',
        head_commit: { id: 'sha-dev', message: 'Revert "feat: x"' },
        repository: { full_name: 'test-org/test-repo' },
      },
      repository: { full_name: 'test-org/test-repo', default_branch: 'dev' },
      installation: { id: 5000 },
    }));
    expect(res.status).toBe(200);
    expect(mockRecordPrReverts).toHaveBeenCalledTimes(1);
    const releaseIdx = updateCalls.findIndex(c => c.table === schemaMock.releases && (c.setValues as any).state === 'failed');
    const taskIdx = updateCalls.findIndex(c => c.table === schemaMock.tasks && (c.setValues as any).releaseResult);
    expect(releaseIdx).toBeGreaterThanOrEqual(0);
    expect(taskIdx).toBeGreaterThan(releaseIdx);
    expect((updateCalls[taskIdx]!.setValues as any).releaseResult.status).toBe('failed');
    const alert = mockNotifyTeamOf.mock.calls.find((c: any[]) => String(c[2]?.title).startsWith('Release workflow failed'));
    expect(alert).toBeDefined();
    expect(alert![0]).toEqual({ taskId: 't-81' });
    expect(alert![2]).toMatchObject({ title: 'Release workflow failed — Release', url: 'https://github.com/test-org/test-repo/actions/runs/8181', priority: 1 });
  });

  it('a Path B failure is isolated: the webhook still answers 200', async () => {
    mockWorkersFindFirst.mockReturnValue(taskWorker());
    mockWorkspacesFindFirst.mockReturnValue(dispatchWorkspace('every_merge'));
    mockRecordAndDispatchRelease.mockImplementationOnce(async () => { throw new Error('github down'); });
    const res = await POST(createWebhookRequest('pull_request', mergedPr()));
    expect(res.status).toBe(200);
    expect(mockRecordAndDispatchRelease).toHaveBeenCalledTimes(1);
  });
});

// ── Characterization: what the webhook does for missions ─────────────────────
// Pins, in order and with arguments, the mission reactions to a task PR's
// merge or close: the loop-on-merge advance and the integration-PR open on
// every merged delivery; the mission wake and the dependency unblock once per
// merge, after the status transition; the surface-intent settle on any close.
// The missions module moves behind emit(); this block must stay green.
describe('webhook → missions (characterization)', () => {
  const order = () => missionLog.map(c => c[0]);
  beforeEach(() => {
    resetAll();
    missionLog.length = 0;
    missionPrOpenResult = { ok: false, reason: 'work_incomplete' };
    mockEvaluateAndAdvanceLoopOnMerge.mockClear();
    mockMaybeOpenMissionIntegrationPr.mockClear();
    mockNoteMissionPrOpenFailure.mockClear();
    mockCheckDependsOnResolved.mockImplementation(async (...a: any[]) => { missionLog.push(['checkDependsOnResolved', ...a]); });
    mockResolveCompletedTask.mockImplementation(async (...a: any[]) => { missionLog.push(['resolveCompletedTask', ...a]); });
    mockWakeMissionAfterResponse.mockImplementation((...a: any[]) => { missionLog.push(['wakeMissionAfterResponse', ...a]); });
    mockCheckAndUnblockDependentMissions.mockImplementation(async (...a: any[]) => { missionLog.push(['checkAndUnblockDependentMissions', ...a]); return []; });
    mockSettleSurfaceIntentsOnClose.mockImplementation(async (...a: any[]) => { missionLog.push(['settleSurfaceIntentsOnClose', ...a]); return { woke: [] }; });
    mockNotifyMissionPrReady.mockImplementation(async (...a: any[]) => { missionLog.push(['notifyMissionPrReady', ...a]); });
  });

  function prEvent(overrides: Record<string, any> = {}) {
    return {
      action: 'closed',
      pull_request: {
        number: 91, merged: true, draft: false, title: 'feat: x', body: null,
        head: { ref: 'buildd/abcdef12-feat-x', sha: 'sha-head-91' },
        base: { ref: 'mission/x-1234abcd', sha: 'sha-base-91' },
        merge_commit_sha: 'sha-merge-91',
        html_url: 'https://github.com/test-org/test-repo/pull/91',
        ...overrides,
      },
      repository: { full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };
  }
  function worker(task: Record<string, any> = {}, w: Record<string, any> = {}) {
    return {
      id: 'w-91', workspaceId: 'ws1', taskId: 't-91', prNumber: 91, mergedAt: null,
      task: {
        id: 't-91', status: 'in_progress', taskClass: 'attempt', workspaceId: 'ws1',
        release: 'false', title: 'X', missionId: 'm-91', loopState: null, ...task,
      },
      ...w,
    };
  }
  const merged = () => order().filter(n => n !== 'settleSurfaceIntentsOnClose');

  it('first merge of an attempt task: dependents, loop, integration PR, then resolve, wake and unblock', async () => {
    mockWorkersFindFirst.mockReturnValue(worker());
    const res = await POST(createWebhookRequest('pull_request', prEvent()));
    expect(res.status).toBe(200);
    expect(merged()).toEqual([
      'checkDependsOnResolved', 'evaluateAndAdvanceLoopOnMerge', 'maybeOpenMissionIntegrationPr',
      'resolveCompletedTask', 'wakeMissionAfterResponse', 'checkAndUnblockDependentMissions',
    ]);
    const call = (n: string) => missionLog.find(c => c[0] === n)!.slice(1);
    expect(call('evaluateAndAdvanceLoopOnMerge')).toEqual(['w-91', 't-91', 'ws1']);
    expect(call('maybeOpenMissionIntegrationPr')).toEqual(['m-91', { assumeCompletedTaskIds: ['t-91'] }]);
    expect(call('wakeMissionAfterResponse')).toEqual(['m-91', 'pr_merged']);
    expect(call('checkAndUnblockDependentMissions')).toEqual(['m-91', 'merged']);
    expect(call('settleSurfaceIntentsOnClose')).toEqual([{ workspaceId: 'ws1', prNumber: 91 }]);
  });

  it('first merge of a work task: no wake on the transition, still the unblock', async () => {
    mockWorkersFindFirst.mockReturnValue(worker({ taskClass: 'work' }));
    await POST(createWebhookRequest('pull_request', prEvent()));
    expect(merged()).toEqual([
      'checkDependsOnResolved', 'evaluateAndAdvanceLoopOnMerge', 'maybeOpenMissionIntegrationPr',
      'resolveCompletedTask', 'checkAndUnblockDependentMissions',
    ]);
  });

  it('first merge of an already-completed task: no resolve; the wake, then the unblock', async () => {
    mockWorkersFindFirst.mockReturnValue(worker({ status: 'completed', taskClass: 'work' }));
    await POST(createWebhookRequest('pull_request', prEvent()));
    expect(merged()).toEqual([
      'checkDependsOnResolved', 'evaluateAndAdvanceLoopOnMerge', 'maybeOpenMissionIntegrationPr',
      'wakeMissionAfterResponse', 'checkAndUnblockDependentMissions',
    ]);
  });

  it('a redelivered merge: loop and integration PR again; no wake, no unblock', async () => {
    mockWorkersFindFirst.mockReturnValue(worker({ status: 'completed' }, { mergedAt: new Date() }));
    await POST(createWebhookRequest('pull_request', prEvent()));
    expect(merged()).toEqual(['checkDependsOnResolved', 'evaluateAndAdvanceLoopOnMerge', 'maybeOpenMissionIntegrationPr']);
  });

  it('a task with no mission: no integration PR, wake or unblock', async () => {
    mockWorkersFindFirst.mockReturnValue(worker({ missionId: null }));
    await POST(createWebhookRequest('pull_request', prEvent()));
    expect(merged()).toEqual(['checkDependsOnResolved', 'evaluateAndAdvanceLoopOnMerge', 'resolveCompletedTask']);
  });

  it('an integration PR that should have opened and did not leaves a mission note', async () => {
    missionPrOpenResult = { ok: false, reason: 'branch_missing', detail: 'gone' };
    mockWorkersFindFirst.mockReturnValue(worker());
    await POST(createWebhookRequest('pull_request', prEvent()));
    expect(missionLog.find(c => c[0] === 'noteMissionPrOpenFailure')!.slice(1)).toEqual(['m-91', missionPrOpenResult]);
  });

  it('a PR closed unmerged: the surface settle only', async () => {
    mockWorkersFindFirst.mockReturnValue(worker());
    await POST(createWebhookRequest('pull_request', prEvent({ merged: false })));
    expect(order()).toEqual(['settleSurfaceIntentsOnClose']);
  });

  it('a branch-matched merge with no worker: the unblock, then the resolve', async () => {
    mockWorkersFindFirst.mockReturnValue(null);
    mockTasksFindFirst.mockReturnValue({ id: 'abcdef12-0000-4000-8000-000000000000', status: 'in_progress', missionId: 'm-91', workspaceId: 'ws1' } as any);
    await POST(createWebhookRequest('pull_request', prEvent()));
    expect(order()).toEqual(['checkAndUnblockDependentMissions', 'resolveCompletedTask']);
    expect(missionLog[0]).toEqual(['checkAndUnblockDependentMissions', 'm-91', 'merged']);
  });
});

describe('webhook → reviews (characterization)', () => {
  // The review reactions to a PR closing and to a GitHub review, in order. The
  // missions and releases reactions running alongside are pinned above.
  const order = () => reviewLog.map(c => c[0]);
  const call = (n: string) => reviewLog.find(c => c[0] === n)!.slice(1);
  const feedbackRows = () => insertCalls.filter(c => c.values?.githubId != null);
  const missionNoteRows = () => insertCalls.filter(c => typeof c.values?.type === 'string' && c.values.type.startsWith('reviewer_'));
  beforeEach(() => {
    resetAll();
    reviewLog.length = 0;
    mockAppendPrActivity.mockClear();
    mockShutdownDeadBuilddPrs.mockClear();
    mockDetectPrSupersession.mockClear();
    mockDeliverPrReviewCallback.mockClear();
    mockDeliverPrReviewCallback.mockImplementation(async (...a: any[]) => { reviewLog.push(['deliverPrReviewCallback', ...a]); return 'fired' as const; });
    mockReadPrReviewStatus.mockImplementation(async (...a: any[]) => {
      reviewLog.push(['readPrReviewStatus', ...a]);
      return {
        state: 'changes_requested', terminal: true, reviewTaskId: 'review-93', adoptedTaskId: null,
        verdict: 'request-changes', confidence: 0.9, summary: null, feedback: null, escalationReason: null,
        iteration: 1, maxIterations: 3, reviewHeadSha: 'sha-head-93', reviewEquivalentHeadShas: [],
        prState: 'merged', merged: true, mergeBlocked: null,
      } as any;
    });
    mockReconcileSubjectEvent.mockImplementation(async (...a: any[]) => { reviewLog.push(['reconcileSubjectEvent', ...a]); return { cancelled: [], lostRace: [], decisions: [] }; });
    mockDetectPrSupersession.mockImplementation(async (...a: any[]) => { reviewLog.push(['detectPrSupersession', ...a]); return { outcome: 'none', candidatesChecked: 0 } as any; });
  });

  function prEvent(overrides: Record<string, any> = {}, top: Record<string, any> = {}) {
    return {
      action: 'closed',
      pull_request: {
        number: 93, merged: true, draft: false, title: 'fix: y', body: null,
        head: { ref: 'buildd/abcdef12-fix-y', sha: 'sha-head-93' },
        base: { ref: 'dev', sha: 'sha-base-93' },
        merge_commit_sha: 'sha-merge-93',
        html_url: 'https://github.com/test-org/test-repo/pull/93',
        ...overrides,
      },
      repository: { full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
      ...top,
    };
  }
  function worker(task: Record<string, any> = {}, w: Record<string, any> = {}) {
    return {
      id: 'w-93', workspaceId: 'ws1', taskId: 't-93', prNumber: 93, mergedAt: null,
      task: {
        id: 't-93', status: 'in_progress', taskClass: 'work', workspaceId: 'ws1',
        release: 'false', title: 'Y', missionId: null, loopState: null, ...task,
      },
      ...w,
    };
  }
  const verdictTelemetry = () => mockFireGateEvent.mock.calls.map(c => c[0])
    .filter((e: any) => e?.detail?.event === 'merged_over_verdict' || e?.detail?.event === 'merged_unreviewed');

  it('first merge: the activity comment, the review callback, the verdict telemetry, then supersession and dead-PR shutdown', async () => {
    mockWorkersFindFirst.mockReturnValue(worker());
    const res = await POST(createWebhookRequest('pull_request', prEvent()));
    expect(res.status).toBe(200);
    expect(order()).toEqual([
      'appendPrActivity', 'deliverPrReviewCallback', 'readPrReviewStatus', 'reconcileSubjectEvent', 'shutdownDeadBuilddPrs',
    ]);
    expect(call('appendPrActivity')).toEqual([{
      installationId: 5000, repoFullName: 'test-org/test-repo', prNumber: 93,
      entry: { kind: 'merged', detail: 'into `dev`' }, onlyIfPresent: true, workspaceId: 'ws1',
    }]);
    expect(call('deliverPrReviewCallback')).toEqual([{ workspaceId: 'ws1', prNumber: 93, repoFullName: 'test-org/test-repo' }]);
    expect(call('readPrReviewStatus')).toEqual([{ workspaceId: 'ws1', prNumber: 93 }]);
    expect(call('reconcileSubjectEvent')).toEqual([{
      kind: 'merged', workspaceId: 'ws1', prNumber: 93, originalTaskId: 't-93',
      door: 'webhook pull_request.closed (merged)',
      pr: { installationId: 5000, repoFullName: 'test-org/test-repo' },
    }]);
    expect(call('shutdownDeadBuilddPrs')).toEqual(['ws1', 93, true, 5000, 'test-org/test-repo']);
    expect(verdictTelemetry()).toHaveLength(1);
    expect(verdictTelemetry()[0]).toMatchObject({
      gate: 'review_verdict', surface: 'webhook pull_request.closed (merged)', outcome: 'bypassed',
      workspaceId: 'ws1', taskId: 't-93', workerId: 'w-93',
      detail: { event: 'merged_over_verdict', prNumber: 93, mergedHeadSha: 'sha-head-93', reviewTaskId: 'review-93' },
    });
    expect(mockDetectPrSupersession).not.toHaveBeenCalled();
  });

  it('the telemetry follows the merge, not the transition: an already-completed task still gets it', async () => {
    mockWorkersFindFirst.mockReturnValue(worker({ status: 'completed' }));
    await POST(createWebhookRequest('pull_request', prEvent()));
    expect(order()).toEqual([
      'appendPrActivity', 'deliverPrReviewCallback', 'readPrReviewStatus', 'reconcileSubjectEvent', 'shutdownDeadBuilddPrs',
    ]);
    expect(verdictTelemetry()).toHaveLength(1);
  });

  it('a redelivered merge: no second telemetry; the idempotent reactions run again', async () => {
    mockWorkersFindFirst.mockReturnValue(worker({ status: 'completed' }, { mergedAt: new Date() }));
    await POST(createWebhookRequest('pull_request', prEvent()));
    expect(order()).toEqual(['appendPrActivity', 'deliverPrReviewCallback', 'reconcileSubjectEvent', 'shutdownDeadBuilddPrs']);
    expect(verdictTelemetry()).toHaveLength(0);
  });

  it('closed unmerged: the comment, the callback, supersession detection, then the reconcile and shutdown', async () => {
    mockWorkersFindFirst.mockReturnValue(worker());
    await POST(createWebhookRequest('pull_request', prEvent({ merged: false })));
    expect(order()).toEqual([
      'appendPrActivity', 'deliverPrReviewCallback', 'detectPrSupersession', 'reconcileSubjectEvent', 'shutdownDeadBuilddPrs',
    ]);
    expect((call('appendPrActivity')[0] as any).entry).toEqual({ kind: 'closed_unmerged' });
    expect(call('detectPrSupersession')).toEqual([{ workerId: 'w-93', via: 'webhook' }]);
    expect(call('reconcileSubjectEvent')).toEqual([expect.objectContaining({ kind: 'closed', door: 'webhook pull_request.closed' })]);
    expect(call('shutdownDeadBuilddPrs')).toEqual(['ws1', 93, false, 5000, 'test-org/test-repo']);
    expect(verdictTelemetry()).toHaveLength(0);
  });

  // Slice D: a kernel-owned PR's close (T18) owes a scan_supersession effect; the subscriber
  // does not run a second, request-bound scan beside it.
  // Neither inline detection nor the legacy reconcile: T18's own scan_supersession and
  // cancel_open_attempts own a kernel PR's close (final kernel audit, task 708a55c0).
  it('closed unmerged, kernel-owned PR: no inline detection and no legacy reconcile; the kernel\'s T18 effects own it', async () => {
    mockWorkersFindFirst.mockReturnValue(worker());
    mockKernelDeliveryForPr.mockImplementation(async () => 'delivery-93');
    try {
      await POST(createWebhookRequest('pull_request', prEvent({ merged: false })));
      expect(mockKernelDeliveryForPr).toHaveBeenCalledWith('ws1', 'test-org/test-repo', 93);
      expect(order()).toEqual(['appendPrActivity', 'deliverPrReviewCallback', 'shutdownDeadBuilddPrs']);
    } finally {
      mockKernelDeliveryForPr.mockImplementation(async () => null);
    }
  });

  it('no installation: no comment and no shutdown; the reconcile runs without PR coordinates', async () => {
    mockWorkersFindFirst.mockReturnValue(worker());
    await POST(createWebhookRequest('pull_request', prEvent({}, { installation: undefined })));
    expect(order()).toEqual(['deliverPrReviewCallback', 'readPrReviewStatus', 'reconcileSubjectEvent']);
    expect((call('reconcileSubjectEvent')[0] as any).pr).toBeNull();
  });

  it('a review step that throws is isolated: the next one still runs and the webhook answers 200', async () => {
    mockWorkersFindFirst.mockReturnValue(worker());
    mockReconcileSubjectEvent.mockImplementation(async (...a: any[]) => {
      reviewLog.push(['reconcileSubjectEvent', ...a]);
      throw new Error('reconcile exploded');
    });
    const res = await POST(createWebhookRequest('pull_request', prEvent()));
    expect(res.status).toBe(200);
    expect(order()).toEqual([
      'appendPrActivity', 'deliverPrReviewCallback', 'readPrReviewStatus', 'reconcileSubjectEvent', 'shutdownDeadBuilddPrs',
    ]);
  });

  it('a PR no worker owns: the comment only, with no workspace', async () => {
    mockWorkersFindFirst.mockReturnValue(null);
    await POST(createWebhookRequest('pull_request', prEvent({ head: { ref: 'feature/y', sha: 'sha-head-93' } })));
    expect(order()).toEqual(['appendPrActivity']);
    expect((call('appendPrActivity')[0] as any).workspaceId).toBeNull();
  });

  // ── pull_request_review / pull_request_review_comment ─────────────────────
  function reviewEvent(state: string, action = 'submitted') {
    return {
      action,
      review: { id: 7001, state, body: 'Needs a test.', user: { login: 'a-maintainer' } },
      pull_request: { number: 93 },
      repository: { full_name: 'test-org/test-repo' },
    };
  }
  const reviewOwner = (missionId: string | null = 'm-93') => ({
    id: 'w-93', taskId: 't-93', workspaceId: 'ws1', task: { id: 't-93', title: 'Y', missionId },
  });

  it('a submitted verdict: feedback captured (deduped on the GitHub id), then the mission note', async () => {
    mockWorkersFindFirst.mockReturnValue(reviewOwner());
    const res = await POST(createWebhookRequest('pull_request_review', reviewEvent('changes_requested')));
    expect(res.status).toBe(200);
    expect(insertCalls.map(c => (c.values?.githubId != null ? 'feedback' : c.values?.type))).toEqual(['feedback', 'reviewer_request_changes']);
    expect(feedbackRows()[0]).toMatchObject({
      conflict: 'nothing',
      values: { githubId: '7001', workspaceId: 'ws1', repoFullName: 'test-org/test-repo', prNumber: 93, taskId: 't-93', workerId: 'w-93' },
    });
    expect(missionNoteRows()[0].values).toMatchObject({ missionId: 'm-93', taskId: 't-93', workerId: 'w-93', authorType: 'user' });
  });

  it('a bare comment review is captured as feedback but writes no mission note', async () => {
    mockWorkersFindFirst.mockReturnValue(reviewOwner());
    await POST(createWebhookRequest('pull_request_review', reviewEvent('commented')));
    expect(feedbackRows()).toHaveLength(1);
    expect(missionNoteRows()).toHaveLength(0);
  });

  it('a verdict on a PR outside a mission: feedback only', async () => {
    mockWorkersFindFirst.mockReturnValue(reviewOwner(null));
    await POST(createWebhookRequest('pull_request_review', reviewEvent('approved')));
    expect(feedbackRows()).toHaveLength(1);
    expect(missionNoteRows()).toHaveLength(0);
  });

  it('a redelivered review hits the same dedupe key; the mission note has none (as today)', async () => {
    mockWorkersFindFirst.mockReturnValue(reviewOwner());
    await POST(createWebhookRequest('pull_request_review', reviewEvent('approved')));
    await POST(createWebhookRequest('pull_request_review', reviewEvent('approved')));
    expect(feedbackRows().map(c => [c.values.githubId, c.conflict])).toEqual([['7001', 'nothing'], ['7001', 'nothing']]);
    expect(missionNoteRows()).toHaveLength(2);
  });

  it('dismissed and edited reviews do nothing, not even the owner lookup', async () => {
    mockWorkersFindFirst.mockReturnValue(reviewOwner());
    await POST(createWebhookRequest('pull_request_review', reviewEvent('approved', 'dismissed')));
    expect(insertCalls).toHaveLength(0);
    expect(mockWorkersFindFirst).not.toHaveBeenCalled();
  });

  it('an inline review comment is captured with its path; an edit is not', async () => {
    mockWorkersFindFirst.mockReturnValue(reviewOwner());
    const comment = { id: 8001, body: 'Off by one here.', path: 'src/a.ts', line: 12, diff_hunk: '@@', user: { login: 'a-maintainer' } };
    const payload = (action: string) => ({ action, comment, pull_request: { number: 93 }, repository: { full_name: 'test-org/test-repo' } });
    await POST(createWebhookRequest('pull_request_review_comment', payload('created')));
    await POST(createWebhookRequest('pull_request_review_comment', payload('edited')));
    expect(feedbackRows()).toHaveLength(1);
    expect(feedbackRows()[0]).toMatchObject({ conflict: 'nothing', values: { githubId: '8001', path: 'src/a.ts', workspaceId: 'ws1', prNumber: 93 } });
  });

  it('a PR with no owning workspace captures nothing', async () => {
    mockWorkersFindFirst.mockReturnValue(null);
    await POST(createWebhookRequest('pull_request_review', reviewEvent('approved')));
    expect(insertCalls).toHaveLength(0);
  });
});

describe('webhook → reviewer flows (characterization)', () => {
  // Reviewer dispatch on open, re-dispatch on push, and the CI-fix retry, with
  // what each one means for core's no-CI auto-merge.
  const order = () => reviewLog.map(c => c[0]);
  const call = (n: string, i = 0) => reviewLog.filter(c => c[0] === n)[i]!.slice(1);
  const OLD = 'a'.repeat(40);
  const NEW = 'b'.repeat(40);
  beforeEach(() => {
    resetAll();
    reviewLog.length = 0;
    mockAppendPrActivity.mockClear();
    mockRetryCiFailureForPr.mockClear();
    mockRecordEvent.mockClear();
    mockInspectPullRequestMigrations.mockImplementation(async (...a: any[]) => { reviewLog.push(['inspectPullRequestMigrations', ...a]); return { safe: true } as any; });
    mockCreateReviewerTask.mockImplementation(async (...a: any[]) => { reviewLog.push(['createReviewerTask', ...a]); return { id: 'reviewer-95' } as any; });
    mockAnnounceTaskCreated.mockImplementation(async (...a: any[]) => { reviewLog.push(['announceTaskCreated', ...a]); });
    mockWakeTask.mockImplementation(async (...a: any[]) => { reviewLog.push(['wakeTask', ...a]); });
    mockTryAutoMergeWorkerPr.mockImplementation(async (...a: any[]) => { reviewLog.push(['tryAutoMergeWorkerPr', ...a]); });
    mockRecordEvent.mockImplementation(async (e: any) => { reviewLog.push(['recordEvent', e]); return { recorded: 1 }; });
    mockWorkersFindFirst.mockReturnValue({ id: 'w-95', workspaceId: 'ws1', taskId: 't-95', branch: 'buildd/abcdef12-z', prNumber: 95, prBaseRef: 'dev' });
    mockWorkspacesFindFirst.mockReturnValue({ id: 'ws1', teamId: 'team-1', gitConfig: {} });
    mockWorkspacesFindMany.mockReturnValue([{ id: 'ws1', teamId: 'team-1', gitConfig: {} }]);
    mockTasksFindFirst.mockReturnValue({
      id: 't-95', title: 'Z', description: 'do z', backend: 'claude', missionId: 'm-95',
      pathManifest: null, context: { iteration: 1, maxIterations: 3 }, requiresReview: false, mission: null,
    });
    mockGithubApi.mockReturnValue(Promise.resolve([{ filename: 'src/z.ts', additions: 3, deletions: 1, status: 'modified' }]));
    agentReview();
  });
  function agentReview() {
    mockResolvePolicy.mockReturnValue({
      tier: 'agent-review', agentReview: { reviewerRole: 'reviewer', escalateToPaths: [], maxConfidenceThreshold: 0.6 },
    } as any);
  }
  function prEvent(action: string, overrides: Record<string, any> = {}) {
    return {
      action,
      pull_request: {
        number: 95, merged: false, draft: false, title: 'feat: z', body: 'Z body',
        head: { ref: 'buildd/abcdef12-z', sha: NEW }, base: { ref: 'dev', sha: 'sha-base-95' },
        html_url: 'https://github.com/test-org/test-repo/pull/95',
        ...overrides,
      },
      repository: { full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };
  }
  function verdict(state: string, over: Record<string, any> = {}) {
    mockReadPrReviewStatus.mockImplementation(async (...a: any[]) => {
      reviewLog.push(['readPrReviewStatus', ...a]);
      return {
        state, terminal: state !== 'queued' && state !== 'reviewing', reviewTaskId: 'review-95', adoptedTaskId: 't-95',
        verdict: state === 'changes_requested' ? 'request-changes' : state === 'approved' ? 'approve' : null,
        confidence: 0.9, summary: 'needs work', feedback: 'fix it', escalationReason: null,
        iteration: 1, maxIterations: 3, reviewHeadSha: OLD, prState: 'open', merged: false, mergeBlocked: null, ...over,
      } as any;
    });
  }

  // ── opened ────────────────────────────────────────────────────────────────
  it('opened, agent-review: migrations, the reviewer, its announce and wake, then the PR comment; no auto-merge', async () => {
    const res = await POST(createWebhookRequest('pull_request', prEvent('opened')));
    expect(res.status).toBe(200);
    expect(order()).toEqual(['inspectPullRequestMigrations', 'createReviewerTask', 'announceTaskCreated', 'wakeTask', 'appendPrActivity']);
    expect(call('createReviewerTask')[0]).toMatchObject({
      workspaceId: 'ws1', originalTaskId: 't-95', worker: { branch: 'buildd/abcdef12-z' }, prNumber: 95, headSha: NEW,
      reviewerRole: 'reviewer', confidenceThreshold: 0.6, installationId: 5000, repoFullName: 'test-org/test-repo',
      prBody: 'Z body', baseRef: 'dev',
      originalTask: { title: 'Z', backend: 'claude', missionId: 'm-95', iteration: 1, maxIterations: 3 },
    });
    expect(call('announceTaskCreated')[0]).toMatchObject({ id: 'reviewer-95', workspaceId: 'ws1', missionId: 'm-95', roleSlug: 'reviewer' });
    expect(call('wakeTask')).toEqual(['reviewer-95', 'task.created']);
    expect((call('appendPrActivity')[0] as any)).toMatchObject({ prNumber: 95, entry: { kind: 'review_queued' }, workspaceId: 'ws1' });
  });

  it('a redelivered open: the reviewer dedupes, nothing is announced, and the PR is still held from auto-merge', async () => {
    mockCreateReviewerTask.mockImplementation(async (...a: any[]) => { reviewLog.push(['createReviewerTask', ...a]); return { id: 'reviewer-95', deduplicated: true } as any; });
    await POST(createWebhookRequest('pull_request', prEvent('opened')));
    expect(order()).toEqual(['inspectPullRequestMigrations', 'createReviewerTask']);
  });

  it('opened, auto-threshold with no CI: no reviewer; core auto-merges', async () => {
    mockResolvePolicy.mockReturnValue({ tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: [] } } as any);
    await POST(createWebhookRequest('pull_request', prEvent('opened')));
    expect(order()).toEqual(['inspectPullRequestMigrations', 'tryAutoMergeWorkerPr']);
  });

  it('opened, auto-threshold, but a migration collision the retry handles: held from the no-CI auto-merge', async () => {
    mockResolvePolicy.mockReturnValue({ tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: [] } } as any);
    mockInspectPullRequestMigrations.mockImplementation(async () => ({ safe: false, collision: { index: 1 } }) as any);
    mockTryDispatchMigrationCollisionRetry.mockImplementation(async (...a: any[]) => { reviewLog.push(['tryDispatchMigrationCollisionRetry', ...a]); return { handled: true }; });
    await POST(createWebhookRequest('pull_request', prEvent('opened')));
    expect(order()).toEqual(['tryDispatchMigrationCollisionRetry']);
    expect(call('tryDispatchMigrationCollisionRetry')[0]).toMatchObject({ workerId: 'w-95', taskId: 't-95', prNumber: 95, headSha: NEW, workspaceId: 'ws1', installationId: 5000 });
  });

  it('opened, pre-flight escalation: mission note, the needs-human fact, a team alert and the PR comment; no reviewer, no auto-merge', async () => {
    mockPreflightEscalationCheck.mockReturnValue({ shouldEscalate: true, reason: 'touches auth' } as any);
    mockNotifyMissionPrReady.mockImplementation(async (...a: any[]) => { reviewLog.push(['notifyMissionPrReady', ...a]); });
    mockNotifyTeamOf.mockImplementation((...a: any[]) => { reviewLog.push(['notifyTeamOf', ...a]); });
    await POST(createWebhookRequest('pull_request', prEvent('opened')));
    expect(order()).toEqual(['inspectPullRequestMigrations', 'notifyMissionPrReady', 'notifyTeamOf', 'appendPrActivity']);
    expect(insertCalls.map(c => c.values?.type)).toEqual(['reviewer_escalated']);
    expect((call('appendPrActivity')[0] as any).entry).toEqual({ kind: 'human_review_required', note: 'touches auth' });
  });

  it('opened as a draft: nothing; a draft is neither reviewed nor auto-merged', async () => {
    await POST(createWebhookRequest('pull_request', prEvent('opened', { draft: true })));
    expect(order()).toEqual([]);
  });

  it('a dispatch that throws falls through to the no-CI path (which holds an agent-review PR)', async () => {
    mockCreateReviewerTask.mockImplementation(async () => { throw new Error('boom'); });
    const res = await POST(createWebhookRequest('pull_request', prEvent('opened')));
    expect(res.status).toBe(200);
    expect(order()).toEqual(['inspectPullRequestMigrations']);
    // The no-CI path ran: it resolved the policy a second time, for the merge.
    expect(mockResolvePolicy).toHaveBeenCalledTimes(2);
  });

  // ── synchronize ───────────────────────────────────────────────────────────
  it('a push after request-changes: the "changes pushed" comment, then the re-review with the prior verdict', async () => {
    verdict('changes_requested');
    await POST(createWebhookRequest('pull_request', prEvent('synchronize')));
    expect(order()).toEqual(['appendPrActivity', 'readPrReviewStatus', 'createReviewerTask', 'announceTaskCreated', 'wakeTask', 'appendPrActivity']);
    expect((call('appendPrActivity')[0] as any)).toMatchObject({ entry: { kind: 'changes_pushed', sha: NEW.slice(0, 7) }, onlyIfPresent: true });
    expect(call('createReviewerTask')[0]).toMatchObject({
      headSha: NEW, baseRef: 'dev',
      priorVerdict: { headSha: OLD, verdict: 'request-changes', confidence: 0.9, summary: 'needs work', feedback: 'fix it' },
    });
    expect((call('appendPrActivity', 1)[0] as any).entry).toEqual({ kind: 'review_queued' });
  });

  it('a redelivered push (head equals the reviewed head): the comment only', async () => {
    verdict('changes_requested', { reviewHeadSha: NEW });
    await POST(createWebhookRequest('pull_request', prEvent('synchronize')));
    expect(order()).toEqual(['appendPrActivity', 'readPrReviewStatus']);
  });

  it('a push while a reviewer works the PR: single-flight, no second reviewer', async () => {
    verdict('reviewing');
    await POST(createWebhookRequest('pull_request', prEvent('synchronize')));
    expect(order()).toEqual(['appendPrActivity', 'readPrReviewStatus']);
    expect(mockFireGateEvent.mock.calls.map(c => (c[0] as any).gate)).toContain('reviewer_single_flight');
  });

  it('a push after an approval carries the approval forward instead of re-reviewing', async () => {
    verdict('approved');
    await POST(createWebhookRequest('pull_request', prEvent('synchronize')));
    expect(order()).toEqual(['appendPrActivity', 'readPrReviewStatus']);
    expect(mockCarryForwardApproval).toHaveBeenCalledTimes(1);
    expect(mockCarryForwardApproval.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws1', prNumber: 95, baseRef: 'dev', headSha: NEW });
  });

  it('a push to a draft: the comment, no re-review', async () => {
    verdict('changes_requested');
    await POST(createWebhookRequest('pull_request', prEvent('synchronize', { draft: true })));
    expect(order()).toEqual(['appendPrActivity']);
  });

  it('a push the workspace no longer wants agent-reviewed: no reviewer', async () => {
    verdict('changes_requested');
    mockResolvePolicy.mockReturnValue({ tier: 'human' } as any);
    await POST(createWebhookRequest('pull_request', prEvent('synchronize')));
    expect(order()).toEqual(['appendPrActivity', 'readPrReviewStatus']);
  });

  // ── check_suite failure ───────────────────────────────────────────────────
  it('CI red: for each PR the ledger records it before the CI-fix retry is asked, with the suite head', async () => {
    const payload = makeCheckSuitePayload({
      check_suite: {
        conclusion: 'failure', head_sha: 'sha-red',
        pull_requests: [{ number: 95, head: { sha: 'sha-red', ref: 'x' }, base: { sha: 'b', ref: 'dev' } }],
      },
    });
    const res = await POST(createWebhookRequest('check_suite', payload));
    expect(res.status).toBe(200);
    expect(order()).toEqual(['recordEvent', 'retryCiFailureForPr']);
    expect(call('retryCiFailureForPr')).toEqual([{
      repoFullName: 'test-org/test-repo', prNumber: 95, headSha: 'sha-red', installationId: 5000, surface: 'webhook:check_suite',
    }]);
  });

  it('a CI-fix retry that throws is isolated: the next PR in the suite is still handled and the webhook answers 200', async () => {
    mockRetryCiFailureForPr.mockImplementationOnce(async (input: any) => {
      reviewLog.push(['retryCiFailureForPr', input]);
      throw new Error('retry exploded');
    });
    const payload = makeCheckSuitePayload({
      check_suite: {
        conclusion: 'failure', head_sha: 'sha-red',
        pull_requests: [
          { number: 95, head: { sha: 'sha-red', ref: 'x' }, base: { sha: 'b', ref: 'dev' } },
          { number: 96, head: { sha: 'sha-red', ref: 'y' }, base: { sha: 'b', ref: 'dev' } },
        ],
      },
    });
    const res = await POST(createWebhookRequest('check_suite', payload));
    expect(res.status).toBe(200);
    expect(reviewLog.filter(c => c[0] === 'retryCiFailureForPr').map(c => (c[1] as any).prNumber)).toEqual([95, 96]);
  });

  it('CI green does not ask for a CI fix', async () => {
    const payload = makeCheckSuitePayload({ check_suite: { conclusion: 'success' } });
    await POST(createWebhookRequest('check_suite', payload));
    expect(mockRetryCiFailureForPr).not.toHaveBeenCalled();
  });

  // ── PR merged: retry attempt cleanup ────────────────────────────────────
  it('cancels open retry attempts when PR merges', async () => {
    mockWorkersFindFirst.mockReturnValue({
      id: 'w-merged-retry',
      workspaceId: 'ws-retry-test',
      taskId: 'task-retry',
      prNumber: 100,
      task: {
        id: 'task-retry',
        status: 'in_progress',
        workspaceId: 'ws-retry-test',
        release: 'false',
        missionId: null,
      },
    });

    const payload = {
      action: 'closed',
      pull_request: {
        number: 100,
        merged: true,
        draft: false,
        head: { ref: 'buildd/retry-fix', sha: 'sha-100' },
        html_url: 'https://github.com/test-org/test-repo/pull/100',
      },
      repository: { full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };

    mockCancelRetryAttemptsForMergedPr.mockClear();
    const res = await POST(createWebhookRequest('pull_request', payload));
    expect(res.status).toBe(200);

    expect(mockCancelRetryAttemptsForMergedPr).toHaveBeenCalledWith({
      workspaceId: 'ws-retry-test',
      prNumber: 100,
      reason: 'PR merged',
    });
  });

  it('cancels open retry attempts when PR is closed without merge', async () => {
    mockWorkersFindFirst.mockReturnValue({
      id: 'w-closed-retry',
      workspaceId: 'ws-retry-test-2',
      taskId: 'task-retry-2',
      prNumber: 101,
      task: {
        id: 'task-retry-2',
        status: 'pending',
        workspaceId: 'ws-retry-test-2',
        release: 'false',
        missionId: null,
      },
    });

    const payload = {
      action: 'closed',
      pull_request: {
        number: 101,
        merged: false,
        draft: false,
        head: { ref: 'buildd/retry-fix-2', sha: 'sha-101' },
        html_url: 'https://github.com/test-org/test-repo/pull/101',
      },
      repository: { full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };

    mockCancelRetryAttemptsForMergedPr.mockClear();
    const res = await POST(createWebhookRequest('pull_request', payload));
    expect(res.status).toBe(200);

    expect(mockCancelRetryAttemptsForMergedPr).toHaveBeenCalledWith({
      workspaceId: 'ws-retry-test-2',
      prNumber: 101,
      reason: 'PR closed',
    });
  });

  it('does not call retry cleanup when worker does not exist', async () => {
    mockWorkersFindFirst.mockReturnValue(null);

    const payload = {
      action: 'closed',
      pull_request: {
        number: 102,
        merged: true,
        draft: false,
        head: { ref: 'buildd/no-worker', sha: 'sha-102' },
        html_url: 'https://github.com/test-org/test-repo/pull/102',
      },
      repository: { full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };

    mockCancelRetryAttemptsForMergedPr.mockClear();
    const res = await POST(createWebhookRequest('pull_request', payload));
    expect(res.status).toBe(200);

    expect(mockCancelRetryAttemptsForMergedPr).not.toHaveBeenCalled();
  });
});
