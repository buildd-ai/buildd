import { describe, it, expect, beforeEach, mock } from 'bun:test';
// workers.id is a uuid column; the route 404s a non-UUID id before any lookup.
const WORKER_ID = '11111111-1111-4111-8111-111111111111';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockTasksFindFirst = mock(() => Promise.resolve(null as any));

const mockInsertReturning = mock(() => [{ id: 'new-task-1', title: 'Continue: Fix auth bug' }]);
const mockInsertValues = mock(() => {
  callOrder.push('insert');
  return { returning: mockInsertReturning };
});
const mockInsert = mock(() => ({
  values: mockInsertValues,
}));

const mockWorkersUpdateReturning = mock(() => [{ id: WORKER_ID, status: 'superseded' }]);
const mockWorkersUpdateWhere = mock(() => ({
  returning: mockWorkersUpdateReturning,
}));
const mockWorkersUpdateSet = mock(() => {
  callOrder.push('update');
  return { where: mockWorkersUpdateWhere };
});
const mockWorkersUpdate = mock(() => ({
  set: mockWorkersUpdateSet,
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
}));

// Order of writes matters (C3): the answer must be claimed with a CAS BEFORE
// the retry task is inserted, so a losing racer inserts nothing.
const callOrder: string[] = [];

// `tasks.context.answerDelivery` write — a plain promise so the route's
// `.catch()` on it resolves.
const mockTasksUpdateSet = mock((values: any) => {
  tasksUpdated.push(values);
  return { where: () => Promise.resolve([]) };
});
const tasksUpdated: any[] = [];

// Feed notes naming which answer path ran.
const notesInserted: any[] = [];
const mockNotesInsertValues = mock((values: any) => {
  notesInserted.push(values);
  return Promise.resolve([]);
});

const mockTriggerEvent = mock(() => Promise.resolve(true));

const mockPreflight = mock(async () => ({ state: 'ok' as const }));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
      tasks: { findFirst: mockTasksFindFirst },
    },
    insert: (table: any) =>
      table === 'missionNotes' ? { values: mockNotesInsertValues } : mockInsert(),
    update: (table: any) =>
      table === 'tasks' ? { set: mockTasksUpdateSet } : mockWorkersUpdate(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
  isNotNull: (field: any) => ({ field, type: 'isNotNull' }),
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' }),
}));

/**
 * The interactive path merges its answerDelivery record into the LIVE
 * tasks.context in SQL (the answer message was just appended to that same
 * column). Returns the record, parsed out of the SQL fragment.
 */
function mergedAnswerDelivery(update: any): any {
  const ctx = update?.context;
  if (!ctx || ctx.type !== 'sql') return undefined;
  for (const v of ctx.values) {
    if (typeof v === 'string' && v.includes('"path"')) return JSON.parse(v);
  }
  return undefined;
}

mock.module('@buildd/core/db/schema', () => ({
  workers: { id: 'workers.id', status: 'workers.status', waitingFor: 'workers.waitingFor' },
  tasks: 'tasks',
  missionNotes: 'missionNotes',
}));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { worker: (id: string) => `worker-${id}`, task: (id: string) => `task-${id}` },
  events: { WORKER_COMMAND: 'worker:command', WORKER_PROGRESS: 'worker:progress' },
}));

mock.module('@/lib/answer-credential-preflight', () => ({
  preflightBackendCredential: mockPreflight,
  CREDENTIAL_PREFLIGHT_MARGIN_MS: 300000,
}));

const mockReleaseAndNotify = mock((_taskId: string, _reason: string) => Promise.resolve());
mock.module('@/lib/path-claim-release', () => ({
  releaseAndNotify: mockReleaseAndNotify,
}));

// The cold path inserts a Continue: task and must wake runners for it the way
// every other new task does, or a webhook-only workspace never runs it.
const mockAnnounceTaskCreated = mock(async (_task: any, _workspace: any) => {});
const mockWakeTask = mock(async (_taskId: string, _cause: string, _opts?: any) => {});
// Full export surface: mock.module is process-global.
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
// A worker a cloud runner parked has no container: the answer must wake one.
const mockDispatchResumedTask = mock(async (_task: any, _workspace: any, _workerId: string) => true);
mock.module('@/lib/task-dispatch-delivery', () => ({
  dispatchResumedTask: mockDispatchResumedTask,
  buildTaskPayload: mock((task: any) => task),
  buildWebhookPayload: mock(() => ({})),
  dispatchToWebhook: mock(async () => false),
  WEBHOOK_DISPATCH_TIMEOUT_MS: 10_000,
}));

// The interactive path queues the answer as a worker message on the task.
const enqueuedMessages: Array<{ taskId: string; message: any }> = [];
const mockEnqueueWorkerMessage = mock(async (taskId: string, message: any) => {
  enqueuedMessages.push({ taskId, message });
  return true;
});
const teamCacheClears: Array<[string | null | undefined, string[]]> = [];
mock.module('@/lib/team-cache', () => ({
  clearTeamCache: async (teamId: string | null | undefined, ...kinds: string[]) => { teamCacheClears.push([teamId, kinds]); return true; },
}));

mock.module('@buildd/core/worker-messages', () => ({
  enqueueWorkerMessage: mockEnqueueWorkerMessage,
  clearWorkerMessages: mock(async () => true),
  buildWorkerMessage: (input: any) => ({
    id: 'msg-1',
    sentAt: new Date(0).toISOString(),
    hopCount: input.hopCount ?? 0,
    ...input,
  }),
  formatWorkerMessages: () => '',
  buildEnqueueContextSql: () => ({}),
  buildClearContextSql: () => ({}),
  WORKER_MESSAGE_CAP: 3,
}));

// The cold path's task write: one shared writer (lib/answer-attempt.ts), whose
// SQL guards are exercised against real Postgres in tests/db.
const mockReopen = mock(async (_input: any): Promise<any> => {
  callOrder.push('reopen');
  return { reopened: true, taskId: 'task-1', entryId: 'entry-1' };
});
mock.module('@/lib/answer-attempt', () => ({ reopenTaskForAnsweredAttempt: mockReopen }));

import { POST } from './route';

function createMockRequest(body?: any): NextRequest {
  const init: RequestInit = {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
  };
  if (body) {
    init.body = JSON.stringify(body);
  }
  return new NextRequest('http://localhost:3000/api/workers/worker-1/respond', init);
}

function createMockRequestWithAuth(body?: any, apiKey?: string): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  const init: RequestInit = {
    method: 'POST',
    headers: new Headers(headers),
  };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest('http://localhost:3000/api/workers/worker-1/respond', init);
}

const mockParams = Promise.resolve({ id: WORKER_ID });

const baseWorker = {
  id: WORKER_ID,
  taskId: 'task-1',
  workspaceId: 'workspace-1',
  accountId: 'account-1',
  status: 'failed',
  branch: 'buildd/task-1-fix-auth',
  waitingFor: {
    type: 'question',
    prompt: 'Which authentication method should we use?',
    options: ['JWT', 'Session cookies'],
  },
  milestones: [
    { label: 'Set up project structure', timestamp: 1700000000 },
    { label: 'Added auth middleware', timestamp: 1700001000 },
  ],
  workspace: { teamId: 'team-1' },
  task: {
    id: 'task-1',
    title: 'Fix auth bug',
    description: 'Fix the authentication bug in login flow',
    workspaceId: 'workspace-1',
    missionId: 'mission-1',
    roleSlug: 'frontend-dev',
    mode: 'execution',
    taskClass: 'work',
    priority: 7,
    outputRequirement: 'pr_required',
    outputSchema: null,
    category: 'bug',
    pathManifest: ['apps/web/src/lib/auth.ts'],
    backend: 'claude',
    dependsOn: ['some-other-task-id'],
    subjectAnchor: { kind: 'ci_retry', prNumber: 42 },
    creationSource: 'orchestrator',
  },
};

describe('POST /api/workers/[id]/respond', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindFirst.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockInsert.mockClear();
    mockInsertValues.mockClear();
    mockInsertReturning.mockClear();
    mockWorkersUpdate.mockClear();
    mockWorkersUpdateSet.mockClear();
    mockWorkersUpdateWhere.mockClear();
    mockWorkersUpdateReturning.mockClear();

    // Reset mock implementations
    mockInsertReturning.mockReturnValue([{ id: 'new-task-1', title: 'Continue: Fix auth bug' }]);
    mockInsertValues.mockImplementation((() => {
      callOrder.push('insert');
      return { returning: mockInsertReturning };
    }) as any);
    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockWorkersUpdateReturning.mockReturnValue([{ id: WORKER_ID, status: 'superseded' }]);
    mockWorkersUpdateWhere.mockReturnValue({ returning: mockWorkersUpdateReturning });
    mockWorkersUpdateSet.mockImplementation((() => {
      callOrder.push('update');
      return { where: mockWorkersUpdateWhere };
    }) as any);
    mockWorkersUpdate.mockReturnValue({ set: mockWorkersUpdateSet });
    mockTasksUpdateSet.mockClear();
    mockNotesInsertValues.mockClear();
    mockTriggerEvent.mockClear();
    mockReleaseAndNotify.mockClear();
    mockPreflight.mockClear();
    mockAnnounceTaskCreated.mockReset();
    mockAnnounceTaskCreated.mockImplementation(async () => {});
    mockWakeTask.mockReset();
    mockWakeTask.mockImplementation(async () => {});
    mockPreflight.mockImplementation(async () => ({ state: 'ok' as const }));
    mockReopen.mockReset();
    mockReopen.mockImplementation(async () => { callOrder.push('reopen'); return { reopened: true, taskId: 'task-1', entryId: 'entry-1' }; });
    mockTasksFindFirst.mockReset();
    mockTasksFindFirst.mockImplementation(async () => null);
    tasksUpdated.length = 0;
    notesInserted.length = 0;
    callOrder.length = 0;
  });

  it('returns 401 when no auth provided', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toContain('Unauthorized');
  });

  it('an answer clears the team\'s cached questions waiting; a refused one clears nothing', async () => {
    teamCacheClears.length = 0;
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });
    expect((await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams })).status).toBe(200);
    expect(teamCacheClears).toEqual([['team-1', ['questions']]]);

    teamCacheClears.length = 0;
    expect((await POST(createMockRequest({}), { params: mockParams })).status).toBe(400);
    expect(teamCacheClears).toEqual([]);
  });

  it('returns 404 when worker not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkersFindFirst.mockResolvedValue(null);

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('returns 404 when session user lacks workspace access', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('returns 400 when worker has no waitingFor', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({
      ...baseWorker,
      waitingFor: null,
      status: 'running',
    });

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.reasonCode).toBe('no_longer_waiting');
    expect(data.nextAction).toEqual({ kind: 'refresh' });
  });

  it('returns 400 when worker is already completed', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({
      ...baseWorker,
      status: 'completed',
      waitingFor: null,
    });

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.reasonCode).toBe('worker_ended');
    expect(data.error).toContain('already stopped');
  });

  // Regression: the /respond endpoint MUST be status-agnostic — it gates on
  // waitingFor presence, not worker.status. The runner's inputAsRetry mode
  // aborts the SDK session when AskUserQuestion fires, leaving the worker in
  // status='error' with waitingFor populated. Covered by the cold-fallback
  // describe below ("answers a %s worker with its question still open").

  it('returns 400 when message is missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });

    const req = createMockRequest({});
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Message is required');
  });

  // ---------------------------------------------------------------------------
  // The cold path: a new attempt of the SAME task, never a new task
  // ---------------------------------------------------------------------------
  // It used to insert a `Continue:` task: a mission grew a card nobody planned,
  // its counters grew, and the parent stayed open forever with its dependents
  // waiting on it. See docs/specs/answered-question-resume.md, "The cold fallback".
  describe('cold fallback: the same task, a new attempt', () => {
    const answerCold = async (over: Record<string, unknown> = {}, message = 'Use JWT tokens') => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
      mockWorkersFindFirst.mockResolvedValue({ ...baseWorker, ...over });
      return POST(createMockRequest({ message }), { params: mockParams });
    };

    it('inserts no task, reopens the answered worker\'s own task and answers with its id (AC-49)', async () => {
      const res = await answerCold();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toMatchObject({ path: 'cold_continuation', taskId: 'task-1', workerId: WORKER_ID, newAttempt: true });
      expect(mockInsertValues).not.toHaveBeenCalled();
      expect(mockReopen).toHaveBeenCalledTimes(1);
      expect(mockReopen.mock.calls[0][0]).toMatchObject({
        taskId: 'task-1',
        worker: { id: WORKER_ID, branch: 'buildd/task-1-fix-auth' },
        question: 'Which authentication method should we use?',
        answer: 'Use JWT tokens',
        milestones: baseWorker.milestones,
        delivery: { path: 'cold_continuation', reasonCode: 'worker_not_parked', workerId: WORKER_ID },
        source: 'respond',
      });
    });

    // An answered worker did not complete its task — a new attempt replaces it.
    // 'completed' counted answered questions as clean successes in
    // get_failure_analytics; 'superseded' is in neither bucket.
    it('supersedes the answered worker (not completed) and links no other task', async () => {
      expect((await answerCold()).status).toBe(200);
      expect(mockWorkersUpdateSet).toHaveBeenCalledTimes(1);
      const setValues = mockWorkersUpdateSet.mock.calls[0][0] as any;
      expect(setValues.status).toBe('superseded');
      expect(setValues.waitingFor).toBeNull();
      expect(setValues.completedAt).toBeInstanceOf(Date);
      expect('continuationTaskId' in setValues).toBe(false);
    });

    it('hands the reopen the end the supersede wrote, so a failed owner names the right attempt', async () => {
      const ended = new Date(5_000);
      mockWorkersUpdateReturning.mockReturnValue([{ id: WORKER_ID, status: 'superseded', completedAt: ended }]);
      await answerCold();
      expect(mockReopen.mock.calls[0][0].worker.completedAt).toEqual(ended);
    });

    it.each([['error'], ['failed'], ['waiting_input']] as const)(
      'answers a %s worker with its question still open onto the same task',
      async ([status]) => {
        const res = await answerCold({ status });
        expect(res.status).toBe(200);
        expect((await res.json()).taskId).toBe('task-1');
      },
    );

    it('releases the superseded attempt\'s path claims and wakes the task as a requeue, once', async () => {
      await answerCold();
      expect(mockReleaseAndNotify).toHaveBeenCalledWith('task-1', 'abandoned');
      expect(mockWakeTask).toHaveBeenCalledTimes(1);
      expect(mockWakeTask.mock.calls[0][0]).toBe('task-1');
      expect(mockWakeTask.mock.calls[0][1]).toBe('task.requeued');
      // No new task to announce.
      expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
    });

    it.each([['completed'], ['cancelled']])('refuses an answer that would reopen a %s task, writing nothing (AC-52)', async (status) => {
      const res = await answerCold({ task: { ...baseWorker.task, status } });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.reasonCode).toBe('task_closed');
      expect(mockWorkersUpdateSet).not.toHaveBeenCalled();
      expect(mockReopen).not.toHaveBeenCalled();
      expect(notesInserted).toHaveLength(0);
    });

    describe('concurrency (CAS) and compensation', () => {
      it('claims the answer with a CAS before reopening the task', async () => {
        expect((await answerCold()).status).toBe(200);
        expect(callOrder[0]).toBe('update');
        expect(callOrder.indexOf('update')).toBeLessThan(callOrder.indexOf('reopen'));
        const where = mockWorkersUpdateWhere.mock.calls[0][0] as any;
        expect(JSON.stringify(where)).toContain('isNotNull');
        expect(JSON.stringify(where)).toContain('workers.waitingFor');
      });

      it('returns 409 and reopens nothing when another answer already won (double answer)', async () => {
        mockWorkersUpdateReturning.mockReturnValue([]);
        const res = await answerCold();
        expect(res.status).toBe(409);
        const data = await res.json();
        expect(data.reasonCode).toBe('already_answered');
        expect(mockReopen).not.toHaveBeenCalled();
        expect(mockInsertValues).not.toHaveBeenCalled();
      });

      it('names the winning answer from a legacy continuation on a 409', async () => {
        mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
        mockAuthenticateApiKey.mockResolvedValue(null);
        mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
        mockWorkersFindFirst
          .mockResolvedValueOnce({ ...baseWorker })
          .mockResolvedValueOnce({ ...baseWorker, status: 'superseded', waitingFor: null, continuationTaskId: 'task-2' });
        mockTasksFindFirst.mockResolvedValueOnce({ context: { userInput: 'Session cookies' } });
        mockWorkersUpdateReturning.mockReturnValue([]);
        const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });
        expect(res.status).toBe(409);
        expect((await res.json()).recordedAnswer).toBe('Session cookies');
      });

      it('names the winning answer from the task\'s own new attempt on a 409', async () => {
        mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
        mockAuthenticateApiKey.mockResolvedValue(null);
        mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
        mockWorkersFindFirst
          .mockResolvedValueOnce({ ...baseWorker })
          .mockResolvedValueOnce({ ...baseWorker, status: 'superseded', waitingFor: null, continuationTaskId: null });
        mockTasksFindFirst.mockResolvedValueOnce({ context: { answeredQuestions: [
          { id: 'e1', workerId: WORKER_ID, question: 'q', answer: 'Session cookies', milestones: [], branch: null, reasonCode: 'worker_not_parked', reason: 'r', answeredAt: '' },
        ] } });
        mockWorkersUpdateReturning.mockReturnValue([]);
        const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });
        expect(res.status).toBe(409);
        expect((await res.json()).recordedAnswer).toBe('Session cookies');
      });

      it('restores the question and answers 500 when reopening the task throws (AC-51)', async () => {
        mockReopen.mockImplementation(async () => { callOrder.push('reopen'); throw new Error('reopen exploded'); });
        const res = await answerCold();
        expect(res.status).toBe(500);
        expect(mockWorkersUpdateSet).toHaveBeenCalledTimes(2);
        const restore = mockWorkersUpdateSet.mock.calls[1][0] as any;
        expect(restore.status).toBe(baseWorker.status);
        expect(restore.waitingFor).toEqual(baseWorker.waitingFor);
        expect(restore.completedAt).toBeNull();
        expect(notesInserted).toHaveLength(0);
        expect(mockWakeTask).not.toHaveBeenCalled();
        expect(mockReleaseAndNotify).not.toHaveBeenCalled();
      });

      it.each([['task_closed'], ['not_reopenable'], ['kernel_refused']] as const)(
        'restores the question and answers 409 when the task cannot be reopened (%s)',
        async (reason) => {
          mockReopen.mockImplementation(async () => { callOrder.push('reopen'); return { reopened: false, reason }; });
          const res = await answerCold();
          expect(res.status).toBe(409);
          expect((await res.json()).reasonCode).toBe(reason);
          const restore = mockWorkersUpdateSet.mock.calls[1][0] as any;
          expect(restore.waitingFor).toEqual(baseWorker.waitingFor);
          expect(mockWakeTask).not.toHaveBeenCalled();
          expect(notesInserted).toHaveLength(0);
        },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Answer path: resume the parked session, or fall back loudly
  // ---------------------------------------------------------------------------
  // A worker parked on a question is a HEALTHY session. Answering it used to
  // end that session unconditionally and hand a cold `Continue:` task a branch
  // and a description — so a worker hundreds of turns deep lost every judgement
  // it had made. See docs/specs/answered-question-resume.md.
  describe('answer path', () => {
    /** A worker that clears every resume gate. */
    function parkedWorker(overrides: Record<string, unknown> = {}) {
      return {
        ...baseWorker,
        status: 'waiting_input',
        updatedAt: new Date(),
        turns: 42,
        supportsInstructionAck: true,
        pendingInstructions: null,
        instructionHistory: [],
        account: { teamId: 'team-1' },
        ...overrides,
      };
    }

    function authorize() {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    }

    // AC-9 — same task, same worker, no Continue: child.
    it('resumes the parked session instead of creating a continuation task', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(parkedWorker());

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.path).toBe('resume');
      expect(data.reasonCode).toBe('resume_eligible');
      // The caller navigates back to the SAME task — the resumed worker is there.
      expect(data.taskId).toBe('task-1');
      expect(mockInsertValues).not.toHaveBeenCalled();
    });

    describe('a worker parked by the cloud runner', () => {
      const PARKED_UNTIL = () => new Date(Date.now() + 60 * 60 * 1000);

      it('resumes although its last sync is hours old, and fires task.resume for the SAME worker', async () => {
        authorize();
        mockDispatchResumedTask.mockClear();
        mockWorkersFindFirst.mockResolvedValue(parkedWorker({
          updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
          parkedUntil: PARKED_UNTIL(),
        }));

        const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.path).toBe('resume');
        expect(data.resumeDispatched).toBe(true);
        expect(mockInsertValues).not.toHaveBeenCalled();
        expect(mockDispatchResumedTask).toHaveBeenCalledTimes(1);
        const [task, , workerId] = mockDispatchResumedTask.mock.calls[0]!;
        expect(task.id).toBe('task-1');
        expect(workerId).toBe(WORKER_ID);
        // The answer is queued first: the container that wakes drains it.
        expect((mockWorkersUpdateSet.mock.calls.at(-1)![0] as any).pendingInstructions).toBe('Use JWT tokens');
      });

      it('an unparked (host runner) resume fires no task.resume', async () => {
        authorize();
        mockDispatchResumedTask.mockClear();
        mockWorkersFindFirst.mockResolvedValue(parkedWorker({ parkedUntil: null }));
        const data = await (await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams })).json();
        expect(data.path).toBe('resume');
        expect(mockDispatchResumedTask).not.toHaveBeenCalled();
      });

      it('an expired park with a stale sync goes cold, as before', async () => {
        authorize();
        mockDispatchResumedTask.mockClear();
        mockWorkersFindFirst.mockResolvedValue(parkedWorker({
          updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
          parkedUntil: new Date(Date.now() - 1000),
        }));
        const data = await (await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams })).json();
        expect(data.path).toBe('cold_continuation');
        expect(mockDispatchResumedTask).not.toHaveBeenCalled();
      });

      it('a failed task.resume still answers resume: the ack deadline sweep covers it', async () => {
        authorize();
        mockDispatchResumedTask.mockClear();
        mockDispatchResumedTask.mockImplementationOnce(async () => { throw new Error('webhook down'); });
        mockWorkersFindFirst.mockResolvedValue(parkedWorker({ updatedAt: new Date(0), parkedUntil: PARKED_UNTIL() }));
        const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });
        expect(res.status).toBe(200);
        expect((await res.json()).resumeDispatched).toBe(false);
      });
    });

    // AC-10 — the answer rides the acknowledged instruction queue, which is
    // the wiring the runner already drains into resumeSession.
    it('queues the answer on the same worker with an unconfirmed delivery state', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(parkedWorker());

      await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      const setValues = mockWorkersUpdateSet.mock.calls[0][0] as any;
      expect(setValues.pendingInstructions).toBe('Use JWT tokens');
      expect(setValues.instructionHistory).toHaveLength(1);
      expect(setValues.instructionHistory[0].deliveryState).toBe('pending');
      expect(setValues.instructionHistory[0].message).toBe('Use JWT tokens');
    });

    it('appends to an existing instruction queue rather than overwriting it', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(
        parkedWorker({ pendingInstructions: 'earlier undelivered message' }),
      );

      await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      const setValues = mockWorkersUpdateSet.mock.calls[0][0] as any;
      expect(setValues.pendingInstructions).toContain('earlier undelivered message');
      expect(setValues.pendingInstructions).toContain('Use JWT tokens');
    });

    // AC-11 — superseding a worker that goes on to finish would hide a real
    // success or failure behind an analytics exclusion.
    it('does not supersede or complete the resumed worker', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(parkedWorker());

      await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      const setValues = mockWorkersUpdateSet.mock.calls[0][0] as any;
      expect(setValues.status).toBeUndefined();
      expect(setValues.completedAt).toBeUndefined();
      expect(setValues.waitingFor).toBeNull();
    });

    it('pushes the answer urgently as well as queueing it', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(parkedWorker());

      await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
      const [channel, event, payload] = mockTriggerEvent.mock.calls[0] as any[];
      expect(channel).toBe(`worker-${WORKER_ID}`);
      expect(event).toBe('worker:command');
      expect(payload).toMatchObject({ action: 'message', text: 'Use JWT tokens' });
    });

    // AC-12/13 — the resume path offers no second way past the single-answer guard.
    it('still gates on the question being open, returning 409 to a racing answer', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(parkedWorker());
      mockWorkersUpdateReturning.mockReturnValue([]);

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(409);
      expect(mockInsertValues).not.toHaveBeenCalled();
      expect(mockTriggerEvent).not.toHaveBeenCalled();
      const where = mockWorkersUpdateWhere.mock.calls[0][0] as any;
      expect(JSON.stringify(where)).toContain('isNotNull');
    });

    // The resume path keeps status waiting_input with the answer queued. A
    // second tap there is a duplicate, and must be told what was recorded.
    it('calls a second tap on a resumed, not-yet-picked-up worker already answered, with the answer', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue({
        ...parkedWorker(),
        waitingFor: null,
        pendingInstructions: 'Park and wait',
        instructionHistory: [{ type: 'instruction', message: 'Park and wait', timestamp: 1, deliveryState: 'pending' }],
      });

      const res = await POST(createMockRequest({ message: 'Park and wait' }), { params: mockParams });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.reasonCode).toBe('already_answered');
      expect(data.recordedAnswer).toBe('Park and wait');
      expect(mockWorkersUpdateSet).not.toHaveBeenCalled();
    });

    it('records the resume decision on the answered task', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(parkedWorker());

      await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(tasksUpdated).toHaveLength(1);
      expect(tasksUpdated[0].context.answerDelivery).toMatchObject({
        path: 'resume',
        reasonCode: 'resume_eligible',
        workerId: WORKER_ID,
      });
      expect(tasksUpdated[0].context.answerDelivery.ackDeadlineAt).toBeTruthy();
      // Warm resume path: the SAME worker/task continue, so nothing was
      // superseded and no claim should be released.
      expect(mockReleaseAndNotify).not.toHaveBeenCalled();
    });

    it('posts one feed note naming the resumed path', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(parkedWorker());

      await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(notesInserted).toHaveLength(1);
      expect(notesInserted[0].type).toBe('update');
      expect(notesInserted[0].taskId).toBe('task-1');
      expect(notesInserted[0].body).toContain('Resumed');
    });

    // AC-14/15 — a fallback is never silent.
    it.each([
      ['a worker that is no longer parked', { status: 'error' }, 'worker_not_parked'],
      [
        'a runner that stopped syncing the worker',
        { updatedAt: new Date(Date.now() - 10 * 60 * 1000) },
        'runner_not_holding_transcript',
      ],
      [
        'a runner that cannot confirm delivery',
        { supportsInstructionAck: false },
        'runner_cannot_confirm_delivery',
      ],
      ['a session past the turn ceiling', { turns: 5000 }, 'context_ceiling'],
    ])('falls back to a new attempt of the same task for %s, recording the reason', async (_label, overrides, reasonCode) => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(parkedWorker(overrides as Record<string, unknown>));

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.path).toBe('cold_continuation');
      expect(data.reasonCode).toBe(reasonCode);
      // AC-14: the same task, never a new one.
      expect(data.taskId).toBe('task-1');
      expect(mockInsertValues).not.toHaveBeenCalled();

      // Recorded on the task (by the reopen, as answerDelivery) and in the feed (AC-15).
      expect(mockReopen.mock.calls[0][0].delivery).toMatchObject({ path: 'cold_continuation', reasonCode });
      expect(notesInserted).toHaveLength(1);
      expect(notesInserted[0].body).toContain('new attempt of this task');

      // The superseded attempt's path claims go, as on every requeue: the new
      // attempt declares its own.
      expect(mockReleaseAndNotify).toHaveBeenCalledWith('task-1', 'abandoned');
    });

    // AC-23 — the answer is still recorded; the owner is warned separately.
    it('warns the owner when the backend credential is unhealthy, without dropping the answer', async () => {
      authorize();
      mockPreflight.mockImplementation(async () => ({
        state: 'unhealthy' as const,
        detail: 'the claude credential for this workspace is expired and could not be refreshed',
      }) as any);
      mockWorkersFindFirst.mockResolvedValue(parkedWorker());

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.reasonCode).toBe('credential_unhealthy');
      // The human's answer survives on a new attempt of the same task (AC-23)...
      expect(mockReopen).toHaveBeenCalledTimes(1);
      expect(mockInsertValues).not.toHaveBeenCalled();
      // ...but that is not progress (AC-55): blocked on the credential, said twice.
      expect(data.blockedOn).toBe('credential');
      expect(notesInserted).toHaveLength(1);
      expect(notesInserted[0].type).toBe('warning');
      expect(notesInserted[0].body).toContain('expired');
      expect(notesInserted[0].body).toContain('cannot start until the credential is reconnected');
    });

    // AC-8 — an account supplying its own key has no managed row.
    it('resumes when no managed credential row exists', async () => {
      authorize();
      mockPreflight.mockImplementation(async () => ({ state: 'unknown' as const }) as any);
      mockWorkersFindFirst.mockResolvedValue(parkedWorker());

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      const data = await res.json();
      expect(data.path).toBe('resume');
    });

    it('preflights the codex credential for a codex-backed task', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(
        parkedWorker({ task: { ...baseWorker.task, backend: 'codex' } }),
      );

      await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(mockPreflight.mock.calls[0][0]).toMatchObject({ backend: 'codex' });
    });

    it('omits the question from the delivery record for a sensitive workspace', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(
        parkedWorker({ workspace: { teamId: 'team-1', dataClass: 'sensitive' } }),
      );

      await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(tasksUpdated[0].context.answerDelivery.question).toBeUndefined();
      const setValues = mockWorkersUpdateSet.mock.calls[0][0] as any;
      expect(setValues.instructionHistory[0].message).toBeUndefined();
    });
  });
  // ---------------------------------------------------------------------------
  // Revoked credential: refused outright, not routed down either path (#2528).
  //
  // A revoked credential cannot be recovered without a human, and the claim
  // rail already declines to inject one — so a continuation could not run
  // either, while superseding the worker would destroy the transcript and
  // worktree that make a later RESUME possible. Refusing keeps the question
  // parked and costs nothing. An expired-but-refreshable credential is the
  // different case handled by gate G5 above.
  // ---------------------------------------------------------------------------
  describe('revoked credential refusal', () => {
    function authorize() {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    }

    it('refuses the answer when the claude credential is revoked, leaving the question open', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });
      mockPreflight.mockImplementation(async () => ({
        state: 'unhealthy' as const,
        revoked: true,
        detail: 'the claude credential for this workspace has been revoked',
        lastFailureMessage: 'invalid_grant',
      }) as any);

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.credentialRevoked).toBe(true);
      expect(data.backend).toBe('claude');
      expect(data.error).toContain('revoked');
      expect(data.error).toContain('invalid_grant');
      // Nothing written: the answer is not lost and no continuation is
      // dispatched into a dead credential.
      expect(mockWorkersUpdateSet).not.toHaveBeenCalled();
      expect(mockInsertValues).not.toHaveBeenCalled();
      expect(notesInserted).toHaveLength(0);
    });

    it('names the codex backend when a codex-backed task has a revoked credential', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue({
        ...baseWorker,
        task: { ...baseWorker.task, backend: 'codex' },
      });
      mockPreflight.mockImplementation(async () => ({
        state: 'unhealthy' as const,
        revoked: true,
        detail: 'the codex credential for this workspace has been revoked',
      }) as any);

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.credentialRevoked).toBe(true);
      expect(data.backend).toBe('codex');
      expect(mockInsertValues).not.toHaveBeenCalled();
      expect(mockReopen).not.toHaveBeenCalled();
    });

    it('proceeds when the credential is merely healthy or absent', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });
      mockPreflight.mockImplementation(async () => ({ state: 'unknown' as const }) as any);

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.taskId).toBe('task-1');
    });
  });

  // ---------------------------------------------------------------------------
  // No link to another task: a new attempt lives under the same task, so
  // `continuationTaskId` (a legacy record's pointer) is never written.
  // ---------------------------------------------------------------------------
  describe('no continuation link', () => {
    function authorize() {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    }

    it('writes no continuationTaskId on the cold path', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });
      expect((await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams })).status).toBe(200);
      for (const [set] of mockWorkersUpdateSet.mock.calls as any[]) expect(set.continuationTaskId).toBeUndefined();
    });

    it('does not link a continuation onto a RESUMED worker', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue({
        ...baseWorker,
        status: 'waiting_input',
        updatedAt: new Date(),
        turns: 42,
        supportsInstructionAck: true,
        pendingInstructions: null,
        instructionHistory: [],
      });

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.path).toBe('resume');
      // One write only — the claim. Nothing claims a supersession that did not
      // happen, and nothing reopens the task.
      expect(mockWorkersUpdateSet).toHaveBeenCalledTimes(1);
      expect(mockWorkersUpdateSet.mock.calls[0][0].continuationTaskId).toBeUndefined();
      expect(mockReopen).not.toHaveBeenCalled();
    });
  });

  // The reopened task needs a wake: a webhook-only workspace (no polling)
  // never finds it otherwise. It is a requeue, not a new task.
  describe('new-attempt dispatch', () => {
    function authorize() {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    }

    it('wakes the same task once as a requeue, and announces no new task', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });
      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });
      expect(res.status).toBe(200);
      expect(mockWakeTask.mock.calls).toEqual([['task-1', 'task.requeued']]);
      expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
    });

    it('does not dispatch anything on the warm resume path', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue({
        ...baseWorker,
        status: 'waiting_input',
        updatedAt: new Date(),
        turns: 42,
        supportsInstructionAck: true,
        pendingInstructions: null,
        instructionHistory: [],
        account: { teamId: 'team-1' },
      });
      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });
      expect(res.status).toBe(200);
      expect((await res.json()).path).toBe('resume');
      expect(mockWakeTask).not.toHaveBeenCalled();
    });

    it('does not dispatch when the task cannot be reopened', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });
      mockReopen.mockImplementation(async () => { throw new Error('reopen failed'); });
      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });
      expect(res.status).toBe(500);
      expect(mockWakeTask).not.toHaveBeenCalled();
    });
  });

  // A stale needs-input card — rendered while the worker was waiting, tapped
  // after it stopped — used to get the raw gate text "Worker is not waiting for
  // input". The reply now says what happened and where to go next.
  describe('stale card (nothing is waiting any more)', () => {
    function authorize() {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    }

    it('points a legacy already-answered question at its continuation task (AC-30)', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue({
        ...baseWorker,
        status: 'superseded',
        waitingFor: null,
        continuationTaskId: 'task-2',
      });

      const res = await POST(createMockRequest({ message: 'Allow once' }), { params: mockParams });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.reasonCode).toBe('already_answered');
      expect(data.nextAction).toEqual({ kind: 'open_task', taskId: 'task-2' });
      expect(data.error).not.toContain('not waiting for input');
      expect(mockWorkersUpdateSet).not.toHaveBeenCalled();
    });

    // The real incident: the permission hook was resolved as deny when the
    // session aborted, but the prompt stayed on the ended worker's row. An
    // "Allow once" there used to become a Continue: task whose whole brief
    // was "Allow once" — granting nothing to a session that no longer exists.
    it.each([['failed'], ['error'], ['completed']])(
      'refuses a permission prompt left on a %s worker instead of starting a continuation',
      async (status) => {
        authorize();
        mockWorkersFindFirst.mockResolvedValue({
          ...baseWorker,
          status,
          waitingFor: { type: 'permission', prompt: 'Permission required for Bash: rm -rf *', options: ['Allow once', 'Deny'] },
        });

        const res = await POST(createMockRequest({ message: 'Allow once' }), { params: mockParams });

        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.reasonCode).toBe('worker_ended');
        expect(data.nextAction).toEqual({ kind: 'follow_up' });
        expect(mockInsertValues).not.toHaveBeenCalled();
        expect(mockWorkersUpdateSet).not.toHaveBeenCalled();
      },
    );

    // A question on an errored worker is still answerable (inputAsRetry).
    it('still accepts a question left on an errored worker', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue({ ...baseWorker, status: 'error' });

      const res = await POST(createMockRequest({ message: 'JWT' }), { params: mockParams });

      expect(res.status).toBe(200);
      expect((await res.json()).path).toBe('cold_continuation');
    });
  });

  describe('permission prompt on a live session', () => {
    it('answers into the live session even far past the resume turn ceiling', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
      mockWorkersFindFirst.mockResolvedValue({
        ...baseWorker,
        status: 'waiting_input',
        updatedAt: new Date(),
        turns: 4000,
        supportsInstructionAck: true,
        pendingInstructions: null,
        instructionHistory: [],
        waitingFor: { type: 'permission', prompt: 'Permission required for Bash: gh run download', options: ['Allow once', 'Deny'] },
      });

      const res = await POST(createMockRequest({ message: 'Allow once' }), { params: mockParams });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.path).toBe('resume');
      expect(mockInsertValues).not.toHaveBeenCalled();
      expect((mockWorkersUpdateSet.mock.calls[0][0] as any).status).toBeUndefined();
    });
  });

  // An interactive worker (claim_task from a person's own session) is parked
  // by ask_human. No runner holds it, so RESUME would queue an answer nobody
  // drains, and COLD would hand live local work to a runner.
  describe('an interactive session', () => {
    function interactiveWorker(overrides: Record<string, unknown> = {}) {
      return {
        ...baseWorker,
        runner: 'mcp',
        status: 'waiting_input',
        updatedAt: new Date(Date.now() - 5 * 60 * 1000),
        turns: 3,
        supportsInstructionAck: false,
        pendingInstructions: null,
        instructionHistory: [],
        account: { teamId: 'team-1' },
        ...overrides,
      };
    }

    function authorize() {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    }

    beforeEach(() => {
      enqueuedMessages.length = 0;
      mockEnqueueWorkerMessage.mockClear();
      mockEnqueueWorkerMessage.mockImplementation(async (taskId: string, message: any) => {
        enqueuedMessages.push({ taskId, message });
        return true;
      });
      mockWorkersUpdateReturning.mockReturnValue([{ id: WORKER_ID, status: 'running', updatedAt: new Date() }] as any);
    });

    it('queues the answer for that session, flips it to running and creates no continuation', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(interactiveWorker());

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.path).toBe('interactive');
      expect(data.reasonCode).toBe('interactive_session');
      expect(data.taskId).toBe('task-1');
      expect(mockInsertValues).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
      expect(mockReleaseAndNotify).not.toHaveBeenCalled();

      // The answer is an `answer` worker message on the worker's own task.
      expect(enqueuedMessages).toHaveLength(1);
      const { taskId, message } = enqueuedMessages[0]!;
      expect(taskId).toBe('task-1');
      expect(message.type).toBe('answer');
      expect(message.toTaskId).toBe('task-1');
      expect(message.body).toMatchObject({
        source: 'human',
        text: 'Use JWT tokens',
        question: 'Which authentication method should we use?',
      });

      // One CAS write: question closed, worker running, answer in history
      // under the message id so the session's ack settles it.
      const set = mockWorkersUpdateSet.mock.calls[0]![0] as any;
      expect(set.status).toBe('running');
      expect(set.waitingFor).toBeNull();
      expect(set.pendingInstructions).toBeUndefined();
      const entry = set.instructionHistory.at(-1);
      expect(entry).toMatchObject({ type: 'instruction', message: 'Use JWT tokens', deliveryState: 'pending', id: message.id });
      const where = mockWorkersUpdateWhere.mock.calls[0]![0] as any;
      expect(where.conditions.some((c: any) => c.type === 'isNotNull' && c.field === 'workers.waitingFor')).toBe(true);

      // Recorded like every other path, naming the message so await_answer
      // can find the answer after the capped queue has evicted it.
      expect(mergedAnswerDelivery(tasksUpdated.at(-1))).toMatchObject({ path: 'interactive', reasonCode: 'interactive_session', workerId: WORKER_ID, messageId: message.id });
      expect(notesInserted.at(-1)?.body).toContain('session that asked');
    });

    // The wait capability ask_human minted names this ask; the record carries
    // it so the shell waiter can tell its own answer from a later one's.
    it('carries the open ask id into the delivery record', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(interactiveWorker({
        waitingFor: { type: 'question', prompt: 'Which authentication method should we use?', waitCapId: 'ask-abc' },
      }));
      await POST(createMockRequest({ message: 'JWT' }), { params: mockParams });
      expect(mergedAnswerDelivery(tasksUpdated.at(-1))).toMatchObject({ path: 'interactive', waitCapId: 'ask-abc' });
    });

    // Regression: the record used to be written as { ...context read before
    // the enqueue, answerDelivery }, which overwrote the pendingWorkerMessages
    // the enqueue had just appended — deleting the answer from the queue.
    it('merges its delivery record into the live context instead of overwriting the queued answer', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(interactiveWorker());
      await POST(createMockRequest({ message: 'JWT' }), { params: mockParams });
      const write = tasksUpdated.at(-1);
      expect(write.context.type).toBe('sql');
      expect(write.context.strings.join('?')).toContain('||');
    });

    // await_answer / receive_messages stamp waitingFor.sessionSeenAt while the
    // session polls. A session that stopped polling is gone: its answer goes
    // cold rather than sitting in a queue nobody reads.
    it('a session whose poll heartbeat went stale goes cold with its own reason', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(interactiveWorker({
        waitingFor: { type: 'question', prompt: 'Which authentication method should we use?', sessionSeenAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
      }));
      mockWorkersUpdateReturning.mockReturnValue([{ id: WORKER_ID, status: 'superseded' }] as any);

      const res = await POST(createMockRequest({ message: 'JWT' }), { params: mockParams });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.path).toBe('cold_continuation');
      expect(data.reasonCode).toBe('interactive_session_stopped_polling');
      // A new attempt of the same task, not a new task.
      expect(mockInsertValues).not.toHaveBeenCalled();
      expect(mockReopen).toHaveBeenCalledTimes(1);
      expect(data.taskId).toBe('task-1');
      expect(mockEnqueueWorkerMessage).not.toHaveBeenCalled();
    });

    it('a session that polled a moment ago is answered in place', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(interactiveWorker({
        waitingFor: { type: 'question', prompt: 'Which authentication method should we use?', sessionSeenAt: new Date(Date.now() - 20_000).toISOString() },
      }));
      const res = await POST(createMockRequest({ message: 'JWT' }), { params: mockParams });
      expect((await res.json()).path).toBe('interactive');
    });

    it('tells open views the worker is running again', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(interactiveWorker());
      await POST(createMockRequest({ message: 'JWT' }), { params: mockParams });

      const calls = mockTriggerEvent.mock.calls as any[];
      const toWorker = calls.find(([ch, ev]) => ch === `worker-${WORKER_ID}` && ev === 'worker:progress');
      const toTask = calls.find(([ch, ev]) => ch === 'task-task-1' && ev === 'worker:progress');
      expect(toWorker?.[2]).toMatchObject({ workerId: WORKER_ID, status: 'running' });
      expect(toTask?.[2]).toMatchObject({ status: 'running' });
    });

    // The session runs on the person's own seat, not the workspace's managed
    // credential, so that credential's state is irrelevant to it.
    it('is not refused by a revoked managed credential, and never preflights it', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(interactiveWorker());
      mockPreflight.mockImplementation(async () => ({ state: 'unhealthy' as const, revoked: true, detail: 'revoked' }) as any);

      const res = await POST(createMockRequest({ message: 'JWT' }), { params: mockParams });

      expect(res.status).toBe(200);
      expect((await res.json()).path).toBe('interactive');
      expect(mockPreflight).not.toHaveBeenCalled();
    });

    it('withholds the answer text from history in a sensitive workspace but still delivers it', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(interactiveWorker({ workspace: { teamId: 'team-1', dataClass: 'sensitive' } }));

      await POST(createMockRequest({ message: 'secret answer' }), { params: mockParams });

      const set = mockWorkersUpdateSet.mock.calls[0]![0] as any;
      expect(set.instructionHistory.at(-1).message).toBeUndefined();
      expect(enqueuedMessages[0]!.message.body.text).toBe('secret answer');
      expect(enqueuedMessages[0]!.message.body.question).toBeUndefined();
    });

    it('a second tap that loses the race queues nothing', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(interactiveWorker());
      mockWorkersUpdateReturning.mockReturnValue([] as any);

      const res = await POST(createMockRequest({ message: 'JWT' }), { params: mockParams });

      expect(res.status).toBe(409);
      expect((await res.json()).reasonCode).toBe('already_answered');
      expect(mockEnqueueWorkerMessage).not.toHaveBeenCalled();
    });

    it('a duplicate tap after the answer reads as already answered, not moved on', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(interactiveWorker({
        status: 'running',
        waitingFor: null,
        instructionHistory: [{ id: 'msg-1', type: 'instruction', message: 'JWT', timestamp: 1, deliveryState: 'pending' }],
      }));

      const res = await POST(createMockRequest({ message: 'JWT' }), { params: mockParams });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.reasonCode).toBe('already_answered');
      expect(data.recordedAnswer).toBe('JWT');
    });

    it('restores the question when the answer cannot be queued', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(interactiveWorker());
      mockEnqueueWorkerMessage.mockImplementation(async () => false);

      const res = await POST(createMockRequest({ message: 'JWT' }), { params: mockParams });

      expect(res.status).toBe(500);
      const restore = mockWorkersUpdateSet.mock.calls.at(-1)![0] as any;
      expect(restore.status).toBe('waiting_input');
      expect(restore.waitingFor).toMatchObject({ type: 'question' });
      expect(restore.instructionHistory).toEqual([]);
      expect(mockInsertValues).not.toHaveBeenCalled();
    });

    // Regression: updatedAt is frozen at the ask while parked, so an answer
    // given hours later must still reach the session that is polling for it.
    it('answers a session parked 3h ago in place, not via a runner continuation', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(interactiveWorker({ updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) }));

      const res = await POST(createMockRequest({ message: 'JWT' }), { params: mockParams });

      expect(res.status).toBe(200);
      expect((await res.json()).path).toBe('interactive');
      expect(mockInsertValues).not.toHaveBeenCalled();
      expect(mockEnqueueWorkerMessage).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['running but past the interactive idle window', { status: 'running', updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) }],
      ['failed', { status: 'failed' }],
      ['errored', { status: 'error' }],
    ])('a session that is gone (%s) goes cold with its reason recorded', async (_label, overrides) => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(interactiveWorker(overrides));
      mockWorkersUpdateReturning.mockReturnValue([{ id: WORKER_ID, status: 'superseded' }] as any);

      const res = await POST(createMockRequest({ message: 'JWT' }), { params: mockParams });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.path).toBe('cold_continuation');
      expect(data.reasonCode).toBe('interactive_session_gone');
      // A new attempt of the same task, not a new task.
      expect(mockInsertValues).not.toHaveBeenCalled();
      expect(mockReopen).toHaveBeenCalledTimes(1);
      expect(data.taskId).toBe('task-1');
      expect(mockEnqueueWorkerMessage).not.toHaveBeenCalled();
      expect(data.message).toContain('interactive session that asked');
      // The continuation runs on a runner, so its credential is preflighted.
      expect(mockPreflight).toHaveBeenCalled();
    });
  });

  // Every other open view of this worker (a phone left on the task page, the
  // home cards) had no signal that the question was gone and kept offering it.
  it('tells open views the worker was superseded when an answer goes cold', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });

    const res = await POST(createMockRequest({ message: 'JWT' }), { params: mockParams });
    expect(res.status).toBe(200);

    const calls = mockTriggerEvent.mock.calls as any[];
    const toWorker = calls.find(([ch]) => ch === `worker-${WORKER_ID}`);
    const toTask = calls.find(([ch]) => ch === 'task-task-1');
    expect(toWorker?.[1]).toBe('worker:progress');
    expect(toWorker?.[2]).toMatchObject({ workerId: WORKER_ID, status: 'superseded' });
    expect(toTask?.[1]).toBe('worker:progress');
  });

  describe('POST /api/workers/[id]/respond — OAuth session owner check', () => {
    // Invariant: a bearer caller may answer only a worker it claimed. An OAuth
    // session shares its account with the whole team, so ownership is the
    // session user recorded at claim (claimedByUserId), not the account.
    // Answering a teammate's worker goes through the dashboard cookie path,
    // which checks workspace membership instead.
    const oauthWorker = { ...baseWorker, accountId: 'account-1', workspaceId: 'workspace-1', claimedByUserId: 'user-a' };
    const session = (sessionUserId: string, extra: Record<string, unknown> = {}) =>
      ({ id: 'account-1', teamId: 'team-1', sessionUserId, level: 'admin', ...extra });

    beforeEach(() => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });
      mockWorkersFindFirst.mockResolvedValue({ ...oauthWorker });
    });

    it('the session user that claimed the worker is allowed', async () => {
      mockAuthenticateApiKey.mockResolvedValue(session('user-a'));
      const res = await POST(createMockRequestWithAuth({ message: 'Use JWT tokens' }, 'oauth-token'), { params: mockParams });
      expect(res.status).toBe(200);
      expect(mockWorkersUpdateSet).toHaveBeenCalled();
    });

    it('an admin-level session of another team member may answer, as it may steer (/instruct)', async () => {
      mockAuthenticateApiKey.mockResolvedValue(session('user-b'));
      const res = await POST(createMockRequestWithAuth({ message: 'Use JWT tokens' }, 'oauth-token'), { params: mockParams });
      expect(res.status).toBe(200);
    });

    it('a worker-level session of another team member is refused, and nothing is written', async () => {
      mockAuthenticateApiKey.mockResolvedValue(session('user-b', { level: 'worker' }));
      // A dashboard cookie for the same person must not rescue the bearer path.
      mockGetCurrentUser.mockResolvedValue({ id: 'user-b' });
      const res = await POST(createMockRequestWithAuth({ message: 'Use JWT tokens' }, 'oauth-token'), { params: mockParams });
      expect(res.status).toBe(403);
      expect(mockWorkersUpdateSet).not.toHaveBeenCalled();
      expect(mockInsertValues).not.toHaveBeenCalled();
      expect(mockTasksUpdateSet).not.toHaveBeenCalled();
      expect(mockTriggerEvent).not.toHaveBeenCalled();
    });

    it("the dashboard cookie session still answers a teammate's worker via workspace access", async () => {
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockGetCurrentUser.mockResolvedValue({ id: 'user-b' });
      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });
      expect(res.status).toBe(200);
      expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith('user-b', 'workspace-1');
    });

    it('a session with no team id is refused even when the user matches', async () => {
      mockAuthenticateApiKey.mockResolvedValue(session('user-a', { teamId: null }));
      const res = await POST(createMockRequestWithAuth({ message: 'Use JWT tokens' }, 'oauth-token'), { params: mockParams });
      expect(res.status).toBe(403);
      expect(mockWorkersUpdateSet).not.toHaveBeenCalled();
      expect(mockInsertValues).not.toHaveBeenCalled();
    });
  });
});
