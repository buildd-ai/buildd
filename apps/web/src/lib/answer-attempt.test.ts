/**
 * reopenTaskForAnsweredAttempt: a cold answer is a new attempt of the SAME task
 * (docs/specs/answered-question-resume.md, "The cold fallback"). The SQL guards
 * themselves are exercised against real Postgres in
 * apps/web/tests/db/answered-attempt-mission.test.ts; this pins the branching.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

let taskRow: Record<string, any> | null = null;
const taskUpdates: Array<{ set: any; where: any }> = [];
let updateReturns: Array<Array<{ id: string }>> = [];
let updateThrows: Error | null = null;

const mockFindFirst = mock(async () => taskRow);

mock.module('@buildd/core/db', () => ({
  db: {
    query: { tasks: { findFirst: mockFindFirst } },
    update: (_table: unknown) => ({
      set: (set: any) => ({
        where: (where: any) => {
          taskUpdates.push({ set, where });
          const rows = updateReturns.shift() ?? [{ id: 'task-2' }];
          const settle = () => (updateThrows ? Promise.reject(updateThrows) : Promise.resolve(rows));
          return { returning: settle, then: (ok: any, ko: any) => settle().then(ok, ko) };
        },
      }),
    }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ type: 'eq', field, value }),
  and: (...conditions: any[]) => ({ type: 'and', conditions }),
  inArray: (field: any, values: any[]) => ({ type: 'inArray', field, values }),
  sql: Object.assign((strings: TemplateStringsArray, ...values: any[]) => ({ type: 'sql', strings: [...strings], values }), {
    join: (parts: any[], sep: any) => ({ type: 'sql-join', parts, sep }),
  }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'tasks.id', status: 'tasks.status', context: 'tasks.context' },
}));
mock.module('@buildd/core/db/relational-sql', () => ({ sqlWhere: (x: unknown) => x }));

const mockRequeueOwner = mock(async (_p: any) => true);
const mockReopenOwner = mock(async (_p: any) => true);
mock.module('@/lib/workflow/owner-attempt', () => ({
  requeueOwner: mockRequeueOwner,
  reopenOwner: mockReopenOwner,
  endedAtOf: (d: Date | string | null | undefined) => (d == null ? null : new Date(d).toISOString()),
  isOwnerTask: (t: any) => !!t?.deliveryId && t.deliveryRole === 'owner',
  notOwnerTaskSql: () => ({ type: 'notOwnerTaskSql' }),
}));
mock.module('@/lib/workflow/pr-fact-scope', () => ({
  notKernelMergedTaskSql: () => ({ type: 'notKernelMergedTaskSql' }),
  notDeliveryOwnedTaskSql: () => ({ type: 'notDeliveryOwnedTaskSql' }),
}));
mock.module('@/lib/workflow/kernel-client', () => ({
  systemPrincipal: (s: string) => ({ kind: 'system', id: s }),
}));
mock.module('@/lib/integration-refresh', () => ({
  requeueBranchContext: (_ctx: unknown, branch: string | null | undefined) => (branch ? { baseBranch: branch, resumeBranch: branch } : {}),
}));

const { reopenTaskForAnsweredAttempt } = await import('./answer-attempt');

const delivery = {
  path: 'cold_continuation' as const,
  reasonCode: 'runner_not_holding_transcript' as const,
  reason: 'the runner stopped reporting',
  workerId: 'worker-2',
  decidedAt: new Date(0).toISOString(),
};

const input = (over: Record<string, unknown> = {}) => ({
  taskId: 'task-2',
  worker: { id: 'worker-2', branch: 'buildd/task-2-build', lastCommitSha: 'abc123', completedAt: new Date(1_000) },
  milestones: [{ label: 'Wrote the parser', timestamp: 1 }],
  question: 'Which format?',
  answer: 'JSON lines',
  delivery,
  source: 'respond',
  ...over,
});

/** The jsonb merge patch a context write carries, parsed out of its SQL. */
function patchOf(set: any): any {
  for (const v of set?.context?.values ?? []) {
    if (typeof v === 'string' && v.includes('answeredQuestions')) return JSON.parse(v);
  }
  return undefined;
}

/** Every SQL guard named anywhere in a WHERE, by type. */
function guards(where: any, out: string[] = []): string[] {
  if (!where || typeof where !== 'object') return out;
  if (where.type) out.push(where.type);
  for (const c of where.conditions ?? []) guards(c, out);
  return out;
}

beforeEach(() => {
  taskRow = { id: 'task-2', workspaceId: 'ws-1', status: 'in_progress', context: { iteration: 1, filingTargets: ['ws-9'] }, deliveryId: null, deliveryRole: null };
  taskUpdates.length = 0;
  updateReturns = [];
  updateThrows = null;
  mockRequeueOwner.mockClear();
  mockReopenOwner.mockClear();
  mockRequeueOwner.mockImplementation(async () => true);
  mockReopenOwner.mockImplementation(async () => true);
});

describe('reopenTaskForAnsweredAttempt', () => {
  it('reopens the same task pending, unclaimed, with the answer merged into its context', async () => {
    const r = await reopenTaskForAnsweredAttempt(input());
    expect(r).toMatchObject({ reopened: true, taskId: 'task-2' });
    expect(taskUpdates).toHaveLength(1);
    const { set, where } = taskUpdates[0];
    expect(set).toMatchObject({ status: 'pending', claimedBy: null, claimedAt: null, expiresAt: null });
    const patch = patchOf(set);
    expect(patch.answeredQuestions).toHaveLength(1);
    expect(patch.answeredQuestions[0]).toMatchObject({ workerId: 'worker-2', question: 'Which format?', answer: 'JSON lines', reasonCode: 'runner_not_holding_transcript', milestones: ['Wrote the parser'] });
    expect(patch).toMatchObject({ resumeBranch: 'buildd/task-2-build', lastCommitSha: 'abc123', iteration: 2 });
    expect(patch.answerDelivery).toMatchObject({ continuation: 'same_task', reasonCode: 'runner_not_holding_transcript' });
    // A merge patch: the task's own keys (a delegation's filing targets) are not in it, so they stay.
    expect('filingTargets' in patch).toBe(false);
    // Gated in SQL: open status, not merged by the kernel, not a delivery owner, no other live attempt.
    const g = guards(where);
    expect(g).toContain('inArray');
    expect(g).toContain('notKernelMergedTaskSql');
    expect(g).toContain('notOwnerTaskSql');
    expect(g.filter(x => x === 'sql').length).toBeGreaterThanOrEqual(1);
    expect(r.reopened && r.entryId).toBe(patch.answeredQuestions[0].id);
  });

  it.each([['completed'], ['cancelled']])('refuses a %s task and writes nothing', async (status) => {
    taskRow!.status = status;
    const r = await reopenTaskForAnsweredAttempt(input());
    expect(r).toEqual({ reopened: false, reason: 'task_closed' });
    expect(taskUpdates).toHaveLength(0);
  });

  it('refuses a task that is gone', async () => {
    taskRow = null;
    expect(await reopenTaskForAnsweredAttempt(input())).toEqual({ reopened: false, reason: 'task_missing' });
  });

  it('a guarded write that moves nothing (the task closed, or another attempt went live) is not a reopen', async () => {
    updateReturns = [[]];
    const r = await reopenTaskForAnsweredAttempt(input());
    expect(r).toEqual({ reopened: false, reason: 'not_reopenable' });
  });

  it('lets a failing write throw, so the caller compensates', async () => {
    updateThrows = new Error('connection reset');
    await expect(reopenTaskForAnsweredAttempt(input())).rejects.toThrow('connection reset');
  });

  describe('a delivery owner task (its status is the kernel\'s)', () => {
    beforeEach(() => {
      taskRow = { ...taskRow!, deliveryId: 'delivery-1', deliveryRole: 'owner' };
    });

    it('writes context only, then asks the kernel to requeue the attempt', async () => {
      const r = await reopenTaskForAnsweredAttempt(input());
      expect(r.reopened).toBe(true);
      expect(taskUpdates).toHaveLength(1);
      expect('status' in taskUpdates[0].set).toBe(false);
      expect('claimedBy' in taskUpdates[0].set).toBe(false);
      expect(patchOf(taskUpdates[0].set).answeredQuestions).toHaveLength(1);
      expect(mockRequeueOwner).toHaveBeenCalledTimes(1);
      expect(mockRequeueOwner.mock.calls[0][0]).toMatchObject({ task: { id: 'task-2', deliveryId: 'delivery-1', deliveryRole: 'owner' }, workerId: 'worker-2' });
      expect(mockReopenOwner).not.toHaveBeenCalled();
    });

    it('reopens a failed owner through AttemptReopened, naming the superseded attempt and its end', async () => {
      taskRow!.status = 'failed';
      await reopenTaskForAnsweredAttempt(input());
      expect(mockReopenOwner).toHaveBeenCalledTimes(1);
      expect(mockReopenOwner.mock.calls[0][0]).toMatchObject({ workerId: 'worker-2', endedAt: new Date(1_000).toISOString(), to: 'pending' });
      expect(mockRequeueOwner).not.toHaveBeenCalled();
    });

    it('a kernel refusal removes the answer it wrote and reports no reopen', async () => {
      mockRequeueOwner.mockImplementation(async () => false);
      const r = await reopenTaskForAnsweredAttempt(input());
      expect(r).toEqual({ reopened: false, reason: 'kernel_refused' });
      expect(taskUpdates).toHaveLength(2);
      const revert = taskUpdates[1].set.context;
      expect(revert.type).toBe('sql');
      expect(revert.values).toContain((patchOf(taskUpdates[0].set).answeredQuestions[0]).id);
    });
  });
});
