/**
 * A worker going terminal frees a concurrency slot (account
 * maxConcurrentWorkers) a cloud container's claim may have been deferred for
 * (EXIT_CLAIM_DEFERRED). Before this wake, nothing proactively re-checked
 * that task: it waited for the cloud runner's own backoff retry or a slow
 * sweep. This covers the gate (cloud-dispatch workspaces only) and the
 * candidate pick (oldest pending claimable task, excluding the one that just
 * finished).
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { CLOUD_DISPATCH_EVENTS } from '@buildd/shared';

const mockWorkspaceFindFirst = mock(async (_opts: any) => null as any);
const mockTaskFindFirst = mock(async (_opts: any) => null as any);
const mockWakeTask = mock(async (_id: string, _cause: string) => {});

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: (...args: any[]) => mockWorkspaceFindFirst(...args) },
      tasks: { findFirst: (...args: any[]) => mockTaskFindFirst(...args) },
    },
  },
}));
mock.module('@buildd/core/db/schema', () => ({
  workspaces: { id: 'id', webhookConfig: 'webhook_config' },
  tasks: { id: 'id', workspaceId: 'workspace_id', priority: 'priority', createdAt: 'created_at' },
}));
mock.module('drizzle-orm', () => ({
  and: (...args: any[]) => ({ type: 'and', args }),
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  ne: (a: any, b: any) => ({ type: 'ne', a, b }),
}));
mock.module('@/app/api/cron/queue-stall/fleet-idle', () => ({
  claimablePendingWhere: (cutoff: Date) => ({ type: 'claimablePendingWhere', cutoff }),
}));
mock.module('@/lib/dispatch-authority', () => ({
  wakeTask: (...args: [string, string]) => mockWakeTask(...args),
}));

const { wakeOldestPendingTaskOnCapacityFreed } = await import('./capacity-freed-wake');

const WS = 'ws-1';
const cloudWebhook = { enabled: true, events: [...CLOUD_DISPATCH_EVENTS] };

beforeEach(() => {
  mockWorkspaceFindFirst.mockReset();
  mockTaskFindFirst.mockReset();
  mockWakeTask.mockReset();
  mockWorkspaceFindFirst.mockImplementation(async () => null);
  mockTaskFindFirst.mockImplementation(async () => null);
});

describe('wakeOldestPendingTaskOnCapacityFreed', () => {
  it('wakes the oldest pending candidate for a cloud-dispatch workspace', async () => {
    mockWorkspaceFindFirst.mockImplementation(async () => ({ webhookConfig: cloudWebhook }));
    mockTaskFindFirst.mockImplementation(async () => ({ id: 'task-oldest' }));

    await wakeOldestPendingTaskOnCapacityFreed(WS, 'task-just-finished');

    expect(mockWakeTask).toHaveBeenCalledTimes(1);
    expect(mockWakeTask.mock.calls[0]).toEqual(['task-oldest', 'capacity.freed']);
    // Excludes the task that just finished from its own candidate query.
    const where = mockTaskFindFirst.mock.calls[0]![0].where;
    expect(JSON.stringify(where)).toContain('task-just-finished');
  });

  it('is a no-op for a workspace with no cloud-dispatch webhook', async () => {
    for (const webhookConfig of [null, undefined, { enabled: false, events: [...CLOUD_DISPATCH_EVENTS] }, { enabled: true, events: ['task.created'] }, { enabled: true }]) {
      mockWorkspaceFindFirst.mockImplementation(async () => ({ webhookConfig }));
      await wakeOldestPendingTaskOnCapacityFreed(WS, null);
    }
    expect(mockTaskFindFirst).not.toHaveBeenCalled();
    expect(mockWakeTask).not.toHaveBeenCalled();
  });

  it('is a no-op when there is no claimable candidate', async () => {
    mockWorkspaceFindFirst.mockImplementation(async () => ({ webhookConfig: cloudWebhook }));
    mockTaskFindFirst.mockImplementation(async () => null);

    await wakeOldestPendingTaskOnCapacityFreed(WS, null);

    expect(mockWakeTask).not.toHaveBeenCalled();
  });

  it('swallows a DB failure rather than throwing (best-effort, called from a terminal PATCH)', async () => {
    mockWorkspaceFindFirst.mockImplementation(async () => { throw new Error('db down'); });
    await expect(wakeOldestPendingTaskOnCapacityFreed(WS, null)).resolves.toBeUndefined();
    expect(mockWakeTask).not.toHaveBeenCalled();
  });

  it('with no excludeTaskId, the candidate query carries no ne() filter', async () => {
    mockWorkspaceFindFirst.mockImplementation(async () => ({ webhookConfig: cloudWebhook }));
    mockTaskFindFirst.mockImplementation(async () => ({ id: 'task-x' }));

    await wakeOldestPendingTaskOnCapacityFreed(WS, null);

    const where = mockTaskFindFirst.mock.calls[0]![0].where;
    expect(JSON.stringify(where)).not.toContain('"type":"ne"');
  });
});
