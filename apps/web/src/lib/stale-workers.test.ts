import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { WORKER_STALE_REAP_MS } from '@buildd/shared';

// --- Mocks ---
const mockWorkersFindMany = mock(() => [] as any[]);
const mockTasksFindFirst = mock(() => null as any);
const mockTasksFindMany = mock(() => [] as any[]);
// cleanupUnresumedAnswers claims its worker with a returning CAS while every
// other caller just awaits the update, so its own beforeEach installs a
// `where` that is both thenable and exposes `.returning()`.
let workersUpdateReturning: any[] = [{ id: 'worker-1' }];
const capturedWorkerUpdates: any[] = [];
const mockWorkersUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));
const mockTasksUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));
const mockTasksInsert = mock(() => ({
  values: mock(() => ({
    returning: mock(() => [{ id: 'new-task-id' }]),
  })),
}));
let capturedAccountsSet: any = null;
const mockAccountsUpdate = mock(() => ({
  set: mock((vals: any) => {
    capturedAccountsSet = vals;
    return { where: mock(() => Promise.resolve()) };
  }),
}));
// Exposed so tests can override section-2 (heartbeat-expiry) behaviour.
// Default: returns a fresh heartbeat → section 2 does NOT fire in most tests.
const mockWorkerHeartbeatsFindFirst = mock(() => ({ id: 'hb-1' }));
let capturedInsertValues: any = null;
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      tasks: { findFirst: mockTasksFindFirst, findMany: mockTasksFindMany },
      missions: { findFirst: mock(() => null) },
      workerHeartbeats: { findFirst: mockWorkerHeartbeatsFindFirst },
    },
    update: (table: any) => {
      if (table === 'workers') return mockWorkersUpdate();
      if (table === 'accounts') return mockAccountsUpdate();
      return mockTasksUpdate();
    },
    insert: (table: any) => table === 'missionNotes'
      ? {
          values: mock((values: any) => {
            capturedInsertValues = values;
            return Promise.resolve();
          }),
        }
      : mockTasksInsert(),
    // resolveCompletedTask (called internally) uses db.select().from().where()
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
  },
}));

// Mock pusher so resolveCompletedTask (called at end of cleanup) is a no-op
mock.module('@/lib/pusher', () => ({
  triggerEvent: mock(() => Promise.resolve()),
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: { CHILDREN_COMPLETED: 'task:children_completed', TASK_UNBLOCKED: 'task:unblocked' },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  or: (...args: any[]) => ({ args, type: 'or' }),
  lt: (field: any, value: any) => ({ field, value, type: 'lt' }),
  gt: (field: any, value: any) => ({ field, value, type: 'gt' }),
  ne: (field: any, value: any) => ({ field, value, type: 'ne' }),
  not: (expr: any) => ({ expr, type: 'not' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' }),
  notInArray: (field: any, values: any[]) => ({ field, values, type: 'notInArray' }),
  isNotNull: (field: any) => ({ field, type: 'isNotNull' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: 'workers',
  tasks: 'tasks',
  workerHeartbeats: { accountId: 'accountId', lastHeartbeatAt: 'lastHeartbeatAt' },
  missionNotes: 'missionNotes',
  accounts: 'accounts',
}));

const mockGetWorkerDeliverableArtifactCount = mock(() => Promise.resolve(0));
const mockCheckWorkerDeliverables = mock(() => ({
  hasPR: false, hasArtifacts: false, hasStructuredOutput: false, hasCommits: false, hasAny: false, details: 'none',
}));
const mockGetLatestWorkerArtifactWithStructuredOutput = mock(() => Promise.resolve(null));
mock.module('@/lib/worker-deliverables', () => ({
  checkWorkerDeliverables: mockCheckWorkerDeliverables,
  getWorkerDeliverableArtifactCount: mockGetWorkerDeliverableArtifactCount,
  getLatestWorkerArtifactWithStructuredOutput: mockGetLatestWorkerArtifactWithStructuredOutput,
}));

// Workflow kernel (lib/workflow/*; real-SQL suite in apps/web/tests/db/workflow-seam.test.ts).
let kernelOwned: string | null = null;
// AC-1 slice 5: whether the reaped worker is the owner task's current attempt (real SQL in
// apps/web/tests/db/reaper-attempt-end.test.ts).
let reapedIsCurrent = true;
const mockReapedOwnerAttemptIsCurrent = mock(async (_taskId: string, _workerId: string) => reapedIsCurrent);
mock.module('@/lib/workflow/authority', () => ({
  kernelDeliveryById: async () => kernelOwned,
  reapedOwnerAttemptIsCurrent: mockReapedOwnerAttemptIsCurrent,
  reapedOwnerAttemptIsCurrentSql: (workerId: string) => ({ reapedOwnerAttemptIsCurrent: workerId }),
}));
const mockWorkflowAttemptEnded = mock(async (_p: any, _c?: any) => ({ handled: true }));
const mockProjectOwnerEnd = mock(async (_p: any) => 'failed' as const);
const mockProjectRequeue = mock(async (_p: any) => true);
mock.module('@/lib/workflow/seam', () => ({ attemptEnded: mockWorkflowAttemptEnded, projectOwnerEnd: mockProjectOwnerEnd, projectRequeue: mockProjectRequeue }));
// T4 goes through the one client (AC-9): the kernel's door, not the seam.
const realKernelClient = await import('@/lib/workflow/kernel-client');
// AC-1 slice 8: a kernel owner's requeue is AttemptRequeued, through the same client.
const mockWorkflowAttemptRequeued = mock(async (_p: any, _c?: any) => ({ handled: true, requeued: true }));
mock.module('@/lib/workflow/kernel-client', () => ({ ...realKernelClient, attemptEnded: mockWorkflowAttemptEnded, attemptRequeued: mockWorkflowAttemptRequeued }));

// Every requeue and continuation here wakes through the dispatch authority.
// Full export surface: mock.module is process-global.
const mockAnnounceTaskCreated = mock(async (_task: any, _workspace: any) => {});
const mockWakeTask = mock(async (_taskId: string, _cause: string, _opts?: any) => {});
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

const mockClearWorkerMessages = mock(async (_taskId: string, _ids: string[]) => true);
mock.module('@buildd/core/worker-messages', () => ({
  clearWorkerMessages: mockClearWorkerMessages,
  enqueueWorkerMessage: mock(async () => true),
  buildEnqueueContextSql: mock(() => ({})),
  buildClearContextSql: mock(() => ({})),
}));

// Both answer sweeps reopen the answered worker's own task through one writer
// (lib/answer-attempt.ts; real SQL in apps/web/tests/db/answered-attempt-mission.test.ts).
const mockReopen = mock(async (input: any): Promise<any> => ({ reopened: true, taskId: input.taskId, entryId: 'entry-1' }));
mock.module('@/lib/answer-attempt', () => ({ reopenTaskForAnsweredAttempt: mockReopen }));

import { cleanupStaleWorkers, cleanupStuckWaitingInput, cleanupUnresumedAnswers, cleanupUnreadInteractiveAnswers, resolveTasksOfReapedWorkers } from './stale-workers';
import { INTERACTIVE_ABANDONED_ERROR } from './worker-exit-taxonomy';
import { capturedWhere } from '@buildd/core/db/relational-sql';

// A tasks update whose `.where()` is awaitable and also supports `.returning()`
// (the same-task requeue moves a guarded row and reads it back).
function taskUpdateChain(sets: any[] = [], rows: any[] = [{ id: 'task-1' }]) {
  return {
    set: mock((vals: any) => {
      sets.push(vals);
      return { where: mock(() => Object.assign(Promise.resolve(), { returning: async () => rows })) };
    }),
  };
}
// The JSON patch the requeue merges into the live context.
function requeuedPatch(set: any) {
  const json = set.context.values.find((v: unknown) => typeof v === 'string' && v.startsWith('{'));
  return JSON.parse(json);
}

describe('cleanupStuckWaitingInput', () => {
  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockTasksInsert.mockReset();
    // Default chains
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
    mockTasksUpdate.mockReturnValue(taskUpdateChain());
    mockTasksInsert.mockReturnValue({
      values: mock(() => ({
        returning: mock(() => [{ id: 'new-task-id' }]),
      })),
    });
  });

  // ask_human parks an interactive (runner = 'mcp') worker on a question. The
  // runner rules skip those rows, so this sweep is their only expiry: it must
  // not exclude them.
  it('covers interactive workers parked on a question, not only runner ones', async () => {
    mockWorkersFindMany.mockResolvedValue([]);
    await cleanupStuckWaitingInput('account-1');
    // drizzle-orm is stubbed in this file: predicates are plain objects.
    const where = (mockWorkersFindMany.mock.calls[0] as any)[0].where;
    const nodes: any[] = [];
    const walk = (n: any) => { if (!n || typeof n !== 'object') return; nodes.push(n); (n.args ?? []).forEach(walk); };
    walk(where);
    expect(nodes.some(n => n.type === 'eq' && n.value === 'waiting_input')).toBe(true);
    expect(nodes.some(n => n.type === 'ne' && n.value === 'mcp')).toBe(false);
    expect(JSON.stringify(nodes.map(n => n.type))).not.toContain('sql');
  });

  // A question parked on a task someone already cancelled: the timeout ends
  // the worker, but must not rewrite the cancel as a failure or file a retry
  // of work the person stopped (late retry/reclaim).
  it('closes a question on a cancelled task without failing the task or filing a retry', async () => {
    mockWorkersFindMany.mockResolvedValue([{
      id: 'w1', taskId: 'task-1', accountId: 'account-1', runner: 'http://runner', status: 'waiting_input',
      updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      waitingFor: { type: 'question', prompt: 'Which repo?' }, task: { missionId: null, mission: null },
    }]);
    mockTasksFindFirst.mockResolvedValue({
      id: 'task-1', workspaceId: 'ws-1', title: 'Add a panel', description: 'd', status: 'cancelled',
      priority: 0, category: null, project: null, context: {}, requiredCapabilities: [], missionId: null,
      runnerPreference: 'any', mode: 'execution', outputRequirement: 'auto', outputSchema: null,
    });

    const result = await cleanupStuckWaitingInput('account-1');

    expect(result.failedWorkers).toBe(1);
    expect(result.retriedTasks).toBe(0);
    expect(mockTasksUpdate).not.toHaveBeenCalled();
    expect(mockTasksInsert).not.toHaveBeenCalled();
  });

  // An interactive session's question that expires unanswered must not be
  // handed to a background runner: the person chose to run this work in their
  // own session, and a cloned retry on a runner mission is exactly the
  // duplicate a person then finds rebuilt behind their back. Only a local
  // mission's retry is safe, because only a person's session can claim it.
  describe('an interactive (runner = mcp) session whose question expired', () => {
    const interactiveTask = (missionId: string | null) => ({
      id: 'task-1', workspaceId: 'ws-1', title: 'Fix the bug', description: 'Fix the login bug', priority: 0,
      category: 'bug', project: 'web', context: {}, requiredCapabilities: [], missionId,
      runnerPreference: 'any', mode: 'execution', outputRequirement: 'auto', outputSchema: null,
    });
    const stuck = (mission: { executor: string } | null) => ({
      id: 'w1', taskId: 'task-1', runner: 'mcp', status: 'waiting_input',
      updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      waitingFor: { type: 'question', prompt: 'What color?' },
      task: { missionId: mission ? 'mission-1' : null, mission },
    });

    function captureWorkerSet() {
      const sets: any[] = [];
      mockWorkersUpdate.mockReturnValue({
        set: mock((vals: any) => { sets.push(vals); return { where: mock(() => Promise.resolve()) }; }),
      });
      return sets;
    }

    it('reads each worker\'s runner and its mission executor', async () => {
      mockWorkersFindMany.mockResolvedValue([]);
      await cleanupStuckWaitingInput('account-1');
      const q = (mockWorkersFindMany.mock.calls[0] as any)[0];
      expect(q.columns.runner).toBe(true);
      expect(q.with.task.with.mission.columns.executor).toBe(true);
    });

    it('standalone: fails the worker and the task with a clear reason, and files no retry', async () => {
      mockWorkersFindMany.mockResolvedValue([stuck(null)]);
      mockTasksFindFirst.mockResolvedValue(interactiveTask(null));
      const sets = captureWorkerSet();
      mockTasksInsert.mockClear();

      const result = await cleanupStuckWaitingInput('account-1');

      expect(result.failedWorkers).toBe(1);
      expect(result.retriedTasks).toBe(0);
      expect(mockTasksInsert).not.toHaveBeenCalled();
      expect(sets[0].status).toBe('failed');
      expect(sets[0].exitCause).toBe('needs_input');
      expect(sets[0].error).toContain('interactive session');
      expect(sets[0].error).toContain('not retried');
    });

    it('on a runner mission: files no retry a background runner could claim', async () => {
      mockWorkersFindMany.mockResolvedValue([stuck({ executor: 'runner' })]);
      mockTasksFindFirst.mockResolvedValue(interactiveTask('mission-1'));
      captureWorkerSet();
      mockTasksInsert.mockClear();

      const result = await cleanupStuckWaitingInput('account-1');

      expect(result.retriedTasks).toBe(0);
      expect(mockTasksInsert).not.toHaveBeenCalled();
    });

    it('on a local mission: requeues the same task, which only a person\'s session can claim', async () => {
      mockWorkersFindMany.mockResolvedValue([stuck({ executor: 'local' })]);
      mockTasksFindFirst.mockResolvedValue(interactiveTask('mission-1'));
      captureWorkerSet();
      mockTasksInsert.mockClear();
      const taskSets: any[] = [];
      mockTasksUpdate.mockReturnValue(taskUpdateChain(taskSets));

      const result = await cleanupStuckWaitingInput('account-1');

      expect(result.retriedTasks).toBe(1);
      expect(mockTasksInsert).not.toHaveBeenCalled();
      expect(taskSets).toHaveLength(1);
      expect(taskSets[0].status).toBe('pending');
    });
  });

  it('does nothing when no stuck waiting_input workers exist', async () => {
    mockWorkersFindMany.mockResolvedValue([]);

    const result = await cleanupStuckWaitingInput('account-1');
    expect(result.failedWorkers).toBe(0);
    expect(result.retriedTasks).toBe(0);
  });

  it('superseded_by_recovery closes the named question now: worker and task failed, no clone, history kept (§16.4)', async () => {
    const fresh = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes: far below any timeout
    const question = { type: 'question', prompt: 'How should I proceed?' };
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w-audit', taskId: 'task-audit', accountId: 'account-1', status: 'waiting_input', updatedAt: fresh, waitingFor: question, task: { missionId: 'm-1' } },
    ]);
    mockTasksFindFirst.mockResolvedValue({ id: 'task-audit', workspaceId: 'ws-1', title: '[surface audit] x', description: '', context: {}, missionId: 'm-1' });
    let workerSet: any = null;
    mockWorkersUpdate.mockReturnValue({ set: mock((v: any) => { workerSet = v; return { where: mock(() => Promise.resolve()) }; }) });

    const result = await cleanupStuckWaitingInput('account-1', { reason: 'superseded_by_recovery', workerIds: ['w-audit'] });

    expect(result).toEqual({ failedWorkers: 1, retriedTasks: 0 });
    expect(workerSet.status).toBe('failed');
    expect(workerSet.error).toStartWith('superseded_by_recovery');
    // The question stays on the row as history: never cleared.
    expect('waitingFor' in workerSet).toBe(false);
    expect(mockTasksUpdate).toHaveBeenCalledTimes(1);
    expect(mockTasksInsert).not.toHaveBeenCalled();
  });

  it('fails workers stuck in waiting_input for 24+ hours', async () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', taskId: 'task-1', status: 'waiting_input', updatedAt: staleDate, waitingFor: { type: 'question', prompt: 'What color?' } },
    ]);

    mockTasksFindFirst.mockResolvedValue({
      id: 'task-1',
      workspaceId: 'ws-1',
      title: 'Fix the bug',
      description: 'Fix the login bug',
      priority: 0,
      category: 'bug',
      project: 'web',
      context: {},
      requiredCapabilities: [],
      missionId: null,
      runnerPreference: 'any',
      mode: 'execution',
      outputRequirement: 'auto',
      outputSchema: null,
    });

    const result = await cleanupStuckWaitingInput('account-1');

    expect(result.failedWorkers).toBe(1);
    expect(result.retriedTasks).toBe(1);
  });

  // A worker timing out unanswered is not a code defect — it must carry its
  // own exit cause so it is excluded from the failure rate / signature
  // ranking (failure-analytics.ts) rather than defaulting to code_failure.
  it('books the timed-out worker as exitCause needs_input, not code_failure', async () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', taskId: 'task-1', status: 'waiting_input', updatedAt: staleDate, waitingFor: { type: 'question', prompt: 'What color?' } },
    ]);

    mockTasksFindFirst.mockResolvedValue({
      id: 'task-1',
      workspaceId: 'ws-1',
      title: 'Fix the bug',
      description: 'Fix the login bug',
      priority: 0,
      category: 'bug',
      project: 'web',
      context: {},
      requiredCapabilities: [],
      missionId: null,
      runnerPreference: 'any',
      mode: 'execution',
      outputRequirement: 'auto',
      outputSchema: null,
    });

    let workerUpdateSet: any = null;
    mockWorkersUpdate.mockReturnValue({
      set: mock((vals: any) => {
        workerUpdateSet = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStuckWaitingInput('account-1');

    expect(workerUpdateSet).not.toBeNull();
    expect(workerUpdateSet.status).toBe('failed');
    expect(workerUpdateSet.exitCause).toBe('needs_input');
  });

  it('ends a kernel fix attempt through the seam (lost) and files no unlinked clone', async () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', taskId: 'task-1', status: 'waiting_input', updatedAt: staleDate, waitingFor: { type: 'question', prompt: 'q' } },
    ]);
    mockTasksFindFirst.mockResolvedValue({
      id: 'task-1', workspaceId: 'ws-1', title: 'Fix', description: 'd', priority: 0, context: { workflowAttemptId: 'a1' },
      deliveryId: 'd1', deliveryRole: 'review_fix', requiredCapabilities: [], missionId: null,
    });
    kernelOwned = 'd1';
    mockWorkflowAttemptEnded.mockClear();
    mockTasksInsert.mockClear();
    try {
      const result = await cleanupStuckWaitingInput('account-1');
      expect(result.retriedTasks).toBe(0);
      expect(mockTasksInsert).not.toHaveBeenCalled();
      expect(mockWorkflowAttemptEnded).toHaveBeenCalledTimes(1);
      expect(mockWorkflowAttemptEnded.mock.calls[0][0]).toMatchObject({
        task: { id: 'task-1', deliveryId: 'd1', deliveryRole: 'review_fix' },
        workerId: 'w1',
        status: 'lost',
      });
      // Through the kernel client as buildd's own sweep (AC-9).
      expect(mockWorkflowAttemptEnded.mock.calls[0][1]).toEqual({ principal: { kind: 'system', id: 'system:sweep:waiting-input' } });
    } finally {
      kernelOwned = null;
    }
  });

  // Final kernel audit (task 708a55c0): the sweep sent localHeadSha null and
  // commitCount 0 whatever the worker had, so the reducer read an owner attempt
  // with unpushed commits as safe and handed the remote head to review instead
  // of AWAITING_PUSH (§9, AC-10). It now passes what the worker reported.
  it('passes a kernel owner attempt\'s local head and commit count to the seam', async () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', taskId: 'task-1', status: 'waiting_input', updatedAt: staleDate, waitingFor: { type: 'question', prompt: 'q' }, lastCommitSha: 'local-h2', commitCount: 3 },
    ]);
    mockTasksFindFirst.mockResolvedValue({
      id: 'task-1', workspaceId: 'ws-1', title: 'Build', description: 'd', priority: 0, context: {},
      deliveryId: 'd1', deliveryRole: 'owner', requiredCapabilities: [], missionId: null,
    });
    kernelOwned = 'd1';
    mockWorkflowAttemptEnded.mockClear();
    mockWorkersFindMany.mockClear();
    try {
      await cleanupStuckWaitingInput('account-1');
      expect(mockWorkflowAttemptEnded).toHaveBeenCalledTimes(1);
      expect(mockWorkflowAttemptEnded.mock.calls[0][0]).toMatchObject({
        task: { id: 'task-1', deliveryId: 'd1', deliveryRole: 'owner' },
        workerId: 'w1',
        status: 'lost',
        localHeadSha: 'local-h2',
        commitCount: 3,
      });
      // The query must select them, or the values above never reach the seam in production.
      const cols = (mockWorkersFindMany.mock.calls[0] as any[])[0]?.columns ?? {};
      expect(cols).toMatchObject({ lastCommitSha: true, commitCount: true });
    } finally {
      kernelOwned = null;
    }
  });

  it('AC-1 slice 5: an owner attempt\'s task is not failed by the sweep; the kernel\'s end projects it, and a stale question ends nothing', async () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const ownerTask = {
      id: 'task-1', workspaceId: 'ws-1', status: 'assigned', title: 'Build', description: 'd', priority: 0, context: {},
      deliveryId: 'd1', deliveryRole: 'owner', requiredCapabilities: [], missionId: null,
    };
    kernelOwned = 'd1';
    const taskSets: any[] = [];
    mockTasksUpdate.mockReturnValue({ set: mock((vals: any) => { taskSets.push(vals); return { where: mock(() => Promise.resolve()) }; }) });
    try {
      for (const current of [true, false]) {
        reapedIsCurrent = current;
        taskSets.length = 0;
        mockWorkflowAttemptEnded.mockClear();
        mockProjectOwnerEnd.mockClear();
        mockWorkersFindMany.mockResolvedValue([
          { id: 'w1', taskId: 'task-1', status: 'waiting_input', updatedAt: staleDate, waitingFor: { type: 'question', prompt: 'q' } },
        ]);
        mockTasksFindFirst.mockResolvedValue(ownerTask);
        await cleanupStuckWaitingInput('account-1');
        expect(taskSets.some((v) => 'status' in v)).toBe(false);
        expect(mockWorkflowAttemptEnded).toHaveBeenCalledTimes(current ? 1 : 0);
        expect(mockProjectOwnerEnd).toHaveBeenCalledTimes(current ? 1 : 0);
        if (current) expect(mockProjectOwnerEnd.mock.calls[0][0]).toEqual({ deliveryId: 'd1', taskId: 'task-1', workerId: 'w1', status: 'lost' });
      }
    } finally {
      kernelOwned = null;
      reapedIsCurrent = true;
    }
  });

  it('does not touch waiting_input workers under 24 hours old', async () => {
    const recentDate = new Date(Date.now() - 12 * 60 * 60 * 1000); // 12 hours ago
    mockWorkersFindMany.mockResolvedValue([]); // Query with lt(24h) returns nothing

    const result = await cleanupStuckWaitingInput('account-1');
    expect(result.failedWorkers).toBe(0);
    expect(result.retriedTasks).toBe(0);
  });

  const plainTask = (over: Record<string, unknown> = {}) => ({
    id: 'task-1', workspaceId: 'ws-1', title: 'Fix the bug', description: 'Fix the login bug', status: 'in_progress',
    priority: 0, category: 'bug', project: 'web', context: { iteration: 1 }, requiredCapabilities: [],
    missionId: null, runnerPreference: 'any', mode: 'execution', outputRequirement: 'auto', outputSchema: null, ...over,
  });

  // AC-58: the last place a parked task changed identity. A question nobody
  // answered requeues the SAME task: no clone, the mission grows no task, the
  // original is never left `failed`, and its description is not rewritten.
  it('requeues the same task for a new attempt: no clone, status pending, description untouched', async () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', taskId: 'task-1', status: 'waiting_input', updatedAt: staleDate, waitingFor: { type: 'question', prompt: 'Need clarification' } },
    ]);
    mockTasksFindFirst.mockResolvedValue(plainTask());
    const taskSets: any[] = [];
    mockTasksUpdate.mockReturnValue(taskUpdateChain(taskSets));
    mockTasksInsert.mockClear();
    mockWakeTask.mockClear();

    const result = await cleanupStuckWaitingInput('account-1');

    expect(result).toMatchObject({ failedWorkers: 1, retriedTasks: 1 });
    expect(mockTasksInsert).not.toHaveBeenCalled();
    // One task write, and it is the requeue: the task is never failed.
    expect(taskSets).toHaveLength(1);
    expect(taskSets[0]).toMatchObject({ status: 'pending', claimedBy: null, claimedAt: null, expiresAt: null });
    for (const k of ['title', 'description', 'roleSlug', 'dependsOn', 'parentTaskId', 'missionId']) expect(k in taskSets[0]).toBe(false);
    // Woken as a requeue of the SAME task, not left to a poll.
    expect(mockWakeTask.mock.calls).toEqual([['task-1', 'task.requeued']]);
  });

  it('carries the question and the do-not-ask-again guidance in context, bumping the iteration', async () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', taskId: 'task-1', status: 'waiting_input', updatedAt: staleDate, branch: 'buildd/task-1-slug',
        waitingFor: { type: 'question', prompt: 'What database should I use?', options: ['PostgreSQL', 'MySQL'] } },
    ]);
    mockTasksFindFirst.mockResolvedValue(plainTask({ context: { iteration: 2 } }));
    const taskSets: any[] = [];
    mockTasksUpdate.mockReturnValue(taskUpdateChain(taskSets));

    await cleanupStuckWaitingInput('account-1');

    const patch = requeuedPatch(taskSets[0]);
    expect(patch.unansweredQuestion).toMatchObject({ workerId: 'w1', prompt: 'What database should I use?', options: ['PostgreSQL', 'MySQL'] });
    expect(patch.iteration).toBe(3);
    expect(patch.failureContext).toBeDefined();
    // The branch is resumed, not treated as a declared base.
    expect(patch.baseBranch).toBe('buildd/task-1-slug');
    expect(patch.resumeBranch).toBe('buildd/task-1-slug');
  });

  it('a requeue guarded out (the task closed in the window) is not counted and wakes nothing', async () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', taskId: 'task-1', status: 'waiting_input', updatedAt: staleDate, waitingFor: null },
    ]);
    mockTasksFindFirst.mockResolvedValue(plainTask());
    mockTasksUpdate.mockReturnValue(taskUpdateChain([], []));
    mockWakeTask.mockClear();

    const result = await cleanupStuckWaitingInput('account-1');

    expect(result.retriedTasks).toBe(0);
    expect(mockWakeTask).not.toHaveBeenCalled();
  });

  it('a mission task keeps its slot: the original id is requeued, nothing inserted', async () => {
    const staleDate = new Date(Date.now() - 5 * 60 * 60 * 1000);
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', taskId: 'task-1', status: 'waiting_input', updatedAt: staleDate, waitingFor: null,
        task: { missionId: 'mission-1', mission: { executor: 'runner' } } },
    ]);
    mockTasksFindFirst.mockResolvedValue(plainTask({
      missionId: 'mission-1', roleSlug: 'visual-auditor', dependsOn: ['builder-a'], parentTaskId: 'parent-1',
    }));
    const taskSets: any[] = [];
    mockTasksUpdate.mockReturnValue(taskUpdateChain(taskSets));
    mockTasksInsert.mockClear();

    const result = await cleanupStuckWaitingInput('account-1');

    expect(result.retriedTasks).toBe(1);
    expect(mockTasksInsert).not.toHaveBeenCalled();
    expect(taskSets).toHaveLength(1);
  });

  it('handles multiple stuck workers across different tasks', async () => {
    const staleDate = new Date(Date.now() - 30 * 60 * 60 * 1000);
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', taskId: 'task-1', status: 'waiting_input', updatedAt: staleDate, waitingFor: { type: 'question', prompt: 'Q1' } },
      { id: 'w2', taskId: 'task-2', status: 'waiting_input', updatedAt: staleDate, waitingFor: { type: 'question', prompt: 'Q2' } },
    ]);

    mockTasksFindFirst
      .mockResolvedValueOnce({
        id: 'task-1', workspaceId: 'ws-1', title: 'Task 1', description: 'Desc 1',
        priority: 0, category: null, project: null, context: {}, requiredCapabilities: [],
        missionId: null, runnerPreference: 'any', mode: 'execution', outputRequirement: 'auto', outputSchema: null,
      })
      .mockResolvedValueOnce({
        id: 'task-2', workspaceId: 'ws-1', title: 'Task 2', description: 'Desc 2',
        priority: 0, category: null, project: null, context: {}, requiredCapabilities: [],
        missionId: null, runnerPreference: 'any', mode: 'execution', outputRequirement: 'auto', outputSchema: null,
      })
    ;

    const result = await cleanupStuckWaitingInput('account-1');

    expect(result.failedWorkers).toBe(2);
    expect(result.retriedTasks).toBe(2);
  });

  it('cleans up mission tasks after 4 hours (shorter timeout)', async () => {
    // 5 hours ago — past the 4h mission threshold
    const staleDate = new Date(Date.now() - 5 * 60 * 60 * 1000);
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'w1', taskId: 'task-1', status: 'waiting_input', updatedAt: staleDate,
        waitingFor: { type: 'question', prompt: 'Which approach?' },
        task: { missionId: 'mission-1' },
      },
    ]);

    mockTasksFindFirst.mockResolvedValue({
      id: 'task-1', workspaceId: 'ws-1', title: 'Mission Task', description: 'Part of a mission',
      priority: 0, category: null, project: null, context: {}, requiredCapabilities: [],
      missionId: 'mission-1', runnerPreference: 'any', mode: 'execution', outputRequirement: 'auto', outputSchema: null,
    });

    const result = await cleanupStuckWaitingInput('account-1');

    // Mission task at 5h should be cleaned up (past 4h threshold)
    expect(result.failedWorkers).toBe(1);
    expect(result.retriedTasks).toBe(1);
  });

  it('does not clean up standalone tasks before 24 hours', async () => {
    // 5 hours ago — past mission threshold but NOT past standalone threshold
    const staleDate = new Date(Date.now() - 5 * 60 * 60 * 1000);
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'w1', taskId: 'task-1', status: 'waiting_input', updatedAt: staleDate,
        waitingFor: { type: 'question', prompt: 'Which approach?' },
        task: { missionId: null },  // standalone — no mission
      },
    ]);

    const result = await cleanupStuckWaitingInput('account-1');

    // Standalone task at 5h should NOT be cleaned up (needs 24h)
    expect(result.failedWorkers).toBe(0);
    expect(result.retriedTasks).toBe(0);
  });

  it('applies different timeouts for mixed mission and standalone tasks', async () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'w1', taskId: 'task-1', status: 'waiting_input', updatedAt: fiveHoursAgo,
        waitingFor: { type: 'question', prompt: 'Mission question' },
        task: { missionId: 'mission-1' },  // mission — 4h timeout
      },
      {
        id: 'w2', taskId: 'task-2', status: 'waiting_input', updatedAt: fiveHoursAgo,
        waitingFor: { type: 'question', prompt: 'Standalone question' },
        task: { missionId: null },  // standalone — 24h timeout
      },
    ]);

    mockTasksFindFirst.mockResolvedValue({
      id: 'task-1', workspaceId: 'ws-1', title: 'Mission Task', description: 'Part of mission',
      priority: 0, category: null, project: null, context: {}, requiredCapabilities: [],
      missionId: 'mission-1', runnerPreference: 'any', mode: 'execution', outputRequirement: 'auto', outputSchema: null,
    });

    const result = await cleanupStuckWaitingInput('account-1');

    // Only the mission task (w1) should be cleaned up, not the standalone (w2)
    expect(result.failedWorkers).toBe(1);
    expect(result.retriedTasks).toBe(1);
  });
});

describe('cleanupStuckWaitingInput — activeSessions seat release', () => {
  beforeEach(() => {
    capturedAccountsSet = null;
    mockWorkersFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockTasksInsert.mockReset();
    mockAccountsUpdate.mockReset();
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
    mockTasksUpdate.mockReturnValue(taskUpdateChain());
    mockTasksInsert.mockReturnValue({
      values: mock(() => ({ returning: mock(() => [{ id: 'new-task-id' }]) })),
    });
    mockAccountsUpdate.mockReturnValue({
      set: mock((vals: any) => {
        capturedAccountsSet = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    });
  });

  it('decrements activeSessions when a stuck waiting_input worker is cleaned up', async () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', taskId: 'task-1', accountId: 'account-1', status: 'waiting_input', updatedAt: staleDate, waitingFor: null, task: { missionId: null } },
    ]);
    mockTasksFindFirst.mockResolvedValue({
      id: 'task-1', workspaceId: 'ws-1', title: 'Fix bug', description: 'Fix the bug',
      priority: 0, category: null, project: null, context: {}, requiredCapabilities: [],
      missionId: null, runnerPreference: 'any', mode: 'execution', outputRequirement: 'auto', outputSchema: null,
    });

    await cleanupStuckWaitingInput('account-1');

    // activeSessions decrement must have been attempted for the worker's account
    expect(mockAccountsUpdate).toHaveBeenCalled();
    expect(capturedAccountsSet).not.toBeNull();
    expect(capturedAccountsSet.activeSessions).toBeDefined();
  });

  it('does not decrement activeSessions when no stuck workers exist', async () => {
    mockWorkersFindMany.mockResolvedValue([]);

    await cleanupStuckWaitingInput('account-1');

    expect(mockAccountsUpdate).not.toHaveBeenCalled();
  });
});

describe('cleanupStaleWorkers — pr_merged reaper exemption (B.3)', () => {
  // Simulates the de0357c2 scenario: worker declares pr_merged wait (condition_unmet),
  // 15+ minutes of silence, reaper leaves task alone. After expiry ceiling, reaper fails.
  const PR_MERGED_LOOP_CONFIG = {
    exitCondition: { type: 'pr_merged' },
    maxLoops: 6,
    waitExpiryMinutes: 240,
  };

  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockCheckWorkerDeliverables.mockReset();
    mockGetWorkerDeliverableArtifactCount.mockReset();
    mockGetLatestWorkerArtifactWithStructuredOutput.mockReset();
    mockGetWorkerDeliverableArtifactCount.mockResolvedValue(0);
    mockGetLatestWorkerArtifactWithStructuredOutput.mockResolvedValue(null);
    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: false, hasArtifacts: false, hasStructuredOutput: false, hasCommits: false, hasAny: false, details: 'none',
    });
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
    mockTasksUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
  });

  it('leaves a pr_merged condition_unmet task as pending when within the wait window', async () => {
    // Worker went stale (no update for 15+ min) but task is condition_unmet with pr_merged
    mockWorkersFindMany
      .mockResolvedValueOnce([{ id: 'w1', taskId: 'task-1', prUrl: null, prNumber: 42, commitCount: 1, branch: 'buildd/feat', error: null }])
      .mockResolvedValueOnce([])   // no other active workers
      .mockResolvedValueOnce([]);  // heartbeat orphans

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);

    // Task is condition_unmet with pr_merged; updatedAt is 2h ago (within 4h window)
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    mockTasksFindFirst
      .mockResolvedValueOnce({
        status: 'pending',
        context: {},
        category: null,
        loopConfig: PR_MERGED_LOOP_CONFIG,
        loopState: 'condition_unmet',
        updatedAt: twoHoursAgo,
      })
      .mockResolvedValueOnce({ parentTaskId: null }); // resolveCompletedTask dep resolution

    const taskUpdates: any[] = [];
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        taskUpdates.push(vals);
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStaleWorkers('account-1');

    // Task must NOT be failed or set to pending with a retry — reaper exemption applies
    expect(taskUpdates.filter(u => u.status === 'failed' || u.status === 'pending')).toHaveLength(0);
  });

  it('fails a pr_merged condition_unmet task when the wait ceiling is exceeded', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([{ id: 'w1', taskId: 'task-1', prUrl: null, prNumber: 42, commitCount: 1, branch: 'buildd/feat', error: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);

    // updatedAt is 5h ago — past the 240-min ceiling
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    mockTasksFindFirst
      .mockResolvedValueOnce({
        status: 'pending',
        context: {},
        category: null,
        loopConfig: PR_MERGED_LOOP_CONFIG,
        loopState: 'condition_unmet',
        updatedAt: fiveHoursAgo,
      })
      .mockResolvedValueOnce({ parentTaskId: null });

    let failedTaskUpdate: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        if (vals.status === 'failed') failedTaskUpdate = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStaleWorkers('account-1');

    // Task must be failed after expiry
    expect(failedTaskUpdate).not.toBeNull();
    expect(failedTaskUpdate.status).toBe('failed');
    expect(JSON.stringify(failedTaskUpdate.result)).toContain('PR merge wait expired');
  });

  it('exempts a task with pr_checks_green condition within wait expiry', async () => {
    // Similar to pr_merged: pr_checks_green tasks are exempt while waiting for webhook
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    mockWorkersFindMany
      .mockResolvedValueOnce([{ id: 'w1', taskId: 'task-1', prUrl: null, prNumber: 42, commitCount: 1, branch: 'buildd/feat', error: null }])
      .mockResolvedValueOnce([])   // no other active workers
      .mockResolvedValueOnce([]);  // heartbeat orphans

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst
      .mockResolvedValueOnce({
        status: 'pending',
        context: {},
        category: null,
        loopConfig: { exitCondition: { type: 'pr_checks_green' }, maxLoops: 3, waitExpiryMinutes: 240 },
        loopState: 'condition_unmet',
        updatedAt: twoHoursAgo,
      })
      .mockResolvedValueOnce({ parentTaskId: null }); // resolveCompletedTask dep resolution

    const taskUpdates: any[] = [];
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        taskUpdates.push(vals);
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStaleWorkers('account-1');

    // Task must NOT be failed or set to pending with a retry — reaper exemption applies
    expect(taskUpdates.filter(u => u.status === 'failed' || u.status === 'pending')).toHaveLength(0);
  });

  it('fails a task with pr_checks_green condition after wait expiry', async () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    mockWorkersFindMany
      .mockResolvedValueOnce([{ id: 'w1', taskId: 'task-1', prUrl: null, prNumber: 42, commitCount: 1, branch: 'buildd/feat', error: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);

    // updatedAt is 5h ago — past the 240-min ceiling
    mockTasksFindFirst
      .mockResolvedValueOnce({
        status: 'pending',
        context: {},
        category: null,
        loopConfig: { exitCondition: { type: 'pr_checks_green' }, maxLoops: 3, waitExpiryMinutes: 240 },
        loopState: 'condition_unmet',
        updatedAt: fiveHoursAgo,
      })
      .mockResolvedValueOnce({ parentTaskId: null }); // resolveCompletedTask dep resolution

    let failedTaskUpdate: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        if (vals.status === 'failed') failedTaskUpdate = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStaleWorkers('account-1');

    // Task must be failed after expiry
    expect(failedTaskUpdate).not.toBeNull();
    expect(failedTaskUpdate.status).toBe('failed');
    expect(JSON.stringify(failedTaskUpdate.result)).toContain('PR checks green wait expired');
  });
});

describe('cleanupStaleWorkers — outcome-first summaries (B.5)', () => {
  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockCheckWorkerDeliverables.mockReset();
    mockGetWorkerDeliverableArtifactCount.mockReset();
    mockGetLatestWorkerArtifactWithStructuredOutput.mockReset();
    mockGetWorkerDeliverableArtifactCount.mockResolvedValue(1);
    mockGetLatestWorkerArtifactWithStructuredOutput.mockResolvedValue(null);
    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: false, hasArtifacts: true, hasStructuredOutput: false, hasCommits: false, hasAny: true, details: '1 artifact',
    });
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
    mockTasksUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
  });

  it('uses structuredOutput.summary from artifact when present', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([{ id: 'w1', taskId: 'task-1', prUrl: null, prNumber: null, commitCount: 0, branch: null, error: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst
      .mockResolvedValueOnce({ status: 'assigned', context: {}, category: null, loopConfig: null, loopState: null, updatedAt: new Date() })
      .mockResolvedValueOnce({ parentTaskId: null });

    const OUTCOME_SUMMARY = 'PR #1721 merged via squash into dev';
    mockGetLatestWorkerArtifactWithStructuredOutput.mockResolvedValue({
      metadata: { structuredOutput: { summary: OUTCOME_SUMMARY } },
    });

    let taskUpdateSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        taskUpdateSet = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStaleWorkers('account-1');

    expect(taskUpdateSet).not.toBeNull();
    expect(taskUpdateSet.status).toBe('completed');
    expect(taskUpdateSet.result.summary).toBe(OUTCOME_SUMMARY);
    expect(taskUpdateSet.result.reaperAutoCompleted).toBe(true);
    expect(taskUpdateSet.result.reaperForensics).toContain('1 artifact');
  });

  it('falls back to reaper forensics summary when no structuredOutput on artifact', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([{ id: 'w1', taskId: 'task-1', prUrl: null, prNumber: null, commitCount: 0, branch: null, error: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst
      .mockResolvedValueOnce({ status: 'assigned', context: {}, category: null, loopConfig: null, loopState: null, updatedAt: new Date() })
      .mockResolvedValueOnce({ parentTaskId: null });

    // Artifact exists but has no structuredOutput.summary
    mockGetLatestWorkerArtifactWithStructuredOutput.mockResolvedValue(null);

    let taskUpdateSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        taskUpdateSet = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStaleWorkers('account-1');

    expect(taskUpdateSet).not.toBeNull();
    expect(taskUpdateSet.status).toBe('completed');
    expect(taskUpdateSet.result.summary).toContain('stale-worker reaper');
    expect(taskUpdateSet.result.reaperAutoCompleted).toBe(true);
    expect(taskUpdateSet.result.reaperForensics).toBeDefined();
  });
});

// ─── Orphan / silent-start taxonomy ─────────────────────────────────────────
// Regression (2026-08-28): every reaped worker was booked as `infra_failure`
// with "Stale worker expired (no update for 15+ minutes)" — including rows the
// server minted at claim that NO runner ever started (started_at IS NULL), and
// sessions that started but streamed nothing at all ($0, ≤2 turns). Both shapes
// inflated the failure rate and were undiagnosable from the DB.
describe('cleanupStaleWorkers — never-started / silent-start taxonomy', () => {
  let workerUpdates: Array<{ vals: any; where: any }> = [];

  beforeEach(() => {
    workerUpdates = [];
    mockWorkersFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockCheckWorkerDeliverables.mockReset();
    mockGetWorkerDeliverableArtifactCount.mockReset();
    mockGetWorkerDeliverableArtifactCount.mockResolvedValue(0);
    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: false, hasArtifacts: false, hasStructuredOutput: false, hasCommits: false, hasAny: false, details: 'none',
    });
    mockWorkersUpdate.mockReturnValue({
      set: mock((vals: any) => ({
        where: mock((where: any) => {
          workerUpdates.push({ vals, where });
          return Promise.resolve();
        }),
      })),
    });
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({ where: mock(() => Promise.resolve()) })),
    });
  });

  it('books a worker no runner ever started as never_started, not infra_failure', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'orphan-1', taskId: 'task-1', status: 'idle', startedAt: null, turns: 0, costUsd: '0.000000', prUrl: null, prNumber: null, commitCount: null, branch: null, error: null },
      ])
      .mockResolvedValueOnce([]) // no other active workers
      .mockResolvedValueOnce([]) // failed workers (retry cap)
      .mockResolvedValueOnce([]); // heartbeat orphans

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', workspaceId: 'ws-1', parentTaskId: null });

    await cleanupStaleWorkers('account-1');

    expect(workerUpdates.length).toBeGreaterThan(0);
    const update = workerUpdates[0].vals;
    expect(update.status).toBe('failed');
    expect(update.exitCause).toBe('never_started');
    expect(update.error).not.toContain('no update for 15+ minutes');
    expect(update.error.toLowerCase()).toContain('never started');
  });

  // Friction 92866723: an MCP claim_task worker reaped by its 2h no-MCP-activity
  // TTL must say so, not claim a runner failed to start it.
  it('books an abandoned interactive (MCP) worker with its own text', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'mcp-1', taskId: 'task-1', runner: 'mcp', status: 'idle', startedAt: null, turns: 0, costUsd: '0.000000', prUrl: null, prNumber: null, commitCount: null, branch: null, error: null },
      ])
      .mockResolvedValueOnce([]) // no other active workers
      .mockResolvedValueOnce([]) // failed workers (retry cap)
      .mockResolvedValueOnce([]); // heartbeat orphans

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', workspaceId: 'ws-1', parentTaskId: null });

    await cleanupStaleWorkers('account-1');

    const update = workerUpdates[0].vals;
    expect(update.status).toBe('failed');
    expect(update.error).toBe(INTERACTIVE_ABANDONED_ERROR);
    expect(update.error.toLowerCase()).not.toContain('never started by a runner');
  });

  it('books a started-but-outputless worker as silent_start with diagnosable text', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'silent-1', taskId: 'task-1', status: 'running', startedAt: new Date(Date.now() - 20 * 60 * 1000), turns: 2, costUsd: '0.000000', prUrl: null, prNumber: null, commitCount: null, branch: null, error: null },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', workspaceId: 'ws-1', parentTaskId: null });

    await cleanupStaleWorkers('account-1');

    const update = workerUpdates[0].vals;
    expect(update.exitCause).toBe('silent_start');
    expect(update.error).toContain('no output');
  });

  it('splits a mixed batch into one update per exit cause', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'orphan-1', taskId: 'task-1', status: 'idle', startedAt: null, turns: 0, costUsd: '0.000000', prUrl: null, prNumber: null, commitCount: null, branch: null, error: null },
        { id: 'silent-1', taskId: 'task-2', status: 'running', startedAt: new Date(), turns: 1, costUsd: '0.000000', prUrl: null, prNumber: null, commitCount: null, branch: null, error: null },
        { id: 'real-1', taskId: 'task-3', status: 'running', startedAt: new Date(), turns: 44, costUsd: '0.230000', prUrl: null, prNumber: null, commitCount: null, branch: null, error: null },
      ])
      .mockResolvedValue([]);

    mockTasksFindMany.mockResolvedValue([
      { id: 'task-1', workspaceId: 'ws-1' },
      { id: 'task-2', workspaceId: 'ws-1' },
      { id: 'task-3', workspaceId: 'ws-1' },
    ]);
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', workspaceId: 'ws-1', parentTaskId: null });

    await cleanupStaleWorkers('account-1');

    const causes = workerUpdates.map(u => u.vals.exitCause);
    expect(causes).toContain('never_started');
    expect(causes).toContain('silent_start');
    expect(causes).toContain('infra_failure');

    // Each update must target only the worker ids of its own class.
    const byCause = new Map(workerUpdates.map(u => [u.vals.exitCause, u.where?.values ?? []]));
    expect(byCause.get('never_started')).toEqual(['orphan-1']);
    expect(byCause.get('silent_start')).toEqual(['silent-1']);
    expect(byCause.get('infra_failure')).toEqual(['real-1']);
  });

  it('does not charge never_started workers against the retry cap', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'orphan-4', taskId: 'task-1', status: 'idle', startedAt: null, turns: 0, costUsd: '0.000000', prUrl: null, prNumber: null, commitCount: null, branch: null, error: null },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'f1', exitCause: 'never_started' },
        { id: 'f2', exitCause: 'never_started' },
        { id: 'f3', exitCause: 'never_started' },
      ])
      .mockResolvedValueOnce([]);

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', workspaceId: 'ws-1', parentTaskId: null });

    let taskUpdateSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        taskUpdateSet = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStaleWorkers('account-1');

    expect(taskUpdateSet).not.toBeNull();
    expect(taskUpdateSet.status).toBe('pending');
  });

  it('fails the task with a legible reason after 3 silent-start sessions', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'silent-4', taskId: 'task-1', status: 'running', startedAt: new Date(), turns: 1, costUsd: '0.000000', prUrl: null, prNumber: null, commitCount: null, branch: null, error: null },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'f1', exitCause: 'silent_start' },
        { id: 'f2', exitCause: 'silent_start' },
        { id: 'f3', exitCause: 'silent_start' },
      ])
      .mockResolvedValueOnce([]);

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', workspaceId: 'ws-1', parentTaskId: null });

    let taskUpdateSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        taskUpdateSet = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStaleWorkers('account-1');

    expect(taskUpdateSet).not.toBeNull();
    expect(taskUpdateSet.status).toBe('failed');
    expect(taskUpdateSet.result.error).toContain('silent-start');
  });

  it('a visual-auditor mission task at the silent-start cap fails as infra_stalled, so the mission stays blocked', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'silent-4', taskId: 'task-1', status: 'running', startedAt: new Date(), turns: 1, costUsd: '0.000000', prUrl: null, prNumber: null, commitCount: null, branch: null, error: null },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'f1', exitCause: 'silent_start' },
        { id: 'f2', exitCause: 'silent_start' },
        { id: 'f3', exitCause: 'silent_start' },
      ])
      .mockResolvedValueOnce([]);

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst.mockResolvedValue({
      id: 'task-1', workspaceId: 'ws-1', parentTaskId: null, status: 'in_progress',
      missionId: 'mission-1', roleSlug: 'visual-auditor', context: {},
    });

    let taskUpdateSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        taskUpdateSet = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStaleWorkers('account-1');

    expect(taskUpdateSet.status).toBe('failed');
    expect(taskUpdateSet.result.error).toContain('silent-start');
    expect(taskUpdateSet.result.errorType).toBe('infra_stalled');
  });

  // Regression: costUsd is never populated on the reaper's own kill path, so
  // "$0 spend" was true for every worker regardless of real activity. A worker
  // that already burned input/output tokens (live-synced by the runner every
  // ~30s) must not be booked as silent_start just because costUsd is still $0.
  it('books a worker with input tokens but $0 cost as infra_failure, not silent_start', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'spender-1', taskId: 'task-1', status: 'running', startedAt: new Date(Date.now() - 20 * 60 * 1000), turns: 1, costUsd: '0.000000', inputTokens: 40000, outputTokens: 0, prUrl: null, prNumber: null, commitCount: null, branch: null, error: null },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', workspaceId: 'ws-1', parentTaskId: null });

    await cleanupStaleWorkers('account-1');

    const update = workerUpdates[0].vals;
    expect(update.exitCause).toBe('infra_failure');
  });

  it('looks for silent-start workers on a shorter clock than the generic stale rule', async () => {
    mockWorkersFindMany.mockResolvedValue([]);

    await cleanupStaleWorkers('account-1');

    // Walk the captured where-tree for the cutoff Dates the query was built with.
    const dates: Date[] = [];
    const walk = (node: any, depth = 0) => {
      if (!node || depth > 8) return;
      if (node instanceof Date) { dates.push(node); return; }
      if (Array.isArray(node)) { node.forEach(n => walk(n, depth + 1)); return; }
      if (typeof node === 'object') { Object.values(node).forEach(n => walk(n, depth + 1)); }
    };
    const findArgs = mockWorkersFindMany.mock.calls[0][0] as any;
    walk({ ...findArgs, where: capturedWhere(findArgs.where) });

    const agesMin = dates.map(d => Math.round((Date.now() - d.getTime()) / 60000));
    // Derived from the shared constant rather than hardcoded: the generic rule
    // is deliberately pinned to the runner's own backstop (+grace) so the server
    // cannot reap a worker the runner is still protecting through a long silent
    // tool call. Hardcoding a number here is what let the two drift apart.
    const reapMin = Math.round(WORKER_STALE_REAP_MS / 60000);
    expect(agesMin).toContain(reapMin);
    // The silent-start rule must still fire well before the generic expiry, and
    // after the 5-minute idle rule.
    const silentWindow = agesMin.find(m => m > 5 && m < reapMin);
    expect(silentWindow).toBeDefined();
  });
});

describe('cleanupStaleWorkers — heartbeat path taxonomy', () => {
  let workerUpdates: Array<{ vals: any; where: any }> = [];

  beforeEach(() => {
    workerUpdates = [];
    mockWorkersFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockWorkerHeartbeatsFindFirst.mockReset();
    mockCheckWorkerDeliverables.mockReset();
    mockGetWorkerDeliverableArtifactCount.mockReset();
    mockGetWorkerDeliverableArtifactCount.mockResolvedValue(0);
    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: false, hasArtifacts: false, hasStructuredOutput: false, hasCommits: false, hasAny: false, details: 'none',
    });
    mockWorkersUpdate.mockReturnValue({
      set: mock((vals: any) => ({
        where: mock((where: any) => {
          workerUpdates.push({ vals, where });
          return Promise.resolve();
        }),
      })),
    });
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({ where: mock(() => Promise.resolve()) })),
    });
  });

  it('books a never-started row as never_started even when the runner heartbeat expired', async () => {
    // No fresh heartbeat → section 2 fires.
    mockWorkerHeartbeatsFindFirst.mockResolvedValue(null);
    mockWorkersFindMany
      .mockResolvedValueOnce([]) // section 1: no stale workers
      .mockResolvedValueOnce([   // section 2: heartbeat orphans
        { id: 'hb-orphan', taskId: 'task-9', startedAt: null, turns: 0, costUsd: '0.000000', prUrl: null, prNumber: null, commitCount: null, branch: null, error: null },
        { id: 'hb-worked', taskId: 'task-10', startedAt: new Date(), turns: 30, costUsd: '0.500000', prUrl: null, prNumber: null, commitCount: null, branch: null, error: null },
      ])
      .mockResolvedValue([]);

    mockTasksFindMany.mockResolvedValue([
      { id: 'task-9', workspaceId: 'ws-1' },
      { id: 'task-10', workspaceId: 'ws-1' },
    ]);
    mockTasksFindFirst.mockResolvedValue({ id: 'task-9', workspaceId: 'ws-1', parentTaskId: null });

    await cleanupStaleWorkers('account-1');

    const byCause = new Map(workerUpdates.map(u => [u.vals.exitCause, u]));
    expect(byCause.get('never_started')?.where?.values).toEqual(['hb-orphan']);
    expect(byCause.get('infra_failure')?.where?.values).toEqual(['hb-worked']);
    expect(byCause.get('infra_failure')?.vals.error).toContain('heartbeat expired');

    // Restore the file-wide default (fresh heartbeat) for anything appended later.
    mockWorkerHeartbeatsFindFirst.mockResolvedValue({ id: 'hb-1' });
  });
});

describe('cleanupStuckWaitingInput — account scoping', () => {
  // The sweep used to take no arguments and query `eq(workers.status,
  // 'waiting_input')` globally, while its only automatic driver was each
  // runner's own 30-minute cleanup tick. One healthy runner on any account
  // therefore fired the waiting_input timeout for every other tenant.
  const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h — past both thresholds
  const fixture = [
    { id: 'w-a', taskId: 'task-a', accountId: 'acct-a', status: 'waiting_input', updatedAt: staleDate, waitingFor: null, branch: null, error: null, task: { missionId: null } },
    { id: 'w-b', taskId: 'task-b', accountId: 'acct-b', status: 'waiting_input', updatedAt: staleDate, waitingFor: null, branch: null, error: null, task: { missionId: null } },
  ];

  /** Every eq() value in the mocked drizzle where-tree, flattened. */
  function eqValues(node: any): unknown[] {
    if (!node || typeof node !== 'object') return [];
    if (node.type === 'eq') return [node.value];
    if (Array.isArray(node.args)) return node.args.flatMap(eqValues);
    return [];
  }

  let workerUpdateIds: string[];
  let lastWhere: any;

  beforeEach(() => {
    workerUpdateIds = [];
    lastWhere = null;
    mockWorkersFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockTasksInsert.mockReset();
    mockAccountsUpdate.mockReset();

    // The account filter lives in SQL, so the fake honours it the way Postgres would.
    mockWorkersFindMany.mockImplementation((args: any) => {
      lastWhere = args?.where;
      const scopes = eqValues(args?.where).filter(
        (v): v is string => typeof v === 'string' && v.startsWith('acct-'),
      );
      return fixture.filter(w => scopes.length === 0 || scopes.includes(w.accountId));
    });
    mockTasksFindFirst.mockImplementation(() => ({
      id: 'task-a', workspaceId: 'ws-1', title: 'T', description: 'D',
      priority: 0, category: null, project: null, context: {}, requiredCapabilities: [],
      missionId: null, runnerPreference: 'any', mode: 'execution',
      outputRequirement: 'auto', outputSchema: null, parentTaskId: null,
    }));
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock((w: any) => {
          if (typeof w?.value === 'string') workerUpdateIds.push(w.value);
          return Promise.resolve();
        }),
      })),
    });
    mockTasksUpdate.mockReturnValue(taskUpdateChain());
    mockTasksInsert.mockReturnValue({
      values: mock(() => ({ returning: mock(() => [{ id: 'new-task-id' }]) })),
    });
    mockAccountsUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
  });

  it('scopes the waiting_input query to the given account', async () => {
    await cleanupStuckWaitingInput('acct-a');
    expect(eqValues(lastWhere)).toContain('acct-a');
  });

  it('does not touch another account\'s stuck waiting_input workers', async () => {
    const result = await cleanupStuckWaitingInput('acct-a');

    expect(workerUpdateIds).toContain('w-a');
    expect(workerUpdateIds).not.toContain('w-b');
    expect(result.failedWorkers).toBe(1);
    expect(result.retriedTasks).toBe(1);
  });

  it('still reclaims the calling account\'s own worker past the threshold', async () => {
    const result = await cleanupStuckWaitingInput('acct-b');

    expect(workerUpdateIds).toEqual(['w-b']);
    expect(result.failedWorkers).toBe(1);
    expect(result.retriedTasks).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// cleanupUnresumedAnswers — an answer queued for a parked session that never
// got acknowledged must degrade to the cold path it would have taken: a new
// attempt of the SAME task carrying the human's text, never a new task.
// See docs/specs/answered-question-resume.md, "The cold fallback".
// ---------------------------------------------------------------------------
describe('cleanupUnresumedAnswers', () => {
  const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  function parkedWithQueuedAnswer(deliveryOverrides: Record<string, unknown> = {}) {
    return {
      id: 'worker-1',
      taskId: 'task-1',
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      branch: 'buildd/task-1-thing',
      lastCommitSha: 'abc123',
      milestones: [{ label: 'Read the route', timestamp: 1 }],
      pendingInstructions: 'Use Postgres',
      instructionHistory: [{ type: 'instruction', message: 'Use Postgres', timestamp: 1, deliveryState: 'pending' }],
      completedAt: null,
      task: {
        id: 'task-1',
        title: 'Pick a database',
        description: 'Choose and wire the store',
        missionId: 'mission-1',
        taskClass: 'work',
        status: 'in_progress',
        context: {
          answerDelivery: {
            path: 'resume',
            reasonCode: 'resume_eligible',
            reason: 'eligible',
            workerId: 'worker-1',
            decidedAt: PAST,
            ackDeadlineAt: PAST,
            question: 'Which database?',
            ...deliveryOverrides,
          },
        },
      },
    };
  }

  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockTasksInsert.mockReset();
    mockTasksInsert.mockReturnValue({
      values: mock(() => ({ returning: mock(() => [{ id: 'new-task-id' }]) })),
    } as any);
    mockReopen.mockReset();
    mockReopen.mockImplementation(async (input: any) => ({ reopened: true, taskId: input.taskId, entryId: 'entry-1' }));
    mockWakeTask.mockReset();
    mockWakeTask.mockImplementation(async () => {});
    mockAnnounceTaskCreated.mockReset();
    capturedInsertValues = null;
    capturedWorkerUpdates.length = 0;
    workersUpdateReturning = [{ id: 'worker-1', completedAt: new Date(7_000) }];
    capturedAccountsSet = null;
    mockAccountsUpdate.mockReset();
    mockAccountsUpdate.mockReturnValue({
      set: mock((vals: any) => {
        capturedAccountsSet = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    } as any);
    mockWorkersUpdate.mockReset();
    mockWorkersUpdate.mockReturnValue({
      set: mock((vals: any) => {
        capturedWorkerUpdates.push(vals);
        return {
          where: mock(() => Object.assign(Promise.resolve(), {
            returning: () => Promise.resolve(workersUpdateReturning),
          })),
        };
      }),
    } as any);
  });

  // AC-16
  it('reopens the worker\'s own task with the queued answer, supersedes the worker, and inserts no task', async () => {
    mockWorkersFindMany.mockReturnValue([parkedWithQueuedAnswer()] as any);

    const result = await cleanupUnresumedAnswers('account-1');

    expect(result.degraded).toBe(1);
    // The worker is superseded and its queue cleared, so a late runner cannot
    // inject the answer into a row whose attempt has ended.
    const supersede = capturedWorkerUpdates[0];
    expect(supersede.status).toBe('superseded');
    expect(supersede.pendingInstructions).toBeNull();
    // A cloud-parked worker whose resume never acknowledged is un-parked too,
    // so nothing can re-attach to the superseded row.
    expect(supersede.parkedUntil).toBeNull();

    expect(mockTasksInsert).not.toHaveBeenCalled();
    expect(mockReopen).toHaveBeenCalledTimes(1);
    expect(mockReopen.mock.calls[0][0]).toMatchObject({
      taskId: 'task-1',
      worker: { id: 'worker-1', branch: 'buildd/task-1-thing', lastCommitSha: 'abc123', completedAt: new Date(7_000) },
      answer: 'Use Postgres',
      // The question was cleared from waitingFor at answer time; the delivery
      // record kept a copy precisely so the new attempt can still be told it.
      question: 'Which database?',
      source: 'sweep:unresumed-answer',
    });
  });

  it('records resume_not_acknowledged as the reason, with no deadline left', async () => {
    mockWorkersFindMany.mockReturnValue([parkedWithQueuedAnswer()] as any);

    await cleanupUnresumedAnswers('account-1');

    const delivery = mockReopen.mock.calls[0][0].delivery;
    expect(delivery.reasonCode).toBe('resume_not_acknowledged');
    expect(delivery.path).toBe('cold_continuation');
    expect(delivery.ackDeadlineAt).toBeUndefined();
  });

  it('posts one warning note naming the failure to deliver, and wakes the same task as a requeue', async () => {
    mockWorkersFindMany.mockReturnValue([parkedWithQueuedAnswer()] as any);

    await cleanupUnresumedAnswers('account-1');

    expect(capturedInsertValues?.type).toBe('warning');
    expect(capturedInsertValues?.taskId).toBe('task-1');
    expect(capturedInsertValues?.body).toContain('never acknowledged');
    expect(capturedInsertValues?.body).toContain('new attempt of this task');
    expect(mockWakeTask.mock.calls).toEqual([['task-1', 'task.requeued']]);
    expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
  });

  it('leaves an answer alone before its deadline', async () => {
    mockWorkersFindMany.mockReturnValue([parkedWithQueuedAnswer({ ackDeadlineAt: FUTURE })] as any);

    const result = await cleanupUnresumedAnswers('account-1');

    expect(result.degraded).toBe(0);
    expect(capturedWorkerUpdates).toHaveLength(0);
  });

  // AC-17 — one pass flips the recorded path, so a second pass skips it.
  it('does not degrade an answer it has already degraded', async () => {
    mockWorkersFindMany.mockReturnValue([
      parkedWithQueuedAnswer({ path: 'cold_continuation', reasonCode: 'resume_not_acknowledged' }),
    ] as any);

    const result = await cleanupUnresumedAnswers('account-1');

    expect(result.degraded).toBe(0);
    expect(mockReopen).not.toHaveBeenCalled();
  });

  // AC-18 — an acknowledged answer clears the queue; the SQL predicate
  // already excludes it, and the JS guard agrees.
  it('ignores a worker with nothing queued', async () => {
    const worker = parkedWithQueuedAnswer();
    worker.pendingInstructions = null as any;
    mockWorkersFindMany.mockReturnValue([worker] as any);

    const result = await cleanupUnresumedAnswers('account-1');

    expect(result.degraded).toBe(0);
  });

  it('ignores a queued /instruct steer that this route never decided about', async () => {
    const worker = parkedWithQueuedAnswer();
    (worker.task.context as any).answerDelivery = undefined;
    mockWorkersFindMany.mockReturnValue([worker] as any);

    const result = await cleanupUnresumedAnswers('account-1');

    expect(result.degraded).toBe(0);
  });

  it('ignores a delivery record that decided about a different worker', async () => {
    mockWorkersFindMany.mockReturnValue([parkedWithQueuedAnswer({ workerId: 'some-other-worker' })] as any);

    const result = await cleanupUnresumedAnswers('account-1');

    expect(result.degraded).toBe(0);
  });

  // A sweep race: the runner can drain the queue in the exact window between
  // the read and the write. It wins; the sweep does nothing.
  it('does nothing when the claiming compare-and-swap matches no row', async () => {
    mockWorkersFindMany.mockReturnValue([parkedWithQueuedAnswer()] as any);
    workersUpdateReturning = [];

    const result = await cleanupUnresumedAnswers('account-1');

    expect(result.degraded).toBe(0);
    expect(mockReopen).not.toHaveBeenCalled();
    expect(mockWakeTask).not.toHaveBeenCalled();
  });

  it('releases one OAuth seat per degraded worker', async () => {
    mockWorkersFindMany.mockReturnValue([parkedWithQueuedAnswer()] as any);

    await cleanupUnresumedAnswers('account-1');

    expect(capturedAccountsSet).not.toBeNull();
  });

  it('touches no account when nothing was degraded', async () => {
    mockWorkersFindMany.mockReturnValue([] as any);

    await cleanupUnresumedAnswers('account-1');

    expect(capturedAccountsSet).toBeNull();
  });

  // AC-19 — no transactions on neon-http: the worker is superseded and the
  // task reopened as two separate writes. If the reopen throws, the worker must
  // not be left permanently superseded with the answer discarded — it goes back
  // to waiting_input so a later sweep can still recover it.
  it('restores the worker to waiting_input when reopening the task throws', async () => {
    mockReopen.mockImplementation(async () => { throw new Error('reopen failed'); });
    mockWorkersFindMany.mockReturnValue([parkedWithQueuedAnswer()] as any);

    const result = await cleanupUnresumedAnswers('account-1');

    expect(result.degraded).toBe(0);
    expect(capturedWorkerUpdates).toHaveLength(2);
    const restore = capturedWorkerUpdates[1];
    expect(restore.status).toBe('waiting_input');
    expect(restore.pendingInstructions).toBe('Use Postgres');
    // No account seat is released for a worker that was never actually degraded.
    expect(capturedAccountsSet).toBeNull();
    expect(mockWakeTask).not.toHaveBeenCalled();
  });

  it('restores the worker when the task can no longer be reopened (closed in the window)', async () => {
    mockReopen.mockImplementation(async () => ({ reopened: false, reason: 'not_reopenable' }));
    mockWorkersFindMany.mockReturnValue([parkedWithQueuedAnswer()] as any);

    const result = await cleanupUnresumedAnswers('account-1');

    expect(result.degraded).toBe(0);
    expect(capturedWorkerUpdates[1]).toMatchObject({ status: 'waiting_input', pendingInstructions: 'Use Postgres' });
  });

  // AC-26 — once the task is reopened the answer is durable, so the feed note
  // is best-effort: a throw there must not abort the sweep for the rest of the
  // account's candidates.
  it('keeps degrading later candidates when the feed note throws', async () => {
    const second = parkedWithQueuedAnswer({ workerId: 'worker-2' });
    second.id = 'worker-2';
    second.taskId = 'task-2';
    second.task = { ...second.task, id: 'task-2' };
    mockWorkersFindMany.mockReturnValue([parkedWithQueuedAnswer(), second] as any);
    const realInsert = (await import('@buildd/core/db')).db.insert;
    const db = (await import('@buildd/core/db')).db as any;
    db.insert = (table: any) => table === 'missionNotes'
      ? { values: () => Promise.reject(new Error('note failed')) }
      : realInsert(table);
    try {
      const result = await cleanupUnresumedAnswers('account-1');
      expect(result.degraded).toBe(2);
      expect(capturedWorkerUpdates.some(u => u.status === 'waiting_input')).toBe(false);
      expect(mockWakeTask.mock.calls.map(c => c[0])).toEqual(['task-1', 'task-2']);
      expect(capturedAccountsSet).not.toBeNull();
    } finally {
      db.insert = realInsert;
    }
  });
});

// The lost-claim release (lib/lost-claim.ts) resolves its tasks through the
// reaper's own rules: requeued pending with the infra backoff and a wake keyed
// to startAt, never charged as a code failure, and stalled truthfully at the cap.
describe('resolveTasksOfReapedWorkers — never-started reap (no acknowledgement)', () => {
  const lost = { id: 'w-lost', taskId: 'task-1', prUrl: null, prNumber: null, commitCount: null, branch: null, error: 'lost' };
  let taskUpdateSet: any;
  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockTasksUpdate.mockReset();
    mockGetWorkerDeliverableArtifactCount.mockReset();
    mockGetWorkerDeliverableArtifactCount.mockResolvedValue(0);
    mockCheckWorkerDeliverables.mockReset();
    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: false, hasArtifacts: false, hasStructuredOutput: false, hasCommits: false, hasAny: false, details: 'none',
    });
    taskUpdateSet = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => { taskUpdateSet = vals; return { where: mock(() => Promise.resolve()) }; }),
    });
    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockWakeTask.mockClear();
  });

  it('requeues pending with backoff and wakes at startAt, without charging a code failure', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([]) // no other live worker on the task
      .mockResolvedValueOnce([{ id: 'w-lost', exitCause: 'never_started' }]); // failed workers
    mockTasksFindFirst.mockResolvedValueOnce({
      id: 'task-1', workspaceId: 'ws-1', status: 'assigned', category: 'feature',
      context: {}, loopState: null, loopConfig: null, updatedAt: new Date(),
    }).mockResolvedValue({ parentTaskId: null });
    const before = Date.now();
    await resolveTasksOfReapedWorkers([lost], 'never_started');
    expect(taskUpdateSet.status).toBe('pending');
    expect(taskUpdateSet.context.infraRetryCount).toBe(1);
    expect(taskUpdateSet.startAt.getTime()).toBeGreaterThanOrEqual(before + 4 * 60_000);
    expect(mockWakeTask.mock.calls).toEqual([['task-1', 'task.requeued', { notBefore: taskUpdateSet.startAt }]]);
  });

  it('stops at the infra cap with a truthful infra_stalled failure, not a completion', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'w-lost', exitCause: 'never_started' }]);
    mockTasksFindFirst.mockResolvedValueOnce({
      id: 'task-1', workspaceId: 'ws-1', status: 'assigned', category: 'feature',
      context: { infraRetryCount: 3 }, loopState: null, loopConfig: null, updatedAt: new Date(),
    }).mockResolvedValue({ parentTaskId: null });
    await resolveTasksOfReapedWorkers([lost], 'never_started');
    expect(taskUpdateSet.status).toBe('failed');
    expect(taskUpdateSet.result.errorType).toBe('infra_stalled');
    expect(mockWakeTask).not.toHaveBeenCalled();
  });

  it('leaves a task alone that another live worker already holds', async () => {
    mockWorkersFindMany.mockResolvedValueOnce([{ id: 'w-other' }]);
    mockTasksFindFirst.mockResolvedValue({ parentTaskId: null });
    await resolveTasksOfReapedWorkers([lost], 'never_started');
    expect(taskUpdateSet).toBeNull();
    expect(mockWakeTask).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cleanupUnreadInteractiveAnswers — an answer sent back to an interactive
// session that then went quiet without reading it (the session died between
// the answer and its next poll) goes to a new attempt of the same task instead
// of sitting on a `running` worker nobody will ever drive again.
// ---------------------------------------------------------------------------
describe('cleanupUnreadInteractiveAnswers', () => {
  const QUIET = new Date(Date.now() - 60 * 60 * 1000);
  const RECENT = new Date(Date.now() - 60 * 1000);

  function interactiveWithUnreadAnswer(overrides: {
    delivery?: Record<string, unknown>;
    entry?: Record<string, unknown>;
    worker?: Record<string, unknown>;
  } = {}) {
    return {
      id: 'worker-1',
      taskId: 'task-1',
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      runner: 'mcp',
      status: 'running',
      updatedAt: QUIET,
      branch: 'buildd/task-1-thing',
      milestones: [{ label: 'Read the route', timestamp: 1 }],
      instructionHistory: [
        { type: 'instruction', id: 'msg-1', message: 'Use Postgres', timestamp: 1, deliveryState: 'pending', ...overrides.entry },
      ],
      ...overrides.worker,
      task: {
        id: 'task-1',
        title: 'Pick a database',
        description: 'Choose and wire the store',
        missionId: 'mission-1',
        taskClass: 'work',
        context: {
          pendingWorkerMessages: [{ id: 'msg-1', type: 'answer', body: { source: 'human', text: 'Use Postgres', workerId: 'worker-1' } }],
          answerDelivery: {
            path: 'interactive',
            reasonCode: 'interactive_session',
            reason: 'live',
            workerId: 'worker-1',
            decidedAt: QUIET.toISOString(),
            messageId: 'msg-1',
            question: 'Which database?',
            ...overrides.delivery,
          },
        },
      },
    };
  }

  const insertedValues: any[] = [];
  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    insertedValues.length = 0;
    mockTasksInsert.mockReset();
    mockTasksInsert.mockReturnValue({
      values: mock((v: any) => { insertedValues.push(v); return { returning: mock(() => [{ id: 'new-task-id' }]) }; }),
    } as any);
    mockTasksUpdate.mockReset();
    mockTasksUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) } as any);
    mockClearWorkerMessages.mockClear();
    mockWakeTask.mockClear();
    mockReopen.mockReset();
    mockReopen.mockImplementation(async (input: any) => ({ reopened: true, taskId: input.taskId, entryId: 'entry-1' }));
    capturedInsertValues = null;
    capturedWorkerUpdates.length = 0;
    workersUpdateReturning = [{ id: 'worker-1', completedAt: new Date(9_000) }];
    capturedAccountsSet = null;
    mockAccountsUpdate.mockReset();
    mockAccountsUpdate.mockReturnValue({
      set: mock((vals: any) => {
        capturedAccountsSet = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    } as any);
    mockWorkersUpdate.mockReset();
    mockWorkersUpdate.mockReturnValue({
      set: mock((vals: any) => {
        capturedWorkerUpdates.push(vals);
        return {
          where: mock(() => Object.assign(Promise.resolve(), {
            returning: () => Promise.resolve(workersUpdateReturning),
          })),
        };
      }),
    } as any);
  });

  // AC-45
  it('sends a quiet session\'s unread answer to a new attempt of the same task and supersedes the worker', async () => {
    mockWorkersFindMany.mockReturnValue([interactiveWithUnreadAnswer()] as any);

    const result = await cleanupUnreadInteractiveAnswers('account-1');

    expect(result.degraded).toBe(1);
    expect(capturedWorkerUpdates[0].status).toBe('superseded');
    expect(insertedValues).toHaveLength(0);
    expect(mockReopen).toHaveBeenCalledTimes(1);
    expect(mockReopen.mock.calls[0][0]).toMatchObject({
      taskId: 'task-1',
      worker: { id: 'worker-1', completedAt: new Date(9_000) },
      answer: 'Use Postgres',
      question: 'Which database?',
      delivery: { path: 'cold_continuation', reasonCode: 'interactive_answer_not_read' },
      source: 'sweep:unread-interactive-answer',
    });
    // No other task to point at.
    expect(capturedWorkerUpdates.some(u => 'continuationTaskId' in u)).toBe(false);
    expect(mockWakeTask.mock.calls).toEqual([['task-1', 'task.requeued']]);
  });

  it('takes the answer out of the task\'s message queue, so a session that comes back cannot also act on it', async () => {
    mockWorkersFindMany.mockReturnValue([interactiveWithUnreadAnswer()] as any);

    await cleanupUnreadInteractiveAnswers('account-1');

    expect(mockClearWorkerMessages).toHaveBeenCalledWith('task-1', ['msg-1']);
  });

  it('posts one warning note saying the session never read the answer', async () => {
    mockWorkersFindMany.mockReturnValue([interactiveWithUnreadAnswer()] as any);

    await cleanupUnreadInteractiveAnswers('account-1');

    expect(capturedInsertValues?.type).toBe('warning');
    expect(capturedInsertValues?.taskId).toBe('task-1');
    expect(capturedInsertValues?.body).toContain('went quiet without reading it');
  });

  it('leaves a session that was active recently alone', async () => {
    mockWorkersFindMany.mockReturnValue([interactiveWithUnreadAnswer({ worker: { updatedAt: RECENT } })] as any);

    const result = await cleanupUnreadInteractiveAnswers('account-1');

    expect(result.degraded).toBe(0);
    expect(capturedWorkerUpdates).toHaveLength(0);
  });

  it('leaves an answer the session already read alone', async () => {
    mockWorkersFindMany.mockReturnValue([interactiveWithUnreadAnswer({ entry: { deliveryState: 'acknowledged' } })] as any);

    const result = await cleanupUnreadInteractiveAnswers('account-1');

    expect(result.degraded).toBe(0);
  });

  it('ignores a delivery that was not sent to an interactive session', async () => {
    mockWorkersFindMany.mockReturnValue([interactiveWithUnreadAnswer({ delivery: { path: 'resume' } })] as any);

    expect((await cleanupUnreadInteractiveAnswers('account-1')).degraded).toBe(0);
  });

  it('ignores a delivery recorded for a different worker', async () => {
    mockWorkersFindMany.mockReturnValue([interactiveWithUnreadAnswer({ delivery: { workerId: 'worker-2' } })] as any);

    expect((await cleanupUnreadInteractiveAnswers('account-1')).degraded).toBe(0);
  });

  it('ignores a runner-managed worker', async () => {
    mockWorkersFindMany.mockReturnValue([interactiveWithUnreadAnswer({ worker: { runner: 'buildd-runner' } })] as any);

    expect((await cleanupUnreadInteractiveAnswers('account-1')).degraded).toBe(0);
  });

  // The session can read the answer, or check in, in the window between the
  // read and the write. It wins.
  it('does nothing when the claiming compare-and-swap matches no row', async () => {
    mockWorkersFindMany.mockReturnValue([interactiveWithUnreadAnswer()] as any);
    workersUpdateReturning = [];

    const result = await cleanupUnreadInteractiveAnswers('account-1');

    expect(result.degraded).toBe(0);
    expect(mockReopen).not.toHaveBeenCalled();
    expect(mockClearWorkerMessages).not.toHaveBeenCalled();
  });

  it.each([
    ['throws', async () => { throw new Error('reopen failed'); }],
    ['moves nothing', async () => ({ reopened: false, reason: 'not_reopenable' })],
  ] as const)('puts the worker back to running, answer still queued, when reopening the task %s', async (_label, impl) => {
    mockReopen.mockImplementation(impl as any);
    mockWorkersFindMany.mockReturnValue([interactiveWithUnreadAnswer()] as any);

    const result = await cleanupUnreadInteractiveAnswers('account-1');

    expect(result.degraded).toBe(0);
    expect(capturedWorkerUpdates).toHaveLength(2);
    expect(capturedWorkerUpdates[1].status).toBe('running');
    expect(mockClearWorkerMessages).not.toHaveBeenCalled();
    expect(capturedAccountsSet).toBeNull();
  });

  it('releases one OAuth seat per degraded worker', async () => {
    mockWorkersFindMany.mockReturnValue([interactiveWithUnreadAnswer()] as any);

    await cleanupUnreadInteractiveAnswers('account-1');

    expect(capturedAccountsSet).not.toBeNull();
  });
});

// failure-incident-recovery §18.3 (I-15, AC-20): an interactive worker's task
// goes back to pending for a session to re-claim — no floor, no charge, and
// never `failed`, even at the infra cap.
describe('resolveTasksOfReapedWorkers — interactive (local session) worker', () => {
  const idle = { id: 'w-mcp', taskId: 'task-1', runner: 'mcp', prUrl: null, prNumber: null, commitCount: 2, branch: 'buildd/abc-fix', error: 'Interactive worker released: no MCP activity from its session for 2 hours (claim_task worker, not run by a runner)', startedAt: new Date() };
  let taskUpdateSet: any;
  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockTasksUpdate.mockReset();
    mockGetWorkerDeliverableArtifactCount.mockReset();
    mockGetWorkerDeliverableArtifactCount.mockResolvedValue(0);
    mockCheckWorkerDeliverables.mockReset();
    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: false, hasArtifacts: false, hasStructuredOutput: false, hasCommits: false, hasAny: false, details: 'none',
    });
    taskUpdateSet = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => { taskUpdateSet = vals; return { where: mock(() => Promise.resolve()) }; }),
    });
    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockWakeTask.mockClear();
  });

  for (const infraRetryCount of [0, 3]) {
    it(`returns the task to pending on its branch, uncharged (infraRetryCount=${infraRetryCount})`, async () => {
      mockWorkersFindMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'w-mcp', exitCause: 'infra_failure' }]);
      mockTasksFindFirst.mockResolvedValueOnce({
        id: 'task-1', workspaceId: 'ws-1', status: 'in_progress', category: 'feature',
        context: { infraRetryCount }, loopState: null, loopConfig: null, updatedAt: new Date(),
      }).mockResolvedValue({ parentTaskId: null });
      await resolveTasksOfReapedWorkers([idle], 'infra_failure');
      expect(taskUpdateSet.status).toBe('pending');
      expect(taskUpdateSet.startAt).toBeNull();
      expect(taskUpdateSet.context.resumeBranch).toBe('buildd/abc-fix');
      expect(taskUpdateSet.context.infraRetryCount).toBe(infraRetryCount);
      expect(mockWakeTask.mock.calls).toEqual([['task-1', 'task.requeued']]);
    });
  }
});

// A claim the runner reported it never received (lib/lost-claim.ts). Nothing
// ran, so it says nothing about the task: requeue without touching the infra
// retry budget, never stall the task, never end a kernel attempt.
describe('resolveTasksOfReapedWorkers — undelivered claim (runner never received it)', () => {
  const lost = { id: 'w-lost', taskId: 'task-1', prUrl: null, prNumber: null, commitCount: null, branch: 'buildd/abc-fix', error: null };
  let taskUpdateSet: any;
  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockTasksUpdate.mockReset();
    taskUpdateSet = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => { taskUpdateSet = vals; return { where: mock(() => Promise.resolve()) }; }),
    });
    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockWakeTask.mockClear();
    mockWorkflowAttemptEnded.mockClear();
  });

  function taskRow(over: Record<string, unknown> = {}) {
    return { id: 'task-1', workspaceId: 'ws-1', status: 'assigned', category: 'feature', context: {}, loopState: null, loopConfig: null, updatedAt: new Date(), ...over };
  }

  for (const infraRetryCount of [0, 3]) {
    it(`requeues pending without charging the infra budget (infraRetryCount=${infraRetryCount})`, async () => {
      mockWorkersFindMany.mockResolvedValueOnce([]); // no other live worker
      mockTasksFindFirst.mockResolvedValueOnce(taskRow({ context: { infraRetryCount } })).mockResolvedValue({ parentTaskId: null });
      const before = Date.now();
      await resolveTasksOfReapedWorkers([lost], 'never_started', { undelivered: true });
      expect(taskUpdateSet.status).toBe('pending');
      expect(taskUpdateSet.result).toBeUndefined();
      expect(taskUpdateSet.context.infraRetryCount).toBe(infraRetryCount);
      expect(taskUpdateSet.context.claimLostCount).toBe(1);
      expect(taskUpdateSet.context.resumeBranch).toBe('buildd/abc-fix');
      expect(taskUpdateSet.startAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
      expect(taskUpdateSet.startAt.getTime()).toBeLessThan(before + 2 * 60_000);
      expect(mockWakeTask.mock.calls).toEqual([['task-1', 'task.requeued', { notBefore: taskUpdateSet.startAt }]]);
      expect(mockWorkflowAttemptEnded).not.toHaveBeenCalled();
    });
  }

  it('backs off further on each repeat, capped, and never fails the task', async () => {
    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockTasksFindFirst.mockResolvedValueOnce(taskRow({ context: { claimLostCount: 40, infraRetryCount: 3 } })).mockResolvedValue({ parentTaskId: null });
    const before = Date.now();
    await resolveTasksOfReapedWorkers([lost], 'never_started', { undelivered: true });
    expect(taskUpdateSet.status).toBe('pending');
    expect(taskUpdateSet.context.claimLostCount).toBe(41);
    expect(taskUpdateSet.startAt.getTime()).toBeGreaterThanOrEqual(before + 15 * 60_000);
    expect(taskUpdateSet.startAt.getTime()).toBeLessThan(before + 16 * 60_000);
  });

  it('requeues a review task the same way, without escalating', async () => {
    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockTasksFindFirst.mockResolvedValueOnce(taskRow({ category: 'review', context: { prNumber: 5, infraRetryCount: 3 } })).mockResolvedValue({ parentTaskId: null });
    await resolveTasksOfReapedWorkers([lost], 'never_started', { undelivered: true });
    expect(taskUpdateSet.status).toBe('pending');
    expect(taskUpdateSet.context.infraRetryCount).toBe(3);
  });

  for (const status of ['cancelled', 'completed', 'failed', 'pending']) {
    it(`leaves a ${status} task alone`, async () => {
      mockWorkersFindMany.mockResolvedValueOnce([]);
      mockTasksFindFirst.mockResolvedValueOnce(taskRow({ status })).mockResolvedValue({ parentTaskId: null });
      await resolveTasksOfReapedWorkers([lost], 'never_started', { undelivered: true });
      expect(taskUpdateSet).toBeNull();
      expect(mockWakeTask).not.toHaveBeenCalled();
    });
  }

  it('leaves a task alone that another live worker already holds', async () => {
    mockWorkersFindMany.mockResolvedValueOnce([{ id: 'w-other' }]);
    mockTasksFindFirst.mockResolvedValue({ parentTaskId: null });
    await resolveTasksOfReapedWorkers([lost], 'never_started', { undelivered: true });
    expect(taskUpdateSet).toBeNull();
  });
});
