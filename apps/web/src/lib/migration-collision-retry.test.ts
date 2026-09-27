import { describe, it, expect, beforeEach, mock } from 'bun:test';

const mockDispatchConflictRetry = mock((_p: any) => Promise.resolve({ dispatched: false }) as Promise<any>);
mock.module('@/lib/conflict-retry', () => ({
  dispatchConflictRetry: mockDispatchConflictRetry,
}));

const mockAppendPrActivity = mock((_p: any) => Promise.resolve({ action: 'created', commentId: 1 }) as Promise<any>);
mock.module('@/lib/pr-activity-comment', () => ({
  appendPrActivity: mockAppendPrActivity,
}));

import { tryDispatchMigrationCollisionRetry } from './migration-collision-retry';

const COLLISION = { file: '0093_safe.sql', otherFile: '0093_other.sql', otherPrNumber: 100 };

const BASE_PARAMS = {
  collision: COLLISION,
  workerId: 'worker-id',
  taskId: 'task-id',
  prNumber: 42,
  headSha: 'sha-abc123',
  repoFullName: 'acme/app',
  workspaceId: 'ws-1',
  installationId: 5,
};

describe('tryDispatchMigrationCollisionRetry', () => {
  beforeEach(() => {
    mockDispatchConflictRetry.mockReset();
    mockAppendPrActivity.mockReset();
    mockDispatchConflictRetry.mockResolvedValue({ dispatched: false });
    mockAppendPrActivity.mockResolvedValue({ action: 'created', commentId: 1 });
  });

  it('dispatches through conflict-retry with migrationCollision and reports handled', async () => {
    mockDispatchConflictRetry.mockResolvedValue({ dispatched: true, taskId: 'new-task' });

    const result = await tryDispatchMigrationCollisionRetry(BASE_PARAMS);

    expect(result.handled).toBe(true);
    expect(mockDispatchConflictRetry).toHaveBeenCalledTimes(1);
    const call = mockDispatchConflictRetry.mock.calls[0][0];
    expect(call.migrationCollision).toEqual(COLLISION);
    expect(call.prNumber).toBe(42);
    expect(call.headSha).toBe('sha-abc123');
  });

  it('posts a "resolving" PR activity entry, not human_review_required', async () => {
    mockDispatchConflictRetry.mockResolvedValue({ dispatched: true, taskId: 'new-task' });

    await tryDispatchMigrationCollisionRetry(BASE_PARAMS);

    expect(mockAppendPrActivity).toHaveBeenCalledTimes(1);
    const entry = mockAppendPrActivity.mock.calls[0][0].entry;
    expect(entry.kind).toBe('migration_collision_fixing');
    expect(entry.kind).not.toBe('human_review_required');
  });

  it('treats an already in-flight retry as handled, without a duplicate dispatch signal', async () => {
    mockDispatchConflictRetry.mockResolvedValue({ dispatched: false, inFlightTaskId: 'existing-task' });

    const result = await tryDispatchMigrationCollisionRetry(BASE_PARAMS);

    expect(result.handled).toBe(true);
    expect(mockAppendPrActivity).toHaveBeenCalledTimes(1);
  });

  it('falls through unhandled when the retry cap is exhausted, so the caller escalates to a human', async () => {
    mockDispatchConflictRetry.mockResolvedValue({ dispatched: false, exhausted: true });

    const result = await tryDispatchMigrationCollisionRetry(BASE_PARAMS);

    expect(result.handled).toBe(false);
    expect(mockAppendPrActivity).not.toHaveBeenCalled();
  });

  it('falls through unhandled when auto-resolve is disabled on the workspace', async () => {
    mockDispatchConflictRetry.mockResolvedValue({ dispatched: false, disabled: true });

    const result = await tryDispatchMigrationCollisionRetry(BASE_PARAMS);

    expect(result.handled).toBe(false);
    expect(mockAppendPrActivity).not.toHaveBeenCalled();
  });

  it('skips the PR activity call when no installationId is available, but still reports handled', async () => {
    mockDispatchConflictRetry.mockResolvedValue({ dispatched: true, taskId: 'new-task' });

    const result = await tryDispatchMigrationCollisionRetry({ ...BASE_PARAMS, installationId: null });

    expect(result.handled).toBe(true);
    expect(mockAppendPrActivity).not.toHaveBeenCalled();
  });
});
