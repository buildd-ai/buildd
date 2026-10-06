import { describe, it, expect, beforeEach, mock } from 'bun:test';

const mockWaitersFindFirst = mock((_args: any) => Promise.resolve(null as any));
mock.module('@buildd/core/db', () => ({ db: { query: { pathClaimWaiters: { findFirst: mockWaitersFindFirst } } } }));
mock.module('@buildd/core/db/schema', () => ({ pathClaimWaiters: { waitingTaskId: 'w', blockingTaskId: 'b' } }));
mock.module('drizzle-orm', () => ({ eq: (f: unknown, v: unknown) => ({ f, v }), and: (...c: unknown[]) => c }));

import { taskScopeIsPathClaimHolder } from './path-claim-holder-read';

const scoped = { taskScope: { taskId: 'task-1', workspaceId: 'ws-1' } };
const holder = { id: 'task-holder', workspaceId: 'ws-1' };

describe('taskScopeIsPathClaimHolder', () => {
  beforeEach(() => mockWaitersFindFirst.mockReset());

  it('allows a task the caller is a registered waiter on', async () => {
    mockWaitersFindFirst.mockResolvedValue({ id: 'w-1' });
    expect(await taskScopeIsPathClaimHolder(scoped, holder)).toBe(true);
  });

  it('refuses a task that is not blocking the caller', async () => {
    mockWaitersFindFirst.mockResolvedValue(null);
    expect(await taskScopeIsPathClaimHolder(scoped, holder)).toBe(false);
  });

  it('refuses another workspace and a non-task-token caller without querying', async () => {
    expect(await taskScopeIsPathClaimHolder(scoped, { ...holder, workspaceId: 'ws-2' })).toBe(false);
    expect(await taskScopeIsPathClaimHolder({}, holder)).toBe(false);
    expect(mockWaitersFindFirst).not.toHaveBeenCalled();
  });
});
