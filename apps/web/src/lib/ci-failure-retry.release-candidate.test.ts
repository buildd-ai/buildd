/**
 * A red frozen release candidate never gets a CI-fix attempt pushed to its own
 * branch (task 7f71c3bb): the fix is filed against the branch the candidate was
 * cut from, once per candidate head, and the kernel door is never asked.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

let workerRow: any = null;
let insertedRows: any[] = [];
let workspaceRow: any = null;
let markerRows: Array<{ id: string }> = [{ id: 't1' }];
const updates: Array<{ set: any; where: any }> = [];
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: async () => workerRow },
      workspaces: { findFirst: async () => workspaceRow },
    },
    select: () => ({ from: () => ({ where: async () => [] }) }),
    update: () => ({
      set: (set: any) => ({
        where: (where: any) => {
          updates.push({ set, where });
          return { returning: async () => markerRows };
        },
      }),
    }),
    insert: () => ({
      values: (v: any) => ({
        returning: async () => {
          const row = { id: `new-${insertedRows.length + 1}`, ...v };
          insertedRows.push(row);
          return [row];
        },
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
let prGate: any = null;
mock.module('@/lib/ci-failure-inspect', () => ({
  checkPrIsDraft: async () => false,
  fetchPrRetryGate: async () => prGate,
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
const activity: any[] = [];
mock.module('@/lib/pr-activity-comment', () => ({ appendPrActivity: async (p: any) => { activity.push(p); return {}; }, taskActivityUrl: (id: string) => `/t/${id}` }));
mock.module('@/lib/pr-review-request', () => ({ resolveOrAdoptPrOwner: async () => ({ ownerWorker: { id: 'w0' } }) }));
mock.module('@/lib/gate-ledger', () => ({
  GATE_SLUGS: new Proxy({}, { get: (_t, k) => String(k) }),
  gateFrictionSignature: () => 'sig',
  gateCallerOrigin: () => 'system',
  fireGateEvent: (e: any) => { gateEvents.push(e); return 'gate-id'; },
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
const gateEvents: any[] = [];
let kernelSeen: any = { handled: false };
const mockObserveCiFailure = mock(async (_p: any, _c?: any) => kernelSeen);
mock.module('@/lib/workflow/seam', () => ({ observeCiFailure: mockObserveCiFailure }));
// T10 goes through the one client (AC-9): the kernel's door, not the seam.
const realKernelClient = await import('@/lib/workflow/kernel-client');
mock.module('@/lib/workflow/kernel-client', () => ({ ...realKernelClient, observeCiFailure: mockObserveCiFailure }));
mock.module('@/lib/policy-overrides', () => ({ policyValue: () => 3, POLICY_DEFAULTS: { maxCiRetries: 3 } }));

const { retryCiFailureForPr } = await import('./ci-failure-retry');

const meta = {
  schema: 1, version: '1.2.3', branch: 'release/v1.2.3', sourceRef: 'dev', sourceSha: 'src-sha',
  candidateSha: 'cand-sha', baseRef: 'main', baseSha: 'base-sha', previousTag: 'v1.2.2',
  amendment: 0, previousCandidateSha: null, supersedes: null, cutAt: '2026-01-01T00:00:00Z',
};
const candidateGate = (over: Record<string, unknown> = {}) => ({
  draft: false, closed: false, merged: false, headRef: 'release/v1.2.3', baseRef: 'main',
  release: {
    headRef: 'release/v1.2.3', baseRef: 'main', headSha: 'cand-sha', author: 'github-actions[bot]',
    headRepoFullName: 'o/r', baseRepoFullName: 'o/r',
    body: `Release\n\n<!-- release-candidate ${JSON.stringify(meta)} -->`,
    ...over,
  },
});
const releaseConfig = {
  enabled: true, strategy: 'workflow_dispatch', prodBranch: 'main',
  candidate: { branches: ['release/v*'], sourceBranch: 'dev', authors: ['github-actions[bot]'] },
};
const input = { repoFullName: 'o/r', prNumber: 76, headSha: 'cand-sha', installationId: 1, surface: 'webhook:check_suite' as const };

describe('retryCiFailureForPr on a red frozen release candidate', () => {
  beforeEach(() => {
    insertedRows = [];
    updates.length = 0;
    activity.length = 0;
    gateEvents.length = 0;
    markerRows = [{ id: 't1' }];
    failedJobNames = ['Integration'];
    kernelSeen = { handled: true, attemptTaskId: 'k1', result: { result: 'applied', decision: { toState: 'REPAIRING' } } };
    mockObserveCiFailure.mockClear();
    mockWakeTask.mockClear();
    prGate = candidateGate();
    workspaceRow = { id: 'ws1', name: 'ws', gitConfig: {}, releaseConfig };
    workerRow = {
      id: 'w1', branch: 'release/v1.2.3', prNumber: 76, prLifecycleStatus: 'open',
      task: { id: 't1', title: 'Release v1.2.3', description: null, workspaceId: 'ws1', missionId: null, status: 'completed', context: { adoptedPr: true }, result: null },
    };
  });

  it('files one fix against the source branch, never a head-branch attempt, and never asks the kernel', async () => {
    const out = await retryCiFailureForPr(input);
    expect(out).toMatchObject({ kind: 'skipped', reason: 'release_candidate' });
    expect(mockObserveCiFailure).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(1);
    const row = insertedRows[0];
    expect(row.context.baseBranch).toBe('dev');
    expect(row.context.resumeBranch).toBeUndefined();
    expect(row.context.repairTarget).toBeUndefined();
    expect(row.ciRetryPrNumber).toBeUndefined();
    expect(row.parentTaskId).toBeUndefined();
    expect(row.taskClass).toBeUndefined();
    expect(row.status).toBe('pending');
    expect(mockWakeTask).toHaveBeenCalledTimes(1);
    // Once per candidate head: the marker is claimed atomically on the owner task.
    const q = new PgDialect().sqlToQuery(updates[0].where);
    expect(q.sql).toMatch(/coalesce\("tasks"\."context"->>\$\d+, ''\) <> \$\d+/);
    expect(q.params).toContain('cand-sha');
    expect(activity[0].entry.kind).toBe('ci_fixing');
    expect(gateEvents.at(-1).detail).toMatchObject({ skipReason: 'release_candidate', fixTaskId: row.id });
  });

  it('a second red report on the same candidate head files nothing', async () => {
    markerRows = [];
    const out = await retryCiFailureForPr(input);
    expect(out).toMatchObject({ kind: 'skipped', reason: 'release_candidate' });
    expect(insertedRows).toHaveLength(0);
    expect(mockObserveCiFailure).not.toHaveBeenCalled();
  });

  it('a candidate whose head was pushed over gets no fix and no push, only the recorded reason', async () => {
    prGate = candidateGate({ headSha: 'pushed-over' });
    const out = await retryCiFailureForPr({ ...input, headSha: 'pushed-over' });
    expect(out).toMatchObject({ kind: 'skipped', reason: 'release_candidate' });
    expect(insertedRows).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(mockObserveCiFailure).not.toHaveBeenCalled();
    expect(gateEvents.at(-1).detail).toMatchObject({ skipReason: 'release_candidate', candidateRejection: 'candidate_sha_moved' });
  });

  it('an ordinary PR in the same workspace still takes the normal path', async () => {
    prGate = { draft: false, closed: false, merged: false, headRef: 'buildd/x', baseRef: 'dev', release: { headRef: 'buildd/x', baseRef: 'dev' } };
    const out = await retryCiFailureForPr({ ...input, headSha: 'abc' });
    expect(out).toEqual({ kind: 'dispatched', taskId: 'k1' });
    expect(mockObserveCiFailure).toHaveBeenCalledTimes(1);
  });
});
