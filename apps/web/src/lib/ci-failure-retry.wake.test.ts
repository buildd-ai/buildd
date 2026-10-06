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
  fetchCommitAuthor: async () => ({ login: 'buildd-bot', email: null, name: null }),
  isBuilddWorkerCommit: () => true,
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

const { retryCiFailureForPr } = await import('./ci-failure-retry');

const input = { repoFullName: 'o/r', prNumber: 7, headSha: 'abc1234', installationId: 1, surface: 'cron:ci-red' as const };

describe('retryCiFailureForPr wakes', () => {
  beforeEach(() => {
    mockWakeTask.mockClear();
    mockAnnounceTaskCreated.mockClear();
    insertedRows = [];
    failedJobNames = ['Build'];
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
