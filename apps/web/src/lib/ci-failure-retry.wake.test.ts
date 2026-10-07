/**
 * A CI-fix task (and a schema-drift diagnose task) is woken through the
 * dispatch authority with cause `ci.retry`, so delivery can tell it apart from
 * a plain new task. The insert itself is made durable by the tasks trigger;
 * that half is covered against real SQL in tests/db/retry-wake.test.ts.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

let workerRow: any = null;
let insertedRows: any[] = [];
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: async () => workerRow },
      workspaces: { findFirst: async () => ({ id: 'ws1', name: 'ws', gitConfig: {} }) },
    },
    select: () => ({ from: () => ({ where: async () => [] }) }),
    insert: () => ({
      values: (v: any) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            const row = { id: `new-${insertedRows.length + 1}`, ...v };
            insertedRows.push(row);
            return [row];
          },
        }),
      }),
    }),
  },
}));

const mockWakeTask = mock(async (_id: string, _cause: string, _opts?: unknown) => {});
const mockAnnounceTaskCreated = mock(async (_task: unknown, _ws: unknown) => {});
mock.module('@/lib/dispatch-authority', () => ({
  wakeTask: mockWakeTask,
  wakeTasks: mock(async () => {}),
  announceTaskCreated: mockAnnounceTaskCreated,
  kickDispatch: mock(() => {}),
  enqueueTaskDispatch: mock(async () => {}),
  drainDispatchOutbox: mock(async () => ({ claimed: 0, delivered: 0, skipped: 0, failed: 0 })),
  deliverTaskDispatch: mock(async () => 'pusher'),
  routeForCause: mock(() => ({ event: 'task.created', legacyDefault: true, legacyUnfilteredRunnerPreference: false })),
  webhookWants: mock(() => false),
  primaryCause: mock((_c: unknown, fallback: unknown) => fallback),
  reseedDispatchTimer: mock(async () => {}),
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH: 25,
}));

let failedJobNames: string[] = ['Build'];
mock.module('@/lib/ci-failure-inspect', () => ({
  checkPrIsDraft: async () => false,
  fetchPrRetryGate: async () => ({ draft: false, closed: false, merged: false }),
  fetchCIFailureLogs: async () => ({ summary: 'tests failed', runId: 1, runUrl: 'https://ci.example.test/run/1', failedJobId: 2, failedJobNames }),
}));
mock.module('@/lib/mission-notifications', () => ({ notifyMissionPrReady: async () => {} }));
mock.module('@/lib/ci-job-log-evidence', () => ({ captureCiJobLogEvidence: async () => ({ kind: 'skipped' }), stripAnsi: (s: string) => s }));
mock.module('@/lib/attempt-identity', () => ({
  inheritAttemptIdentity: async () => ({}),
  attemptIdentityFrom: () => ({}),
}));
mock.module('@/lib/subject-anchor-observer', () => ({
  prepareSubjectFiling: async () => ({ taskValues: {}, anchor: null, match: null }),
  recordSubjectMatchObserved: async () => {},
}));
mock.module('@/lib/pr-activity-comment', () => ({ appendPrActivity: async () => ({}), taskActivityUrl: (id: string) => `/t/${id}` }));
mock.module('@/lib/pr-review-request', () => ({ resolveOrAdoptPrOwner: async () => ({ ownerWorker: { id: 'w0' } }) }));
mock.module('@/lib/gate-ledger', () => ({
  GATE_SLUGS: new Proxy({}, { get: (_t, k) => String(k) }),
  gateFrictionSignature: () => 'sig',
  gateCallerOrigin: () => 'system',
  fireGateEvent: () => 'gate-id',
  fireDeferralEvent: () => {},
  fireRepeatGateEvent: () => {},
  fireGateEventForWorkspaceRef: () => {},
}));
mock.module('@/lib/ci-red-queue', () => ({
  CI_RED_DUE_QUEUE: 'ci-red',
  CI_RED_ESCALATED_KEY: 'ciRedEscalatedHeadSha',
  ciRedMember: () => 'm',
  parseCiRedMember: () => null,
  scheduleCiRedLook: async () => {},
}));

// Workflow kernel door (lib/workflow/seam.ts; real-SQL cases in tests/db/workflow-matrix.test.ts).
let kernelSeen: any = { handled: false };
const mockObserveCiFailure = mock(async (_p: any) => kernelSeen);
mock.module('@/lib/workflow/seam', () => ({ observeCiFailure: mockObserveCiFailure }));
const gateEvents: any[] = [];
mock.module('@/lib/policy-overrides', () => ({ policyValue: () => 3, POLICY_DEFAULTS: { maxCiRetries: 3 } }));

const { retryCiFailureForPr, kernelCiOutcome } = await import('./ci-failure-retry');

const input = { repoFullName: 'o/r', prNumber: 7, headSha: 'abc1234', installationId: 1, surface: 'cron:ci-red' as const };

describe('retryCiFailureForPr wakes', () => {
  beforeEach(() => {
    mockWakeTask.mockClear();
    mockAnnounceTaskCreated.mockClear();
    insertedRows = [];
    failedJobNames = ['Build'];
    kernelSeen = { handled: false };
    mockObserveCiFailure.mockClear();
    gateEvents.length = 0;
    workerRow = {
      id: 'w1', branch: 'buildd/x', prNumber: 7, prLifecycleStatus: 'open',
      task: { id: 't1', title: 'Do it', description: null, workspaceId: 'ws1', missionId: null, status: 'completed', context: {}, result: null },
    };
  });

  it('a CI-fix task is announced and woken as ci.retry', async () => {
    const out = await retryCiFailureForPr(input);
    expect(out.kind).toBe('dispatched');
    const id = (out as { taskId: string }).taskId;
    expect(mockAnnounceTaskCreated).toHaveBeenCalledTimes(1);
    expect(mockWakeTask.mock.calls).toEqual([[id, 'ci.retry']]);
  });

  it('a schema-drift diagnose task is woken as ci.retry', async () => {
    failedJobNames = ['Schema Drift / check-prod'];
    const out = await retryCiFailureForPr(input);
    expect(out.kind).toBe('diagnose_dispatched');
    const id = (out as { taskId: string }).taskId;
    expect(mockWakeTask.mock.calls).toEqual([[id, 'ci.retry']]);
  });
});

describe('retryCiFailureForPr on a kernel-owned PR (§5.7, T10)', () => {
  beforeEach(() => {
    insertedRows = [];
    workerRow = {
      id: 'w1', branch: 'buildd/x', prNumber: 7, prLifecycleStatus: 'open',
      task: { id: 't1', title: 'Do it', description: null, workspaceId: 'ws1', missionId: null, status: 'completed', context: { iteration: 9 }, result: null },
    };
  });

  it('the kernel decides and the legacy insert never runs beside it', async () => {
    kernelSeen = { handled: true, attemptTaskId: 'ci-task-1', result: { result: 'applied', decision: { toState: 'REPAIRING' } } };
    const out = await retryCiFailureForPr(input);
    expect(out).toEqual({ kind: 'dispatched', taskId: 'ci-task-1' });
    expect(insertedRows).toEqual([]);
    expect(mockObserveCiFailure.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws1', prNumber: 7, headSha: 'abc1234', maxAttempts: 3, source: 'cron:ci-red' });
  });

  it('a kernel refusal is a skip the sweep understands, still with no legacy insert', async () => {
    kernelSeen = { handled: true, attemptTaskId: null, result: { result: 'rejected', reason: 'fix_in_flight', current: { state: 'REPAIRING' } } };
    expect(await retryCiFailureForPr(input)).toEqual({ kind: 'skipped', reason: 'fix_in_flight' });
    kernelSeen = { handled: true, attemptTaskId: null, result: { result: 'applied', decision: { toState: 'ESCALATED' } } };
    expect(await retryCiFailureForPr(input)).toEqual({ kind: 'skipped', reason: 'retries_exhausted' });
    expect(insertedRows).toEqual([]);
  });

  it('maps every kernel answer onto a CI-door outcome', () => {
    expect(kernelCiOutcome({ result: { result: 'applied', decision: { toState: 'REPAIRING' } }, attemptTaskId: null })).toMatchObject({ kind: 'skipped', reason: 'fix_in_flight' });
    expect(kernelCiOutcome({ result: { result: 'applied', decision: { toState: 'CHANGES_REQUESTED' } } })).toMatchObject({ reason: 'fix_in_flight' });
    expect(kernelCiOutcome({ result: { result: 'stale', reason: 'state_not_allowed', current: { state: 'WORKING' } } })).toMatchObject({ reason: 'fix_in_flight' });
    expect(kernelCiOutcome({ result: { result: 'stale', reason: 'state_not_allowed', current: { state: 'ESCALATED' } } })).toMatchObject({ reason: 'kernel_owned' });
    expect(kernelCiOutcome({ result: { result: 'stale', reason: 'head_not_current', current: { state: 'AWAITING_REVIEW' } } })).toMatchObject({ reason: 'kernel_owned' });
  });
});

describe('legacy CI budget: allocation is consumption, never author or context.iteration', () => {
  it('an owner context.iteration does not shorten or extend the budget; the filed rows do', async () => {
    kernelSeen = { handled: false };
    insertedRows = [];
    failedJobNames = ['Build'];
    workerRow = {
      id: 'w1', branch: 'buildd/x', prNumber: 7, prLifecycleStatus: 'open',
      task: { id: 't1', title: 'Do it', description: null, workspaceId: 'ws1', missionId: null, status: 'completed', context: { iteration: 9 }, result: null },
    };
    const out = await retryCiFailureForPr(input);
    expect(out.kind).toBe('dispatched');
    expect(insertedRows[0].context).toMatchObject({ iteration: 1 });
    expect(insertedRows[0].context.foreign_head_sha).toBeUndefined();
  });
});
