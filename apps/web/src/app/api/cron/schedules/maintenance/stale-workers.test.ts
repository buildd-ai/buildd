import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockWorkerHeartbeatsFindMany = mock(() => [] as any[]);
const mockWorkersFindMany = mock(() => [] as any[]);
const mockReportOps = mock(() => Promise.resolve());

let updateCalls: any[] = [];
let deleteCalls = 0;
// When set, the heartbeat lookup throws it — drives the swallow-everything path.
let findError: Error | null = null;

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workerHeartbeats: {
        findMany: (...args: any[]) => {
          if (findError) throw findError;
          return mockWorkerHeartbeatsFindMany(...(args as []));
        },
      },
      workers: { findMany: mockWorkersFindMany },
    },
    update: mock((table: any) => ({
      set: mock((vals: any) => {
        const entry: any = { table, set: vals };
        updateCalls.push(entry);
        return { where: mock((cond: any) => { entry.where = cond; return Promise.resolve(); }) };
      }),
    })),
    delete: mock(() => ({ where: mock(() => { deleteCalls++; return Promise.resolve(); }) })),
  },
}));

mock.module('drizzle-orm', () => ({
  // Operators withCronRun imports. mock.module is process-global, so a
  // partial stub removes them for every other importer too.
  eq: (a: any, b: any) => ({ a, b, op: 'eq' }),
  desc: (a: any) => ({ a, op: 'desc' }),
  gt: (a: any, b: any) => ({ a, b, op: 'gt' }),
  and: (...args: any[]) => args,
  lt: (field: any, value: any) => ({ field, value, type: 'lt' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  // withCronRun imports this; mock.module replaces the whole module, so a
  // partial stub deletes the export for every other importer in the process.
  cronRuns: { id: 'id', job: 'job', startedAt: 'startedAt', alertedAt: 'alertedAt' },
  tasks: 'tasks',
  workers: 'workers',
  workerHeartbeats: 'workerHeartbeats',
}));

mock.module('@buildd/core/report-ops', () => ({ reportOps: mockReportOps }));

import { runStaleWorkerCleanup } from './stale-workers';

const NOW = new Date('2026-03-01T12:00:00Z');

/**
 * Behavioural contract (prose):
 *   - No stale heartbeats → no writes, no alert, 0 orphans.
 *   - Stale heartbeat with live workers → those workers are failed, their tasks
 *     are returned to `pending`, the count is returned, heartbeat rows deleted.
 *   - Stale heartbeat with NO live workers → still alerts (an idle-but-wedged
 *     runner must not vanish silently) and still deletes the heartbeat rows.
 *   - Any throw is swallowed: the cron tick must still return 200.
 */
describe('runStaleWorkerCleanup', () => {
  beforeEach(() => {
    mockWorkerHeartbeatsFindMany.mockReset();
    mockWorkerHeartbeatsFindMany.mockResolvedValue([] as any);
    mockWorkersFindMany.mockReset();
    mockWorkersFindMany.mockResolvedValue([] as any);
    mockReportOps.mockReset();
    updateCalls = [];
    deleteCalls = 0;
    findError = null;
  });

  it('does nothing when no heartbeat is stale', async () => {
    expect(await runStaleWorkerCleanup(NOW)).toBe(0);
    expect(updateCalls).toHaveLength(0);
    expect(deleteCalls).toBe(0);
    expect(mockReportOps).not.toHaveBeenCalled();
  });

  it('fails orphaned workers, requeues their tasks, and returns the count', async () => {
    mockWorkerHeartbeatsFindMany.mockResolvedValue([{ id: 'hb-1', accountId: 'acct-1' }] as any);
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w-1', taskId: 't-1' },
      { id: 'w-2', taskId: 't-2' },
    ] as any);

    expect(await runStaleWorkerCleanup(NOW)).toBe(2);

    const workerUpdate = updateCalls.find(c => c.table === 'workers');
    expect(workerUpdate).toBeDefined();
    expect(workerUpdate.set.status).toBe('failed');
    expect(workerUpdate.set.error).toContain('heartbeat expired');
    expect(workerUpdate.set.completedAt).toBe(NOW);

    // Tasks must go back to the queue, unclaimed, or they stay wedged forever.
    const taskUpdate = updateCalls.find(c => c.table === 'tasks');
    expect(taskUpdate).toBeDefined();
    expect(taskUpdate.set.status).toBe('pending');
    expect(taskUpdate.set.claimedBy).toBeNull();
    expect(taskUpdate.set.claimedAt).toBeNull();
    expect(taskUpdate.where.values).toEqual(['t-1', 't-2']);

    expect(deleteCalls).toBe(1);
  });

  it('skips the task requeue when the orphaned workers hold no task', async () => {
    mockWorkerHeartbeatsFindMany.mockResolvedValue([{ id: 'hb-1', accountId: 'acct-1' }] as any);
    mockWorkersFindMany.mockResolvedValue([{ id: 'w-1', taskId: null }] as any);

    expect(await runStaleWorkerCleanup(NOW)).toBe(1);
    expect(updateCalls.find(c => c.table === 'workers')).toBeDefined();
    expect(updateCalls.find(c => c.table === 'tasks')).toBeUndefined();
  });

  it('alerts even when the stale runner had no live workers', async () => {
    // Idle-but-wedged runner: the orphan-failover finds nothing, so the alert
    // is the ONLY signal that the runner went dark.
    mockWorkerHeartbeatsFindMany.mockResolvedValue([{ id: 'hb-1', accountId: 'acct-1' }] as any);
    mockWorkersFindMany.mockResolvedValue([] as any);

    expect(await runStaleWorkerCleanup(NOW)).toBe(0);
    expect(updateCalls).toHaveLength(0);

    expect(mockReportOps).toHaveBeenCalledTimes(1);
    const arg = (mockReportOps.mock.calls[0] as any[])[0];
    expect(arg.source).toBe('runner-offline');
    expect(arg.severity).toBe('error');
    expect(arg.detail).toContain('orphaned workers failed: 0');

    // Heartbeat rows must still be cleared or the alert re-fires forever.
    expect(deleteCalls).toBe(1);
  });

  it('swallows a DB failure and reports 0 orphans so the cron tick still succeeds', async () => {
    findError = new Error('neon HTTP blip');
    expect(await runStaleWorkerCleanup(NOW)).toBe(0);
    expect(mockReportOps).not.toHaveBeenCalled();
  });
});
