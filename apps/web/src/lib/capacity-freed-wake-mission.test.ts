/**
 * Regression: a final verification deferred on `mission_concurrent` (the
 * mission at its cap: a GPU task parked on a question plus a criterion check)
 * stayed pending with idle host runners after the criterion check finished.
 * Nothing woke it: the capacity-freed wake only serves cloud-dispatch
 * webhook workspaces, and host runners are push-driven with an hourly
 * fallback poll. A mission task going terminal must wake the next sibling.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

const mockTaskFindFirst = mock(async (_opts: any) => null as any);
const mockMissionFindFirst = mock(async (_opts: any) => null as any);
const mockWakeTask = mock(async (_id: string, _cause: string) => {});

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: (...args: any[]) => mockTaskFindFirst(...args) },
      missions: { findFirst: (...args: any[]) => mockMissionFindFirst(...args) },
    },
  },
}));
mock.module('@buildd/core/db/schema', () => ({
  workspaces: { id: 'id', webhookConfig: 'webhook_config' },
  tasks: { id: 'id', missionId: 'mission_id', priority: 'priority', createdAt: 'created_at' },
  missions: { id: 'id', maxConcurrentTasks: 'max_concurrent_tasks' },
}));
mock.module('drizzle-orm', () => ({
  and: (...args: any[]) => ({ type: 'and', args }),
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  ne: (a: any, b: any) => ({ type: 'ne', a, b }),
}));
mock.module('@buildd/core/db/relational-sql', () => ({
  sqlWhere: (w: any) => w,
  sqlOrderByFn: (f: any) => f,
}));
mock.module('@/app/api/cron/queue-stall/fleet-idle', () => ({
  claimablePendingWhere: (cutoff: Date) => ({ type: 'claimablePendingWhere', cutoff }),
}));
mock.module('@/app/api/workers/claim/deps-gate', () => ({
  depsGate: () => ({ type: 'depsGate' }),
}));
mock.module('@/lib/dispatch-authority', () => ({
  wakeTask: (...args: [string, string]) => mockWakeTask(...args),
}));

const { wakeMissionSlotWaiter } = await import('./capacity-freed-wake');

const FINISHED = 'criterion-check';
const MISSION = 'mission-1';

/** First tasks.findFirst reads the finished task; the second picks the candidate. */
function setup(opts: { missionId: string | null; cap: number | null; candidate: string | null }) {
  let call = 0;
  mockTaskFindFirst.mockImplementation(async () => {
    call += 1;
    if (call === 1) return { missionId: opts.missionId };
    return opts.candidate ? { id: opts.candidate } : null;
  });
  mockMissionFindFirst.mockImplementation(async () => ({ maxConcurrentTasks: opts.cap }));
}

beforeEach(() => {
  mockTaskFindFirst.mockReset();
  mockMissionFindFirst.mockReset();
  mockWakeTask.mockReset();
});

describe('wakeMissionSlotWaiter', () => {
  it('wakes the next claimable sibling of a capped mission when one of its tasks finishes', async () => {
    setup({ missionId: MISSION, cap: 2, candidate: 'final-verification' });

    await wakeMissionSlotWaiter(FINISHED);

    expect(mockWakeTask).toHaveBeenCalledTimes(1);
    expect(mockWakeTask.mock.calls[0]).toEqual(['final-verification', 'capacity.freed']);
    // Scoped to the mission, gated like a claim (claimable, deps satisfied), never the finished task.
    const where = JSON.stringify(mockTaskFindFirst.mock.calls[1]![0].where);
    expect(where).toContain(MISSION);
    expect(where).toContain('claimablePendingWhere');
    expect(where).toContain('depsGate');
    expect(where).toContain(`"type":"ne","a":"id","b":"${FINISHED}"`);
  });

  it('does not depend on a cloud-dispatch webhook (host-polled workspaces get the wake too)', async () => {
    setup({ missionId: MISSION, cap: 2, candidate: 'final-verification' });
    await wakeMissionSlotWaiter(FINISHED);
    // No workspace read at all: the wake is not gated on webhookConfig.
    expect(mockWakeTask).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for a mission with no concurrency cap (no slot was freed)', async () => {
    setup({ missionId: MISSION, cap: null, candidate: 'x' });
    await wakeMissionSlotWaiter(FINISHED);
    expect(mockTaskFindFirst).toHaveBeenCalledTimes(1);
    expect(mockWakeTask).not.toHaveBeenCalled();
  });

  it('is a no-op for a task outside any mission', async () => {
    setup({ missionId: null, cap: 2, candidate: 'x' });
    await wakeMissionSlotWaiter(FINISHED);
    expect(mockMissionFindFirst).not.toHaveBeenCalled();
    expect(mockWakeTask).not.toHaveBeenCalled();
  });

  it('is a no-op with no finished task id or no waiting sibling', async () => {
    await wakeMissionSlotWaiter(null);
    expect(mockTaskFindFirst).not.toHaveBeenCalled();

    setup({ missionId: MISSION, cap: 2, candidate: null });
    await wakeMissionSlotWaiter(FINISHED);
    expect(mockWakeTask).not.toHaveBeenCalled();
  });

  it('swallows a DB failure (best-effort, called from a terminal PATCH)', async () => {
    mockTaskFindFirst.mockImplementation(async () => { throw new Error('db down'); });
    await expect(wakeMissionSlotWaiter(FINISHED)).resolves.toBeUndefined();
    expect(mockWakeTask).not.toHaveBeenCalled();
  });
});
